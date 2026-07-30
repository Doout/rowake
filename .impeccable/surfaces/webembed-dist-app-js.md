---
version: 1
slug: "webembed-dist-app-js"
primary_target: "webembed/dist/app.js"
related_targets: ["webembed/dist/styles.css"]
---

Mode: Operate.

Audience: Developers and operators choosing and inspecting a database during development or incident work.

Primary task: Start by choosing a saved database. Adding a new database begins with a connection-string/type chooser, then moves to a dedicated PostgreSQL or SQLite setup screen before connecting and inspecting data.

Evidence: Show only live connection and catalog facts from SQLite or PostgreSQL: database identity, endpoint, access mode, schemas, tables, columns, keys, and bounded row snapshots.

Direction: Make launch a calm connection decision inside Rowake's restrained dark instrument world. Saved databases use one flat list with explicit Connect actions. The add journey separates database selection from configuration: a connection string can auto-detect PostgreSQL, while direct PostgreSQL and SQLite choices open dedicated setup screens. PostgreSQL keeps Connection name above General and SSH / SSL tabs, with a URI synchronized to its structured connection fields.

Constraints: Database access is read-only by default; PostgreSQL credentials remain in memory; URL parsing accepts postgres and postgresql schemes; SSL mode remains functional; the SSH tunnel form is visibly disabled until Jump Server support exists; compact layouts preserve identity and action.

Unresolved: Actual Jump Server connection behavior, SSH authentication and key handling, plus persistence, editing, and removal of non-SQLite connection profiles.
