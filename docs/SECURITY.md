# Security model

Rowake is a personal, read-only investigation tool. The safest deployment is the desktop app or a loopback browser process on a trusted workstation. Database credentials should be restricted by the database itself to the intended databases, schemas, and read operations; Rowake's statement checks are defense in depth.

## Access boundary

Loopback serving is trusted to the local user. Listening on a non-loopback address requires `--access-token` or `ROWAKE_ACCESS_TOKEN`. A correct token can be supplied once in the URL; Rowake removes it immediately and creates an HTTP-only, same-site cookie. The health endpoint remains unauthenticated for probes. Use TLS at a trusted reverse proxy because the built-in server does not terminate TLS, and treat one token as one shared trust domain rather than multi-user authentication.

## Secrets and persistence

Connection-store files are written atomically with user-only permissions. SQLite paths and non-secret PostgreSQL fields may be saved. Plaintext passwords and passwords embedded in legacy DSNs are stripped during migration. A PostgreSQL profile may name an environment variable or an OS secret service/account pair; only those references are stored. Passwords can still appear in process memory while a pool is connected.

The browser workspace is separate from connection profiles. It stores query text, history, saved queries, object shortcuts, schema-only snapshots, and bounded execution preferences in local storage. It does not receive or persist connection passwords.

## Remaining risks

- A read-only query can still consume database resources until its row, byte, or 15-second execution bound is reached.
- Query text and returned data are visible to anyone who can access the workstation profile or authenticated browser session.
- Schema metadata can reveal sensitive names even though snapshots contain no row data.
- OS-level compromise, browser extensions, reverse-proxy misconfiguration, or an over-privileged database account are outside Rowake's protection boundary.
