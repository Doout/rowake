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

(() => {
  "use strict";

  const app = document.getElementById("app");
  const toastRoot = document.getElementById("toast-root");
  const cspNonce = document.querySelector('meta[name="csp-nonce"]')?.content || "";
  const queryLanguage = new Compartment();
  let queryEditorView = null;
  let pendingValueFormats = [];
  let valueFormatFrame = 0;
  let valueFormatIdle = 0;
  let valueFormatIdleKind = "";
  let valueFormatGeneration = 0;
  let valueFormatSerial = 0;
  const valueFormatBudgetMS = 4;
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
    inspectorOpen: false,
    sidebarCollapsed: window.matchMedia("(max-width: 980px)").matches,
    tableTab: "data",
    tableSearch: "",
    tableFilters: [],
    tableSort: null,
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
      database: "",
      ssl_mode: "disable",
    },
    postgresDatabases: [],
    postgresDiscoveryLoading: false,
    postgresDiscoveryError: "",
    postgresFormTab: "general",
    postgresURLTimer: 0,
    connectingID: "",
    settings: { rowLimit: 100, statementTimeout: 15 },
  };

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
    element.className = valueFormatClass(formatted);
    element.textContent = formatted.display;
    if (formatted.changed) {
      element.title = `Raw value: ${formatted.raw}`;
      element.setAttribute("aria-label", `${formatted.display}. Raw value: ${formatted.raw}`);
    } else {
      element.removeAttribute("title");
      element.removeAttribute("aria-label");
    }
  }

  function applyInspectorFormat(element, formatted) {
    const display = formatted.kind === "json" && formatted.pretty
      ? `<pre>${html(formatted.pretty)}</pre>`
      : `<span class="${valueFormatClass(formatted, false)}">${html(formatted.display)}</span>`;
    const raw = formatted.rawDiffers
      ? `<details class="raw-value"><summary>Raw value</summary><code>${html(formatted.raw)}</code></details>`
      : "";
    element.className = "inspector-value";
    element.innerHTML = `${display}${raw}`;
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
    }
    if (state.selected.table) await loadTable(false);
  }

  async function loadTable(render = true) {
    if (!state.connectionID || !state.selected.table) return;
    state.tableLoading = true;
    if (render && state.route === "browse") renderBrowse();
    try {
      const params = new URLSearchParams({
        connection_id: state.connectionID,
        schema: state.selected.schema,
        table: state.selected.table,
        limit: String(state.settings.rowLimit),
      });
      state.snapshot = await api(`/api/v1/table?${params}`);
      state.selectedRow = 0;
      state.inspectorOpen = false;
      state.tableSearch = "";
      state.tableFilters = [];
      state.tableSort = null;
      state.dataControl = "";
      state.querySQL = `SELECT *\nFROM ${quoteIdentifier(state.selected.schema)}.${quoteIdentifier(state.selected.table)}\nLIMIT ${state.settings.rowLimit};`;
    } catch (error) {
      state.snapshot = null;
      toast(error.message, "error");
    } finally {
      state.tableLoading = false;
      if (render && state.route === "browse") renderBrowse();
    }
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
        <div class="database-workbench ${hasInspector ? "has-inspector" : ""}">
          ${renderCatalogRail()}
          ${renderTableSurface()}
          ${hasInspector ? renderRowInspector() : ""}
        </div>
      </section>`;
    shell(body, "browse", { workspace: true });
  }

  function renderCatalogRail() {
    const schemas = state.catalog?.schemas || [];
    const search = state.catalogSearch.toLowerCase().trim();
    return `<aside class="catalog-rail" aria-label="Database objects">
      <div class="rail-header">
        <strong>Objects</strong>
      </div>
      <div class="rail-search"><span>⌕</span><input id="catalog-search" type="search" placeholder="Filter objects" value="${html(state.catalogSearch)}"></div>
      <div class="catalog-tree">
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
          <button type="button" class="btn small" data-action="copy-table-name">Copy name</button>
          <button type="button" class="btn small" data-nav="query">Query</button>
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
    const columnIndexes = new Map(snapshot.columns.map((column, index) => [column.name, index]));
    const rows = snapshot.rows.map((row, index) => ({ row, index })).filter(({ row }) => {
      if (term && !row.some(value => String(value ?? "null").toLowerCase().includes(term))) return false;
      return state.tableFilters.every(filter => {
        const columnIndex = columnIndexes.get(filter.column);
        return columnIndex !== undefined && valueMatchesFilter(row[columnIndex], filter);
      });
    });
    if (state.tableSort) {
      const columnIndex = columnIndexes.get(state.tableSort.column);
      if (columnIndex !== undefined) {
        const direction = state.tableSort.direction === "desc" ? -1 : 1;
        rows.sort((left, right) => {
          const comparison = compareValues(left.row[columnIndex], right.row[columnIndex]);
          return comparison === 0 ? left.index - right.index : comparison * direction;
        });
      }
    }
    return rows;
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
    const selectedVisible = rows.some(item => item.index === state.selectedRow);
    if (!selectedVisible && rows.length) state.selectedRow = rows[0].index;
    return `<div class="data-instrument">
      <div class="data-toolbar">
        <div class="row-search"><span>⌕</span><input id="table-search" type="search" placeholder="Filter loaded rows" value="${html(state.tableSearch)}"></div>
        <div class="data-controls">
          <button type="button" class="btn small toolbar-button ${state.dataControl === "filter" ? "active" : ""}" data-action="toggle-data-control" data-control="filter">Filter${state.tableFilters.length ? `<span class="toolbar-count">${state.tableFilters.length}</span>` : ""}</button>
          <button type="button" class="btn small toolbar-button ${state.dataControl === "sort" ? "active" : ""}" data-action="toggle-data-control" data-control="sort">Sort${state.tableSort ? `<span class="sort-direction">${state.tableSort.direction === "desc" ? "↓" : "↑"}</span>` : ""}</button>
          <span class="read-scope">${state.settings.rowLimit} row preview</span>
          <button type="button" class="btn small" data-action="reload-table">↻ Reload</button>
        </div>
      </div>
      ${renderDataControl(snapshot)}
      <div class="grid-scroll">
        <table class="result-grid">
          <thead><tr><th class="row-number-head">#</th>${snapshot.columns.map(column => `<th><button type="button" class="column-header-control" data-action="sort-column" data-column="${html(column.name)}"><span>${html(column.name)}${state.tableSort?.column === column.name ? `<i>${state.tableSort.direction === "desc" ? "↓" : "↑"}</i>` : ""}</span><small>${html(column.data_type)}</small></button></th>`).join("")}</tr></thead>
          <tbody>
            ${rows.map(({ row, index }, visibleIndex) => `<tr class="selectable-row ${index === state.selectedRow ? "selected" : ""}" data-action="select-row" data-row="${index}">
              <td class="row-number">${visibleIndex + 1}</td>
              ${row.map((value, columnIndex) => `<td>${formatCell(value, snapshot.columns[columnIndex])}</td>`).join("")}
            </tr>`).join("") || `<tr><td class="grid-empty" colspan="${snapshot.columns.length + 1}">No loaded rows match the current search and filters.</td></tr>`}
          </tbody>
        </table>
      </div>
      <footer class="result-status">
        <div><span class="status-light good"></span><strong>${rows.length}</strong> shown · ${fullNumber(snapshot.total_rows)} total rows</div>
        <div><span>${snapshot.duration_ms} ms</span><i></i><span>${snapshot.truncated ? "bounded result" : "complete result"}</span><i></i><span>${snapshot.capabilities.can_write ? "write enabled" : "read-only"}</span></div>
      </footer>
    </div>`;
  }

  function formatCell(value, column = {}) {
    const pending = queueValueFormat(value, column, "cell");
    const nullState = value === null || value === undefined ? " null-value" : "";
    return `<span id="${pending.id}" class="formatted-value value-format-pending${nullState}">${html(pending.raw)}</span>`;
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

  function renderRowInspector() {
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
      <dl class="row-fields">
        ${snapshot.columns.map((column, index) => `<div class="row-field">
          <dt><span>${html(column.name)}</span><small>${html(column.data_type)}</small></dt>
          <dd>${inspectorValue(row[index], column)}</dd>
        </div>`).join("")}
      </dl>
      <footer class="inspector-foot"><span class="lock-mark">⌑</span><span>Read-only</span></footer>
    </aside>`;
  }

  function inspectorValue(value, column = {}) {
    const pending = queueValueFormat(value, column, "inspector");
    return `<div id="${pending.id}" class="inspector-value value-format-pending"><span>${html(pending.raw)}</span></div>`;
  }

  async function loadTopology(force = false) {
    if (!state.connectionID || state.topologyLoading) return;
    state.topologyLoading = true;
    state.topologyError = "";
    try {
      let topology = !force ? state.topologyCache.get(state.connectionID) : null;
      if (!topology) {
        topology = await api(`/api/v1/topology?connection_id=${encodeURIComponent(state.connectionID)}`);
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
        <div class="workspace-identity"><span class="eyebrow">Schema map</span><div class="workspace-title-row"><h1 class="workspace-title">${html(connection.database)}</h1><span class="status good">live schema</span></div></div>
        <div class="header-actions">${connectionPicker()}<button type="button" class="btn" data-action="refresh-topology">↻ <span>Refresh</span></button><button type="button" class="btn primary" data-nav="browse">Browse data</button></div>
      </header>
      <div class="command-strip">
        <div class="breadcrumb"><span>${html(engineLabel(connection.engine))}</span><i>/</i><strong>${html(connection.database)}</strong><i>/</i><span>${connection.engine === "sqlite" ? "main" : "all schemas"}</span></div>
        <div class="command-signals"><span><i class="signal-dot"></i>Introspected from database</span><span>${topology.relationships.length} foreign keys</span></div>
      </div>
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
    const result = state.queryResult;
    const editorValue = state.querySQL || "SELECT 1 AS result;";
    const body = `<section class="workspace query-page">
      <header class="workspace-header">
        <div class="workspace-identity"><span class="eyebrow">SQL workspace</span><div class="workspace-title-row"><h1 class="workspace-title">Query</h1><span class="status info">read-only</span></div></div>
        <div class="header-actions">${connectionPicker()}<button type="button" class="btn" data-action="format-query">Format</button><button type="button" class="btn primary" data-action="run-query" ${state.queryRunning ? "disabled" : ""}>${state.queryRunning ? "Running…" : "▶ Run"}</button></div>
      </header>
      <div class="command-strip">
        <div class="breadcrumb"><span>${html(connection?.name || "No connection")}</span><i>/</i><strong>scratch.sql</strong></div>
        <div class="command-signals"><span><i class="signal-dot"></i>Cmd/Ctrl + Enter to run</span><span>${state.settings.statementTimeout}s timeout</span><span>${state.settings.rowLimit} row cap</span></div>
      </div>
      <div class="query-workbench">
        <section class="query-editor-panel">
          <header class="editor-header"><div><span class="editor-dot"></span><strong>scratch.sql</strong></div><span>${html(engineLabel(connection?.engine || "SQL"))}</span></header>
          <div id="query-editor" class="sql-editor"></div>
          <footer id="query-editor-help" class="editor-foot"><div><span>UTF-8</span><span>${html(engineLabel(connection.engine))} SQL</span><span>Read-only guard active</span></div><div><span>Ctrl+Space suggestions</span><span>Tab to complete</span></div></footer>
        </section>
        <section class="query-results-panel">
          <header class="query-results-header"><div><strong>Results</strong>${result ? `<span>${result.row_count} rows</span>` : ""}</div><div>${result ? `<span>${result.duration_ms} ms</span><button class="btn small" type="button" data-action="copy-results">Copy JSON</button>` : ""}</div></header>
          ${renderQueryResult()}
        </section>
      </div>
    </section>`;
    shell(body, "query", { workspace: true });
    mountQueryEditor(editorValue);
    if ((!state.topology || state.topology.connection_id !== state.connectionID) && !state.topologyLoading) loadTopology();
  }

  function renderQueryResult() {
    if (state.queryRunning) return `<div class="query-running"><span class="loading-track"><i></i></span><strong>Running statement</strong><small>The result remains bounded by the current row limit.</small></div>`;
    if (state.queryError) return `<div class="query-error"><span>!</span><div><strong>Query failed</strong><pre>${html(state.queryError)}</pre></div></div>`;
    const result = state.queryResult;
    if (!result) return `<div class="query-empty"><span class="empty-glyph">⌁</span><strong>No results</strong><p>Run a statement to see its result.</p></div>`;
    return `<div class="query-result-instrument"><div class="grid-scroll"><table class="result-grid"><thead><tr><th class="row-number-head">#</th>${result.columns.map(column => `<th><span>${html(column.name)}</span><small>${html(column.data_type)}</small></th>`).join("")}</tr></thead><tbody>${result.rows.map((row, index) => `<tr><td class="row-number">${index + 1}</td>${row.map((value, columnIndex) => `<td>${formatCell(value, result.columns[columnIndex])}</td>`).join("")}</tr>`).join("")}</tbody></table></div><footer class="result-status"><div><span class="status-light good"></span><strong>${result.row_count}</strong> rows returned</div><div><span>${result.duration_ms} ms</span><i></i><span>${result.truncated ? "bounded result" : "complete result"}</span><i></i><span>read-only</span></div></footer></div>`;
  }

  function renderConnections() {
    const hasConnections = state.connections.length > 0;
    const showForm = !hasConnections || state.connectionFormOpen;
    const configuring = showForm && state.connectionAddStep === "configure";
    const heading = !showForm
      ? "Choose a database"
      : configuring
        ? state.connectionEngine === "postgres" ? "Connect to PostgreSQL" : "Open a SQLite database"
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
              <span class="ready-signal"><i></i>${active ? "In use" : "Ready"}</span>
              <small>${connection.read_only ? "Read-only" : "Read/write"}</small>
            </div>
            <button class="btn ${active ? "" : "primary"}" type="button" data-action="use-connection" data-connection="${html(connection.id)}" ${connecting ? "disabled" : ""}>
              ${connecting ? "Connecting…" : active ? "Continue" : "Connect"}
            </button>
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
    return `<section class="connection-editor" aria-label="Connection details">
      <form id="connection-form" class="${postgres ? "postgres-form" : "sqlite-form"}">
        <div class="connection-setup-heading">
          <button type="button" class="connection-back-link" data-action="back-to-connection-types"><span aria-hidden="true">←</span> Database types</button>
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
            <button type="button" class="btn" data-action="back-to-connection-types">Back</button>
            <button type="submit" class="btn primary">Add and connect</button>
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
    const password = String(draft.password || "");
    const credentials = username
      ? `${encodeURIComponent(username)}${password ? `:${encodeURIComponent(password)}` : ""}@`
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

  async function runQuery() {
    if (queryEditorView) state.querySQL = queryEditorView.state.doc.toString();
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
    renderQuery();
    try {
      state.queryResult = await api("/api/v1/query", {
        method: "POST",
        body: JSON.stringify({
          connection_id: state.connectionID,
          sql: state.querySQL,
          limit: state.settings.rowLimit,
        }),
      });
    } catch (error) {
      state.queryError = error.message;
    } finally {
      state.queryRunning = false;
      renderQuery();
    }
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
      renderBrowse();
      await loadTable(true);
    } else if (action === "select-table-tab") {
      state.tableTab = target.dataset.tab;
      renderBrowse();
    } else if (action === "select-row") {
      state.selectedRow = Number(target.dataset.row || 0);
      renderBrowse();
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
      renderBrowse();
    } else if (action === "clear-table-filters") {
      state.tableFilters = [];
      renderBrowse();
    } else if (action === "clear-table-sort") {
      state.tableSort = null;
      renderBrowse();
    } else if (action === "sort-column") {
      const column = target.dataset.column;
      if (state.tableSort?.column !== column) state.tableSort = { column, direction: "asc" };
      else if (state.tableSort.direction === "asc") state.tableSort = { column, direction: "desc" };
      else state.tableSort = null;
      renderBrowse();
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
      renderBrowse();
      return;
    }
    if (event.target.id === "table-sort-form") {
      event.preventDefault();
      const fields = new FormData(event.target);
      state.tableSort = {
        column: String(fields.get("column") || ""),
        direction: String(fields.get("direction") || "asc") === "desc" ? "desc" : "asc",
      };
      renderBrowse();
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
      const response = await api("/api/v1/connections", {
        method: "POST",
        body: JSON.stringify(request),
      });
      const connection = response.connection;
      state.connections.push(connection);
      state.connectionID = connection.id;
      state.connectionFormOpen = false;
      state.connectionAddStep = "choose";
      state.snapshot = null;
      state.queryResult = null;
      state.queryError = "";
      state.connectionDraft.password = "";
      state.postgresDatabases = [];
      await loadCatalog(connection.id, true);
      const persisted = connection.engine === "sqlite" && state.meta?.features?.connection_persistence;
      toast(`${persisted ? "Saved" : "Opened"} ${connection.name}`);
      navigate("browse");
    } catch (error) {
      errorNode.textContent = state.connectionEngine === "postgres"
        ? `${error.message}. Check the endpoint, credentials, database, and SSL mode.`
        : `${error.message}. Check the file path and try again.`;
      errorNode.hidden = false;
      submit.disabled = false;
      submit.textContent = "Add and connect";
    }
  });

  document.addEventListener("change", async event => {
    if (event.target.id === "connection-picker") {
      await changeConnection(event.target.value);
    } else if (event.target.id === "connection-string-entry") {
      applyConnectionEntryURL(event.target.value, true);
    } else if (event.target.id === "postgres-url") {
      applyPostgresURLToForm(event.target.value, true);
    } else if (
      event.target.form?.id === "connection-form" &&
      state.connectionEngine === "postgres" &&
      ["host", "port", "username", "password", "database", "ssl_mode"].includes(event.target.name)
    ) {
      syncPostgresURLFromForm();
    }
  });

  document.addEventListener("input", event => {
    if (event.target.matches("[data-connection-menu-search]")) {
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
      ["host", "port", "username", "password", "database"].includes(event.target.name)
    ) {
      syncPostgresURLFromForm(false);
    }
  });

  document.addEventListener("keydown", async event => {
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
  });
  window.addEventListener("resize", () => closeConnectionMenu());
  window.addEventListener("hashchange", renderRoute);
  bootstrap();
})();
