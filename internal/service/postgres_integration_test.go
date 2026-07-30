package service_test

import (
	"context"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/Doout/rowake/internal/app"
	"github.com/Doout/rowake/internal/db"
	"github.com/Doout/rowake/internal/service"
	"github.com/jackc/pgx/v5"
)

func TestPostgresConnectionWorkflow(t *testing.T) {
	source := os.Getenv("ROWAKE_TEST_POSTGRES_DSN")
	if source == "" {
		t.Skip("ROWAKE_TEST_POSTGRES_DSN is not set")
	}
	config, err := pgx.ParseConfig(source)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	admin, err := db.Open(ctx, db.OpenOptions{
		Driver:          "pgx",
		DataSourceName:  source,
		MaxOpen:         1,
		MaxIdle:         1,
		ConnectionProbe: 10 * time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close()

	schema := fmt.Sprintf("rowake_test_%d", time.Now().UnixNano())
	quotedSchema := `"` + strings.ReplaceAll(schema, `"`, `""`) + `"`
	fixtureStatements := []string{
		"CREATE SCHEMA " + quotedSchema,
		`CREATE TABLE ` + quotedSchema + `.teams (
			id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
			name text NOT NULL UNIQUE
		)`,
		`CREATE TABLE ` + quotedSchema + `.members (
			id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
			team_id bigint NOT NULL REFERENCES ` + quotedSchema + `.teams(id) ON DELETE CASCADE,
			email text NOT NULL
		)`,
		"INSERT INTO " + quotedSchema + ".teams (name) VALUES ('Platform')",
		"INSERT INTO " + quotedSchema + ".members (team_id, email) VALUES (1, 'dev@example.test')",
	}
	for _, statement := range fixtureStatements {
		if _, err := admin.ExecContext(ctx, statement); err != nil {
			t.Fatal(err)
		}
	}
	defer func() {
		if _, err := admin.ExecContext(context.Background(), "DROP SCHEMA "+quotedSchema+" CASCADE"); err != nil {
			t.Errorf("drop PostgreSQL fixture schema: %v", err)
		}
	}()

	value := service.New("dev")
	t.Cleanup(func() { _ = value.Close() })
	request := app.ConnectionRequest{
		Name:           "PostgreSQL fixture",
		Engine:         "postgres",
		DataSourceName: source,
	}
	databases, err := value.Databases(ctx, request)
	if err != nil {
		t.Fatal(err)
	}
	if !containsString(databases, config.Database) {
		t.Fatalf("databases = %#v, want %q", databases, config.Database)
	}
	connection, err := value.AddConnection(ctx, request)
	if err != nil {
		t.Fatal(err)
	}
	if connection.Engine != "postgres" || connection.Database != config.Database || !connection.ReadOnly {
		t.Fatalf("connection = %#v", connection)
	}

	catalog, err := value.Catalog(ctx, connection.ID)
	if err != nil {
		t.Fatal(err)
	}
	foundSchema := false
	for _, catalogSchema := range catalog.Schemas {
		if catalogSchema.Name == schema && len(catalogSchema.Tables) == 2 {
			foundSchema = true
		}
	}
	if !foundSchema {
		t.Fatalf("catalog does not contain fixture schema: %#v", catalog)
	}
	topology, err := value.Topology(ctx, connection.ID)
	if err != nil {
		t.Fatal(err)
	}
	foundRelationship := false
	for _, relationship := range topology.Relationships {
		if relationship.FromSchema == schema &&
			relationship.FromTable == "members" &&
			relationship.ToSchema == schema &&
			relationship.ToTable == "teams" {
			foundRelationship = true
		}
	}
	if !foundRelationship {
		t.Fatalf("topology does not contain fixture relationship: %#v", topology.Relationships)
	}
	table, err := value.Table(ctx, connection.ID, schema, "members", 100)
	if err != nil {
		t.Fatal(err)
	}
	if table.TotalRows != 1 || table.RowCount != 1 || len(table.PrimaryKey) != 1 ||
		table.PrimaryKey[0] != "id" || len(table.Indexes) == 0 {
		t.Fatalf("table = %#v", table)
	}
	result, err := value.Query(ctx, app.QueryRequest{
		ConnectionID: connection.ID,
		SQL:          "SHOW default_transaction_read_only",
		Limit:        10,
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.RowCount != 1 || result.Rows[0][0] != "on" {
		t.Fatalf("read-only setting = %#v", result.Rows)
	}
	if _, err := value.Query(ctx, app.QueryRequest{
		ConnectionID: connection.ID,
		SQL: "WITH inserted AS (" +
			"INSERT INTO " + quotedSchema + ".teams (name) VALUES ('Blocked') RETURNING id" +
			") SELECT id FROM inserted",
		Limit: 10,
	}); err == nil {
		t.Fatal("write CTE succeeded in a read-only PostgreSQL transaction")
	}
}

func containsString(values []string, wanted string) bool {
	for _, value := range values {
		if value == wanted {
			return true
		}
	}
	return false
}
