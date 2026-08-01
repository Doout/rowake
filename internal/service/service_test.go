package service_test

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/Doout/rowake/internal/app"
	"github.com/Doout/rowake/internal/service"
)

func TestSQLiteCompositeRelationshipMetadataAndFilters(t *testing.T) {
	path := filepath.Join(t.TempDir(), "composite.sqlite")
	database, err := sql.Open("sqlite3", path)
	if err != nil {
		t.Fatal(err)
	}
	statements := []string{
		`PRAGMA foreign_keys = ON`,
		`CREATE TABLE parent (tenant_id INTEGER NOT NULL, record_id INTEGER NOT NULL, name TEXT, PRIMARY KEY (tenant_id, record_id))`,
		`CREATE TABLE child (id INTEGER PRIMARY KEY, tenant_id INTEGER, parent_id INTEGER, FOREIGN KEY (tenant_id, parent_id) REFERENCES parent (tenant_id, record_id))`,
		`INSERT INTO parent VALUES (7, 42, 'target')`,
		`INSERT INTO child VALUES (1, 7, 42)`,
	}
	for _, statement := range statements {
		if _, err := database.Exec(statement); err != nil {
			database.Close()
			t.Fatal(err)
		}
	}
	if err := database.Close(); err != nil {
		t.Fatal(err)
	}

	value := service.New("dev")
	t.Cleanup(func() { _ = value.Close() })
	connection, err := value.AddConnection(context.Background(), app.ConnectionRequest{Engine: "sqlite", DataSourceName: path})
	if err != nil {
		t.Fatal(err)
	}
	topology, err := value.Topology(context.Background(), connection.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(topology.Relationships) != 2 || topology.Relationships[0].ConstraintID == "" || topology.Relationships[0].ConstraintID != topology.Relationships[1].ConstraintID {
		t.Fatalf("composite relationships = %#v", topology.Relationships)
	}
	page, err := value.TablePage(context.Background(), app.TablePageRequest{
		ConnectionID: connection.ID,
		Schema:       "main",
		Table:        "parent",
		Limit:        10,
		Filters: []app.TableFilter{
			{Column: "tenant_id", Operator: "equals", Value: "7"},
			{Column: "record_id", Operator: "equals", Value: "42"},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if page.RowCount != 1 || page.Rows[0][2] != "target" {
		t.Fatalf("composite related page = %#v", page)
	}
}

func TestSQLiteConnectionWorkflow(t *testing.T) {
	ctx := context.Background()
	value := service.New("1.2.3")
	t.Cleanup(func() {
		if err := value.Close(); err != nil {
			t.Errorf("close service: %v", err)
		}
	})

	meta, err := value.Meta(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if meta.Version != "1.2.3" {
		t.Fatalf("meta = %#v", meta)
	}

	connections, err := value.Connections(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if connections == nil || len(connections) != 0 {
		t.Fatalf("connections = %#v, want an empty list", connections)
	}
	if _, err := value.Catalog(ctx, "missing"); !errors.Is(err, service.ErrConnectionRequired) {
		t.Fatalf("catalog error = %v", err)
	}

	connection, err := value.AddConnection(ctx, app.ConnectionRequest{
		Name:           "Fixture",
		Engine:         "sqlite",
		DataSourceName: fixturePath(t),
	})
	if err != nil {
		t.Fatal(err)
	}
	if connection.ID == "" || connection.Database != "rowake-test.sqlite" || !connection.ReadOnly {
		t.Fatalf("connection = %#v", connection)
	}

	catalog, err := value.Catalog(ctx, connection.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(catalog.Schemas) != 1 || len(catalog.Schemas[0].Tables) != 3 {
		t.Fatalf("catalog = %#v", catalog)
	}
	topology, err := value.Topology(ctx, connection.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(topology.Tables) != 3 || len(topology.Relationships) != 2 {
		t.Fatalf("topology = %#v", topology)
	}
	if topology.Relationships[0].FromColumn == "" || topology.Relationships[0].ToColumn == "" {
		t.Fatalf("topology relationship = %#v", topology.Relationships[0])
	}

	table, err := value.Table(ctx, connection.ID, "main", "users", 2)
	if err != nil {
		t.Fatal(err)
	}
	if table.TotalRows != nil || table.RowCount != 2 || !table.Truncated || !table.HasMore || table.NextCursor == "" {
		t.Fatalf("table page = total %#v, rows %d, truncated %v, more %v", table.TotalRows, table.RowCount, table.Truncated, table.HasMore)
	}
	if len(table.PrimaryKey) != 1 || table.PrimaryKey[0] != "id" {
		t.Fatalf("primary key = %#v", table.PrimaryKey)
	}
	if len(table.Indexes) != 1 || !table.Indexes[0].Unique {
		t.Fatalf("indexes = %#v", table.Indexes)
	}
	if table.Rows[0][1] != "alice@example.test" {
		t.Fatalf("first row = %#v", table.Rows[0])
	}
	filtered, err := value.TablePage(ctx, app.TablePageRequest{
		ConnectionID: connection.ID,
		Schema:       "main",
		Table:        "users",
		Limit:        2,
		Filters: []app.TableFilter{{
			Column: "email", Operator: "contains", Value: "ben",
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if filtered.RowCount != 1 || filtered.Rows[0][1] != "ben@example.test" || filtered.HasMore {
		t.Fatalf("filtered table page = %#v", filtered)
	}
	secondPage, err := value.TablePage(ctx, app.TablePageRequest{
		ConnectionID: connection.ID,
		Schema:       "main",
		Table:        "users",
		Limit:        2,
		Cursor:       table.NextCursor,
	})
	if err != nil {
		t.Fatal(err)
	}
	if secondPage.RowCount != 1 || secondPage.PreviousCursor == "" || secondPage.Rows[0][1] != "casey@example.test" {
		t.Fatalf("second table page = %#v", secondPage)
	}
	firstPageAgain, err := value.TablePage(ctx, app.TablePageRequest{
		ConnectionID: connection.ID,
		Schema:       "main",
		Table:        "users",
		Limit:        2,
		Cursor:       secondPage.PreviousCursor,
	})
	if err != nil {
		t.Fatal(err)
	}
	if firstPageAgain.RowCount != 2 || firstPageAgain.Rows[0][1] != "alice@example.test" || firstPageAgain.Rows[1][1] != "ben@example.test" {
		t.Fatalf("previous keyset page = %#v", firstPageAgain)
	}
	if _, err := value.TablePage(ctx, app.TablePageRequest{
		ConnectionID: connection.ID,
		Schema:       "main",
		Table:        "users",
		Limit:        2,
		Cursor:       table.NextCursor,
		Sort:         &app.TableSort{Column: "email", Direction: "asc"},
	}); err == nil {
		t.Fatal("keyset cursor was accepted with a different ordering")
	}

	result, err := value.Query(ctx, app.QueryRequest{
		ConnectionID: connection.ID,
		SQL:          "SELECT name, status FROM projects ORDER BY id",
		Limit:        1,
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.RowCount != 1 || !result.Truncated || result.Rows[0][0] != "Atlas" {
		t.Fatalf("query result = %#v", result)
	}
	if _, err := value.Query(ctx, app.QueryRequest{
		ConnectionID: connection.ID,
		SQL:          "DELETE FROM users",
	}); err == nil {
		t.Fatal("write query succeeded")
	}
	if _, err := value.TablePage(ctx, app.TablePageRequest{
		ConnectionID: connection.ID,
		Schema:       "main",
		Table:        "users",
		Filters:      []app.TableFilter{{Column: `email\" OR 1=1 --`, Operator: "equals", Value: "x"}},
	}); err == nil {
		t.Fatal("unsafe filter identifier succeeded")
	}

	plan, err := value.Explain(ctx, app.QueryRequest{ConnectionID: connection.ID, SQL: "SELECT * FROM users WHERE id = 1"})
	if err != nil {
		t.Fatal(err)
	}
	if plan.Engine != "sqlite" || len(plan.Nodes) == 0 || plan.Nodes[0].Operation == "" {
		t.Fatalf("explain plan = %#v", plan)
	}
	if _, err := value.Explain(ctx, app.QueryRequest{ConnectionID: connection.ID, SQL: "EXPLAIN SELECT * FROM users"}); err == nil {
		t.Fatal("nested EXPLAIN succeeded")
	}
	schemaSnapshot, err := value.SchemaSnapshot(ctx, connection.ID)
	if err != nil {
		t.Fatal(err)
	}
	if schemaSnapshot.Version != 1 || schemaSnapshot.Database != connection.Database || len(schemaSnapshot.Topology.Tables) != 3 {
		t.Fatalf("schema snapshot = %#v", schemaSnapshot)
	}

	updated, err := value.UpdateConnection(ctx, connection.ID, app.ConnectionRequest{
		Name:           "Renamed fixture",
		Engine:         "sqlite",
		DataSourceName: fixturePath(t),
	})
	if err != nil {
		t.Fatal(err)
	}
	if updated.ID != connection.ID || updated.Name != "Renamed fixture" {
		t.Fatalf("updated connection = %#v", updated)
	}
	disconnected, err := value.DisconnectConnection(ctx, connection.ID)
	if err != nil {
		t.Fatal(err)
	}
	if disconnected.Status != "disconnected" {
		t.Fatalf("disconnected connection = %#v", disconnected)
	}
	if _, err := value.Catalog(ctx, connection.ID); err == nil || !strings.Contains(err.Error(), "disconnected") {
		t.Fatalf("catalog after disconnect error = %v", err)
	}
	reconnected, err := value.ReconnectConnection(ctx, connection.ID, "")
	if err != nil {
		t.Fatal(err)
	}
	if reconnected.Status != "connected" {
		t.Fatalf("reconnected connection = %#v", reconnected)
	}
	if err := value.RemoveConnection(ctx, connection.ID); err != nil {
		t.Fatal(err)
	}
	connections, err = value.Connections(ctx)
	if err != nil || len(connections) != 0 {
		t.Fatalf("connections after removal = %#v, %v", connections, err)
	}
}

func TestAddConnectionValidation(t *testing.T) {
	value := service.New("dev")
	t.Cleanup(func() { _ = value.Close() })

	if _, err := value.AddConnection(context.Background(), app.ConnectionRequest{
		Engine:         "postgres",
		DataSourceName: fixturePath(t),
	}); err == nil {
		t.Fatal("unsupported engine succeeded")
	}
	if _, err := value.AddConnection(context.Background(), app.ConnectionRequest{
		Engine:         "sqlite",
		DataSourceName: "missing.sqlite",
	}); err == nil {
		t.Fatal("missing database succeeded")
	}
	invalid := filepath.Join(t.TempDir(), "not-sqlite.db")
	if err := os.WriteFile(invalid, []byte("not a SQLite database"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := value.AddConnection(context.Background(), app.ConnectionRequest{
		Engine:         "sqlite",
		DataSourceName: invalid,
	}); err == nil {
		t.Fatal("invalid SQLite database succeeded")
	}
}

func TestConnectionPersistence(t *testing.T) {
	ctx := context.Background()
	storePath := filepath.Join(t.TempDir(), "Rowake", "connections.json")

	first := service.New("dev")
	if err := first.EnablePersistence(ctx, storePath); err != nil {
		t.Fatal(err)
	}
	meta, err := first.Meta(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !meta.Features["connection_persistence"] {
		t.Fatal("connection persistence feature is not enabled")
	}
	if _, err := first.AddConnection(ctx, app.ConnectionRequest{
		Name:           "Saved fixture",
		Engine:         "sqlite",
		DataSourceName: fixturePath(t),
	}); err != nil {
		t.Fatal(err)
	}
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}

	info, err := os.Stat(storePath)
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" && info.Mode().Perm() != 0o600 {
		t.Fatalf("connection store permissions = %o", info.Mode().Perm())
	}

	second := service.New("dev")
	t.Cleanup(func() { _ = second.Close() })
	if err := second.EnablePersistence(ctx, storePath); err != nil {
		t.Fatal(err)
	}
	connections, err := second.Connections(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(connections) != 1 || connections[0].Name != "Saved fixture" {
		t.Fatalf("restored connections = %#v", connections)
	}
	if _, err := second.Catalog(ctx, connections[0].ID); err != nil {
		t.Fatalf("restored connection catalog: %v", err)
	}
}

func TestConnectionPersistenceRestoresServerProfileWithoutCredentials(t *testing.T) {
	ctx := context.Background()
	storePath := filepath.Join(t.TempDir(), "Rowake", "connections.json")
	if err := os.MkdirAll(filepath.Dir(storePath), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(storePath, []byte(`{
  "version": 1,
  "connections": [{
    "name": "Do not persist",
    "engine": "postgres",
    "host": "127.0.0.1",
    "port": 5432,
    "username": "postgres",
    "password": "example-secret",
    "password_env": "ROWAKE_DATABASE_PASSWORD",
    "secret_service": "Rowake",
    "secret_account": "postgres@example",
    "database": "postgres"
  }]
}`), 0o600); err != nil {
		t.Fatal(err)
	}

	value := service.New("dev")
	t.Cleanup(func() { _ = value.Close() })
	if err := value.EnablePersistence(ctx, storePath); err != nil {
		t.Fatal(err)
	}
	connections, err := value.Connections(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(connections) != 1 || connections[0].Status != "disconnected" || connections[0].Engine != "postgres" {
		t.Fatalf("restored server profiles = %#v", connections)
	}
	profile, err := value.ConnectionProfile(ctx, connections[0].ID)
	if err != nil {
		t.Fatal(err)
	}
	if profile.Password != "" || profile.PasswordEnv != "ROWAKE_DATABASE_PASSWORD" || profile.SecretService != "Rowake" || profile.SecretAccount != "postgres@example" {
		t.Fatalf("restored secret references = %#v", profile)
	}
	if _, err := value.AddConnection(ctx, app.ConnectionRequest{
		Name:           "Saved fixture",
		Engine:         "sqlite",
		DataSourceName: fixturePath(t),
	}); err != nil {
		t.Fatal(err)
	}
	stored, err := os.ReadFile(storePath)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(stored), "example-secret") || !strings.Contains(string(stored), `"engine": "postgres"`) || !strings.Contains(string(stored), `"secret_service": "Rowake"`) {
		t.Fatalf("server profile was not safely persisted: %s", stored)
	}
}

func fixturePath(t *testing.T) string {
	t.Helper()
	path, err := filepath.Abs(filepath.Join("..", "..", "testdata", "rowake-test.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	return path
}
