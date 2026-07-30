import assert from "node:assert/strict";
import test from "node:test";

import { formatDatabaseValue } from "./value-formatters.mjs";

const fixedLocale = { locale: "en-US", timeZone: "UTC" };

test("formats timestamps with timezone for the viewer and preserves the raw value", () => {
  const raw = "2026-07-14T18:48:08.217034-04:00";
  const formatted = formatDatabaseValue(raw, { data_type: "timestamp with time zone" }, fixedLocale);

  assert.equal(formatted.kind, "datetime");
  assert.match(formatted.display, /Jul 14, 2026/);
  assert.match(formatted.display, /10:48:08\.217 PM/);
  assert.match(formatted.display, /UTC/);
  assert.equal(formatted.raw, raw);
  assert.equal(formatted.rawDiffers, true);
});

test("keeps timezone-free timestamps as floating database time", () => {
  const formatted = formatDatabaseValue(
    "2026-07-14 18:48:08.123456",
    { data_type: "timestamp without time zone" },
    fixedLocale,
  );

  assert.match(formatted.display, /Jul 14, 2026/);
  assert.match(formatted.display, /6:48:08\.123 PM/);
  assert.doesNotMatch(formatted.display, /UTC/);
});

test("formats dates and time values without applying an accidental day shift", () => {
  const date = formatDatabaseValue("2026-07-14", { data_type: "date" }, fixedLocale);
  const time = formatDatabaseValue("18:48:08.25", { data_type: "time" }, fixedLocale);

  assert.equal(date.display, "Jul 14, 2026");
  assert.match(time.display, /6:48:08\.25 PM/);
});

test("preserves exact decimal precision while adding locale grouping", () => {
  const raw = "12345678901234567890.0012300";
  const formatted = formatDatabaseValue(raw, { data_type: "numeric(30, 7)" }, fixedLocale);

  assert.equal(formatted.display, "12,345,678,901,234,567,890.0012300");
  assert.equal(formatted.raw, raw);
});

test("normalizes database booleans without hiding their raw representation", () => {
  const formatted = formatDatabaseValue(1, { data_type: "boolean" }, fixedLocale);

  assert.equal(formatted.display, "TRUE");
  assert.equal(formatted.raw, "1");
  assert.equal(formatted.rawDiffers, true);
});

test("compacts JSON for cells and retains a readable inspector representation", () => {
  const raw = '{\n  "status": "ready",\n  "count": 2\n}';
  const formatted = formatDatabaseValue(raw, { data_type: "jsonb" }, fixedLocale);

  assert.equal(formatted.display, '{"status":"ready","count":2}');
  assert.match(formatted.pretty, /\n  "status": "ready"/);
  assert.equal(formatted.raw, raw);
});

test("summarizes binary values and leaves plain text unchanged", () => {
  const binary = formatDatabaseValue("hello", { data_type: "blob" }, fixedLocale);
  const text = formatDatabaseValue("hello", { data_type: "text" }, fixedLocale);

  assert.equal(binary.display, "Binary · 5 bytes");
  assert.equal(binary.raw, "hello");
  assert.equal(text.display, "hello");
  assert.equal(text.rawDiffers, false);
});
