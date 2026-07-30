# Rowake

Rowake is a relational database viewer for the browser and desktop. It currently opens SQLite database files in read-only mode.

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

Open **Connections**, add the path to an existing SQLite file, then browse its tables, filter or sort the loaded row preview, inspect its relationship topology, or run a read-only query. The Wails desktop app saves and restores connections. Browser and server modes keep them in memory until Rowake closes.

For Compose, place SQLite files in `./data`; they are available to Rowake under `/data`:

```sh
mkdir -p data
docker compose up --build
```

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
