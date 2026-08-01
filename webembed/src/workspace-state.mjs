export const WORKSPACE_VERSION = 2;

export function normalizeWorkspace(raw) {
  let parsed;
  try {
    parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch (_) {
    return null;
  }
  if (!parsed || ![1, WORKSPACE_VERSION].includes(parsed.version)) return null;

  const queryTabs = Array.isArray(parsed.query_tabs) ? parsed.query_tabs.slice(0, 20).map((tab, index) => ({
    id: String(tab?.id || `query-${index + 1}`),
    name: String(tab?.name || `Query ${index + 1}`).slice(0, 80),
    sql: String(tab?.sql || "").slice(0, 1_000_000),
    connection_scope: String(tab?.connection_scope || "").slice(0, 500),
  })) : [];
  const rowLimit = [50, 100, 250, 500, 1000].includes(Number(parsed.settings?.rowLimit))
    ? Number(parsed.settings.rowLimit)
    : 100;
  const statementTimeout = [5, 10, 15].includes(Number(parsed.settings?.statementTimeout))
    ? Number(parsed.settings.statementTimeout)
    : 15;

  return {
    version: WORKSPACE_VERSION,
    query_tabs: queryTabs,
    active_query_tab_id: queryTabs.some(tab => tab.id === parsed.active_query_tab_id)
      ? String(parsed.active_query_tab_id)
      : queryTabs[0]?.id || "",
    query_history: Array.isArray(parsed.query_history) ? parsed.query_history.slice(0, 100) : [],
    saved_queries: Array.isArray(parsed.saved_queries) ? parsed.saved_queries.slice(0, 100) : [],
    recent_objects: Array.isArray(parsed.recent_objects) ? parsed.recent_objects.slice(0, 50) : [],
    pinned_objects: Array.isArray(parsed.pinned_objects) ? parsed.pinned_objects.slice(0, 50) : [],
    schema_snapshots: Array.isArray(parsed.schema_snapshots) ? parsed.schema_snapshots.slice(0, 10) : [],
    settings: { rowLimit, statementTimeout },
  };
}
