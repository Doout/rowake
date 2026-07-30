package service_test

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/Doout/rowake/internal/app"
	"github.com/Doout/rowake/internal/service"
)

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
	if table.TotalRows != 3 || table.RowCount != 2 || !table.Truncated {
		t.Fatalf("table counts = total %d, rows %d, truncated %v", table.TotalRows, table.RowCount, table.Truncated)
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

func TestConnectionPersistenceDropsServerCredentials(t *testing.T) {
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
    "database": "postgres"
  }]
}`), 0o600); err != nil {
		t.Fatal(err)
	}

	value := service.New("dev")
	t.Cleanup(func() { _ = value.Close() })
	if err := value.EnablePersistence(ctx, storePath); err == nil ||
		!strings.Contains(err.Error(), "server credentials are session-only") {
		t.Fatalf("persistence error = %v", err)
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
	if strings.Contains(string(stored), "example-secret") || strings.Contains(string(stored), "postgres") {
		t.Fatalf("server connection remained in store: %s", stored)
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
