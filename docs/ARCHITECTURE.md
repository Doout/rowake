# Architecture

```text
cmd/rowake/          CLI and browser/server launch
desktop-wails/       Native Wails shell
internal/app/        Product-facing data contracts
internal/service/    Session connections and SQLite viewer adapter
internal/db/         database/sql boundary and driver registration
internal/launch/     Shared loopback server lifecycle
internal/server/     HTTP API and embedded web serving
webembed/dist/       Dependency-free browser interface
```

The CLI and Wails app start the same loopback HTTP server. The Wails WebView navigates to that local origin, so desktop and browser modes use one interface and API.

## Service boundary

`internal/app.Service` defines connection creation, catalogs, database topology, table snapshots, and query results. `internal/service` keeps live connections in memory and implements read-only SQLite catalog, foreign-key introspection, table, index, and query operations.

The Wails shell supplies a user-configuration path to `internal/launch`. Connection definitions are written atomically with user-only file permissions and restored when the desktop app starts. Browser and server launches do not supply a store and remain session-only.

SQLite files are opened with `mode=ro`, one pooled connection, bounded row limits, and a query timeout. The statement guard accepts only a single read-oriented statement.

`GET /api/v1/topology` returns real tables, columns, primary keys, and foreign-key relationships for the selected connection. The browser lays those facts out as an interactive three-column schema map. Search, filters, and sorting in the data browser operate on the bounded table snapshot; they do not issue unbounded queries.

## Build invariant

A normal `go build ./cmd/rowake` registers:

```text
mysql
postgres
sqlite
```

Tests, driver checks, container checks, and release builds enforce this set.

## Current limits

- No persistence in browser or server mode.
- Desktop persistence currently stores SQLite names and local file paths only.
- No PostgreSQL or MySQL/MariaDB catalog adapters.
- No row or schema mutation in the current implementation. Table capabilities keep that boundary explicit for planned row editing.
- No multi-user authentication.

Read-only database credentials remain the primary safety boundary.

## Test fixture

`cmd/rowake-testdb` creates `testdata/rowake-test.sqlite` from a deterministic schema and fixed records. Service, API, and smoke tests use this file for the complete SQLite workflow.

## Container

The final image contains the static Rowake executable, CA roots, and time-zone data. It runs as numeric non-root user `65532` and writes only to `/data`.
