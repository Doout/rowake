# Rowake

Rowake is a read-only relational database viewer for the browser and desktop. It supports SQLite database files and PostgreSQL servers.

## Run

Open Rowake in the browser:

```sh
make run
```

Build and open the Wails desktop app:

```sh
make desktop
```

Run as a server:

```sh
make build
./bin/rowake serve --listen 0.0.0.0:8080
```

Open **Connections** to choose a saved database. Adding one starts with a connection-string/type chooser, then opens a dedicated SQLite or PostgreSQL setup screen. PostgreSQL connections can load the databases available to the supplied account before you select one. Browse tables across schemas, filter or sort the loaded row preview, inspect relationship topology, or run a read-only query.

The Wails desktop app saves and restores SQLite file connections. PostgreSQL credentials are never persisted by Rowake; PostgreSQL connections and all browser/server connections stay in memory until Rowake closes. Use a database account restricted to the intended databases and schemas.

For Compose, place SQLite files in `./data`; they are available to Rowake under `/data`:

```sh
mkdir -p data
docker compose up --build
```

When Rowake runs on the host, connect to a published PostgreSQL container through its host port, commonly `127.0.0.1:5432`. When Rowake and PostgreSQL share a Compose network, use the PostgreSQL service name as the host.

## Test database

The deterministic test database is committed at `testdata/rowake-test.sqlite`. Rebuild it after changing the fixture schema or records:

```sh
make test-db
```

Use its absolute path in the connection form when testing the UI. The fixture contains related `users`, `projects`, and `events` tables so the same database covers row, structure, index, query, and topology testing.

## Verify

```sh
make check
make race
make smoke
make cross-build
make vuln
```

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Database drivers](docs/DRIVERS.md)
- [Releases](docs/RELEASING.md)
- [Product scope](PRODUCT.md)

No Rowake software license has been selected.
