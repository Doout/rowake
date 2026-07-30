# Third-party notices

Rowake's universal binary directly includes these database drivers:

- `github.com/ncruces/go-sqlite3` v0.35.2 — MIT License
- `github.com/jackc/pgx/v5` v5.10.0 — MIT License
- `github.com/go-sql-driver/mysql` v1.10.0 — Mozilla Public License 2.0

The Go module graph also includes transitive dependencies selected by those modules. `go version -m rowake` and `go list -m all` can be used to inspect the exact graph of a built release.

The upstream source and license text for each module are available from its repository and from the Go module proxy. Rowake does not modify the driver source code.
