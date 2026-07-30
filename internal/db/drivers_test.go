package db

import (
	"context"
	"database/sql"
	"reflect"
	"slices"
	"testing"
	"time"
)

func TestUniversalBuildRegistersAllDrivers(t *testing.T) {
	t.Parallel()

	want := []Driver{
		{Engine: "mysql", DisplayName: "MySQL / MariaDB", DatabaseSQLName: "mysql"},
		{Engine: "postgres", DisplayName: "PostgreSQL", DatabaseSQLName: "pgx"},
		{Engine: "sqlite", DisplayName: "SQLite", DatabaseSQLName: "sqlite3"},
	}
	if got := Compiled(); !reflect.DeepEqual(got, want) {
		t.Fatalf("compiled drivers = %#v, want %#v", got, want)
	}

	registered := sql.Drivers()
	for _, name := range []string{"mysql", "pgx", "sqlite3"} {
		if !slices.Contains(registered, name) {
			t.Fatalf("database/sql driver %q is not registered; registered: %v", name, registered)
		}
	}
}

func TestSQLiteDriver(t *testing.T) {
	t.Parallel()

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	database, err := Open(ctx, OpenOptions{
		Driver:          "sqlite3",
		DataSourceName:  "file:rowake-driver-test?mode=memory&cache=shared",
		MaxOpen:         1,
		MaxIdle:         1,
		ConnectionProbe: 5 * time.Second,
	})
	if err != nil {
		t.Fatalf("open SQLite: %v", err)
	}
	defer database.Close()

	if _, err := database.ExecContext(ctx, `CREATE TABLE probe (value INTEGER NOT NULL)`); err != nil {
		t.Fatalf("create SQLite table: %v", err)
	}
	if _, err := database.ExecContext(ctx, `INSERT INTO probe (value) VALUES (1)`); err != nil {
		t.Fatalf("insert SQLite row: %v", err)
	}

	var value int
	if err := database.QueryRowContext(ctx, `SELECT value FROM probe`).Scan(&value); err != nil {
		t.Fatalf("query SQLite: %v", err)
	}
	if value != 1 {
		t.Fatalf("SQLite value = %d, want 1", value)
	}
}
