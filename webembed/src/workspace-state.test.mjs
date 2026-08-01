import assert from "node:assert/strict";
import test from "node:test";

import { normalizeWorkspace, WORKSPACE_VERSION } from "./workspace-state.mjs";

test("migrates a version-one workspace and applies bounded defaults", () => {
  const value = normalizeWorkspace(JSON.stringify({
    version: 1,
    query_tabs: [{ id: "one", name: "Investigation", sql: "SELECT 1", password: "must-not-survive" }],
    active_query_tab_id: "one",
    settings: { rowLimit: 250 },
  }));
  assert.equal(value.version, WORKSPACE_VERSION);
  assert.deepEqual(value.settings, { rowLimit: 250, statementTimeout: 15 });
  assert.equal(value.query_tabs[0].sql, "SELECT 1");
  assert.equal("password" in value.query_tabs[0], false);
});

test("rejects corrupt and unsupported workspace data safely", () => {
  assert.equal(normalizeWorkspace("{broken"), null);
  assert.equal(normalizeWorkspace({ version: 99, query_tabs: [] }), null);
  assert.equal(normalizeWorkspace(null), null);
});

test("bounds workspace collections and preferences", () => {
  const value = normalizeWorkspace({
    version: 2,
    query_tabs: Array.from({ length: 30 }, (_, index) => ({ id: `tab-${index}`, sql: "SELECT 1" })),
    query_history: Array.from({ length: 130 }, (_, index) => ({ id: index })),
    settings: { rowLimit: 5000, statementTimeout: 60 },
  });
  assert.equal(value.query_tabs.length, 20);
  assert.equal(value.query_history.length, 100);
  assert.deepEqual(value.settings, { rowLimit: 100, statementTimeout: 15 });
});
