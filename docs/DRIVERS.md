# Universal driver policy

## One Rowake edition

Every normal local build, GitHub release archive, and official container image includes all supported engines:

| Engine | Go package | Version | `database/sql` name | Runtime policy |
|---|---|---:|---|---|
| SQLite | `github.com/ncruces/go-sqlite3/driver` | `v0.35.2` | `sqlite3` | CGO-free, WebAssembly-backed SQLite |
| PostgreSQL | `github.com/jackc/pgx/v5/stdlib` | `v5.10.0` | `pgx` | Pure-Go PostgreSQL adapter |
| MySQL / MariaDB | `github.com/go-sql-driver/mysql` | `v1.10.0` | `mysql` | Pure-Go MySQL protocol driver |

The imports live in `internal/db/drivers.go` with no build tags. Official and ordinary builds therefore always include all three engines.

Users select an archive only by operating system and CPU architecture. They never select a database-specific download.

Driver registration and product adapters are separate concerns. The current UI and service adapter support SQLite. PostgreSQL and MySQL/MariaDB are registered and build-verified, with their connection and catalog adapters planned for later.

## Why this is the default

Rowake is meant to be downloaded or self-hosted and then pointed at a database. Driver variants would complicate installation, support, documentation, containers, and troubleshooting. The extra binary size is a better tradeoff than fragmented editions.

## Why Go remains a good fit

`database/sql` provides one lifecycle contract for pooling, context cancellation, scanning, and connection management. All selected drivers can be built without CGO, so a Linux GitHub runner can cross-compile the same source for Linux, macOS, and Windows on amd64 and arm64.

Engine-specific behavior remains in small Rowake adapters rather than an ORM. Those adapters should own catalog introspection, identifier quoting, type normalization, read-only session setup, statement timeouts, and capability reporting.

## What GitHub proves

1. The registry and `database/sql` both contain `mysql`, `pgx`, and `sqlite3`.
2. SQLite creates, writes, and reads an in-memory database.
3. PostgreSQL and MySQL connect to live service containers and execute `SELECT 1`.
4. The source cross-compiles for all six release targets with `CGO_ENABLED=0`.
5. The container builds and reports all three engines from inside the final image.
6. A tag release produces six archives, checksums, and a manifest declaring the universal driver set.

## Safety boundary

The SQL statement guard is defense in depth, not an authorization boundary. Production connections should use database credentials restricted to read-only access and only the intended schemas.
