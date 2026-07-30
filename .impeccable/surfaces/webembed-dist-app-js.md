---
version: 1
slug: "webembed-dist-app-js"
primary_target: "webembed/dist/app.js"
related_targets: ["webembed/dist/styles.css"]
---

Mode: Operate.

Audience: Developers and operators inspecting a database during development or incident work.

Primary task: Find a table, narrow its loaded rows, understand its relationships, and move directly between the schema map and row browser.

Evidence: Render only live SQLite catalog facts: tables, columns, primary keys, foreign keys, and bounded row snapshots.

Direction: Keep Rowake's dark instrument shell and dense evidence surfaces. Use a spreadsheet-like table hierarchy for rows and a three-column relationship canvas for topology.

Constraints: The current implementation is read-only, all controls must be real, write actions remain capability-gated for future work, and small screens may stack the topology while preserving every table.
