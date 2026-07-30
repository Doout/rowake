# Architecture

```text
cmd/rowake/          CLI and browser/server launch
desktop-wails/       Native Wails shell
internal/app/        Product-facing data contracts
internal/service/    Session connections and database-specific viewer adapters
internal/db/         database/sql boundary and driver registration
internal/launch/     Shared loopback server lifecycle
internal/server/     HTTP API and embedded web serving
webembed/src/        Browser interface source and SQL editor integration
webembed/dist/       Prebuilt, dependency-free browser assets embedded by Go
```

The CLI and Wails app start the same loopback HTTP server. The Wails WebView navigates to that local origin, so desktop and browser modes use one interface and API.

The browser interface uses CodeMirror's SQL package for dialect-aware editing and schema completion. `npm run build:web` bundles it into `webembed/dist/app.js`; normal Go and release builds consume the committed bundle and do not need Node.js or a CDN.

## Service boundary

`internal/app.Service` defines database discovery, connection creation, catalogs, database topology, table snapshots, and query results. `internal/service` keeps live connections in memory and implements read-only SQLite and PostgreSQL catalog, foreign-key introspection, table, index, and query operations.

The Wails shell supplies a user-configuration path to `internal/launch`. SQLite connection definitions are written atomically with user-only file permissions and restored when the desktop app starts. PostgreSQL credentials are never written to that store. Browser and server launches do not supply a store and remain session-only.

SQLite files are opened with `mode=ro`, one pooled connection, bounded row limits, and a query timeout. The statement guard accepts only a single read-oriented statement.

PostgreSQL accepts structured host, port, username, password, database, and SSL-mode settings or a DSN through the API. Before a connection is added, the service can query `pg_database` for databases the account may connect to. Connected pools force `default_transaction_read_only=on`, run user SQL in an explicit read-only transaction, set a statement timeout, hide credentials from connection responses, and expose only non-system schemas.

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
- Desktop persistence stores SQLite names and local file paths only.
- No MySQL/MariaDB catalog adapter.
- No row or schema mutation in the current implementation. Table capabilities keep that boundary explicit for planned row editing.
- No multi-user authentication.

Read-only database credentials remain the primary safety boundary.

## Test fixture

`cmd/rowake-testdb` creates `testdata/rowake-test.sqlite` from a deterministic schema and fixed records. Service, API, and smoke tests use this file for the complete SQLite workflow.

## Container

The final image contains the static Rowake executable, CA roots, and time-zone data. It runs as numeric non-root user `65532` and writes only to `/data`.
