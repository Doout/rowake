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
./bin/rowake serve --listen 0.0.0.0:8080 --access-token 'replace-with-a-long-random-token'
```

Non-loopback server mode requires an access token. Open the server once with

```text
http://server:8080/?token=replace-with-a-long-random-token
```

to establish an HTTP-only browser session; Rowake immediately removes the token from the URL. The `ROWAKE_ACCESS_TOKEN` environment variable is equivalent to `--access-token`.

Open **Connections** to add, test, edit, disconnect, reconnect, or remove a profile. PostgreSQL can load the databases available to the supplied account. Browse tables with bounded server-side filters, sorting, and pagination; follow parent/child records; inspect schema topology; save investigation tabs; run read-only SQL; or request a non-analyzing explain plan.

The Wails desktop app saves SQLite definitions and non-secret PostgreSQL profile fields. PostgreSQL passwords are never persisted by Rowake. A profile can instead name an environment variable or an OS secret item (macOS Keychain or Linux Secret Service). Use a database account restricted to the intended databases and schemas.

For Compose, place SQLite files in `./data`; they are available to Rowake under `/data`:

```sh
mkdir -p data
export ROWAKE_ACCESS_TOKEN='replace-with-a-long-random-token'
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
- [Security](docs/SECURITY.md)
- [Database drivers](docs/DRIVERS.md)
- [Releases](docs/RELEASING.md)
- [Product scope](PRODUCT.md)

No Rowake software license has been selected.
