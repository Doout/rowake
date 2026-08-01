/*
THESIS: Opening Rowake begins with a database decision, not a management table or an already-selected session.
OWN-WORLD: A restrained dark instrument surface, one blue action color, flat connection rows, and precise status signals.
STORY: Choose a known database, or add one through a focused connection-string/type chooser followed by a dedicated setup screen.
FIRST VIEWPORT: A quiet Rowake bar, one clear “Choose a database” heading, saved connections as the dominant list, and Add database beside it.
FORM: Adding a database is a two-step journey; PostgreSQL setup uses General and SSH / SSL tabs, with a live URL composer and an honest tunnel-settings shell.
*/
import { basicSetup } from "codemirror";
import { acceptCompletion, completionStatus, startCompletion } from "@codemirror/autocomplete";
import { indentWithTab } from "@codemirror/commands";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { Compartment, Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { MySQL, PostgreSQL, SQLite, sql } from "@codemirror/lang-sql";
import { tags } from "@lezer/highlight";
import { formatDatabaseValue, rawDatabaseValue } from "./value-formatters.mjs";
import { normalizeWorkspace, WORKSPACE_VERSION } from "./workspace-state.mjs";

(() => {
  "use strict";

  const app = document.getElementById("app");
  const toastRoot = document.getElementById("toast-root");
  const cellValuePreview = document.getElementById("cell-value-preview");
  const cspNonce = document.querySelector('meta[name="csp-nonce"]')?.content || "";
  const queryLanguage = new Compartment();
  let queryEditorView = null;
  let workspacePersistTimer = 0;
  let tableRequestController = null;
  let pendingValueFormats = [];
  let valueFormatFrame = 0;
  let valueFormatIdle = 0;
  let valueFormatIdleKind = "";
  let valueFormatGeneration = 0;
  let valueFormatSerial = 0;
  const valueFormatBudgetMS = 4;
  let cellPreviewTarget = null;
  let cellPreviewTimer = 0;
  const cellRawValues = new WeakMap();
  const columnCompletionSection = { name: "Columns", rank: 0 };
  const tableCompletionSection = { name: "Tables", rank: 1 };
  const keywordCompletionSection = { name: "Keywords", rank: 2 };

  const state = {
    meta: null,
    connections: [],
    connectionID: "",
    catalog: null,
    catalogCache: new Map(),
    selected: { schema: "", table: "" },
    snapshot: null,
    selectedRow: 0,
    selectedColumn: 0,
    inspectorOpen: false,
    sidebarCollapsed: window.matchMedia("(max-width: 980px)").matches,
    tableTab: "data",
    tableSearch: "",
    tableFilters: [],
    tableSort: null,
    tableCursor: "",
    dataControl: "",
    filterSerial: 0,
    catalogSearch: "",
    topology: null,
    topologyCache: new Map(),
    topologyLoading: false,
    topologyError: "",
    topologyZoom: 1,
    topologyExpanded: new Set(),
    topologyObserver: null,
    topologyDrawFrame: 0,
    route: "browse",
    loading: true,
    tableLoading: false,
    querySQL: "",
    queryResult: null,
    queryError: "",
    queryRunning: false,
    explainResult: null,
    explainRunning: false,
    queryResultMode: "results",
    queryTabs: [{ id: "query-1", name: "scratch.sql", sql: "", connection_scope: "" }],
    activeQueryTabID: "query-1",
    queryHistory: [],
    savedQueries: [],
    recentObjects: [],
    pinnedObjects: [],
    workspacePanel: "",
    schemaSnapshots: [],
    schemaDiff: null,
    relatedNavigation: [],
    connectionFormOpen: false,
    connectionAddStep: "choose",
    connectionEngine: "sqlite",
    connectionEntryURL: "",
    connectionEntryError: "",
    connectionEntryTimer: 0,
    connectionDraft: {
      name: "",
      data_source_name: "",
      connection_url: "",
      host: "127.0.0.1",
      port: "5432",
      username: "",
      password: "",
      password_env: "",
      secret_service: "",
      secret_account: "",
      database: "",
      ssl_mode: "disable",
    },
    postgresDatabases: [],
    postgresDiscoveryLoading: false,
    postgresDiscoveryError: "",
    postgresFormTab: "general",
    postgresURLTimer: 0,
    connectingID: "",
    editingConnectionID: "",
    testingConnection: false,
    settings: { rowLimit: 100, statementTimeout: 15 },
  };

  const workspaceStorageKey = "rowake.workspace.v1";

  function connectionScope(connection = currentConnection()) {
    if (!connection) return "";
    return [connection.engine, connection.address, connection.database].join(":");
  }

  function activeQueryTab() {
    let tab = state.queryTabs.find(item => item.id === state.activeQueryTabID);
    if (!tab) {
      tab = state.queryTabs[0] || { id: `query-${Date.now()}`, name: "scratch.sql", sql: "", connection_scope: "" };
      if (!state.queryTabs.length) state.queryTabs = [tab];
      state.activeQueryTabID = tab.id;
    }
    return tab;
  }

  function syncActiveQuery(value = state.querySQL) {
    const tab = activeQueryTab();
    tab.sql = String(value || "").slice(0, 1_000_000);
    tab.connection_scope = tab.connection_scope || connectionScope();
    state.querySQL = tab.sql;
  }

  function loadWorkspace() {
    try {
      const raw = localStorage.getItem(workspaceStorageKey);
      const parsed = normalizeWorkspace(raw);
      if (!parsed) {
        if (raw) localStorage.removeItem(workspaceStorageKey);
        return;
      }
      const tabs = parsed.query_tabs;
      if (tabs.length) state.queryTabs = tabs;
      state.activeQueryTabID = tabs.some(tab => tab.id === parsed.active_query_tab_id)
        ? parsed.active_query_tab_id
        : state.queryTabs[0].id;
      state.queryHistory = parsed.query_history;
      state.savedQueries = parsed.saved_queries;
      state.recentObjects = parsed.recent_objects;
      state.pinnedObjects = parsed.pinned_objects;
      state.schemaSnapshots = parsed.schema_snapshots;
      state.settings = parsed.settings;
      state.querySQL = activeQueryTab().sql;
    } catch (_) {
      localStorage.removeItem(workspaceStorageKey);
    }
  }

  function persistWorkspace() {
    clearTimeout(workspacePersistTimer);
    workspacePersistTimer = window.setTimeout(() => {
      try {
        syncActiveQuery();
        localStorage.setItem(workspaceStorageKey, JSON.stringify({
          version: WORKSPACE_VERSION,
          query_tabs: state.queryTabs,
          active_query_tab_id: state.activeQueryTabID,
          query_history: state.queryHistory,
          saved_queries: state.savedQueries,
          recent_objects: state.recentObjects,
          pinned_objects: state.pinnedObjects,
          schema_snapshots: state.schemaSnapshots,
          settings: state.settings,
        }));
      } catch (_) {
        // The active session remains usable if private mode or storage quotas reject persistence.
      }
    }, 120);
  }

  loadWorkspace();

  const queryHighlighting = syntaxHighlighting(HighlightStyle.define([
    { tag: tags.keyword, color: "#c8b4e5", fontWeight: "620" },
    { tag: [tags.typeName, tags.className], color: "#9bc7f2" },
    { tag: [tags.propertyName, tags.attributeName], color: "#a9d2fb" },
    { tag: [tags.string, tags.special(tags.string)], color: "#9ed8ba" },
    { tag: [tags.number, tags.bool, tags.null], color: "#dfc483" },
    { tag: tags.comment, color: "#65717d", fontStyle: "italic" },
    { tag: [tags.operator, tags.punctuation], color: "#8c98a4" },
    { tag: tags.name, color: "#dce3ea" },
  ]));

  const queryEditorTheme = EditorView.theme({
    "&": {
      height: "100%",
      backgroundColor: "#0d1115",
      color: "#dce3ea",
      fontSize: "12px",
    },
    "&.cm-focused": { outline: "none" },
    ".cm-scroller": {
      overflow: "auto",
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
      lineHeight: "1.7",
    },
    ".cm-content": {
      minHeight: "100%",
      padding: "15px 0",
      caretColor: "#86b9fb",
    },
    ".cm-line": { padding: "0 17px" },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "#86b9fb" },
    ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection": {
      backgroundColor: "#244365 !important",
    },
    ".cm-activeLine": { backgroundColor: "#111820" },
    ".cm-gutters": {
      minWidth: "44px",
      borderRight: "1px solid #202832",
      backgroundColor: "#0c1014",
      color: "#4f5a66",
    },
    ".cm-lineNumbers .cm-gutterElement": {
      minWidth: "43px",
      padding: "0 9px 0 6px",
      fontSize: "11px",
    },
    ".cm-activeLineGutter": {
      backgroundColor: "#121920",
      color: "#82909e",
    },
    ".cm-tooltip": {
      border: "1px solid #3b4857",
      borderRadius: "7px",
      backgroundColor: "#11171d",
      boxShadow: "0 14px 30px rgba(0, 0, 0, .42)",
      overflow: "hidden",
    },
    ".cm-tooltip-autocomplete > ul": {
      maxHeight: "278px",
      padding: "4px",
      fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
    },
    ".cm-tooltip-autocomplete completion-section": {
      padding: "7px 9px 4px",
      color: "#75818d",
      fontSize: "8px",
      fontWeight: "700",
      letterSpacing: ".08em",
      textTransform: "uppercase",
    },
    ".cm-tooltip-autocomplete > ul > li": {
      minHeight: "34px",
      margin: "1px 0",
      padding: "7px 9px",
      border: "1px solid transparent",
      borderRadius: "5px",
      color: "#bec7d0",
      display: "flex",
      alignItems: "center",
    },
    ".cm-tooltip-autocomplete > ul > li[aria-selected]": {
      borderColor: "#314967",
      backgroundColor: "#172438",
      color: "#edf4fc",
    },
    ".cm-completionIcon": {
      width: "18px",
      marginRight: "7px",
      color: "#8fbef0",
      fontSize: "12px",
    },
    ".cm-completionLabel": {
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
      fontSize: "10px",
      fontWeight: "620",
    },
    ".cm-completionDetail": {
      marginLeft: "auto",
      paddingLeft: "14px",
      color: "#75818d",
      fontSize: "8px",
      fontStyle: "normal",
    },
    ".cm-panels": {
      borderColor: "#29323c",
      backgroundColor: "#101419",
      color: "#c8d0d8",
    },
    ".cm-searchMatch": { backgroundColor: "#5a481f", outline: "1px solid #96712a" },
    ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "#735d29" },
  }, { dark: true });

  class APIError extends Error {}

  const html = value => String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

  function cancelValueFormatting() {
    valueFormatGeneration += 1;
    if (valueFormatFrame) cancelAnimationFrame(valueFormatFrame);
    if (valueFormatIdle) {
      if (valueFormatIdleKind === "idle") window.cancelIdleCallback(valueFormatIdle);
      else clearTimeout(valueFormatIdle);
    }
    valueFormatFrame = 0;
    valueFormatIdle = 0;
    valueFormatIdleKind = "";
  }

  function requestValueFormatChunk(callback) {
    if ("requestIdleCallback" in window) {
      valueFormatIdleKind = "idle";
      valueFormatIdle = window.requestIdleCallback(callback, { timeout: 50 });
      return;
    }
    valueFormatIdleKind = "timeout";
    valueFormatIdle = window.setTimeout(callback, 0);
  }

  function valueFormatClass(formatted, includeRawState = true) {
    const booleanState = formatted.kind === "boolean" ? ` ${formatted.display.toLowerCase()}` : "";
    const rawState = includeRawState && formatted.changed ? " has-raw" : "";
    return `formatted-value ${formatted.kind}-value${booleanState}${rawState}`;
  }

  function applyCellFormat(element, formatted) {
    element.className = `cell-value ${valueFormatClass(formatted)}`;
    element.textContent = formatted.display;
    element.dataset.previewKind = formatted.kind === "json" ? "json" : "text";
    cellRawValues.set(element, formatted.raw);
    if (formatted.changed) {
      element.setAttribute("aria-label", `${formatted.display}. Raw value: ${formatted.raw}`);
    } else {
      element.removeAttribute("aria-label");
    }
  }

  function applyInspectorFormat(element, formatted) {
    element.className = "inspector-value";
    element.innerHTML = inspectorFormatHTML(formatted);
  }

  function inspectorFormatHTML(formatted) {
    const display = formatted.kind === "json" && formatted.pretty
      ? `<pre>${html(formatted.pretty)}</pre>`
      : `<span class="${valueFormatClass(formatted, false)}">${html(formatted.display)}</span>`;
    const raw = formatted.rawDiffers
      ? `<details class="raw-value"><summary>Raw value</summary><code>${html(formatted.raw)}</code></details>`
      : "";
    return `${display}${raw}`;
  }

  function queueValueFormat(value, column, mode) {
    const raw = rawDatabaseValue(value);
    const id = `value-format-${++valueFormatSerial}`;
    pendingValueFormats.push({ id, value, column, raw, mode });
    return { id, raw };
  }

  function scheduleValueFormatting(jobs) {
    cancelValueFormatting();
    if (!jobs.length) return;
    const generation = valueFormatGeneration;
    let cursor = 0;
    const formatChunk = () => {
      valueFormatIdle = 0;
      valueFormatIdleKind = "";
      if (generation !== valueFormatGeneration) return;
      const started = performance.now();
      do {
        const job = jobs[cursor++];
        const element = document.getElementById(job.id);
        if (element) {
          try {
            const formatted = formatDatabaseValue(job.value, job.column, { raw: job.raw });
            if (job.mode === "inspector") applyInspectorFormat(element, formatted);
            else applyCellFormat(element, formatted);
          } catch (_) {
            element.classList.remove("value-format-pending");
          }
          element.removeAttribute("id");
        }
      } while (cursor < jobs.length && performance.now() - started < valueFormatBudgetMS);
      if (cursor < jobs.length) requestValueFormatChunk(formatChunk);
    };
    valueFormatFrame = requestAnimationFrame(() => {
      valueFormatFrame = 0;
      if (generation === valueFormatGeneration) requestValueFormatChunk(formatChunk);
    });
  }

  async function api(path, options = {}) {
    const headers = new Headers(options.headers || {});
    if (options.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    const response = await fetch(path, { credentials: "same-origin", ...options, headers });
    const type = response.headers.get("Content-Type") || "";
    const body = type.includes("application/json") ? await response.json() : await response.text();
    if (!response.ok) {
      const message = typeof body === "object" && body?.error ? body.error : String(body || response.statusText);
      throw new APIError(message);
    }
    return body;
  }

  function toast(message, kind = "") {
    const node = document.createElement("div");
    node.className = `toast ${kind}`.trim();
    node.innerHTML = `<span class="toast-signal"></span><span>${html(message)}</span>`;
    toastRoot.append(node);
    setTimeout(() => node.classList.add("leaving"), 3900);
    setTimeout(() => node.remove(), 4300);
  }

  function currentConnection() {
    return state.connections.find(connection => connection.id === state.connectionID) || null;
  }

  function engineLabel(engine) {
    return ({ sqlite: "SQLite", postgres: "PostgreSQL", mysql: "MySQL" })[engine] || engine;
  }

  function compactNumber(value) {
    const number = Number(value || 0);
    return new Intl.NumberFormat(undefined, {
      notation: number >= 10000 ? "compact" : "standard",
      maximumFractionDigits: 1,
    }).format(number);
  }

  function fullNumber(value) {
    return new Intl.NumberFormat().format(Number(value || 0));
  }

  function capturedLabel(value) {
    const date = new Date(value || "");
    if (Number.isNaN(date.getTime())) return "capture time unavailable";
    return `captured ${new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", second: "2-digit" }).format(date)}`;
  }

  function navigate(route) {
    const path = route.startsWith("/") ? route : `/${route}`;
    if (location.hash === `#${path}`) renderRoute();
    else location.hash = path;
  }

  function routeFromHash() {
    const route = location.hash.replace(/^#\/?/, "").split("?")[0];
    return ["browse", "topology", "query", "connections"].includes(route) ? route : "browse";
  }

  function navButton(name, symbol, label, active) {
    return `<button type="button" class="nav-button ${name === active ? "active" : ""}" data-nav="${name}" aria-label="${html(label)}" title="${html(label)}">
      <span class="nav-icon" aria-hidden="true">${symbol}</span><span class="nav-label">${html(label)}</span>
    </button>`;
  }

  function shell(content, active = "browse", options = {}) {
    if (queryEditorView) {
      state.querySQL = queryEditorView.state.doc.toString();
      syncActiveQuery(state.querySQL);
      persistWorkspace();
      queryEditorView.destroy();
      queryEditorView = null;
    }
    const valueFormats = pendingValueFormats;
    pendingValueFormats = [];
    const connection = currentConnection();
    const version = state.meta?.version ? `v${state.meta.version.replace(/-.*/, "")}` : "";
    app.className = `shell ${state.sidebarCollapsed ? "sidebar-collapsed" : ""} ${options.workspace ? "workspace-shell" : ""}`.trim();
    app.innerHTML = `
      <aside class="sidebar">
        <button type="button" class="brand" data-action="toggle-sidebar" aria-label="${state.sidebarCollapsed ? "Expand navigation" : "Collapse navigation"}" title="${state.sidebarCollapsed ? "Expand navigation" : "Collapse navigation"}">
          <img class="brand-mark" src="/icon.svg" alt="">
          <span>Rowake</span>
          <span class="sidebar-toggle-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none">
              <rect x="3" y="3" width="18" height="18" rx="2"></rect>
              <path d="M9 3v18"></path>
              <path d="m16 9-3 3 3 3"></path>
            </svg>
          </span>
        </button>
        <nav class="nav" aria-label="Primary">
          ${navButton("browse", "▦", "Browse", active)}
          ${navButton("topology", `<svg viewBox="0 0 20 20" fill="none"><rect x="2.5" y="2.5" width="5" height="4" rx="1"></rect><rect x="12.5" y="2.5" width="5" height="4" rx="1"></rect><rect x="7.5" y="13.5" width="5" height="4" rx="1"></rect><path d="M5 6.5v3h10v-3M10 9.5v4"></path></svg>`, "Topology", active)}
          ${navButton("query", "⌁", "Query", active)}
          ${navButton("connections", "↔", "Connections", active)}
        </nav>
        <div class="sidebar-tail">
          ${connection ? `<div class="sidebar-context">
            <span class="sidebar-context-label">Active connection</span>
            <button type="button" class="sidebar-connection" data-nav="connections" title="Open connections">
              <span class="engine-dot ${html(connection.engine)}"></span>
              <span><strong>${html(connection.name)}</strong><small>${html(engineLabel(connection.engine))} · ${connection.read_only ? "read-only" : "read/write"}</small></span>
            </button>
          </div>` : ""}
          <div class="sidebar-foot"><span>${html(version)}</span></div>
        </div>
      </aside>
      <main class="main">${content}</main>`;
    scheduleValueFormatting(valueFormats);
  }

  function launchShell(content) {
    pendingValueFormats = [];
    cancelValueFormatting();
    const connection = currentConnection();
    const version = state.meta?.version ? `v${state.meta.version.replace(/-.*/, "")}` : "";
    app.className = "connection-launch";
    app.innerHTML = `<main class="launch-main">
      <header class="launch-bar">
        <div class="launch-brand">
          <img src="/icon.svg" alt="">
          <strong>Rowake</strong>
          <span>Database browser</span>
        </div>
        <div class="launch-bar-actions">
          <span class="launch-readonly"><i></i>Read-only by default</span>
          ${connection ? `<button type="button" class="btn small" data-nav="browse">Back to ${html(connection.name)}</button>` : ""}
          <span class="launch-version">${html(version)}</span>
        </div>
      </header>
      ${content}
    </main>`;
  }

  async function bootstrap() {
    history.replaceState(null, "", "#/connections");
    launchShell(`<section class="connection-hub loading-hub">
      <div class="loading"><span class="loading-track"><i></i></span>Reading available databases…</div>
    </section>`);
    try {
      const [meta, response] = await Promise.all([
        api("/api/v1/meta"),
        api("/api/v1/connections"),
      ]);
      state.meta = meta;
      state.connections = response.connections || [];
      state.connectionID = "";
      state.loading = false;
      await renderRoute();
    } catch (error) {
      state.loading = false;
      launchShell(`<section class="connection-hub"><div class="notice error"><strong>Rowake could not start</strong><span>${html(error.message)}</span></div></section>`);
    }
  }

  async function loadCatalog(connectionID, selectDefault = false) {
    state.connectionID = connectionID;
    let catalog = state.catalogCache.get(connectionID);
    if (!catalog) {
      catalog = await api(`/api/v1/catalog?connection_id=${encodeURIComponent(connectionID)}`);
      state.catalogCache.set(connectionID, catalog);
    }
    state.catalog = catalog;
    const selectedExists = catalog.schemas.some(schema =>
      schema.name === state.selected.schema &&
      schema.tables.some(table => table.name === state.selected.table)
    );
    if (selectDefault || !selectedExists) {
      const firstSchema = catalog.schemas[0];
      const preferred = firstSchema?.tables[0];
      state.selected = {
        schema: preferred?.schema || firstSchema?.name || "",
        table: preferred?.name || "",
      };
      state.tableFilters = [];
      state.tableSort = null;
      state.tableCursor = "";
    }
    if (state.selected.table) await loadTable(false);
  }

  async function loadTable(render = true, cursor = state.tableCursor) {
    if (!state.connectionID || !state.selected.table) return;
    tableRequestController?.abort();
    tableRequestController = new AbortController();
    state.tableLoading = true;
    if (render && state.route === "browse") renderBrowse();
    try {
      state.snapshot = await api("/api/v1/table/page", {
        method: "POST",
        signal: tableRequestController.signal,
        body: JSON.stringify({
          connection_id: state.connectionID,
          schema: state.selected.schema,
          table: state.selected.table,
          limit: state.settings.rowLimit,
          timeout_seconds: state.settings.statementTimeout,
          cursor: cursor || "",
          filters: state.tableFilters.map(({ column, operator, value }) => ({ column, operator, value })),
          sort: state.tableSort,
        }),
      });
      state.tableCursor = cursor || "";
      state.selectedRow = 0;
      state.selectedColumn = 0;
      state.inspectorOpen = false;
      state.tableSearch = "";
      state.dataControl = "";
      rememberObject(state.selected.schema, state.selected.table);
    } catch (error) {
      if (error?.name !== "AbortError") {
        state.snapshot = null;
        toast(error.message, "error");
      }
    } finally {
      state.tableLoading = false;
      if (render && state.route === "browse") renderBrowse();
    }
  }

  function rememberObject(schema, table) {
    const item = { connection_scope: connectionScope(), schema, table, visited_at: new Date().toISOString() };
    const key = `${item.connection_scope}:${schema}.${table}`;
    state.recentObjects = [item, ...state.recentObjects.filter(candidate =>
      `${candidate.connection_scope}:${candidate.schema}.${candidate.table}` !== key
    )].slice(0, 50);
    persistWorkspace();
  }

  function objectKey(item) {
    return `${item.connection_scope}:${item.schema}.${item.table}`;
  }

  function isSelectedObjectPinned() {
    const key = objectKey({ connection_scope: connectionScope(), schema: state.selected.schema, table: state.selected.table });
    return state.pinnedObjects.some(item => objectKey(item) === key);
  }

  function toggleSelectedObjectPin() {
    const item = { connection_scope: connectionScope(), schema: state.selected.schema, table: state.selected.table, pinned_at: new Date().toISOString() };
    const key = objectKey(item);
    if (state.pinnedObjects.some(candidate => objectKey(candidate) === key)) {
      state.pinnedObjects = state.pinnedObjects.filter(candidate => objectKey(candidate) !== key);
      toast(`Unpinned ${item.table}`);
    } else {
      state.pinnedObjects = [item, ...state.pinnedObjects.filter(candidate => objectKey(candidate) !== key)].slice(0, 50);
      toast(`Pinned ${item.table}`);
    }
    persistWorkspace();
    renderBrowse();
  }

  function quoteIdentifier(value) {
    return `"${String(value).replaceAll('"', '""')}"`;
  }

  async function renderRoute() {
    state.route = routeFromHash();
    if (state.loading) return;
    if (state.route !== "topology" && state.topologyObserver) {
      state.topologyObserver.disconnect();
      state.topologyObserver = null;
    }
    switch (state.route) {
      case "query": renderQuery(); break;
      case "topology": renderTopology(); break;
      case "connections": renderConnections(); break;
      default: renderBrowse();
    }
  }

  function connectionPicker() {
    if (!state.connections.length) {
      return `<button type="button" class="btn" data-nav="connections">Connections</button>`;
    }
    const menuID = "connection-picker-menu";
    const optionsID = `${menuID}-options`;
    const connection = currentConnection();
    return `<div class="connection-picker compact">
      <span class="picker-signal engine-dot ${html(connection?.engine || "")}"></span>
      <button type="button" class="connection-menu-trigger" data-action="toggle-connection-picker" aria-label="Connection: ${html(connection?.name || "")}" title="${html(connection?.name || "")}" aria-haspopup="dialog" aria-controls="${menuID}" aria-expanded="false">
        <span data-connection-menu-label>${html(connection?.name || "")}</span><span class="connection-menu-chevron" aria-hidden="true"></span>
      </button>
      <div id="${menuID}" class="connection-menu" role="dialog" aria-label="Choose connection" hidden>
        <label class="connection-menu-search">
          <svg aria-hidden="true" viewBox="0 0 20 20"><circle cx="8.5" cy="8.5" r="5.5"></circle><path d="m12.6 12.6 4 4"></path></svg>
          <input type="search" role="combobox" aria-autocomplete="list" aria-controls="${optionsID}" aria-expanded="true" autocomplete="off" placeholder="Search connections…" aria-label="Search connections" data-connection-menu-search>
          <button type="button" class="connection-menu-search-clear" data-action="clear-connection-search" aria-label="Clear search" hidden>×</button>
        </label>
        <div class="connection-menu-results-meta" data-connection-menu-summary>${state.connections.length} option${state.connections.length === 1 ? "" : "s"}</div>
        <div id="${optionsID}" role="listbox" aria-label="Connection options" data-connection-menu-options>
          ${state.connections.map(item => {
            const selected = item.id === state.connectionID;
            const search = `${item.name} ${item.database || ""} ${engineLabel(item.engine)}`.toLowerCase();
            return `<button type="button" class="connection-menu-option ${selected ? "selected" : ""}" role="option" aria-selected="${selected}" data-action="select-connection-option" data-value="${html(item.id)}" data-search="${html(search)}" title="${html(item.name)}"><span><strong>${html(item.name)}</strong><small>${html(engineLabel(item.engine))} · ${html(item.database || item.address || "")}</small></span><span class="connection-menu-check" aria-hidden="true">✓</span></button>`;
          }).join("")}
        </div>
        <div class="connection-menu-empty" data-connection-menu-empty hidden>
          <span class="connection-menu-empty-icon" aria-hidden="true"><svg viewBox="0 0 20 20"><circle cx="8.5" cy="8.5" r="5.5"></circle><path d="m12.6 12.6 4 4"></path></svg></span>
          <strong>No connections found</strong>
          <span>Try another search.</span>
        </div>
      </div>
    </div>`;
  }

  function filterConnectionMenuOptions(field, query) {
    if (!field) return [];
    const needle = String(query || "").trim().toLowerCase();
    const visible = [];
    field.querySelectorAll(".connection-menu-option").forEach(option => {
      const matches = !needle || String(option.dataset.search || option.textContent || "").toLowerCase().includes(needle);
      option.hidden = !matches;
      if (matches) visible.push(option);
    });
    const empty = field.querySelector("[data-connection-menu-empty]");
    if (empty) empty.hidden = visible.length > 0;
    const summary = field.querySelector("[data-connection-menu-summary]");
    if (summary) {
      const total = field.querySelectorAll(".connection-menu-option").length;
      summary.textContent = needle
        ? `${visible.length} result${visible.length === 1 ? "" : "s"}`
        : `${total} option${total === 1 ? "" : "s"}`;
    }
    const clear = field.querySelector(".connection-menu-search-clear");
    if (clear) clear.hidden = !needle;
    return visible;
  }

  function focusConnectionMenuSearch(field, initialValue = "") {
    const search = field?.querySelector("[data-connection-menu-search]");
    if (!search) return;
    search.value = initialValue;
    filterConnectionMenuOptions(field, initialValue);
    requestAnimationFrame(() => {
      search.focus();
      search.setSelectionRange(search.value.length, search.value.length);
    });
  }

  function closeConnectionMenu(restoreFocus = false) {
    const field = document.querySelector(".connection-picker");
    const menu = field?.querySelector(".connection-menu");
    const trigger = field?.querySelector(".connection-menu-trigger");
    if (!field || !menu || menu.hidden) return;
    menu.hidden = true;
    field.classList.remove("opens-up");
    menu.style.transform = "";
    trigger?.setAttribute("aria-expanded", "false");
    if (restoreFocus) trigger?.focus();
  }

  function toggleConnectionMenu(field, forceOpen, focusSearch = false) {
    if (!field) return;
    const menu = field.querySelector(".connection-menu");
    const trigger = field.querySelector(".connection-menu-trigger");
    if (!menu || !trigger) return;
    const open = forceOpen ?? menu.hidden;
    closeConnectionMenu();
    if (!open) return;
    const bounds = field.getBoundingClientRect();
    const roomBelow = window.innerHeight - bounds.bottom;
    field.classList.toggle("opens-up", roomBelow < Math.min(360, window.innerHeight * .64) && bounds.top > roomBelow);
    menu.hidden = false;
    const menuBounds = menu.getBoundingClientRect();
    const horizontalShift = menuBounds.left < 12
      ? 12 - menuBounds.left
      : menuBounds.right > window.innerWidth - 12 ? window.innerWidth - 12 - menuBounds.right : 0;
    menu.style.transform = horizontalShift ? `translateX(${horizontalShift}px)` : "";
    trigger.setAttribute("aria-expanded", "true");
    if (focusSearch) focusConnectionMenuSearch(field);
  }

  function renderBrowse() {
    const connection = currentConnection();
    if (!connection) {
      shell(`<section class="workspace empty-workspace">
        <div class="empty-primary">
          <img src="/icon.svg" alt="">
          <h1>No connection</h1>
          <p>Add a SQLite or PostgreSQL database to inspect its tables and rows.</p>
          <button type="button" class="btn primary" data-nav="connections">Add database</button>
        </div>
      </section>`, "browse", { workspace: true });
      return;
    }
    const hasInspector = state.snapshot && state.tableTab === "data" && state.inspectorOpen;
    const body = `
      <section class="workspace browse-page">
        <header class="workspace-header">
          <div class="workspace-identity">
            <span class="eyebrow">Database browser</span>
            <div class="workspace-title-row">
              <h1 class="workspace-title">${html(connection?.database || "Browse")}</h1>
              ${connection ? `<span class="status ${connection.status === "connected" ? "good" : "neutral"}">${html(connection.status)}</span>` : ""}
            </div>
          </div>
          <div class="header-actions">
            ${connectionPicker()}
            <button type="button" class="btn" data-action="refresh-catalog">↻ <span>Refresh</span></button>
            <button type="button" class="btn primary" data-nav="query">Open query</button>
          </div>
        </header>
        <div class="command-strip">
          <div class="breadcrumb">
            <span>${html(engineLabel(connection?.engine || "database"))}</span><i>/</i>
            <span>${html(state.selected.schema || "schema")}</span><i>/</i>
            <strong>${html(state.selected.table || "table")}</strong>
          </div>
          <div class="command-signals">
            <span><i class="signal-dot"></i>${connection?.read_only ? "Read-only session" : "Writable session"}</span>
            <span>${html(connection?.address || "")}</span>
          </div>
        </div>
        ${mobileObjectPicker()}
        <div class="database-workbench ${hasInspector ? "has-inspector" : ""}">
          ${renderCatalogRail()}
          ${renderTableSurface()}
          ${hasInspector ? renderRowInspector() : ""}
        </div>
      </section>`;
    shell(body, "browse", { workspace: true });
    if ((!state.topology || state.topology.connection_id !== state.connectionID) && !state.topologyLoading) loadTopology();
  }

  function mobileObjectPicker() {
    const objects = (state.catalog?.schemas || []).flatMap((schema, schemaIndex) =>
      schema.tables.map((table, tableIndex) => ({ schema, table, value: `${schemaIndex}:${tableIndex}` }))
    );
    if (!objects.length) return "";
    return `<label class="mobile-object-picker"><span>Database object</span><select id="mobile-object-picker"><option value="">Choose a table or view</option>${objects.map(item => `<option value="${item.value}" ${item.table.schema === state.selected.schema && item.table.name === state.selected.table ? "selected" : ""}>${html(item.schema.name)}.${html(item.table.name)}</option>`).join("")}</select></label>`;
  }

  function renderCatalogRail() {
    const schemas = state.catalog?.schemas || [];
    const search = state.catalogSearch.toLowerCase().trim();
    const scope = connectionScope();
    const pinned = state.pinnedObjects.filter(item => item.connection_scope === scope);
    const recent = state.recentObjects.filter(item => item.connection_scope === scope && !pinned.some(pin => objectKey(pin) === objectKey(item))).slice(0, 5);
    const renderShortcut = (item, pinnedItem = false) => `<button type="button" class="catalog-item object-shortcut" data-action="select-table" data-schema="${html(item.schema)}" data-table="${html(item.table)}"><span class="object-icon">${pinnedItem ? "◆" : "◷"}</span><span class="object-name">${html(item.table)}</span><small>${html(item.schema)}</small></button>`;
    return `<aside class="catalog-rail" aria-label="Database objects">
      <div class="rail-header">
        <strong>Objects</strong>
      </div>
      <div class="rail-search"><span>⌕</span><input id="catalog-search" type="search" placeholder="Filter objects" value="${html(state.catalogSearch)}"></div>
      <div class="catalog-tree">
        ${!search && pinned.length ? `<section class="object-shortcuts"><header>Pinned</header>${pinned.map(item => renderShortcut(item, true)).join("")}</section>` : ""}
        ${!search && recent.length ? `<section class="object-shortcuts"><header>Recent</header>${recent.map(item => renderShortcut(item)).join("")}</section>` : ""}
        ${schemas.map(schema => {
          const tables = schema.tables.filter(table => !search || `${schema.name}.${table.name}`.toLowerCase().includes(search));
          if (search && !tables.length) return "";
          return `<details class="schema-group" open>
            <summary><span class="schema-chevron">›</span><span class="schema-icon">⌗</span><strong>${html(schema.name)}</strong><small>${tables.length}</small></summary>
            <div class="schema-tables">
              ${tables.map(table => {
                const active = table.schema === state.selected.schema && table.name === state.selected.table;
                return `<button type="button" class="catalog-item ${active ? "active" : ""}" data-action="select-table" data-schema="${html(table.schema)}" data-table="${html(table.name)}">
                  <span class="object-icon">${table.kind === "view" ? "◇" : "▤"}</span>
                  <span class="object-name">${html(table.name)}</span>
                </button>`;
              }).join("") || `<span class="catalog-empty">No matching objects</span>`}
            </div>
          </details>`;
        }).join("") || `<div class="catalog-zero">No database objects match “${html(state.catalogSearch)}”.</div>`}
      </div>
      <div class="rail-foot"><span>${schemas.reduce((total, schema) => total + schema.tables.length, 0)} objects</span><span>${schemas.length} schemas</span></div>
    </aside>`;
  }

  function renderTableSurface() {
    if (state.tableLoading) {
      return `<section class="evidence-surface"><div class="surface-loading"><span class="loading-track"><i></i></span><strong>Reading ${html(state.selected.schema)}.${html(state.selected.table)}</strong><small>Fetching a bounded preview</small></div></section>`;
    }
    if (!state.snapshot) {
      return `<section class="evidence-surface"><div class="empty-state"><span class="empty-glyph">▦</span><strong>Select a table</strong><p>Choose an object from the catalog to inspect its rows and structure.</p></div></section>`;
    }
    const snapshot = state.snapshot;
    const kind = state.catalog?.schemas
      .find(schema => schema.name === snapshot.schema)?.tables
      .find(table => table.name === snapshot.name)?.kind || "table";
    return `<section class="evidence-surface">
      <header class="surface-header">
        <div class="surface-title">
          <span class="object-kind">${html(kind.toUpperCase())}</span>
          <h2>${html(snapshot.name)}</h2>
          <span class="surface-schema">${html(snapshot.schema)}</span>
        </div>
        <div class="surface-actions">
          ${state.relatedNavigation.length ? `<button type="button" class="btn small" data-action="back-related">← Back</button>` : ""}
          <button type="button" class="btn small" data-action="copy-table-name">Copy name</button>
          <button type="button" class="btn small" data-action="toggle-object-pin">${isSelectedObjectPinned() ? "Unpin" : "Pin"}</button>
          <button type="button" class="btn small" data-action="query-table">Query</button>
          ${state.tableTab === "data" && snapshot.rows.length ? `<button type="button" class="icon-button inspector-toggle ${state.inspectorOpen ? "active" : ""}" data-action="toggle-inspector" aria-label="${state.inspectorOpen ? "Collapse selected row" : "Open selected row"}" title="${state.inspectorOpen ? "Collapse selected row" : "Open selected row"}" aria-expanded="${state.inspectorOpen}">
            <span class="panel-toggle-icon" aria-hidden="true"></span>
          </button>` : ""}
        </div>
      </header>
      <nav class="surface-tabs" aria-label="Table detail">
        ${tableTab("data", "Data", snapshot.total_rows ? compactNumber(snapshot.total_rows) : "")}
        ${tableTab("structure", "Structure", snapshot.columns.length)}
        ${tableTab("indexes", "Indexes", snapshot.indexes.length)}
      </nav>
      ${state.tableTab === "structure" ? renderStructure(snapshot) : state.tableTab === "indexes" ? renderIndexes(snapshot) : renderRows(snapshot)}
    </section>`;
  }

  function tableTab(name, label, count) {
    return `<button type="button" class="surface-tab ${state.tableTab === name ? "active" : ""}" data-action="select-table-tab" data-tab="${name}">
      <span>${label}</span>${count !== "" ? `<small>${html(count)}</small>` : ""}
    </button>`;
  }

  function filteredRows(snapshot) {
    const term = state.tableSearch.toLowerCase().trim();
    return snapshot.rows.map((row, index) => ({ row, index })).filter(({ row }) =>
      !term || row.some(value => String(value ?? "null").toLowerCase().includes(term))
    );
  }

  function valueMatchesFilter(value, filter) {
    const operator = filter.operator;
    if (operator === "is-null") return value === null || value === undefined;
    if (operator === "is-not-null") return value !== null && value !== undefined;
    if (value === null || value === undefined) return false;
    const actual = String(value ?? "");
    const expected = String(filter.value ?? "");
    const actualFolded = actual.toLocaleLowerCase();
    const expectedFolded = expected.toLocaleLowerCase();
    if (operator === "contains") return actualFolded.includes(expectedFolded);
    if (operator === "not-contains") return !actualFolded.includes(expectedFolded);
    if (operator === "starts-with") return actualFolded.startsWith(expectedFolded);
    if (operator === "ends-with") return actualFolded.endsWith(expectedFolded);
    if (operator === "equals") return actualFolded === expectedFolded;
    if (operator === "not-equals") return actualFolded !== expectedFolded;
    const actualNumber = Number(value);
    const expectedNumber = Number(expected);
    const comparison = Number.isFinite(actualNumber) && Number.isFinite(expectedNumber)
      ? actualNumber - expectedNumber
      : actual.localeCompare(expected, undefined, { numeric: true, sensitivity: "base" });
    if (operator === "greater") return comparison > 0;
    if (operator === "greater-equal") return comparison >= 0;
    if (operator === "less") return comparison < 0;
    if (operator === "less-equal") return comparison <= 0;
    return true;
  }

  function compareValues(left, right) {
    const leftNull = left === null || left === undefined;
    const rightNull = right === null || right === undefined;
    if (leftNull || rightNull) return leftNull === rightNull ? 0 : leftNull ? 1 : -1;
    if (typeof left === "number" && typeof right === "number") return left - right;
    return String(left).localeCompare(String(right), undefined, { numeric: true, sensitivity: "base" });
  }

  function filterOperatorLabel(operator) {
    return ({
      contains: "contains",
      "not-contains": "does not contain",
      equals: "equals",
      "not-equals": "does not equal",
      "starts-with": "starts with",
      "ends-with": "ends with",
      greater: "is greater than",
      "greater-equal": "is at least",
      less: "is less than",
      "less-equal": "is at most",
      "is-null": "is null",
      "is-not-null": "is not null",
    })[operator] || operator;
  }

  function renderDataControl(snapshot) {
    if (state.dataControl === "filter") {
      return `<section class="data-control-panel" aria-label="Loaded row filters">
        <form id="table-filter-form" class="filter-builder">
          <label><span>Column</span><select name="column" aria-label="Filter column">${snapshot.columns.map(column => `<option value="${html(column.name)}">${html(column.name)}</option>`).join("")}</select></label>
          <label><span>Condition</span><select name="operator" aria-label="Filter condition">
            <option value="contains">contains</option><option value="not-contains">does not contain</option>
            <option value="equals">equals</option><option value="not-equals">does not equal</option>
            <option value="starts-with">starts with</option><option value="ends-with">ends with</option>
            <option value="greater">is greater than</option><option value="greater-equal">is at least</option>
            <option value="less">is less than</option><option value="less-equal">is at most</option>
            <option value="is-null">is null</option><option value="is-not-null">is not null</option>
          </select></label>
          <label class="filter-value"><span>Value</span><input name="value" autocomplete="off" placeholder="Value"></label>
          <button type="submit" class="btn small primary">Add filter</button>
        </form>
        <div class="filter-list">
          ${state.tableFilters.map(filter => `<span class="filter-token"><strong>${html(filter.column)}</strong> ${html(filterOperatorLabel(filter.operator))}${!["is-null", "is-not-null"].includes(filter.operator) ? ` <code>${html(filter.value)}</code>` : ""}<button type="button" data-action="remove-table-filter" data-filter="${filter.id}" aria-label="Remove filter">×</button></span>`).join("") || `<span class="control-empty">No filters. Add one to narrow the loaded rows.</span>`}
          ${state.tableFilters.length ? `<button type="button" class="text-button" data-action="clear-table-filters">Clear all</button>` : ""}
        </div>
      </section>`;
    }
    if (state.dataControl === "sort") {
      return `<section class="data-control-panel" aria-label="Loaded row sort">
        <form id="table-sort-form" class="sort-builder">
          <label><span>Column</span><select name="column">${snapshot.columns.map(column => `<option value="${html(column.name)}" ${state.tableSort?.column === column.name ? "selected" : ""}>${html(column.name)}</option>`).join("")}</select></label>
          <label><span>Direction</span><select name="direction"><option value="asc" ${state.tableSort?.direction !== "desc" ? "selected" : ""}>Ascending</option><option value="desc" ${state.tableSort?.direction === "desc" ? "selected" : ""}>Descending</option></select></label>
          <button type="submit" class="btn small primary">Apply sort</button>
          ${state.tableSort ? `<button type="button" class="btn small" data-action="clear-table-sort">Clear</button>` : ""}
        </form>
      </section>`;
    }
    return "";
  }

  function renderRows(snapshot) {
    const rows = filteredRows(snapshot);
    const relatedByColumn = new Map();
    selectedRelationshipGroups().outgoing.forEach(group => group.relationships.forEach(relationship => {
      relatedByColumn.set(relationship.from_column, group);
    }));
    const selectedVisible = rows.some(item => item.index === state.selectedRow);
    if (!selectedVisible && rows.length) state.selectedRow = rows[0].index;
    state.selectedColumn = Math.min(
      Math.max(Number.isInteger(state.selectedColumn) ? state.selectedColumn : 0, 0),
      Math.max(snapshot.columns.length - 1, 0)
    );
    return `<div class="data-instrument">
      <div class="data-toolbar">
        <div class="row-search"><span>⌕</span><input id="table-search" type="search" placeholder="Search this page" value="${html(state.tableSearch)}"></div>
        <div class="data-controls">
          <button type="button" class="btn small toolbar-button ${state.dataControl === "filter" ? "active" : ""}" data-action="toggle-data-control" data-control="filter">Filter${state.tableFilters.length ? `<span class="toolbar-count">${state.tableFilters.length}</span>` : ""}</button>
          <button type="button" class="btn small toolbar-button ${state.dataControl === "sort" ? "active" : ""}" data-action="toggle-data-control" data-control="sort">Sort${state.tableSort ? `<span class="sort-direction">${state.tableSort.direction === "desc" ? "↓" : "↑"}</span>` : ""}</button>
          <span class="read-scope">${snapshot.row_count} loaded · ${html(capturedLabel(snapshot.captured_at))}</span>
          <button type="button" class="btn small" data-action="reload-table">↻ Reload</button>
        </div>
      </div>
      ${renderDataControl(snapshot)}
      <div class="grid-scroll">
        <table class="result-grid" aria-label="Table data. Select a data cell, then use the arrow keys to move between cells.">
          <thead><tr><th class="row-number-head">#</th>${snapshot.columns.map(column => `<th><button type="button" class="column-header-control" data-action="sort-column" data-column="${html(column.name)}"><span>${html(column.name)}${state.tableSort?.column === column.name ? `<i>${state.tableSort.direction === "desc" ? "↓" : "↑"}</i>` : ""}</span><small>${html(column.data_type)}</small></button></th>`).join("")}</tr></thead>
          <tbody>
            ${rows.map(({ row, index }, visibleIndex) => `<tr class="selectable-row ${index === state.selectedRow ? "selected" : ""}" data-action="select-row" data-row="${index}" aria-selected="${index === state.selectedRow}">
              <td class="row-number">${visibleIndex + 1}</td>
              ${row.map((value, columnIndex) => {
                const active = index === state.selectedRow && columnIndex === state.selectedColumn;
                const related = relatedByColumn.get(snapshot.columns[columnIndex].name);
                return `<td class="data-cell ${active ? "active-cell" : ""} ${related ? "foreign-key-cell" : ""}" data-action="select-cell" data-row="${index}" data-column="${columnIndex}" tabindex="${active ? "0" : "-1"}">${formatCell(value, snapshot.columns[columnIndex])}${related ? `<button type="button" class="cell-relationship-link" data-action="open-related-cell" data-row="${index}" data-relationship="${html(related.id)}" aria-label="Open related record" ${value === null || value === undefined ? "disabled" : ""}>↗</button>` : ""}</td>`;
              }).join("")}
            </tr>`).join("") || `<tr><td class="grid-empty" colspan="${snapshot.columns.length + 1}">No loaded rows match the current search and filters.</td></tr>`}
          </tbody>
        </table>
      </div>
      <footer class="result-status paged-status">
        <div><span class="status-light good"></span><strong>${rows.length}</strong> shown on this page${state.tableSearch ? " after local search" : ""}</div>
        <div class="page-controls">
          <span>${snapshot.duration_ms} ms</span><i></i><span>${snapshot.byte_limited ? "byte cap reached" : snapshot.has_more ? "more rows available" : "end of result"}</span><i></i><span>read-only</span>
          <button type="button" class="btn small" data-action="previous-table-page" ${snapshot.previous_cursor ? "" : "disabled"}>Previous</button>
          <button type="button" class="btn small" data-action="next-table-page" ${snapshot.next_cursor ? "" : "disabled"}>Next</button>
        </div>
      </footer>
    </div>`;
  }

  function selectTableCell(rowIndex, columnIndex) {
    const snapshot = state.snapshot;
    if (
      !Number.isInteger(rowIndex) ||
      !Number.isInteger(columnIndex) ||
      !snapshot?.rows?.[rowIndex] ||
      !snapshot.columns.length
    ) return;
    const rows = filteredRows(snapshot);
    if (!rows.some(item => item.index === rowIndex)) return;

    const grid = document.querySelector(".data-instrument > .grid-scroll");
    const previousRow = grid?.querySelector(".selectable-row.selected");
    const previousCell = grid?.querySelector(".data-cell.active-cell");
    state.selectedRow = rowIndex;
    state.selectedColumn = Math.min(Math.max(columnIndex, 0), snapshot.columns.length - 1);
    const nextRow = grid?.querySelector(`.selectable-row[data-row="${state.selectedRow}"]`);
    const nextCell = nextRow?.querySelector(`.data-cell[data-column="${state.selectedColumn}"]`);
    previousRow?.classList.remove("selected");
    previousRow?.setAttribute("aria-selected", "false");
    previousCell?.classList.remove("active-cell");
    previousCell?.setAttribute("tabindex", "-1");
    nextRow?.classList.add("selected");
    nextRow?.setAttribute("aria-selected", "true");
    nextCell?.classList.add("active-cell");
    nextCell?.setAttribute("tabindex", "0");
    if (state.inspectorOpen) refreshRowInspector();
    nextCell?.focus({ preventScroll: true });
    nextCell?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  function moveTableCell(cell, key) {
    const snapshot = state.snapshot;
    if (!snapshot?.columns?.length) return;
    const rows = filteredRows(snapshot);
    const rowIndex = Number(cell.dataset.row);
    const columnIndex = Number(cell.dataset.column);
    const visibleRowIndex = rows.findIndex(item => item.index === rowIndex);
    if (visibleRowIndex < 0 || !Number.isInteger(columnIndex)) return;

    let nextVisibleRow = visibleRowIndex;
    let nextColumn = columnIndex;
    if (key === "ArrowUp") nextVisibleRow = Math.max(visibleRowIndex - 1, 0);
    if (key === "ArrowDown") nextVisibleRow = Math.min(visibleRowIndex + 1, rows.length - 1);
    if (key === "ArrowLeft") nextColumn = Math.max(columnIndex - 1, 0);
    if (key === "ArrowRight") nextColumn = Math.min(columnIndex + 1, snapshot.columns.length - 1);

    const nextRow = rows[nextVisibleRow]?.index;
    if (nextRow === undefined || (nextRow === rowIndex && nextColumn === columnIndex)) return;
    selectTableCell(nextRow, nextColumn);
  }

  function formatCell(value, column = {}) {
    const pending = queueValueFormat(value, column, "cell");
    const nullState = value === null || value === undefined ? " null-value" : "";
    const previewTabIndex = pending.raw.length > 48 ? ` tabindex="0"` : "";
    return `<span id="${pending.id}" class="cell-value formatted-value value-format-pending${nullState}" data-cell-preview data-preview-kind="text"${previewTabIndex}>${html(pending.raw)}</span>`;
  }

  function cellNeedsPreview(target) {
    const displayedText = target.textContent || "";
    const rawText = cellRawValues.get(target) ?? displayedText;
    return rawText !== displayedText || rawText.length > 48 || rawText.includes("\n") || target.scrollWidth > target.clientWidth + 1;
  }

  function hideCellValuePreview() {
    clearTimeout(cellPreviewTimer);
    cellPreviewTimer = 0;
    cellPreviewTarget?.removeAttribute("aria-describedby");
    cellPreviewTarget = null;
    if (!cellValuePreview) return;
    cellValuePreview.hidden = true;
    cellValuePreview.setAttribute("aria-hidden", "true");
  }

  function positionCellValuePreview(target) {
    if (!cellValuePreview) return;
    const targetRect = target.getBoundingClientRect();
    const previewRect = cellValuePreview.getBoundingClientRect();
    const viewportPadding = 12;
    const gap = 10;
    const spaceBelow = window.innerHeight - targetRect.bottom - viewportPadding;
    const spaceAbove = targetRect.top - viewportPadding;
    const placeBelow = spaceBelow >= previewRect.height + gap || spaceBelow >= spaceAbove;
    const preferredTop = placeBelow
      ? targetRect.bottom + gap
      : targetRect.top - previewRect.height - gap;
    const top = Math.min(
      Math.max(viewportPadding, preferredTop),
      Math.max(viewportPadding, window.innerHeight - previewRect.height - viewportPadding),
    );
    const preferredLeft = targetRect.left - 12;
    const left = Math.min(
      Math.max(viewportPadding, preferredLeft),
      Math.max(viewportPadding, window.innerWidth - previewRect.width - viewportPadding),
    );
    const anchor = Math.min(
      Math.max(18, targetRect.left + targetRect.width / 2 - left),
      previewRect.width - 18,
    );
    cellValuePreview.dataset.placement = placeBelow ? "below" : "above";
    cellValuePreview.style.setProperty("--cell-preview-anchor", `${anchor}px`);
    cellValuePreview.style.left = `${left}px`;
    cellValuePreview.style.top = `${top}px`;
    cellValuePreview.style.visibility = "visible";
  }

  function showCellValuePreview(target) {
    if (!cellValuePreview || !target.isConnected || !cellNeedsPreview(target)) return;
    const rawText = cellRawValues.get(target) ?? target.textContent ?? "";
    const kind = target.dataset.previewKind === "json" ? "json" : "text";
    let previewText = rawText;
    if (kind === "json") {
      try {
        previewText = JSON.stringify(JSON.parse(rawText), null, 2);
      } catch (_) {
        previewText = rawText;
      }
    }
    const previewLimit = 12000;
    const clipped = previewText.length > previewLimit;
    const content = cellValuePreview.querySelector("[data-cell-preview-content]");
    const type = cellValuePreview.querySelector("[data-cell-preview-type]");
    const meta = cellValuePreview.querySelector("[data-cell-preview-meta]");
    content.textContent = clipped ? `${previewText.slice(0, previewLimit)}\n…` : previewText;
    type.textContent = kind === "json" ? "Raw JSON value" : "Raw value";
    meta.textContent = `${rawText.length.toLocaleString()} chars${clipped ? " · preview clipped" : ""}`;
    cellPreviewTarget = target;
    target.setAttribute("aria-describedby", cellValuePreview.id);
    cellValuePreview.style.visibility = "hidden";
    cellValuePreview.hidden = false;
    content.scrollTop = 0;
    cellValuePreview.setAttribute("aria-hidden", "false");
    positionCellValuePreview(target);
  }

  function queueCellValuePreview(target) {
    if (target === cellPreviewTarget && !cellValuePreview?.hidden) return;
    hideCellValuePreview();
    cellPreviewTimer = window.setTimeout(() => showCellValuePreview(target), 140);
  }

  function renderStructure(snapshot) {
    return `<div class="structure-panel">
      <div class="structure-intro"><span>Column definition</span><span>${snapshot.columns.length} columns · ${snapshot.primary_key?.length ? `primary key on ${snapshot.primary_key.join(", ")}` : "no primary key reported"}</span></div>
      <div class="grid-scroll structure-scroll"><table class="definition-table">
        <thead><tr><th>Column</th><th>Type</th><th>Nullable</th><th>Default</th><th>Key</th></tr></thead>
        <tbody>${snapshot.columns.map(column => `<tr>
          <td><span class="column-name">${html(column.name)}</span></td>
          <td><code>${html(column.data_type)}</code></td>
          <td>${column.nullable ? "Yes" : "No"}</td>
          <td>${column.default ? `<code>${html(column.default)}</code>` : `<span class="muted-value">—</span>`}</td>
          <td>${column.primary_key ? `<span class="key-chip">PRIMARY</span>` : `<span class="muted-value">—</span>`}</td>
        </tr>`).join("")}</tbody>
      </table></div>
      <footer class="result-status"><div><span class="status-light good"></span>Introspected from connection</div><div><span>schema ${html(snapshot.schema)}</span></div></footer>
    </div>`;
  }

  function renderIndexes(snapshot) {
    return `<div class="index-panel">
      <div class="index-list">
        ${snapshot.indexes.map(index => `<article class="index-row">
          <span class="index-signal ${index.unique ? "unique" : ""}"></span>
          <div><strong>${html(index.name)}</strong><small>${index.unique ? "Unique" : "Index"} · ${html(index.columns.join(", "))}</small></div>
          <code>${html(index.definition || "")}</code>
        </article>`).join("") || `<div class="empty-inline"><strong>No indexes reported</strong><span>This object may be a view or the driver did not return index metadata.</span></div>`}
      </div>
      <footer class="result-status"><div><span class="status-light good"></span>${snapshot.indexes.length} indexes</div><div><span>${snapshot.indexes.filter(index => index.unique).length} unique</span></div></footer>
    </div>`;
  }

  function renderRowInspector(immediate = false) {
    const snapshot = state.snapshot;
    const row = snapshot?.rows[state.selectedRow];
    if (!snapshot || !row) return "";
    const primary = snapshot.primary_key?.map(key => {
      const index = snapshot.columns.findIndex(column => column.name === key);
      return index >= 0 ? `${key}=${row[index]}` : key;
    }).join(", ") || `row ${state.selectedRow + 1}`;
    return `<aside class="row-inspector" aria-label="Selected row">
      <header class="inspector-header">
        <div><span class="eyebrow">Selected row</span><strong>${html(primary)}</strong></div>
        <button type="button" class="icon-button subtle-button" data-action="toggle-inspector" aria-label="Collapse selected row" title="Collapse selected row" aria-expanded="true">
          <span class="panel-toggle-icon" aria-hidden="true"></span>
        </button>
      </header>
      <div class="inspector-actions">
        <button type="button" class="btn small" data-action="copy-row">Copy JSON</button>
        <button type="button" class="btn small" data-action="copy-where">Copy WHERE</button>
      </div>
      ${renderRowRelationships(snapshot, row)}
      <dl class="row-fields">
        ${snapshot.columns.map((column, index) => `<div class="row-field">
          <dt><span>${html(column.name)}</span><small>${html(column.data_type)}</small></dt>
          <dd>${inspectorValue(row[index], column, immediate)}</dd>
        </div>`).join("")}
      </dl>
      <footer class="inspector-foot"><span class="lock-mark">⌑</span><span>Read-only</span></footer>
    </aside>`;
  }

  function refreshRowInspector() {
    const current = document.querySelector(".row-inspector");
    if (!current) return;
    const scrollTop = current.scrollTop;
    current.insertAdjacentHTML("afterend", renderRowInspector(true));
    const replacement = current.nextElementSibling;
    current.remove();
    if (replacement?.classList.contains("row-inspector")) replacement.scrollTop = scrollTop;
  }

  function inspectorValue(value, column = {}, immediate = false) {
    if (immediate) {
      try {
        const raw = rawDatabaseValue(value);
        const formatted = formatDatabaseValue(value, column, { raw });
        return `<div class="inspector-value">${inspectorFormatHTML(formatted)}</div>`;
      } catch (_) {
        return `<div class="inspector-value"><span>${html(rawDatabaseValue(value))}</span></div>`;
      }
    }
    const pending = queueValueFormat(value, column, "inspector");
    return `<div id="${pending.id}" class="inspector-value value-format-pending"><span>${html(pending.raw)}</span></div>`;
  }

  function selectedRelationshipGroups() {
    const topology = state.topology;
    if (!topology) return { outgoing: [], incoming: [] };
    const group = relationships => {
      const grouped = new Map();
      relationships.forEach(relationship => {
        const key = relationship.constraint_id || relationship.id;
        if (!grouped.has(key)) grouped.set(key, { id: key, relationships: [] });
        grouped.get(key).relationships.push(relationship);
      });
      return [...grouped.values()];
    };
    return {
      outgoing: group(topology.relationships.filter(relationship =>
        (relationship.from_schema || "main") === state.selected.schema && relationship.from_table === state.selected.table
      )),
      incoming: group(topology.relationships.filter(relationship =>
        (relationship.to_schema || "main") === state.selected.schema && relationship.to_table === state.selected.table
      )),
    };
  }

  function renderRowRelationships(snapshot, row) {
    const groups = selectedRelationshipGroups();
    const renderGroup = (group, direction) => {
      const first = group.relationships[0];
      const columns = direction === "outgoing"
        ? group.relationships.map(item => item.from_column)
        : group.relationships.map(item => item.to_column);
      const missing = columns.some(column => {
        const index = snapshot.columns.findIndex(item => item.name === column);
        return index < 0 || row[index] === null || row[index] === undefined;
      });
      const target = direction === "outgoing"
        ? `${first.to_schema || "main"}.${first.to_table}`
        : `${first.from_schema || "main"}.${first.from_table}`;
      return `<button type="button" class="relationship-action" data-action="open-related" data-relationship="${html(group.id)}" data-direction="${direction}" ${missing ? "disabled" : ""}><span>${direction === "outgoing" ? "Parent" : "Children"}</span><strong>${html(target)}</strong><small>${html(columns.join(" + "))}</small></button>`;
    };
    if (!groups.outgoing.length && !groups.incoming.length) return "";
    return `<section class="row-relationships"><header><strong>Related records</strong><span>Bounded navigation</span></header><div>${groups.outgoing.map(group => renderGroup(group, "outgoing")).join("")}${groups.incoming.map(group => renderGroup(group, "incoming")).join("")}</div></section>`;
  }

  async function openRelatedRelationship(relationshipID, direction) {
    const snapshot = state.snapshot;
    const row = snapshot?.rows[state.selectedRow];
    if (!snapshot || !row || !state.topology) return;
    const relationships = state.topology.relationships.filter(item => (item.constraint_id || item.id) === relationshipID);
    if (!relationships.length) return;
    const first = relationships[0];
    const target = direction === "incoming"
      ? { schema: first.from_schema || "main", table: first.from_table }
      : { schema: first.to_schema || "main", table: first.to_table };
    const filters = relationships.map(relationship => {
      const sourceColumn = direction === "incoming" ? relationship.to_column : relationship.from_column;
      const targetColumn = direction === "incoming" ? relationship.from_column : relationship.to_column;
      const sourceIndex = snapshot.columns.findIndex(column => column.name === sourceColumn);
      state.filterSerial += 1;
      return { id: state.filterSerial, column: targetColumn, operator: "equals", value: String(row[sourceIndex] ?? "") };
    });
    state.relatedNavigation.push({
      selected: { ...state.selected },
      filters: state.tableFilters.map(filter => ({ ...filter })),
      sort: state.tableSort ? { ...state.tableSort } : null,
      cursor: state.tableCursor,
    });
    state.selected = target;
    state.tableFilters = filters;
    state.tableSort = null;
    state.tableCursor = "";
    state.snapshot = null;
    state.inspectorOpen = false;
    navigate("browse");
    await loadTable(true, "");
  }

  async function backRelatedNavigation() {
    const previous = state.relatedNavigation.pop();
    if (!previous) return;
    state.selected = previous.selected;
    state.tableFilters = previous.filters;
    state.tableSort = previous.sort;
    state.tableCursor = previous.cursor || "";
    state.snapshot = null;
    state.inspectorOpen = false;
    await loadTable(true, state.tableCursor);
  }

  async function loadTopology(force = false) {
    if (!state.connectionID || state.topologyLoading) return;
    state.topologyLoading = true;
    state.topologyError = "";
    try {
      let topology = !force ? state.topologyCache.get(state.connectionID) : null;
      if (!topology) {
        topology = await api(`/api/v1/topology?connection_id=${encodeURIComponent(state.connectionID)}`);
        topology.captured_at = new Date().toISOString();
        state.topologyCache.set(state.connectionID, topology);
      }
      state.topology = topology;
      state.topologyExpanded = new Set(topology.tables.map(table => table.id));
    } catch (error) {
      state.topology = null;
      state.topologyError = error.message;
    } finally {
      state.topologyLoading = false;
      if (state.route === "topology") renderTopology();
      else if (state.route === "query") refreshQueryEditorLanguage();
      else if (state.route === "browse") renderBrowse();
    }
  }

  function topologyGroups(topology) {
    const incoming = new Map(topology.tables.map(table => [topologyTableKey(table), 0]));
    const outgoing = new Map(topology.tables.map(table => [topologyTableKey(table), 0]));
    topology.relationships.forEach(relationship => {
      const from = topologyRelationshipKey(relationship, "from");
      const to = topologyRelationshipKey(relationship, "to");
      outgoing.set(from, (outgoing.get(from) || 0) + 1);
      incoming.set(to, (incoming.get(to) || 0) + 1);
    });
    const groups = { source: [], bridge: [], target: [] };
    topology.tables.forEach(table => {
      const key = topologyTableKey(table);
      const inCount = incoming.get(key) || 0;
      const outCount = outgoing.get(key) || 0;
      if (outCount && !inCount) groups.source.push(table);
      else if (inCount && !outCount) groups.target.push(table);
      else groups.bridge.push(table);
    });
    return { groups, incoming, outgoing };
  }

  function renderTopologyTable(table, topology, incoming, outgoing) {
    const expanded = state.topologyExpanded.has(table.id);
    const tableKey = topologyTableKey(table);
    const foreignColumns = new Map(topology.relationships
      .filter(relationship => topologyRelationshipKey(relationship, "from") === tableKey)
      .map(relationship => [relationship.from_column, relationship]));
    const referencedColumns = new Set(topology.relationships
      .filter(relationship => topologyRelationshipKey(relationship, "to") === tableKey)
      .map(relationship => relationship.to_column));
    return `<article id="topology-${html(table.id)}" class="db-topology-node ${expanded ? "expanded" : ""}" tabindex="0" data-topology-node data-table-key="${html(tableKey)}">
      <header class="db-topology-node-header">
        <span class="topology-table-mark" aria-hidden="true">T</span>
        <div><strong>${html(table.name)}</strong><small>${html(table.schema)} · ${table.columns.length} columns</small></div>
        <button type="button" class="topology-node-action" data-action="open-topology-table" data-schema="${html(table.schema)}" data-table="${html(table.name)}" title="Browse ${html(table.name)} rows" aria-label="Browse ${html(table.name)} rows">→</button>
        <button type="button" class="topology-node-action toggle" data-action="toggle-topology-table" data-id="${html(table.id)}" title="${expanded ? "Collapse columns" : "Expand columns"}" aria-label="${expanded ? "Collapse" : "Expand"} ${html(table.name)} columns" aria-expanded="${expanded}">⌄</button>
      </header>
      <div class="db-topology-columns" ${expanded ? "" : "hidden"}>
        ${table.columns.map(column => {
          const foreign = foreignColumns.get(column.name);
          const referenced = referencedColumns.has(column.name);
          return `<div class="db-topology-column ${foreign ? "relationship-source" : ""} ${referenced ? "relationship-target" : ""}" data-topology-field data-column="${html(column.name)}">
            <span class="column-key ${column.primary_key ? "primary" : foreign ? "foreign" : referenced ? "referenced" : ""}">${column.primary_key ? "PK" : foreign ? "FK" : referenced ? "REF" : ""}</span>
            <span class="topology-column-name">${html(column.name)}</span>
            <span class="topology-column-type">${html(column.data_type || "any")}</span>
            ${foreign ? `<span class="column-reference" title="References ${html(foreign.to_schema || "main")}.${html(foreign.to_table)}.${html(foreign.to_column)}">→ ${html(foreign.to_table)}</span>` : ""}
          </div>`;
        }).join("")}
      </div>
      <footer class="db-topology-node-foot"><span>${outgoing.get(tableKey) || 0} outbound</span><span>${incoming.get(tableKey) || 0} inbound</span></footer>
    </article>`;
  }

  function topologyTableKey(table) {
    return `${encodeURIComponent(table.schema || "main")}/${encodeURIComponent(table.name)}`;
  }

  function topologyRelationshipKey(relationship, side) {
    return `${encodeURIComponent(relationship[`${side}_schema`] || "main")}/${encodeURIComponent(relationship[`${side}_table`])}`;
  }

  function renderTopologyColumn(label, tables, topology, incoming, outgoing) {
    return `<section class="db-topology-column-group">
      <header><span>${html(label)}</span><small>${tables.length}</small></header>
      <div class="db-topology-column-stack">
        ${tables.map(table => renderTopologyTable(table, topology, incoming, outgoing)).join("") || `<div class="topology-column-empty">No tables in this group</div>`}
      </div>
    </section>`;
  }

  async function captureSchemaSnapshot() {
    const snapshot = await api(`/api/v1/schema-snapshot?connection_id=${encodeURIComponent(state.connectionID)}`);
    snapshot.connection_scope = connectionScope();
    state.schemaSnapshots = [snapshot, ...state.schemaSnapshots.filter(item => item.connection_scope !== snapshot.connection_scope)].slice(0, 10);
    state.schemaDiff = null;
    persistWorkspace();
    renderTopology();
    toast(`Captured ${snapshot.database} schema`);
  }

  async function compareSchemaSnapshot() {
    const baseline = state.schemaSnapshots.find(item => item.connection_scope === connectionScope());
    if (!baseline) {
      toast("Capture a schema snapshot before comparing", "error");
      return;
    }
    const current = await api(`/api/v1/schema-snapshot?connection_id=${encodeURIComponent(state.connectionID)}`);
    current.connection_scope = connectionScope();
    state.schemaDiff = diffSchemaSnapshots(baseline, current);
    renderTopology();
  }

  function diffSchemaSnapshots(before, after) {
    const changes = [];
    const tableKey = table => `${table.schema}.${table.name}`;
    const beforeTables = new Map((before.topology?.tables || []).map(table => [tableKey(table), table]));
    const afterTables = new Map((after.topology?.tables || []).map(table => [tableKey(table), table]));
    beforeTables.forEach((table, key) => {
      if (!afterTables.has(key)) changes.push({ kind: "removed", path: key, detail: "Table removed" });
    });
    afterTables.forEach((table, key) => {
      if (!beforeTables.has(key)) {
        changes.push({ kind: "added", path: key, detail: "Table added" });
        return;
      }
      const previous = beforeTables.get(key);
      const previousColumns = new Map((previous.columns || []).map(column => [column.name, column]));
      const nextColumns = new Map((table.columns || []).map(column => [column.name, column]));
      previousColumns.forEach((column, name) => {
        if (!nextColumns.has(name)) changes.push({ kind: "removed", path: `${key}.${name}`, detail: "Column removed" });
      });
      nextColumns.forEach((column, name) => {
        const old = previousColumns.get(name);
        if (!old) changes.push({ kind: "added", path: `${key}.${name}`, detail: `Column added (${column.data_type})` });
        else if (JSON.stringify([old.data_type, old.nullable, old.default, old.primary_key]) !== JSON.stringify([column.data_type, column.nullable, column.default, column.primary_key])) {
          changes.push({ kind: "changed", path: `${key}.${name}`, detail: `${old.data_type} → ${column.data_type}` });
        }
      });
      const indexSignature = value => JSON.stringify((value.indexes || []).map(index => [index.name, index.columns, index.unique, index.definition]).sort());
      if (indexSignature(previous) !== indexSignature(table)) changes.push({ kind: "changed", path: key, detail: "Indexes changed" });
    });
    const relationshipSignature = snapshot => JSON.stringify((snapshot.topology?.relationships || []).map(item => [item.constraint_id, item.from_schema, item.from_table, item.from_column, item.to_schema, item.to_table, item.to_column, item.on_update, item.on_delete]).sort());
    if (relationshipSignature(before) !== relationshipSignature(after)) changes.push({ kind: "changed", path: "relationships", detail: "Foreign-key relationships changed" });
    return { before, after, changes, captured_at: after.captured_at };
  }

  function renderSchemaDiff() {
    const diff = state.schemaDiff;
    if (!diff) return "";
    return `<section class="schema-diff" aria-label="Schema changes"><header><div><strong>Schema comparison</strong><span>${html(capturedLabel(diff.before.captured_at))} → ${html(capturedLabel(diff.after.captured_at))}</span></div><div><button type="button" class="btn small" data-action="copy-schema-diff" data-format="markdown">Copy Markdown</button><button type="button" class="btn small" data-action="copy-schema-diff" data-format="json">Copy JSON</button><button type="button" class="icon-button subtle-button" data-action="close-schema-diff" aria-label="Close comparison">×</button></div></header><div>${diff.changes.map(change => `<article class="${html(change.kind)}"><span>${html(change.kind)}</span><strong>${html(change.path)}</strong><small>${html(change.detail)}</small></article>`).join("") || `<div class="schema-diff-empty"><strong>No schema changes</strong><span>The current schema matches the captured snapshot.</span></div>`}</div></section>`;
  }

  function schemaDiffMarkdown(diff) {
    const lines = [`# Schema diff: ${diff.after.database}`, "", `Baseline: ${diff.before.captured_at}`, `Current: ${diff.after.captured_at}`, ""];
    if (!diff.changes.length) lines.push("No schema changes.");
    else diff.changes.forEach(change => lines.push(`- **${change.kind}** \`${change.path}\`: ${change.detail}`));
    return lines.join("\n");
  }

  function renderTopology() {
    const connection = currentConnection();
    if (!connection) {
      shell(`<section class="workspace empty-workspace"><div class="empty-primary"><img src="/icon.svg" alt=""><h1>No connection</h1><p>Add a SQLite or PostgreSQL database to map its tables and foreign keys.</p><button type="button" class="btn primary" data-nav="connections">Add database</button></div></section>`, "topology", { workspace: true });
      return;
    }
    if (!state.topology || state.topology.connection_id !== state.connectionID) {
      const error = state.topologyError;
      shell(`<section class="workspace topology-page">
        <header class="workspace-header"><div class="workspace-identity"><span class="eyebrow">Schema map</span><div class="workspace-title-row"><h1 class="workspace-title">${html(connection.database)}</h1></div></div><div class="header-actions">${connectionPicker()}</div></header>
        <div class="${error ? "topology-error-state" : "surface-loading"}">
          ${error ? `<span class="empty-glyph">!</span><strong>Topology unavailable</strong><small>${html(error)}</small><button type="button" class="btn" data-action="refresh-topology">Try again</button>` : `<span class="loading-track"><i></i></span><strong>Mapping database</strong><small>Reading tables, columns, primary keys, and foreign keys</small>`}
        </div>
      </section>`, "topology", { workspace: true });
      if (!error && !state.topologyLoading) loadTopology();
      return;
    }
    const topology = state.topology;
    const { groups, incoming, outgoing } = topologyGroups(topology);
    const columnCount = topology.tables.reduce((total, table) => total + table.columns.length, 0);
    const allExpanded = state.topologyExpanded.size === topology.tables.length;
    const body = `<section class="workspace topology-page">
      <header class="workspace-header">
        <div class="workspace-identity"><span class="eyebrow">Schema map</span><div class="workspace-title-row"><h1 class="workspace-title">${html(connection.database)}</h1><span class="status info">captured schema</span></div></div>
        <div class="header-actions">${connectionPicker()}<button type="button" class="btn" data-action="capture-schema">Capture</button><button type="button" class="btn" data-action="compare-schema">Compare</button><button type="button" class="btn" data-action="refresh-topology">↻ <span>Refresh</span></button><button type="button" class="btn primary" data-nav="browse">Browse data</button></div>
      </header>
      <div class="command-strip">
        <div class="breadcrumb"><span>${html(engineLabel(connection.engine))}</span><i>/</i><strong>${html(connection.database)}</strong><i>/</i><span>${connection.engine === "sqlite" ? "main" : "all schemas"}</span></div>
        <div class="command-signals"><span><i class="signal-dot"></i>${html(capturedLabel(topology.captured_at))}</span><span>${topology.relationships.length} foreign keys</span></div>
      </div>
      ${renderSchemaDiff()}
      <div class="topology-toolbar">
        <div class="topology-summary"><span><strong>${topology.tables.length}</strong> tables</span><i></i><span><strong>${topology.relationships.length}</strong> relationships</span><i></i><span><strong>${columnCount}</strong> columns</span></div>
        <div class="topology-controls">
          <button type="button" class="btn small" data-action="toggle-all-topology-tables">${allExpanded ? "Collapse all" : "Expand all"}</button>
          <div class="zoom-control" aria-label="Topology zoom"><button type="button" data-action="zoom-topology" data-direction="out" aria-label="Zoom out">−</button><button type="button" data-action="reset-topology-zoom" class="zoom-value" title="Reset zoom">${Math.round(state.topologyZoom * 100)}%</button><button type="button" data-action="zoom-topology" data-direction="in" aria-label="Zoom in">+</button></div>
        </div>
      </div>
      <div class="db-topology-viewport">
        <div class="db-topology-world">
          <div class="db-topology-map">
            <svg class="db-topology-edges" aria-hidden="true"></svg>
            ${renderTopologyColumn("References others", groups.source, topology, incoming, outgoing)}
            ${renderTopologyColumn("Connected tables", groups.bridge, topology, incoming, outgoing)}
            ${renderTopologyColumn("Referenced tables", groups.target, topology, incoming, outgoing)}
          </div>
        </div>
      </div>
      <footer class="topology-status"><span>Hover or focus a table to trace its relationships.</span><span>${html(engineLabel(connection.engine))} · read-only</span></footer>
    </section>`;
    shell(body, "topology", { workspace: true });
    requestAnimationFrame(bindDatabaseTopology);
  }

  function topologyNodeByKey(key) {
    return [...document.querySelectorAll("[data-topology-node]")].find(node => node.dataset.tableKey === key);
  }

  function topologyFieldByName(node, column) {
    return [...node.querySelectorAll("[data-topology-field]")].find(field => field.dataset.column === column) || null;
  }

  function drawDatabaseTopology() {
    const viewport = document.querySelector(".db-topology-viewport");
    const world = document.querySelector(".db-topology-world");
    const map = document.querySelector(".db-topology-map");
    const svg = document.querySelector(".db-topology-edges");
    if (!viewport || !world || !map || !svg || !state.topology) return;
    const zoom = state.topologyZoom;
    map.style.transform = `scale(${zoom})`;
    world.style.width = `${Math.max(map.offsetWidth * zoom, viewport.clientWidth)}px`;
    world.style.height = `${Math.max(map.offsetHeight * zoom, viewport.clientHeight)}px`;
    const mapRect = map.getBoundingClientRect();
    const width = map.offsetWidth;
    const height = map.offsetHeight;
    const paths = state.topology.relationships.map(relationship => {
      const fromKey = topologyRelationshipKey(relationship, "from");
      const toKey = topologyRelationshipKey(relationship, "to");
      const from = topologyNodeByKey(fromKey);
      const to = topologyNodeByKey(toKey);
      if (!from || !to) return "";
      const fromField = topologyFieldByName(from, relationship.from_column);
      const toField = topologyFieldByName(to, relationship.to_column);
      const fromRect = from.getBoundingClientRect();
      const toRect = to.getBoundingClientRect();
      const fromAnchorRect = fromField && !fromField.hidden && fromField.offsetParent ? fromField.getBoundingClientRect() : fromRect;
      const toAnchorRect = toField && !toField.hidden && toField.offsetParent ? toField.getBoundingClientRect() : toRect;
      const forward = toRect.left >= fromRect.left;
      const startX = ((forward ? fromRect.right : fromRect.left) - mapRect.left) / zoom;
      const endX = ((forward ? toRect.left : toRect.right) - mapRect.left) / zoom;
      const startY = (fromAnchorRect.top + fromAnchorRect.height / 2 - mapRect.top) / zoom;
      const endY = (toAnchorRect.top + toAnchorRect.height / 2 - mapRect.top) / zoom;
      const distance = Math.max(54, Math.abs(endX - startX) * .48);
      const controlOne = forward ? startX + distance : startX - distance;
      const controlTwo = forward ? endX - distance : endX + distance;
      return `<path class="topology-edge" data-from="${html(fromKey)}" data-to="${html(toKey)}" d="M ${startX} ${startY} C ${controlOne} ${startY}, ${controlTwo} ${endY}, ${endX} ${endY}" marker-start="url(#topology-origin)" marker-end="url(#topology-arrow)"><title>${html(relationship.from_schema || "main")}.${html(relationship.from_table)}.${html(relationship.from_column)} → ${html(relationship.to_schema || "main")}.${html(relationship.to_table)}.${html(relationship.to_column)}</title></path>`;
    }).join("");
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.innerHTML = `<defs><marker id="topology-origin" viewBox="0 0 7 7" refX="3.5" refY="3.5" markerWidth="6" markerHeight="6"><circle cx="3.5" cy="3.5" r="2.2"></circle></marker><marker id="topology-arrow" viewBox="0 0 7 7" refX="6" refY="3.5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0 7 3.5 0 7z"></path></marker></defs>${paths}`;
  }

  function highlightTopologyTable(key) {
    document.querySelectorAll("[data-topology-node]").forEach(node => {
      node.classList.toggle("connected", node.dataset.tableKey !== key && state.topology.relationships.some(relationship =>
        (topologyRelationshipKey(relationship, "from") === key && topologyRelationshipKey(relationship, "to") === node.dataset.tableKey) ||
        (topologyRelationshipKey(relationship, "to") === key && topologyRelationshipKey(relationship, "from") === node.dataset.tableKey)
      ));
      node.classList.toggle("focused", node.dataset.tableKey === key);
    });
    document.querySelectorAll(".topology-edge").forEach(edge => edge.classList.toggle("active", edge.dataset.from === key || edge.dataset.to === key));
  }

  function clearTopologyHighlight() {
    document.querySelectorAll(".db-topology-node.connected, .db-topology-node.focused").forEach(node => node.classList.remove("connected", "focused"));
    document.querySelectorAll(".topology-edge.active").forEach(edge => edge.classList.remove("active"));
  }

  function bindDatabaseTopology() {
    const viewport = document.querySelector(".db-topology-viewport");
    const map = document.querySelector(".db-topology-map");
    if (!viewport || !map) return;
    const sizeMap = () => {
      const minimum = window.matchMedia("(max-width: 760px)").matches ? viewport.clientWidth : 1080;
      map.style.width = `${Math.max(minimum, viewport.clientWidth)}px`;
    };
    sizeMap();
    if (state.topologyObserver) state.topologyObserver.disconnect();
    state.topologyObserver = new ResizeObserver(() => {
      sizeMap();
      cancelAnimationFrame(state.topologyDrawFrame);
      state.topologyDrawFrame = requestAnimationFrame(drawDatabaseTopology);
    });
    state.topologyObserver.observe(viewport);
    state.topologyObserver.observe(map);
    document.querySelectorAll("[data-topology-node]").forEach(node => {
      node.addEventListener("pointerenter", () => highlightTopologyTable(node.dataset.tableKey));
      node.addEventListener("pointerleave", clearTopologyHighlight);
      node.addEventListener("focusin", () => highlightTopologyTable(node.dataset.tableKey));
      node.addEventListener("focusout", clearTopologyHighlight);
    });
    drawDatabaseTopology();
  }

  function newQueryTab(sql = "", name = "") {
    if (queryEditorView) syncActiveQuery(queryEditorView.state.doc.toString());
    const id = `query-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const tab = {
      id,
      name: String(name || `Query ${state.queryTabs.length + 1}`).slice(0, 80),
      sql: String(sql || "").slice(0, 1_000_000),
      connection_scope: connectionScope(),
    };
    state.queryTabs.push(tab);
    state.activeQueryTabID = id;
    state.querySQL = tab.sql;
    state.queryResult = null;
    state.explainResult = null;
    state.queryResultMode = "results";
    persistWorkspace();
    return tab;
  }

  function activateQueryTab(id) {
    if (queryEditorView) syncActiveQuery(queryEditorView.state.doc.toString());
    if (!state.queryTabs.some(tab => tab.id === id)) return;
    state.activeQueryTabID = id;
    state.querySQL = activeQueryTab().sql;
    state.queryResult = null;
    state.explainResult = null;
    state.queryResultMode = "results";
    persistWorkspace();
    renderQuery();
  }

  function closeQueryTab(id) {
    if (state.queryTabs.length === 1) {
      const tab = state.queryTabs[0];
      tab.sql = "";
      tab.name = "scratch.sql";
      state.querySQL = "";
    } else {
      const index = state.queryTabs.findIndex(tab => tab.id === id);
      if (index < 0) return;
      state.queryTabs.splice(index, 1);
      if (state.activeQueryTabID === id) {
        state.activeQueryTabID = state.queryTabs[Math.max(0, index - 1)].id;
        state.querySQL = activeQueryTab().sql;
      }
    }
    state.queryResult = null;
    state.explainResult = null;
    persistWorkspace();
    renderQuery();
  }

  function queryWorkspacePanel() {
    if (!state.workspacePanel) return "";
    const scope = connectionScope();
    const items = state.workspacePanel === "saved"
      ? state.savedQueries.filter(item => !item.connection_scope || item.connection_scope === scope)
      : state.queryHistory.filter(item => !item.connection_scope || item.connection_scope === scope);
    const label = state.workspacePanel === "saved" ? "Saved queries" : "Query history";
    return `<aside class="query-library" aria-label="${label}">
      <header><div><strong>${label}</strong><span>${items.length} ${items.length === 1 ? "item" : "items"} for this connection</span></div><button type="button" class="icon-button subtle-button" data-action="close-query-library" aria-label="Close ${label}">×</button></header>
      <div class="query-library-list">
        ${items.map(item => `<article>
          <button type="button" class="query-library-open" data-action="open-${state.workspacePanel}-query" data-query-id="${html(item.id)}"><strong>${html(item.name || "Untitled query")}</strong><code>${html(String(item.sql || "").replace(/\s+/g, " ").slice(0, 140))}</code><span>${html(capturedLabel(item.created_at))}</span></button>
          ${state.workspacePanel === "saved" ? `<button type="button" class="query-library-remove" data-action="remove-saved-query" data-query-id="${html(item.id)}" aria-label="Remove ${html(item.name)}">×</button>` : ""}
        </article>`).join("") || `<div class="query-library-empty"><strong>No ${label.toLowerCase()}</strong><span>${state.workspacePanel === "saved" ? "Save the active tab to reuse it here." : "Successful statements will appear here."}</span></div>`}
      </div>
    </aside>`;
  }

  function renderQueryTabs() {
    return `<div class="query-tab-strip" role="tablist" aria-label="Query tabs">
      ${state.queryTabs.map(tab => `<div class="query-tab ${tab.id === state.activeQueryTabID ? "active" : ""}">
        <button type="button" role="tab" aria-selected="${tab.id === state.activeQueryTabID}" data-action="select-query-tab" data-query-tab="${html(tab.id)}"><span class="editor-dot"></span>${html(tab.name)}</button>
        <button type="button" data-action="close-query-tab" data-query-tab="${html(tab.id)}" aria-label="Close ${html(tab.name)}">×</button>
      </div>`).join("")}
      <button type="button" class="new-query-tab" data-action="new-query-tab" aria-label="New query tab">＋</button>
    </div>`;
  }

  function queryDialect() {
    switch (currentConnection()?.engine) {
      case "postgres": return PostgreSQL;
      case "mysql": return MySQL;
      default: return SQLite;
    }
  }

  function querySchema() {
    const schema = {};
    (state.catalog?.schemas || []).forEach(namespace => {
      schema[namespace.name] = {};
      namespace.tables.forEach(table => {
        schema[namespace.name][table.name] = {
          self: {
            label: table.name,
            type: "type",
            detail: table.kind || "table",
            boost: table.schema === state.selected.schema && table.name === state.selected.table ? 99 : 60,
            section: tableCompletionSection,
          },
          children: [],
        };
      });
    });
    if (state.topology?.connection_id === state.connectionID) {
      state.topology.tables.forEach(table => {
        schema[table.schema] ||= {};
        schema[table.schema][table.name] = {
          self: {
            label: table.name,
            type: "type",
            detail: table.kind || "table",
            boost: table.schema === state.selected.schema && table.name === state.selected.table ? 99 : 60,
            section: tableCompletionSection,
          },
          children: table.columns.map(column => ({
            label: column.name,
            type: "property",
            detail: column.data_type || "column",
            boost: 70,
            section: columnCompletionSection,
          })),
        };
      });
    } else if (state.snapshot) {
      schema[state.snapshot.schema] ||= {};
      schema[state.snapshot.schema][state.snapshot.name] = {
        self: {
          label: state.snapshot.name,
          type: "type",
          detail: "table",
          boost: state.snapshot.schema === state.selected.schema && state.snapshot.name === state.selected.table ? 99 : 60,
          section: tableCompletionSection,
        },
        children: state.snapshot.columns.map(column => ({
          label: column.name,
          type: "property",
          detail: column.data_type || "column",
          boost: 70,
          section: columnCompletionSection,
        })),
      };
    }
    return schema;
  }

  function queryLanguageSupport() {
    const schemas = state.catalog?.schemas || [];
    const defaultSchema = schemas.some(schema => schema.name === state.selected.schema)
      ? state.selected.schema
      : schemas[0]?.name;
    const dialect = queryDialect();
    return [
      sql({
        dialect,
        schema: querySchema(),
        defaultSchema,
        upperCaseKeywords: true,
        keywordCompletion: (label, type) => ({
          label,
          type,
          boost: -1,
          section: keywordCompletionSection,
        }),
      }),
      dialect.language.data.of({ autocomplete: contextualSQLCompletion }),
    ];
  }

  function completionOption(label, type, detail, boost, section) {
    const option = { label, type, detail, boost, section };
    if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(label)) {
      option.apply = `"${label.replaceAll('"', '""')}"`;
    }
    return option;
  }

  function availableQueryColumns(tableNames = []) {
    const normalizedTables = new Set(tableNames.map(name => name.toLowerCase()));
    let tables = state.topology?.connection_id === state.connectionID
      ? state.topology.tables
      : [];
    if (!tables.length && state.snapshot) {
      tables = [{
        schema: state.snapshot.schema,
        name: state.snapshot.name,
        columns: state.snapshot.columns,
      }];
    }
    if (normalizedTables.size) {
      tables = tables.filter(table => normalizedTables.has(table.name.toLowerCase()));
    }
    const columns = new Map();
    tables.forEach(table => {
      table.columns.forEach(column => {
        const key = column.name.toLowerCase();
        const current = columns.get(key);
        if (current) {
          if (!current.tables.includes(table.name)) current.tables.push(table.name);
        } else {
          columns.set(key, {
            name: column.name,
            dataType: column.data_type || "column",
            tables: [table.name],
          });
        }
      });
    });
    return [...columns.values()];
  }

  function referencedQueryTables(sqlText) {
    return [...sqlText.matchAll(/\b(?:FROM|JOIN)\s+(?:(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_$]*)\s*\.\s*)?"?([A-Za-z_][A-Za-z0-9_$]*)"?/gi)]
      .map(match => match[1]);
  }

  function contextualSQLCompletion(context) {
    const word = context.matchBefore(/[A-Za-z0-9_$]*/);
    if (!word) return null;
    const before = context.state.sliceDoc(0, word.from);
    if (/\.\s*$/.test(before)) return null;
    const tableContext = /\b(?:FROM|JOIN|UPDATE|INTO)\s*$/i.test(before);
    const columnContext = /(?:\bSELECT|\bWHERE|\bON|\bHAVING|\bBY|\bAND|\bOR|,)\s*$/i.test(before);
    if (tableContext || !columnContext) return null;

    const options = availableQueryColumns(referencedQueryTables(before)).map(column =>
      completionOption(
        column.name,
        "property",
        `${column.dataType} · ${column.tables.join(", ")}`,
        90,
        columnCompletionSection,
      )
    );
    if (!options.length) return null;
    return {
      from: word.from,
      options,
      validFor: /^[A-Za-z0-9_$]*$/,
    };
  }

  function shouldStartQueryCompletion(editorState) {
    const caret = editorState.selection.main.head;
    if (!caret) return false;
    const lastCharacter = editorState.sliceDoc(caret - 1, caret);
    if (/[A-Za-z_$.,]/.test(lastCharacter)) return true;
    if (!/\s/.test(lastCharacter)) return false;
    const beforeCaret = editorState.sliceDoc(Math.max(0, caret - 48), caret);
    return /\b(?:SELECT|FROM|JOIN|UPDATE|INTO|WHERE|ON|AND|OR|BY|HAVING)\s+$/i.test(beforeCaret);
  }

  function runQueryCommand() {
    void runQuery();
    return true;
  }

  function refreshQueryEditorLanguage() {
    if (!queryEditorView) return;
    queryEditorView.dispatch({
      effects: queryLanguage.reconfigure(queryLanguageSupport()),
    });
  }

  function mountQueryEditor(value) {
    const parent = document.getElementById("query-editor");
    if (!parent) return;
    queryEditorView = new EditorView({
      parent,
      doc: value,
      extensions: [
        basicSetup,
        queryLanguage.of(queryLanguageSupport()),
        queryHighlighting,
        queryEditorTheme,
        EditorView.cspNonce.of(cspNonce),
        Prec.high(keymap.of([
          {
            key: "Mod-Enter",
            preventDefault: true,
            run: runQueryCommand,
          },
          {
            key: "Ctrl-Enter",
            preventDefault: true,
            run: runQueryCommand,
          },
          {
            key: "Tab",
            run: view => completionStatus(view.state)
              ? acceptCompletion(view)
              : indentWithTab.run(view),
            shift: indentWithTab.shift,
          },
        ])),
        EditorView.contentAttributes.of({
          "aria-label": "SQL query",
          "aria-describedby": "query-editor-help",
          "aria-keyshortcuts": "Control+Enter Meta+Enter",
          autocapitalize: "off",
          spellcheck: "false",
        }),
        EditorView.updateListener.of(update => {
          if (!update.docChanged) return;
          state.querySQL = update.state.doc.toString();
          syncActiveQuery(state.querySQL);
          persistWorkspace();
          const input = update.transactions.some(transaction => transaction.isUserEvent("input"));
          const completed = update.transactions.some(transaction => transaction.isUserEvent("input.complete"));
          if (input && !completed && shouldStartQueryCompletion(update.state)) {
            requestAnimationFrame(() => {
              if (queryEditorView === update.view && !completionStatus(update.view.state)) {
                startCompletion(update.view);
              }
            });
          }
        }),
      ],
    });
  }

  function renderQuery() {
    const connection = currentConnection();
    if (!connection) {
      shell(`<section class="workspace empty-workspace">
        <div class="empty-primary">
          <span class="empty-glyph">⌁</span>
          <h1>No connection</h1>
          <p>Add a SQLite or PostgreSQL database before running SQL.</p>
          <button type="button" class="btn primary" data-nav="connections">Add database</button>
        </div>
      </section>`, "query", { workspace: true });
      return;
    }
    const tab = activeQueryTab();
    state.querySQL = tab.sql;
    const result = state.queryResult;
    const editorValue = tab.sql || "SELECT 1 AS result;";
    const body = `<section class="workspace query-page">
      <header class="workspace-header">
        <div class="workspace-identity"><span class="eyebrow">SQL workspace</span><div class="workspace-title-row"><h1 class="workspace-title">Query</h1><span class="status info">read-only</span></div></div>
        <div class="header-actions">${connectionPicker()}<button type="button" class="btn" data-action="toggle-query-history">History</button><button type="button" class="btn" data-action="toggle-saved-queries">Saved</button><button type="button" class="btn" data-action="save-query">Save</button><button type="button" class="btn" data-action="format-query">Format</button><button type="button" class="btn" data-action="explain-query" ${state.explainRunning ? "disabled" : ""}>${state.explainRunning ? "Explaining…" : "Explain"}</button><button type="button" class="btn primary" data-action="run-query" ${state.queryRunning ? "disabled" : ""}>${state.queryRunning ? "Running…" : "▶ Run"}</button></div>
      </header>
      <div class="command-strip">
        <div class="breadcrumb"><span>${html(connection?.name || "No connection")}</span><i>/</i><strong>${html(tab.name)}</strong></div>
        <div class="command-signals"><span><i class="signal-dot"></i>Cmd/Ctrl + Enter to run</span><label class="row-cap-control">Row cap <select data-setting="row-limit"><option value="50" ${state.settings.rowLimit === 50 ? "selected" : ""}>50</option><option value="100" ${state.settings.rowLimit === 100 ? "selected" : ""}>100</option><option value="250" ${state.settings.rowLimit === 250 ? "selected" : ""}>250</option><option value="500" ${state.settings.rowLimit === 500 ? "selected" : ""}>500</option><option value="1000" ${state.settings.rowLimit === 1000 ? "selected" : ""}>1000</option></select></label><label class="row-cap-control">Timeout <select data-setting="statement-timeout"><option value="5" ${state.settings.statementTimeout === 5 ? "selected" : ""}>5s</option><option value="10" ${state.settings.statementTimeout === 10 ? "selected" : ""}>10s</option><option value="15" ${state.settings.statementTimeout === 15 ? "selected" : ""}>15s</option></select></label></div>
      </div>
      ${renderQueryTabs()}
      <div class="query-stage">
      <div class="query-workbench">
        <section class="query-editor-panel">
          <header class="editor-header"><div><span class="editor-dot"></span><input class="query-name-input" value="${html(tab.name)}" maxlength="80" aria-label="Query tab name" data-query-name></div><span>${html(engineLabel(connection?.engine || "SQL"))}</span></header>
          <div id="query-editor" class="sql-editor"></div>
          <footer id="query-editor-help" class="editor-foot"><div><span>UTF-8</span><span>${html(engineLabel(connection.engine))} SQL</span><span>Read-only guard active</span></div><div><span>Ctrl+Space suggestions</span><span>Tab to complete</span></div></footer>
        </section>
        <section class="query-results-panel">
          <header class="query-results-header"><div><button type="button" class="result-mode ${state.queryResultMode === "results" ? "active" : ""}" data-action="show-query-results">Results</button><button type="button" class="result-mode ${state.queryResultMode === "plan" ? "active" : ""}" data-action="show-query-plan">Plan</button>${result && state.queryResultMode === "results" ? `<span>${result.row_count} rows</span>` : ""}</div><div>${result && state.queryResultMode === "results" ? `<span>${result.duration_ms} ms</span><button class="btn small" type="button" data-action="copy-results">Copy JSON</button>` : ""}</div></header>
          ${renderQueryResult()}
        </section>
      </div>
      ${queryWorkspacePanel()}
      </div>
    </section>`;
    shell(body, "query", { workspace: true });
    mountQueryEditor(editorValue);
    if ((!state.topology || state.topology.connection_id !== state.connectionID) && !state.topologyLoading) loadTopology();
  }

  function renderQueryResult() {
    if (state.queryResultMode === "plan") return renderExplainResult();
    if (state.queryRunning) return `<div class="query-running"><span class="loading-track"><i></i></span><strong>Running statement</strong><small>The result remains bounded by the current row limit.</small></div>`;
    if (state.queryError) return `<div class="query-error"><span>!</span><div><strong>Query failed</strong><pre>${html(state.queryError)}</pre></div></div>`;
    const result = state.queryResult;
    if (!result) return `<div class="query-empty"><span class="empty-glyph">⌁</span><strong>No results</strong><p>Run a statement to see its result.</p></div>`;
    return `<div class="query-result-instrument"><div class="grid-scroll"><table class="result-grid"><thead><tr><th class="row-number-head">#</th>${result.columns.map(column => `<th><span>${html(column.name)}</span><small>${html(column.data_type)}</small></th>`).join("")}</tr></thead><tbody>${result.rows.map((row, index) => `<tr><td class="row-number">${index + 1}</td>${row.map((value, columnIndex) => `<td>${formatCell(value, result.columns[columnIndex])}</td>`).join("")}</tr>`).join("")}</tbody></table></div><footer class="result-status"><div><span class="status-light good"></span><strong>${result.row_count}</strong> rows returned</div><div><span>${html(capturedLabel(result.captured_at))}</span><i></i><span>${result.truncated ? "bounded result" : "complete result"}</span><i></i><span>read-only</span></div></footer></div>`;
  }

  function renderExplainResult() {
    if (state.explainRunning) return `<div class="query-running"><span class="loading-track"><i></i></span><strong>Building read-only plan</strong><small>The statement is not executed with analysis.</small></div>`;
    const result = state.explainResult;
    if (!result) return `<div class="query-empty"><span class="empty-glyph">⌁</span><strong>No plan captured</strong><p>Choose Explain to inspect the statement without running ANALYZE.</p></div>`;
    const rows = [];
    const visit = (node, depth = 0) => {
      rows.push({ node, depth });
      (node.children || []).forEach(child => visit(child, depth + 1));
    };
    (result.nodes || []).forEach(node => visit(node));
    return `<div class="explain-instrument"><div class="grid-scroll"><table class="definition-table explain-table"><thead><tr><th>Operation</th><th>Relation</th><th>Estimated rows</th><th>Total cost</th><th>Warning</th><th>Detail</th></tr></thead><tbody>${rows.map(({ node, depth }) => `<tr><td><span class="plan-operation" style="--plan-depth:${depth}">${html(node.operation || "Plan")}</span></td><td>${html(node.relation || "—")}</td><td>${node.estimated_rows || "—"}</td><td>${node.total_cost || "—"}</td><td class="plan-warning">${html(node.warning || "—")}</td><td><code>${html(node.detail || "")}</code></td></tr>`).join("")}</tbody></table></div><footer class="result-status"><div><span class="status-light good"></span>${rows.length} plan ${rows.length === 1 ? "node" : "nodes"}</div><div>${html(capturedLabel(result.captured_at))}<i></i>ANALYZE disabled</div></footer></div>`;
  }

  function renderConnections() {
    const hasConnections = state.connections.length > 0;
    const showForm = !hasConnections || state.connectionFormOpen;
    const configuring = showForm && state.connectionAddStep === "configure";
    const heading = !showForm
      ? "Choose a database"
      : configuring
        ? state.editingConnectionID
          ? `Edit ${state.connections.find(connection => connection.id === state.editingConnectionID)?.name || "connection"}`
          : state.connectionEngine === "postgres" ? "Connect to PostgreSQL" : "Open a SQLite database"
        : hasConnections ? "Add another database" : "Add your first database";
    const description = !showForm
      ? "Select a database to enter the workspace. You can return here whenever you need to switch."
      : configuring
        ? state.connectionEngine === "postgres"
          ? "Paste a PostgreSQL URL or enter the connection details. Rowake opens the database in read-only mode."
          : "Choose a local database file. Rowake opens it in read-only mode."
        : "Paste a connection string to detect its type, or choose a database below.";
    const body = `<section class="connection-hub">
      <div class="connection-hub-content">
        <header class="connection-hub-header">
          <div>
            <span class="connection-hub-kicker">${showForm ? "New connection" : "Start here"}</span>
            <h1>${html(heading)}</h1>
            <p>${html(description)}</p>
          </div>
          ${hasConnections && !showForm ? `<button type="button" class="btn primary" data-action="show-connection-form"><span aria-hidden="true">＋</span>Add database</button>` : ""}
        </header>
        ${showForm
          ? state.connectionAddStep === "configure"
            ? renderConnectionForm()
            : renderConnectionEntry(hasConnections)
          : renderConnectionChoices()}
      </div>
      <footer class="connection-hub-footer">
        <span>Database credentials define the access boundary.</span>
        <span>Connection previews and query results remain bounded.</span>
      </footer>
    </section>`;
    launchShell(body);
  }

  function renderConnectionChoices() {
    return `<section class="connection-list" aria-label="Available databases">
      <header class="connection-list-header">
        <span>Available databases</span>
        <small>${state.connections.length} ${state.connections.length === 1 ? "connection" : "connections"}</small>
      </header>
      <div class="connection-list-body">
        ${state.connections.map(connection => {
          const active = connection.id === state.connectionID;
          const connecting = connection.id === state.connectingID;
          const connected = connection.status === "connected";
          return `<article class="connection-choice ${active ? "active" : ""}">
            <div class="connection-choice-identity">
              <span class="engine-tile ${html(connection.engine)}">${engineMonogram(connection.engine)}</span>
              <div>
                <strong>${html(connection.name)}</strong>
                <span>${html(connection.database)}</span>
              </div>
            </div>
            <div class="connection-choice-facts">
              <span>${html(engineLabel(connection.engine))}</span>
              <code title="${html(connection.address)}">${html(connection.address)}</code>
            </div>
            <div class="connection-choice-access">
              <span class="ready-signal ${connected ? "" : "offline"}"><i></i>${connected ? active ? "In use" : "Ready" : "Disconnected"}</span>
              <small>${connection.read_only ? "Read-only" : "Read/write"}</small>
            </div>
            <div class="connection-choice-actions">
              <button class="btn ${active || !connected ? "" : "primary"}" type="button" data-action="${connected ? "use-connection" : "reconnect-connection"}" data-connection="${html(connection.id)}" ${connecting ? "disabled" : ""}>${connecting ? "Connecting…" : connected ? active ? "Continue" : "Connect" : "Reconnect"}</button>
              <details class="connection-actions-menu"><summary class="icon-button subtle-button" aria-label="Manage ${html(connection.name)}">•••</summary><div>
                <button type="button" data-action="edit-connection" data-connection="${html(connection.id)}">Edit profile</button>
                ${connected ? `<button type="button" data-action="disconnect-connection" data-connection="${html(connection.id)}">Disconnect</button>` : ""}
                <button type="button" class="danger-copy" data-action="remove-connection" data-connection="${html(connection.id)}">Remove</button>
              </div></details>
            </div>
          </article>`;
        }).join("")}
      </div>
      <button type="button" class="add-connection-row" data-action="show-connection-form">
        <span aria-hidden="true">＋</span>
        <span><strong>Add another database</strong><small>SQLite file or PostgreSQL server</small></span>
        <i aria-hidden="true">→</i>
      </button>
    </section>`;
  }

  function renderConnectionEntry(canCancel) {
    return `<section class="connection-editor connection-entry" aria-label="Choose a database type">
      <form id="connection-entry-form">
        <div class="connection-entry-url">
          <label for="connection-string-entry">Connection string</label>
          <div class="connection-string-control">
            <span aria-hidden="true">⌁</span>
            <input id="connection-string-entry" name="connection_string" type="text" inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="protocol://user:password@host:port/database" value="${html(state.connectionEntryURL)}" aria-describedby="connection-entry-status">
          </div>
          <small id="connection-entry-status" class="field-status ${state.connectionEntryError ? "error-copy" : ""}" aria-live="polite">${html(state.connectionEntryError || "Paste your connection string to auto-detect the database type.")}</small>
        </div>
        <div class="connection-choice-divider"><span>or select database</span></div>
        <div class="database-type-picker" role="group" aria-label="Database type">
          <button type="button" data-action="choose-connection-engine" data-engine="postgres">
            <span class="engine-tile postgres" aria-hidden="true">P</span>
            <span><strong>PostgreSQL</strong><small>Connect to a database server</small></span>
            <i aria-hidden="true">→</i>
          </button>
          <button type="button" data-action="choose-connection-engine" data-engine="sqlite">
            <span class="engine-tile sqlite" aria-hidden="true">S</span>
            <span><strong>SQLite</strong><small>Open a local database file</small></span>
            <i aria-hidden="true">→</i>
          </button>
        </div>
        <button class="sr-only" type="submit">Continue</button>
        ${canCancel ? `<footer class="connection-entry-actions"><button type="button" class="btn" data-action="cancel-connection-form">Back to databases</button></footer>` : ""}
      </form>
    </section>`;
  }

  function renderConnectionForm() {
    const postgres = state.connectionEngine === "postgres";
    const draft = state.connectionDraft;
    const persistenceCopy = postgres
      ? "Credentials stay in memory until Rowake closes."
      : state.meta?.features?.connection_persistence
        ? "Saved on this device."
        : "Available until Rowake closes.";
    const editing = Boolean(state.editingConnectionID);
    return `<section class="connection-editor" aria-label="Connection details">
      <form id="connection-form" class="${postgres ? "postgres-form" : "sqlite-form"}">
        <div class="connection-setup-heading">
          <button type="button" class="connection-back-link" data-action="${editing ? "cancel-connection-form" : "back-to-connection-types"}"><span aria-hidden="true">←</span> ${editing ? "Connections" : "Database types"}</button>
          <div class="connection-setup-identity">
            <span class="engine-tile ${postgres ? "postgres" : "sqlite"}" aria-hidden="true">${postgres ? "P" : "S"}</span>
            <span><strong>${postgres ? "PostgreSQL" : "SQLite"}</strong><small>${postgres ? "Server connection" : "Local database file"}</small></span>
          </div>
        </div>
        ${postgres ? `
          <label class="connection-field connection-name-field connection-name-wide">
            <span>Connection name <small>optional</small></span>
            <input id="connection-name" name="name" type="text" autocomplete="off" maxlength="120" placeholder="My PostgreSQL database" value="${html(draft.name)}">
          </label>
          ${renderPostgresConnectionFields(draft)}` : `
          <label class="connection-field connection-name-field">
            <span>Connection name <small>optional</small></span>
            <input id="connection-name" name="name" type="text" autocomplete="off" maxlength="120" placeholder="Local database" value="${html(draft.name)}">
          </label>
          <label class="connection-field path-field">
            <span>Database file</span>
            <input name="data_source_name" type="text" autocomplete="off" spellcheck="false" placeholder="/path/to/database.sqlite" value="${html(draft.data_source_name)}" required>
          </label>`}
        <p class="connection-form-error" role="alert" hidden></p>
        <footer class="connection-form-actions">
          <span>${persistenceCopy}</span>
          <div>
            <button type="button" class="btn" data-action="test-connection" ${state.testingConnection ? "disabled" : ""}>${state.testingConnection ? "Testing…" : "Test connection"}</button>
            <button type="button" class="btn" data-action="${editing ? "cancel-connection-form" : "back-to-connection-types"}">Cancel</button>
            <button type="submit" class="btn primary">${editing ? "Save changes" : "Add and connect"}</button>
          </div>
        </footer>
      </form>
    </section>`;
  }

  function renderPostgresConnectionFields(draft) {
    const securityTab = state.postgresFormTab === "security";
    const databases = state.postgresDatabases;
    const connectionURL = draft.connection_url || postgresURLFromDraft(draft);
    const databaseControl = databases.length
      ? `<select id="postgres-database" name="database" required aria-describedby="postgres-database-status">
          <option value="">Select a database</option>
          ${databases.map(database => `<option value="${html(database)}" ${database === draft.database ? "selected" : ""}>${html(database)}</option>`).join("")}
        </select>`
      : `<input id="postgres-database" name="database" type="text" autocomplete="off" spellcheck="false" maxlength="63" placeholder="postgres" value="${html(draft.database)}" required aria-describedby="postgres-database-status">`;
    let status = "Enter a database name, or load the databases this account can connect to.";
    let statusClass = "";
    if (state.postgresDiscoveryLoading) {
      status = "Connecting to PostgreSQL and reading available databases…";
      statusClass = "loading-copy";
    } else if (state.postgresDiscoveryError) {
      status = state.postgresDiscoveryError;
      statusClass = "error-copy";
    } else if (databases.length) {
      status = `${databases.length} ${databases.length === 1 ? "database" : "databases"} available to this account.`;
      statusClass = "success-copy";
    }
    return `<nav class="connection-setup-tabs" role="tablist" aria-label="PostgreSQL connection settings">
      <button id="postgres-general-tab" type="button" role="tab" class="${securityTab ? "" : "active"}" data-action="select-postgres-form-tab" data-postgres-tab="general" aria-selected="${!securityTab}" aria-controls="postgres-general-panel" tabindex="${securityTab ? "-1" : "0"}">General</button>
      <button id="postgres-security-tab" type="button" role="tab" class="${securityTab ? "active" : ""}" data-action="select-postgres-form-tab" data-postgres-tab="security" aria-selected="${securityTab}" aria-controls="postgres-security-panel" tabindex="${securityTab ? "0" : "-1"}">
        <span>SSH / SSL</span><small>SSH</small>
      </button>
    </nav>
    ${securityTab ? renderPostgresSecurityFields(draft) : `<section id="postgres-general-panel" class="postgres-tab-panel postgres-general-panel" role="tabpanel" aria-labelledby="postgres-general-tab">
      <div class="connection-field postgres-url-field">
        <label for="postgres-url">Connection URI</label>
        <div class="postgres-url-control">
          <span aria-hidden="true">P</span>
          <input id="postgres-url" name="connection_url" type="text" inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="postgresql://user:password@localhost:5432/database" value="${html(connectionURL)}" aria-describedby="postgres-url-status postgres-url-security">
        </div>
        <small id="postgres-url-status" class="field-status" aria-live="polite">Paste a PostgreSQL URL, or edit the fields below to build it.</small>
        <small id="postgres-url-security" class="postgres-url-security">This URL may reveal your password. It stays in memory and is not saved.</small>
      </div>
      <div class="connection-method-divider"><span>or</span></div>
      <p class="connection-parts-note">Enter the connection details separately. Every change updates the URI above.</p>
      <label class="connection-field host-field">
        <span>Host</span>
        <input name="host" type="text" autocomplete="off" spellcheck="false" placeholder="127.0.0.1" value="${html(draft.host)}" required>
      </label>
      <label class="connection-field port-field">
        <span>Port</span>
        <input name="port" type="number" inputmode="numeric" min="1" max="65535" value="${html(draft.port)}" required>
      </label>
      <label class="connection-field username-field">
        <span>Username</span>
        <input name="username" type="text" autocomplete="username" spellcheck="false" value="${html(draft.username)}" required>
      </label>
      <label class="connection-field password-field">
        <span>Password <small>optional</small></span>
        <input name="password" type="password" autocomplete="current-password" value="${html(draft.password)}">
      </label>
      <div class="connection-field database-field">
        <label for="postgres-database">Database</label>
        <div class="database-picker">
          ${databaseControl}
          <button type="button" class="btn" data-action="discover-postgres-databases" ${state.postgresDiscoveryLoading ? "disabled" : ""}>${state.postgresDiscoveryLoading ? "Loading…" : databases.length ? "Reload list" : "Load databases"}</button>
        </div>
        <small id="postgres-database-status" class="field-status ${statusClass}" aria-live="polite">${html(status)}</small>
      </div>
    </section>`}`;
  }

  function renderPostgresSecurityFields(draft) {
    const sslModeLabels = {
      disable: "Disabled",
      prefer: "Prefer",
      require: "Require",
      "verify-ca": "Verify CA",
      "verify-full": "Verify full",
    };
    return `<section id="postgres-security-panel" class="postgres-tab-panel postgres-security-panel" role="tabpanel" aria-labelledby="postgres-security-tab">
      <label class="connection-field security-ssl-field">
        <span>SSL mode</span>
        <select name="ssl_mode" aria-describedby="ssl-mode-status">
          ${Object.entries(sslModeLabels).map(([mode, label]) => `<option value="${mode}" ${mode === draft.ssl_mode ? "selected" : ""}>${label}</option>`).join("")}
        </select>
        <small id="ssl-mode-status" class="field-status">TLS mode is included in the connection URL when enabled.</small>
      </label>
      <label class="connection-field password-env-field">
        <span>Password environment variable <small>optional</small></span>
        <input name="password_env" type="text" autocomplete="off" spellcheck="false" placeholder="ROWAKE_DATABASE_PASSWORD" value="${html(draft.password_env)}">
        <small class="field-status">Only the variable name is saved. Its value is read when connecting.</small>
      </label>
      <label class="connection-field secret-service-field">
        <span>OS secret service <small>optional</small></span>
        <input name="secret_service" type="text" autocomplete="off" spellcheck="false" placeholder="Rowake" value="${html(draft.secret_service)}">
      </label>
      <label class="connection-field secret-account-field">
        <span>OS secret account <small>optional</small></span>
        <input name="secret_account" type="text" autocomplete="off" spellcheck="false" placeholder="database-user" value="${html(draft.secret_account)}">
        <small class="field-status">Uses macOS Keychain or Linux Secret Service. Both fields are required together.</small>
      </label>
      <div class="ssh-tunnel-heading">
        <span>SSH tunnel</span>
        <small>Jump Server</small>
      </div>
      <div class="ssh-tunnel-mode" aria-label="SSH tunnel mode">
        <span class="active">Off</span>
        <span aria-disabled="true">Over SSH <i>Coming later</i></span>
      </div>
      <fieldset class="ssh-fields-shell" disabled aria-describedby="ssh-shell-status">
        <legend class="sr-only">Future SSH tunnel settings</legend>
        <label class="connection-field ssh-server-field">
          <span>SSH server</span>
          <input type="text" placeholder="192.168.1.1">
        </label>
        <label class="connection-field ssh-port-field">
          <span>Port</span>
          <input type="number" inputmode="numeric" value="22">
        </label>
        <label class="connection-field ssh-username-field">
          <span>SSH username</span>
          <input type="text" placeholder="ubuntu">
        </label>
        <div class="ssh-authentication-shell">
          <span>Authentication</span>
          <div><strong>Password</strong><span>Private key</span></div>
        </div>
        <label class="connection-field ssh-password-field">
          <span>SSH password</span>
          <input type="password" placeholder="••••••••">
        </label>
      </fieldset>
      <p id="ssh-shell-status" class="ssh-shell-status">SSH tunneling is not active yet. This area reserves the future Jump Server settings.</p>
    </section>`;
  }

  function freshConnectionDraft() {
    return {
      name: "",
      data_source_name: "",
      connection_url: "",
      host: "127.0.0.1",
      port: "5432",
      username: "",
      password: "",
      password_env: "",
      secret_service: "",
      secret_account: "",
      database: "",
      ssl_mode: "disable",
    };
  }

  function resetConnectionAddFlow() {
    clearTimeout(state.connectionEntryTimer);
    clearTimeout(state.postgresURLTimer);
    state.connectionAddStep = "choose";
    state.connectionEngine = "sqlite";
    state.connectionEntryURL = "";
    state.connectionEntryError = "";
    state.connectionDraft = freshConnectionDraft();
    state.postgresDatabases = [];
    state.postgresDiscoveryLoading = false;
    state.postgresDiscoveryError = "";
    state.postgresFormTab = "general";
    state.editingConnectionID = "";
  }

  function decodePostgresURLPart(value) {
    try {
      return decodeURIComponent(value || "");
    } catch {
      throw new Error("The connection URL contains invalid percent-encoding");
    }
  }

  function parsePostgresURL(value) {
    const raw = String(value || "").trim();
    if (!raw) throw new Error("Enter a PostgreSQL connection URL");
    let url;
    try {
      url = new URL(raw);
    } catch {
      throw new Error("Enter a complete PostgreSQL URL");
    }
    if (!["postgres:", "postgresql:"].includes(url.protocol)) {
      throw new Error("The URL must start with postgres:// or postgresql://");
    }
    if (!url.hostname) throw new Error("The PostgreSQL URL needs a host");
    const sslMode = url.searchParams.get("sslmode") || url.searchParams.get("ssl_mode") || "disable";
    if (!["disable", "prefer", "require", "verify-ca", "verify-full"].includes(sslMode)) {
      throw new Error(`Unsupported sslmode "${sslMode}"`);
    }
    return {
      host: url.hostname.replace(/^\[(.*)\]$/, "$1"),
      port: url.port || "5432",
      username: decodePostgresURLPart(url.username),
      password: decodePostgresURLPart(url.password),
      database: decodePostgresURLPart(url.pathname.replace(/^\/+/, "")),
      ssl_mode: sslMode,
    };
  }

  function postgresURLFromDraft(draft) {
    const hostValue = String(draft.host || "127.0.0.1").trim();
    const host = hostValue.includes(":") && !hostValue.startsWith("[") ? `[${hostValue}]` : hostValue;
    const username = String(draft.username || "");
    const credentials = username
      ? `${encodeURIComponent(username)}@`
      : "";
    const port = String(draft.port || "5432").trim();
    const database = String(draft.database || "").trim();
    const sslMode = String(draft.ssl_mode || "disable");
    const query = sslMode && sslMode !== "disable" ? `?sslmode=${encodeURIComponent(sslMode)}` : "";
    return `postgresql://${credentials}${host}${port ? `:${port}` : ""}/${database ? encodeURIComponent(database) : ""}${query}`;
  }

  function normalizedPostgresDraft(draft) {
    if (!String(draft.connection_url || "").trim()) {
      return { ...draft, connection_url: postgresURLFromDraft(draft) };
    }
    const parsed = parsePostgresURL(draft.connection_url);
    if (!parsed.password) parsed.password = draft.password;
    const normalized = { ...draft, ...parsed };
    return { ...normalized, connection_url: postgresURLFromDraft(normalized) };
  }

  function setConnectionEntryStatus(message, kind = "") {
    const status = document.getElementById("connection-entry-status");
    if (!status) return;
    status.textContent = message;
    status.className = `field-status ${kind}`.trim();
  }

  function applyConnectionEntryURL(value, reportIncomplete = false, announce = true) {
    state.connectionEntryURL = String(value || "");
    const raw = state.connectionEntryURL.trim();
    if (!raw) {
      state.connectionEntryError = "";
      if (announce) setConnectionEntryStatus("Paste your connection string to auto-detect the database type.");
      return false;
    }
    try {
      const parsed = parsePostgresURL(raw);
      const draft = { ...freshConnectionDraft(), ...parsed };
      draft.connection_url = postgresURLFromDraft(draft);
      state.connectionDraft = draft;
      state.connectionEntryURL = draft.connection_url;
      state.connectionEntryError = "";
      state.connectionEngine = "postgres";
      state.connectionAddStep = "configure";
      state.postgresFormTab = "general";
      renderConnections();
      document.getElementById("connection-name")?.focus();
      return true;
    } catch (error) {
      const looksComplete = /^[a-z][a-z0-9+.-]*:\/\/[^/\s]+/i.test(raw);
      const showError = reportIncomplete || looksComplete;
      state.connectionEntryError = showError ? error.message : "";
      if (announce) {
        setConnectionEntryStatus(
          showError ? error.message : "Waiting for a complete connection string…",
          showError ? "error-copy" : ""
        );
      }
      return false;
    }
  }

  function setPostgresURLStatus(message, kind = "") {
    const status = document.getElementById("postgres-url-status");
    if (!status) return;
    status.textContent = message;
    status.className = `field-status ${kind}`.trim();
  }

  function applyPostgresURLToForm(value, reportIncomplete = false, announce = true) {
    const form = document.getElementById("connection-form");
    if (!form) return false;
    if (!String(value || "").trim()) {
      if (announce) setPostgresURLStatus("Paste a PostgreSQL URL, or edit the fields below to build it.");
      return false;
    }
    try {
      const parsed = parsePostgresURL(value);
      const draft = { ...connectionDraftFromForm(form), ...parsed };
      draft.connection_url = postgresURLFromDraft(draft);
      state.connectionDraft = draft;
      ["host", "port", "username", "password", "ssl_mode"].forEach(name => {
        if (form.elements[name]) form.elements[name].value = draft[name];
      });
      const databaseControl = form.elements.database;
      if (databaseControl) {
        if (databaseControl.tagName === "SELECT" && draft.database && ![...databaseControl.options].some(option => option.value === draft.database)) {
          databaseControl.add(new Option(draft.database, draft.database), 1);
        }
        databaseControl.value = draft.database;
      }
      const urlInput = document.getElementById("postgres-url");
      if (urlInput) urlInput.value = draft.connection_url;
      const errorNode = form.querySelector(".connection-form-error");
      if (errorNode) errorNode.hidden = true;
      state.postgresDiscoveryError = "";
      if (announce) setPostgresURLStatus("URL applied to the connection fields.", "success-copy");
      return true;
    } catch (error) {
      const looksComplete = /^[a-z][a-z0-9+.-]*:\/\/[^/\s]+/i.test(String(value || "").trim());
      const showError = reportIncomplete || looksComplete;
      if (announce) {
        setPostgresURLStatus(
          showError ? error.message : "Waiting for a complete PostgreSQL URL…",
          showError ? "error-copy" : ""
        );
      }
      return false;
    }
  }

  function syncPostgresURLFromForm(announce = true) {
    const form = document.getElementById("connection-form");
    const urlInput = document.getElementById("postgres-url");
    if (!form) return;
    const draft = connectionDraftFromForm(form);
    draft.connection_url = postgresURLFromDraft(draft);
    state.connectionDraft = draft;
    if (urlInput) {
      urlInput.value = draft.connection_url;
      if (announce) setPostgresURLStatus("URL updated from the connection fields.", "success-copy");
    }
  }

  function connectionDraftFromForm(form = document.getElementById("connection-form")) {
    if (!form) return { ...state.connectionDraft };
    const fields = new FormData(form);
    const value = (name, fallback = "") => fields.has(name) ? String(fields.get(name) || "") : fallback;
    return {
      name: value("name", state.connectionDraft.name).trim(),
      data_source_name: value("data_source_name", state.connectionDraft.data_source_name).trim(),
      connection_url: value("connection_url", state.connectionDraft.connection_url).trim(),
      host: value("host", state.connectionDraft.host || "127.0.0.1").trim(),
      port: value("port", state.connectionDraft.port || "5432").trim(),
      username: value("username", state.connectionDraft.username).trim(),
      password: value("password", state.connectionDraft.password),
      password_env: value("password_env", state.connectionDraft.password_env).trim(),
      secret_service: value("secret_service", state.connectionDraft.secret_service).trim(),
      secret_account: value("secret_account", state.connectionDraft.secret_account).trim(),
      database: value("database", state.connectionDraft.database).trim(),
      ssl_mode: value("ssl_mode", state.connectionDraft.ssl_mode || "disable"),
    };
  }

  function postgresRequest(draft) {
    return {
      name: draft.name,
      engine: "postgres",
      host: draft.host,
      port: Number(draft.port),
      username: draft.username,
      password: draft.password,
      password_env: draft.password_env,
      secret_service: draft.secret_service,
      secret_account: draft.secret_account,
      database: draft.database,
      ssl_mode: draft.ssl_mode,
    };
  }

  async function discoverPostgresDatabases() {
    const form = document.getElementById("connection-form");
    const errorNode = form?.querySelector(".connection-form-error");
    try {
      state.connectionDraft = normalizedPostgresDraft(connectionDraftFromForm(form));
    } catch (error) {
      if (errorNode) {
        errorNode.textContent = `${error.message}. Correct the connection URL or edit the fields below.`;
        errorNode.hidden = false;
      }
      setPostgresURLStatus(error.message, "error-copy");
      return;
    }
    if (!state.connectionDraft.host || !state.connectionDraft.username) {
      if (errorNode) {
        errorNode.textContent = "Enter the PostgreSQL host and username before loading databases.";
        errorNode.hidden = false;
      }
      return;
    }
    state.postgresDiscoveryLoading = true;
    state.postgresDiscoveryError = "";
    renderConnections();
    try {
      const response = await api("/api/v1/databases", {
        method: "POST",
        body: JSON.stringify(postgresRequest(state.connectionDraft)),
      });
      state.postgresDatabases = response.databases || [];
      if (!state.postgresDatabases.length) {
        state.postgresDiscoveryError = "No connectable databases were returned. Enter a database name manually.";
      } else if (!state.postgresDatabases.includes(state.connectionDraft.database)) {
        state.connectionDraft.database = "";
      }
    } catch (error) {
      state.postgresDatabases = [];
      state.postgresDiscoveryError = `${error.message}. Check the host, credentials, and SSL mode, then try again.`;
    } finally {
      state.postgresDiscoveryLoading = false;
      renderConnections();
      document.querySelector('[name="database"]')?.focus();
    }
  }

  function engineMonogram(engine) {
    return ({ sqlite: "S", postgres: "P", mysql: "M" })[engine] || "D";
  }

  async function changeConnection(connectionID, destination = state.route) {
    if (!connectionID || connectionID === state.connectionID) {
      if (destination === "connections") navigate("browse");
      return;
    }
    const previousConnectionID = state.connectionID;
    const previousCatalog = state.catalog;
    state.connectingID = connectionID;
    if (destination === "connections") renderConnections();
    state.snapshot = null;
    state.topology = null;
    state.topologyError = "";
    state.topologyZoom = 1;
    state.queryResult = null;
    state.queryError = "";
    try {
      await loadCatalog(connectionID, true);
      toast(`Opened ${currentConnection()?.name || "connection"}`);
      if (destination === "connections") navigate("browse");
      else renderRoute();
    } catch (error) {
      state.connectionID = previousConnectionID;
      state.catalog = previousCatalog;
      state.connectingID = "";
      toast(error.message, "error");
      if (destination === "connections") renderConnections();
    } finally {
      state.connectingID = "";
    }
  }

  function replaceConnection(connection) {
    const index = state.connections.findIndex(candidate => candidate.id === connection.id);
    if (index >= 0) state.connections[index] = connection;
    else state.connections.push(connection);
  }

  async function editConnection(connectionID) {
    try {
      const response = await api(`/api/v1/connections/${encodeURIComponent(connectionID)}/profile`);
      const profile = response.profile || {};
      state.connectionDraft = {
        ...freshConnectionDraft(),
        name: profile.name || "",
        data_source_name: profile.data_source_name || "",
        host: profile.host || "127.0.0.1",
        port: String(profile.port || 5432),
        username: profile.username || "",
        password_env: profile.password_env || "",
        secret_service: profile.secret_service || "",
        secret_account: profile.secret_account || "",
        database: profile.database || "",
        ssl_mode: profile.ssl_mode || "prefer",
      };
      state.connectionEngine = profile.engine === "postgres" ? "postgres" : "sqlite";
      state.connectionDraft.connection_url = state.connectionEngine === "postgres" ? postgresURLFromDraft(state.connectionDraft) : "";
      state.editingConnectionID = connectionID;
      state.connectionFormOpen = true;
      state.connectionAddStep = "configure";
      state.postgresFormTab = "general";
      renderConnections();
      document.getElementById("connection-name")?.focus();
    } catch (error) {
      toast(error.message, "error");
    }
  }

  async function testConnectionForm() {
    const form = document.getElementById("connection-form");
    if (!form || state.testingConnection) return;
    const errorNode = form.querySelector(".connection-form-error");
    try {
      let draft = connectionDraftFromForm(form);
      if (state.connectionEngine === "postgres") draft = normalizedPostgresDraft(draft);
      const request = state.connectionEngine === "postgres"
        ? postgresRequest(draft)
        : { name: draft.name, engine: "sqlite", data_source_name: draft.data_source_name };
      state.testingConnection = true;
      state.connectionDraft = draft;
      renderConnections();
      await api("/api/v1/connections/test", { method: "POST", body: JSON.stringify(request) });
      toast("Connection test succeeded");
    } catch (error) {
      toast(error.message, "error");
      if (errorNode) {
        errorNode.textContent = error.message;
        errorNode.hidden = false;
      }
    } finally {
      state.testingConnection = false;
      renderConnections();
    }
  }

  async function disconnectConnection(connectionID) {
    try {
      const response = await api(`/api/v1/connections/${encodeURIComponent(connectionID)}/disconnect`, { method: "POST" });
      replaceConnection(response.connection);
      if (state.connectionID === connectionID) {
        state.connectionID = "";
        state.catalog = null;
        state.snapshot = null;
      }
      toast(`Disconnected ${response.connection.name}`);
      renderConnections();
    } catch (error) {
      toast(error.message, "error");
    }
  }

  async function reconnectConnection(connectionID) {
    const connection = state.connections.find(candidate => candidate.id === connectionID);
    let password = "";
    if (connection?.engine === "postgres") {
      try {
        const response = await api(`/api/v1/connections/${encodeURIComponent(connectionID)}/profile`);
        if (!response.profile?.password_env && !response.profile?.secret_service) {
          password = window.prompt(`Password for ${connection.name} (leave blank if none)`) || "";
        }
      } catch (_) {
        password = "";
      }
    }
    state.connectingID = connectionID;
    renderConnections();
    try {
      const response = await api(`/api/v1/connections/${encodeURIComponent(connectionID)}/reconnect`, {
        method: "POST",
        body: JSON.stringify({ password }),
      });
      replaceConnection(response.connection);
      await changeConnection(connectionID, "connections");
    } catch (error) {
      state.connectingID = "";
      toast(error.message, "error");
      renderConnections();
    }
  }

  async function removeConnection(connectionID) {
    const connection = state.connections.find(candidate => candidate.id === connectionID);
    if (!connection || !window.confirm(`Remove ${connection.name}? The database itself will not be changed.`)) return;
    try {
      await api(`/api/v1/connections/${encodeURIComponent(connectionID)}`, { method: "DELETE" });
      state.connections = state.connections.filter(candidate => candidate.id !== connectionID);
      state.catalogCache.delete(connectionID);
      state.topologyCache.delete(connectionID);
      if (state.connectionID === connectionID) {
        state.connectionID = "";
        state.catalog = null;
        state.snapshot = null;
      }
      toast(`Removed ${connection.name}`);
      renderConnections();
    } catch (error) {
      toast(error.message, "error");
    }
  }

  async function runQuery() {
    if (queryEditorView) state.querySQL = queryEditorView.state.doc.toString();
    syncActiveQuery(state.querySQL);
    if (!state.connectionID) {
      toast("Select a connection first", "error");
      return;
    }
    if (!state.querySQL.trim()) {
      toast("Enter a query first", "error");
      return;
    }
    state.queryRunning = true;
    state.queryResult = null;
    state.queryError = "";
    state.queryResultMode = "results";
    renderQuery();
    try {
      state.queryResult = await api("/api/v1/query", {
        method: "POST",
        body: JSON.stringify({
          connection_id: state.connectionID,
          sql: state.querySQL,
          limit: state.settings.rowLimit,
          timeout_seconds: state.settings.statementTimeout,
        }),
      });
      state.queryHistory = [{
        id: `history-${Date.now()}`,
        name: activeQueryTab().name,
        sql: state.querySQL,
        connection_scope: connectionScope(),
        created_at: state.queryResult.captured_at || new Date().toISOString(),
      }, ...state.queryHistory].slice(0, 100);
      persistWorkspace();
    } catch (error) {
      state.queryError = error.message;
    } finally {
      state.queryRunning = false;
      renderQuery();
    }
  }

  async function explainQuery() {
    if (queryEditorView) state.querySQL = queryEditorView.state.doc.toString();
    syncActiveQuery(state.querySQL);
    if (!state.connectionID || !state.querySQL.trim()) {
      toast("Enter a query before requesting a plan", "error");
      return;
    }
    state.explainRunning = true;
    state.queryError = "";
    state.queryResultMode = "plan";
    renderQuery();
    try {
      state.explainResult = await api("/api/v1/explain", {
        method: "POST",
        body: JSON.stringify({ connection_id: state.connectionID, sql: state.querySQL, limit: state.settings.rowLimit, timeout_seconds: state.settings.statementTimeout }),
      });
    } catch (error) {
      state.queryError = error.message;
      state.explainResult = null;
      toast(error.message, "error");
    } finally {
      state.explainRunning = false;
      renderQuery();
    }
  }

  function saveActiveQuery() {
    if (queryEditorView) syncActiveQuery(queryEditorView.state.doc.toString());
    const tab = activeQueryTab();
    if (!tab.sql.trim()) {
      toast("Enter a query before saving it", "error");
      return;
    }
    const existing = state.savedQueries.find(item => item.id === `saved-${tab.id}`);
    const saved = {
      id: `saved-${tab.id}`,
      name: tab.name || "Untitled query",
      sql: tab.sql,
      connection_scope: connectionScope(),
      created_at: new Date().toISOString(),
    };
    if (existing) Object.assign(existing, saved);
    else state.savedQueries.unshift(saved);
    persistWorkspace();
    toast(`Saved ${saved.name}`);
  }

  function selectedRowObject() {
    const snapshot = state.snapshot;
    const row = snapshot?.rows[state.selectedRow];
    if (!snapshot || !row) return null;
    return Object.fromEntries(snapshot.columns.map((column, index) => [column.name, row[index]]));
  }

  async function copyText(text, success) {
    try {
      await navigator.clipboard.writeText(text);
      toast(success);
    } catch (_) {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      document.body.append(textarea);
      textarea.select();
      document.execCommand("copy");
      textarea.remove();
      toast(success);
    }
  }

  document.addEventListener("click", async event => {
    if (!event.target.closest(".connection-picker")) closeConnectionMenu();
    const nav = event.target.closest("[data-nav]");
    if (nav) {
      navigate(nav.dataset.nav);
      return;
    }

    const target = event.target.closest("[data-action]");
    if (!target) return;
    const action = target.dataset.action;

    if (action === "toggle-sidebar") {
      state.sidebarCollapsed = !state.sidebarCollapsed;
      await renderRoute();
    } else if (action === "toggle-connection-picker") {
      toggleConnectionMenu(target.closest(".connection-picker"), undefined, true);
    } else if (action === "clear-connection-search") {
      const field = target.closest(".connection-picker");
      const search = field?.querySelector("[data-connection-menu-search]");
      if (search) {
        search.value = "";
        filterConnectionMenuOptions(field, "");
        search.focus();
      }
    } else if (action === "select-connection-option") {
      closeConnectionMenu();
      await changeConnection(target.dataset.value);
    } else if (action === "select-table") {
      state.selected = { schema: target.dataset.schema, table: target.dataset.table };
      state.tableTab = "data";
      state.snapshot = null;
      state.inspectorOpen = false;
      state.tableFilters = [];
      state.tableSort = null;
      state.tableCursor = "";
      renderBrowse();
      await loadTable(true);
    } else if (action === "select-table-tab") {
      state.tableTab = target.dataset.tab;
      renderBrowse();
    } else if (action === "select-cell") {
      selectTableCell(Number(target.dataset.row), Number(target.dataset.column));
    } else if (action === "select-row") {
      selectTableCell(Number(target.dataset.row || 0), state.selectedColumn);
    } else if (action === "toggle-inspector") {
      state.inspectorOpen = !state.inspectorOpen;
      renderBrowse();
    } else if (action === "reload-table") {
      await loadTable(true);
      toast("Table preview refreshed");
    } else if (action === "toggle-data-control") {
      state.dataControl = state.dataControl === target.dataset.control ? "" : target.dataset.control;
      renderBrowse();
    } else if (action === "remove-table-filter") {
      state.tableFilters = state.tableFilters.filter(filter => String(filter.id) !== target.dataset.filter);
      state.tableCursor = "";
      await loadTable(true, "");
    } else if (action === "clear-table-filters") {
      state.tableFilters = [];
      state.tableCursor = "";
      await loadTable(true, "");
    } else if (action === "clear-table-sort") {
      state.tableSort = null;
      state.tableCursor = "";
      await loadTable(true, "");
    } else if (action === "sort-column") {
      const column = target.dataset.column;
      if (state.tableSort?.column !== column) state.tableSort = { column, direction: "asc" };
      else if (state.tableSort.direction === "asc") state.tableSort = { column, direction: "desc" };
      else state.tableSort = null;
      state.tableCursor = "";
      await loadTable(true, "");
    } else if (action === "previous-table-page") {
      await loadTable(true, state.snapshot?.previous_cursor || "");
    } else if (action === "next-table-page") {
      await loadTable(true, state.snapshot?.next_cursor || "");
    } else if (action === "refresh-catalog") {
      state.catalogCache.delete(state.connectionID);
      state.topologyCache.delete(state.connectionID);
      await loadCatalog(state.connectionID, false);
      renderBrowse();
      toast("Catalog refreshed");
    } else if (action === "refresh-topology") {
      state.topologyCache.delete(state.connectionID);
      state.topology = null;
      state.topologyError = "";
      await loadTopology(true);
      if (!state.topologyError) toast("Topology refreshed");
    } else if (action === "capture-schema") {
      try {
        await captureSchemaSnapshot();
      } catch (error) {
        toast(error.message, "error");
      }
    } else if (action === "compare-schema") {
      try {
        await compareSchemaSnapshot();
      } catch (error) {
        toast(error.message, "error");
      }
    } else if (action === "close-schema-diff") {
      state.schemaDiff = null;
      renderTopology();
    } else if (action === "copy-schema-diff") {
      const content = target.dataset.format === "json"
        ? JSON.stringify(state.schemaDiff, null, 2)
        : schemaDiffMarkdown(state.schemaDiff);
      await copyText(content, `Schema diff copied as ${target.dataset.format === "json" ? "JSON" : "Markdown"}`);
    } else if (action === "toggle-topology-table") {
      const next = new Set(state.topologyExpanded);
      if (next.has(target.dataset.id)) next.delete(target.dataset.id);
      else next.add(target.dataset.id);
      state.topologyExpanded = next;
      renderTopology();
    } else if (action === "toggle-all-topology-tables") {
      state.topologyExpanded = state.topologyExpanded.size === state.topology.tables.length
        ? new Set()
        : new Set(state.topology.tables.map(table => table.id));
      renderTopology();
    } else if (action === "zoom-topology") {
      const delta = target.dataset.direction === "in" ? .1 : -.1;
      state.topologyZoom = Math.min(1.4, Math.max(.7, Number((state.topologyZoom + delta).toFixed(1))));
      renderTopology();
    } else if (action === "reset-topology-zoom") {
      state.topologyZoom = 1;
      renderTopology();
    } else if (action === "open-topology-table") {
      state.selected = { schema: target.dataset.schema, table: target.dataset.table };
      state.tableTab = "data";
      state.snapshot = null;
      navigate("browse");
      await loadTable(true);
    } else if (action === "copy-table-name") {
      await copyText(`${state.selected.schema}.${state.selected.table}`, "Table name copied");
    } else if (action === "toggle-object-pin") {
      toggleSelectedObjectPin();
    } else if (action === "query-table") {
      newQueryTab(`SELECT *\nFROM ${quoteIdentifier(state.selected.schema)}.${quoteIdentifier(state.selected.table)}\nLIMIT ${state.settings.rowLimit};`, `${state.selected.table}.sql`);
      navigate("query");
    } else if (action === "open-related") {
      await openRelatedRelationship(target.dataset.relationship, target.dataset.direction);
    } else if (action === "open-related-cell") {
      state.selectedRow = Number(target.dataset.row || 0);
      await openRelatedRelationship(target.dataset.relationship, "outgoing");
    } else if (action === "back-related") {
      await backRelatedNavigation();
    } else if (action === "copy-row") {
      await copyText(JSON.stringify(selectedRowObject(), null, 2), "Row copied as JSON");
    } else if (action === "copy-where") {
      const snapshot = state.snapshot;
      const row = snapshot?.rows[state.selectedRow];
      const parts = (snapshot?.primary_key || []).map(key => {
        const index = snapshot.columns.findIndex(column => column.name === key);
        const value = row?.[index];
        return `${quoteIdentifier(key)} = ${typeof value === "number" ? value : `'${String(value).replaceAll("'", "''")}'`}`;
      });
      await copyText(parts.length ? `WHERE ${parts.join(" AND ")}` : "-- No primary key reported", "WHERE clause copied");
    } else if (action === "new-query-tab") {
      newQueryTab();
      renderQuery();
    } else if (action === "select-query-tab") {
      activateQueryTab(target.dataset.queryTab);
    } else if (action === "close-query-tab") {
      closeQueryTab(target.dataset.queryTab);
    } else if (action === "save-query") {
      saveActiveQuery();
    } else if (action === "toggle-query-history") {
      state.workspacePanel = state.workspacePanel === "history" ? "" : "history";
      renderQuery();
    } else if (action === "toggle-saved-queries") {
      state.workspacePanel = state.workspacePanel === "saved" ? "" : "saved";
      renderQuery();
    } else if (action === "close-query-library") {
      state.workspacePanel = "";
      renderQuery();
    } else if (action === "open-saved-query" || action === "open-history-query") {
      const source = action === "open-saved-query" ? state.savedQueries : state.queryHistory;
      const item = source.find(candidate => candidate.id === target.dataset.queryId);
      if (item) {
        newQueryTab(item.sql, item.name);
        state.workspacePanel = "";
        renderQuery();
      }
    } else if (action === "remove-saved-query") {
      state.savedQueries = state.savedQueries.filter(item => item.id !== target.dataset.queryId);
      persistWorkspace();
      renderQuery();
    } else if (action === "show-query-results") {
      state.queryResultMode = "results";
      renderQuery();
    } else if (action === "show-query-plan") {
      state.queryResultMode = "plan";
      renderQuery();
    } else if (action === "explain-query") {
      await explainQuery();
    } else if (action === "run-query") {
      await runQuery();
    } else if (action === "format-query") {
      if (queryEditorView) {
        const value = queryEditorView.state.doc.toString()
          .replace(/\s+from\s+/ig, "\nFROM ")
          .replace(/\s+where\s+/ig, "\nWHERE ")
          .replace(/\s+order\s+by\s+/ig, "\nORDER BY ")
          .replace(/\s+limit\s+/ig, "\nLIMIT ");
        const anchor = Math.min(queryEditorView.state.selection.main.head, value.length);
        queryEditorView.dispatch({
          changes: { from: 0, to: queryEditorView.state.doc.length, insert: value },
          selection: { anchor },
        });
        queryEditorView.focus();
      }
    } else if (action === "copy-results") {
      const result = state.queryResult;
      const objects = result.rows.map(row => Object.fromEntries(result.columns.map((column, index) => [column.name, row[index]])));
      await copyText(JSON.stringify(objects, null, 2), "Query results copied");
    } else if (action === "use-connection") {
      await changeConnection(target.dataset.connection, "connections");
    } else if (action === "edit-connection") {
      await editConnection(target.dataset.connection);
    } else if (action === "test-connection") {
      await testConnectionForm();
    } else if (action === "disconnect-connection") {
      await disconnectConnection(target.dataset.connection);
    } else if (action === "reconnect-connection") {
      await reconnectConnection(target.dataset.connection);
    } else if (action === "remove-connection") {
      await removeConnection(target.dataset.connection);
    } else if (action === "show-connection-form") {
      state.connectionFormOpen = true;
      resetConnectionAddFlow();
      renderConnections();
      document.getElementById("connection-string-entry")?.focus();
    } else if (action === "choose-connection-engine") {
      state.connectionEngine = target.dataset.engine === "postgres" ? "postgres" : "sqlite";
      state.connectionAddStep = "configure";
      if (state.connectionEngine === "postgres") {
        state.postgresFormTab = "general";
        state.connectionDraft.connection_url = postgresURLFromDraft(state.connectionDraft);
      }
      state.connectionEntryError = "";
      state.postgresDiscoveryError = "";
      renderConnections();
      document.getElementById("connection-name")?.focus();
    } else if (action === "back-to-connection-types") {
      state.connectionDraft = connectionDraftFromForm();
      if (state.connectionEngine === "postgres") {
        state.connectionDraft.connection_url = postgresURLFromDraft(state.connectionDraft);
        state.connectionEntryURL = state.connectionDraft.connection_url;
      }
      state.connectionEntryError = "";
      state.connectionAddStep = "choose";
      renderConnections();
      document.getElementById("connection-string-entry")?.focus();
    } else if (action === "discover-postgres-databases") {
      await discoverPostgresDatabases();
    } else if (action === "select-postgres-form-tab") {
      state.connectionDraft = connectionDraftFromForm();
      state.connectionDraft.connection_url = postgresURLFromDraft(state.connectionDraft);
      state.postgresFormTab = target.dataset.postgresTab === "security" ? "security" : "general";
      renderConnections();
      document.querySelector(`[data-postgres-tab="${state.postgresFormTab}"]`)?.focus();
    } else if (action === "cancel-connection-form") {
      state.connectionFormOpen = false;
      resetConnectionAddFlow();
      renderConnections();
    }
  });

  document.addEventListener("submit", async event => {
    if (event.target.id === "table-filter-form") {
      event.preventDefault();
      const fields = new FormData(event.target);
      const operator = String(fields.get("operator") || "contains");
      state.filterSerial += 1;
      state.tableFilters = [...state.tableFilters, {
        id: state.filterSerial,
        column: String(fields.get("column") || ""),
        operator,
        value: ["is-null", "is-not-null"].includes(operator) ? "" : String(fields.get("value") || ""),
      }];
      state.tableCursor = "";
      await loadTable(true, "");
      return;
    }
    if (event.target.id === "table-sort-form") {
      event.preventDefault();
      const fields = new FormData(event.target);
      state.tableSort = {
        column: String(fields.get("column") || ""),
        direction: String(fields.get("direction") || "asc") === "desc" ? "desc" : "asc",
      };
      state.tableCursor = "";
      await loadTable(true, "");
      return;
    }
    if (event.target.id === "connection-entry-form") {
      event.preventDefault();
      applyConnectionEntryURL(event.target.elements.connection_string.value, true);
      return;
    }
    if (event.target.id !== "connection-form") return;
    event.preventDefault();
    const form = event.target;
    const submit = form.querySelector('button[type="submit"]');
    const errorNode = form.querySelector(".connection-form-error");
    let draft = connectionDraftFromForm(form);
    if (state.connectionEngine === "postgres") {
      try {
        draft = normalizedPostgresDraft(draft);
      } catch (error) {
        errorNode.textContent = `${error.message}. Correct the connection URL or edit the fields below.`;
        errorNode.hidden = false;
        setPostgresURLStatus(error.message, "error-copy");
        return;
      }
      const requiredPostgresFields = [
        ["host", "host"],
        ["port", "port"],
        ["username", "username"],
        ["database", "database"],
      ];
      const missing = requiredPostgresFields.find(([name]) => !String(draft[name] || "").trim());
      if (missing) {
        state.connectionDraft = draft;
        state.postgresFormTab = "general";
        renderConnections();
        const generalForm = document.getElementById("connection-form");
        const generalError = generalForm?.querySelector(".connection-form-error");
        if (generalError) {
          generalError.textContent = `Enter the PostgreSQL ${missing[1]} before connecting.`;
          generalError.hidden = false;
        }
        generalForm?.elements[missing[0]]?.focus();
        return;
      }
    }
    state.connectionDraft = draft;
    submit.disabled = true;
    submit.textContent = "Connecting…";
    errorNode.hidden = true;
    try {
      const request = state.connectionEngine === "postgres"
        ? postgresRequest(draft)
        : {
            name: draft.name,
            engine: "sqlite",
            data_source_name: draft.data_source_name,
          };
      const editingID = state.editingConnectionID;
      const response = await api(editingID ? `/api/v1/connections/${encodeURIComponent(editingID)}` : "/api/v1/connections", {
        method: editingID ? "PUT" : "POST",
        body: JSON.stringify(request),
      });
      const connection = response.connection;
      replaceConnection(connection);
      state.connectionID = connection.id;
      state.connectionFormOpen = false;
      state.connectionAddStep = "choose";
      state.snapshot = null;
      state.queryResult = null;
      state.queryError = "";
      state.connectionDraft.password = "";
      state.editingConnectionID = "";
      state.postgresDatabases = [];
      await loadCatalog(connection.id, true);
      const persisted = connection.engine === "sqlite" && state.meta?.features?.connection_persistence;
      toast(`${editingID ? "Updated" : persisted ? "Saved" : "Opened"} ${connection.name}`);
      navigate("browse");
    } catch (error) {
      errorNode.textContent = state.connectionEngine === "postgres"
        ? `${error.message}. Check the endpoint, credentials, database, and SSL mode.`
        : `${error.message}. Check the file path and try again.`;
      errorNode.hidden = false;
      submit.disabled = false;
      submit.textContent = state.editingConnectionID ? "Save changes" : "Add and connect";
    }
  });

  document.addEventListener("change", async event => {
    if (event.target.matches('[data-setting="row-limit"]')) {
      const limit = Number(event.target.value);
      if ([50, 100, 250, 500, 1000].includes(limit)) {
        state.settings.rowLimit = limit;
        persistWorkspace();
      }
    } else if (event.target.matches('[data-setting="statement-timeout"]')) {
      const timeout = Number(event.target.value);
      if ([5, 10, 15].includes(timeout)) {
        state.settings.statementTimeout = timeout;
        persistWorkspace();
      }
    } else if (event.target.id === "connection-picker") {
      await changeConnection(event.target.value);
    } else if (event.target.id === "mobile-object-picker") {
      const [schemaIndex, tableIndex] = String(event.target.value || "").split(":").map(Number);
      const table = state.catalog?.schemas?.[schemaIndex]?.tables?.[tableIndex];
      if (table) {
        state.selected = { schema: table.schema, table: table.name };
        state.tableTab = "data";
        state.snapshot = null;
        state.inspectorOpen = false;
        state.tableFilters = [];
        state.tableSort = null;
        state.tableCursor = "";
        renderBrowse();
        await loadTable(true);
      }
    } else if (event.target.id === "connection-string-entry") {
      applyConnectionEntryURL(event.target.value, true);
    } else if (event.target.id === "postgres-url") {
      applyPostgresURLToForm(event.target.value, true);
    } else if (
      event.target.form?.id === "connection-form" &&
      state.connectionEngine === "postgres" &&
      ["host", "port", "username", "password", "password_env", "secret_service", "secret_account", "database", "ssl_mode"].includes(event.target.name)
    ) {
      syncPostgresURLFromForm();
    }
  });

  document.addEventListener("input", event => {
    if (event.target.matches("[data-query-name]")) {
      activeQueryTab().name = String(event.target.value || "Untitled query").slice(0, 80);
      persistWorkspace();
      const tabLabel = document.querySelector(`[data-query-tab="${CSS.escape(state.activeQueryTabID)}"] span`)?.nextSibling;
      if (tabLabel) tabLabel.textContent = activeQueryTab().name;
    } else if (event.target.matches("[data-connection-menu-search]")) {
      filterConnectionMenuOptions(event.target.closest(".connection-picker"), event.target.value);
    } else if (event.target.id === "catalog-search") {
      state.catalogSearch = event.target.value;
      const position = event.target.selectionStart;
      renderBrowse();
      const input = document.getElementById("catalog-search");
      input?.focus();
      if (input) input.selectionStart = input.selectionEnd = position;
    } else if (event.target.id === "table-search") {
      state.tableSearch = event.target.value;
      const position = event.target.selectionStart;
      renderBrowse();
      const input = document.getElementById("table-search");
      input?.focus();
      if (input) input.selectionStart = input.selectionEnd = position;
    } else if (event.target.id === "connection-string-entry") {
      state.connectionEntryURL = event.target.value;
      if (["insertFromPaste", "insertFromDrop"].includes(event.inputType)) {
        applyConnectionEntryURL(event.target.value, true);
      } else {
        clearTimeout(state.connectionEntryTimer);
        const value = event.target.value;
        state.connectionEntryTimer = setTimeout(() => applyConnectionEntryURL(value, false, false), 240);
      }
    } else if (event.target.id === "postgres-url") {
      if (["insertFromPaste", "insertFromDrop"].includes(event.inputType)) {
        applyPostgresURLToForm(event.target.value, true);
      } else {
        clearTimeout(state.postgresURLTimer);
        const value = event.target.value;
        state.postgresURLTimer = setTimeout(() => applyPostgresURLToForm(value, false, false), 240);
      }
    } else if (
      event.target.form?.id === "connection-form" &&
      state.connectionEngine === "postgres" &&
      ["host", "port", "username", "password", "password_env", "secret_service", "secret_account", "database"].includes(event.target.name)
    ) {
      syncPostgresURLFromForm(false);
    }
  });

  document.addEventListener("pointerover", event => {
    const target = event.target.closest?.("[data-cell-preview]");
    if (target) queueCellValuePreview(target);
  });

  document.addEventListener("pointerout", event => {
    const target = event.target.closest?.("[data-cell-preview]");
    if (target && !target.contains(event.relatedTarget) && !cellValuePreview?.contains(event.relatedTarget)) hideCellValuePreview();
  });

  cellValuePreview?.addEventListener("pointerleave", event => {
    if (!event.relatedTarget?.closest?.("[data-cell-preview]")) hideCellValuePreview();
  });
  document.addEventListener("pointerdown", event => {
    if (!cellValuePreview?.contains(event.target)) hideCellValuePreview();
  });
  document.addEventListener("scroll", event => {
    if (!cellValuePreview?.contains(event.target)) hideCellValuePreview();
  }, true);

  document.addEventListener("keydown", async event => {
    if (event.key === "Escape") hideCellValuePreview();
    const tableCell = event.target.closest?.(".data-cell");
    if (tableCell && ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key) && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault();
      moveTableCell(tableCell, event.key);
      return;
    }
    if (event.target.matches?.('[role="tab"][data-postgres-tab]') && ["ArrowLeft", "ArrowRight"].includes(event.key)) {
      event.preventDefault();
      const nextTab = event.target.dataset.postgresTab === "general" ? "security" : "general";
      document.querySelector(`[data-postgres-tab="${nextTab}"]`)?.click();
      return;
    }
    const connectionField = event.target.closest?.(".connection-picker");
    if (!connectionField) return;
    const menu = connectionField.querySelector(".connection-menu");
    const options = [...connectionField.querySelectorAll(".connection-menu-option")].filter(option => !option.hidden);
    const option = event.target.closest(".connection-menu-option");
    const optionIndex = options.indexOf(option);
    const search = event.target.closest("[data-connection-menu-search]");
    if (event.key === "Escape" && menu && !menu.hidden) {
      event.preventDefault();
      closeConnectionMenu(true);
      return;
    }
    if (search && ["ArrowDown", "ArrowUp"].includes(event.key) && options.length) {
      event.preventDefault();
      options[event.key === "ArrowDown" ? 0 : options.length - 1]?.focus();
      return;
    }
    if (search && event.key === "Enter" && options.length) {
      event.preventDefault();
      options[0].click();
      return;
    }
    if (event.target.matches(".connection-menu-trigger") && event.key.length === 1 && event.key !== " " && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault();
      toggleConnectionMenu(connectionField, true);
      focusConnectionMenuSearch(connectionField, event.key);
      return;
    }
    if (event.target.matches(".connection-menu-trigger") && ["ArrowDown", "ArrowUp"].includes(event.key)) {
      event.preventDefault();
      toggleConnectionMenu(connectionField, true);
      requestAnimationFrame(() => {
        const selected = options.find(item => item.classList.contains("selected"));
        (selected || options[event.key === "ArrowDown" ? 0 : options.length - 1])?.focus();
      });
      return;
    }
    if (option && options.length && ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      let nextIndex = optionIndex;
      if (event.key === "ArrowDown") nextIndex = (optionIndex + 1) % options.length;
      if (event.key === "ArrowUp") nextIndex = (optionIndex - 1 + options.length) % options.length;
      if (event.key === "Home") nextIndex = 0;
      if (event.key === "End") nextIndex = options.length - 1;
      options[nextIndex]?.focus();
    }
  });

  document.addEventListener("focusin", event => {
    if (!event.target.closest(".connection-picker")) closeConnectionMenu();
    const target = event.target.closest?.("[data-cell-preview]");
    if (target) queueCellValuePreview(target);
  });
  document.addEventListener("focusout", event => {
    if (event.target.closest?.("[data-cell-preview]")) hideCellValuePreview();
  });
  window.addEventListener("resize", () => {
    closeConnectionMenu();
    hideCellValuePreview();
  });
  window.addEventListener("hashchange", renderRoute);
  bootstrap();
})();
