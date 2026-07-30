package db

import (
	"context"
	"os"
	"testing"
	"time"
)

func TestExternalDrivers(t *testing.T) {
	tests := []struct {
		name   string
		driver string
		env    string
	}{
		{name: "PostgreSQL", driver: "pgx", env: "ROWAKE_TEST_POSTGRES_DSN"},
		{name: "MySQL", driver: "mysql", env: "ROWAKE_TEST_MYSQL_DSN"},
	}

	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			dsn := os.Getenv(test.env)
			if dsn == "" {
				t.Skipf("%s is not set", test.env)
			}

			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()

			database, err := Open(ctx, OpenOptions{
				Driver:          test.driver,
				DataSourceName:  dsn,
				MaxOpen:         2,
				MaxIdle:         1,
				ConnectionTTL:   time.Minute,
				ConnectionProbe: 20 * time.Second,
			})
			if err != nil {
				t.Fatalf("open %s: %v", test.name, err)
			}
			defer database.Close()

			var value int
			if err := database.QueryRowContext(ctx, `SELECT 1`).Scan(&value); err != nil {
				t.Fatalf("query %s: %v", test.name, err)
			}
			if value != 1 {
				t.Fatalf("%s value = %d, want 1", test.name, value)
			}
		})
	}
}
