package main

import (
	"database/sql"
	"flag"
	"fmt"
	"os"
	"path/filepath"

	_ "github.com/ncruces/go-sqlite3/driver"
)

func main() {
	output := flag.String("out", "testdata/rowake-test.sqlite", "path for the generated SQLite fixture")
	flag.Parse()
	if err := generate(*output); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	fmt.Println(*output)
}

func generate(output string) error {
	path, err := filepath.Abs(output)
	if err != nil {
		return fmt.Errorf("resolve output path: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return fmt.Errorf("create output directory: %w", err)
	}
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("replace existing fixture: %w", err)
	}

	database, err := sql.Open("sqlite3", path)
	if err != nil {
		return fmt.Errorf("open fixture: %w", err)
	}
	defer database.Close()

	transaction, err := database.Begin()
	if err != nil {
		return fmt.Errorf("begin fixture transaction: %w", err)
	}
	defer transaction.Rollback()

	statements := []string{
		`PRAGMA foreign_keys = ON`,
		`CREATE TABLE users (
			id INTEGER PRIMARY KEY,
			email TEXT NOT NULL UNIQUE,
			name TEXT NOT NULL,
			role TEXT NOT NULL,
			active INTEGER NOT NULL DEFAULT 1,
			created_at TEXT NOT NULL
		)`,
		`CREATE TABLE projects (
			id INTEGER PRIMARY KEY,
			name TEXT NOT NULL,
			status TEXT NOT NULL,
			owner_id INTEGER NOT NULL REFERENCES users(id),
			created_at TEXT NOT NULL
		)`,
		`CREATE TABLE events (
			id INTEGER PRIMARY KEY,
			project_id INTEGER NOT NULL REFERENCES projects(id),
			kind TEXT NOT NULL,
			payload TEXT,
			occurred_at TEXT NOT NULL
		)`,
		`CREATE INDEX projects_owner_id_idx ON projects(owner_id)`,
		`CREATE INDEX events_project_id_idx ON events(project_id)`,
		`INSERT INTO users (id, email, name, role, active, created_at) VALUES
			(1, 'alice@example.test', 'Alice Park', 'admin', 1, '2026-01-15T09:00:00Z'),
			(2, 'ben@example.test', 'Ben Ortiz', 'member', 1, '2026-02-02T14:30:00Z'),
			(3, 'casey@example.test', 'Casey Morgan', 'viewer', 0, '2026-03-19T18:45:00Z')`,
		`INSERT INTO projects (id, name, status, owner_id, created_at) VALUES
			(1, 'Atlas', 'active', 1, '2026-04-01T10:00:00Z'),
			(2, 'Beacon', 'paused', 2, '2026-04-12T16:20:00Z')`,
		`INSERT INTO events (id, project_id, kind, payload, occurred_at) VALUES
			(1, 1, 'created', '{"source":"fixture"}', '2026-04-01T10:00:00Z'),
			(2, 1, 'updated', '{"field":"status"}', '2026-04-08T11:15:00Z'),
			(3, 2, 'created', NULL, '2026-04-12T16:20:00Z')`,
	}
	for _, statement := range statements {
		if _, err := transaction.Exec(statement); err != nil {
			return fmt.Errorf("build fixture: %w", err)
		}
	}
	if err := transaction.Commit(); err != nil {
		return fmt.Errorf("commit fixture: %w", err)
	}
	return nil
}
