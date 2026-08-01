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

`internal/app.Service` defines database discovery, connection lifecycle, catalogs, database topology, paged table reads, query results, explain plans, and schema snapshots. `internal/service` keeps live pools in memory and implements the read-only SQLite and PostgreSQL adapters.

The Wails shell supplies a user-configuration path to `internal/launch`. SQLite definitions and non-secret PostgreSQL profile fields are written atomically with user-only file permissions and restored when the desktop app starts. Plaintext passwords and credential-bearing DSNs are stripped during migration. PostgreSQL profiles may refer to an environment variable, macOS Keychain item, or Linux Secret Service item. Browser and server launches do not supply a connection store and remain session-only.

SQLite files are opened with `mode=ro`, one pooled connection, bounded row/byte limits, and a configurable timeout capped at 15 seconds. The statement guard accepts only a single read-oriented statement.

PostgreSQL accepts structured host, port, username, password, database, and SSL-mode settings or a DSN through the API. Before a connection is added, the service can query `pg_database` for databases the account may connect to. Connected pools force `default_transaction_read_only=on`, run user SQL in an explicit read-only transaction, set a statement timeout, hide credentials from connection responses, and expose only non-system schemas.

`POST /api/v1/table/page` validates identifiers against live metadata, binds every filter value, applies stable ordering, avoids exact counts, and returns opaque previous/next cursors plus capture and truncation metadata. `GET /api/v1/topology` returns tables, columns, indexes, primary keys, and grouped foreign-key constraints. Related-record navigation converts those constraints into bounded parameterized page requests.

The browser stores a versioned investigation workspace in local storage: named query tabs, unsaved SQL, connection-scoped history, saved queries, recent/pinned objects, schema snapshots, and bounded row/time preferences. It never stores connection requests or passwords.

Explain is opt-in. SQLite uses `EXPLAIN QUERY PLAN`; PostgreSQL uses JSON `EXPLAIN` with `ANALYZE FALSE` inside a read-only transaction. Schema snapshots contain topology only, never row data or credentials, and are diffed client-side into deterministic JSON or Markdown.

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
- Desktop persistence stores non-secret connection profiles; password material must be supplied directly for the process or resolved through a named secret reference.
- No MySQL/MariaDB catalog adapter.
- No row or schema mutation in the current implementation. Table capabilities keep that boundary explicit for planned row editing.
- Server mode provides a shared access-token boundary, not user accounts or per-user authorization.

Read-only database credentials remain the primary safety boundary.

See [Security](SECURITY.md) for the deployment threat model.

## Test fixture

`cmd/rowake-testdb` creates `testdata/rowake-test.sqlite` from a deterministic schema and fixed records. Service, API, and smoke tests use this file for the complete SQLite workflow.

## Container

The final image contains the static Rowake executable, CA roots, and time-zone data. It runs as numeric non-root user `65532` and writes only to `/data`.
