const BOOLEAN_TYPE = /^(?:bool|boolean)$/;
const NUMERIC_TYPE = /^(?:tinyint|smallint|mediumint|int|integer|bigint|int2|int4|int8|serial|bigserial|smallserial|decimal|numeric|number|real|double precision|double|float|float4|float8|money)$/;
const BINARY_TYPE = /^(?:bytea|blob|binary|varbinary|longblob|mediumblob|tinyblob)$/;
const JSON_TYPE = /^(?:json|jsonb)$/;
const UUID_TYPE = /^(?:uuid|uniqueidentifier)$/;
const UUID_VALUE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CACHE_LIMIT = 64;
const normalizedTypeCache = new Map();
const temporalTypeCache = new Map();
const dateTimeFormatCache = new Map();
const numberFormatCache = new Map();
const decimalSeparatorCache = new Map();
const textEncoder = typeof TextEncoder === "undefined" ? null : new TextEncoder();

export function rawDatabaseValue(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "string") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "object") {
    try {
      const serialized = JSON.stringify(value);
      if (serialized !== undefined) return serialized;
    } catch (_) {}
  }
  return String(value);
}

function baseType(column = {}) {
  const declaredType = String(column.data_type || "");
  const cached = normalizedTypeCache.get(declaredType);
  if (cached !== undefined) return cached;
  const normalized = declaredType
    .trim()
    .toLowerCase()
    .replace(/\(\s*\d+(?:\s*,\s*\d+)?\s*\)/g, "")
    .replace(/\s+/g, " ");
  if (normalizedTypeCache.size >= CACHE_LIMIT) normalizedTypeCache.clear();
  normalizedTypeCache.set(declaredType, normalized);
  return normalized;
}

function result(kind, display, context, { pretty = "" } = {}) {
  return {
    kind,
    display,
    raw: context.raw,
    pretty,
    changed: display !== context.raw,
    rawDiffers: display !== context.raw || Boolean(pretty && pretty !== context.raw),
  };
}

function booleanValue(context) {
  if (typeof context.value === "boolean") return context.value;
  if (!BOOLEAN_TYPE.test(context.type)) return null;
  if (context.value === 1 || /^(?:1|t|true|yes|on)$/i.test(context.raw)) return true;
  if (context.value === 0 || /^(?:0|f|false|no|off)$/i.test(context.raw)) return false;
  return null;
}

function temporalType(type) {
  if (temporalTypeCache.has(type)) return temporalTypeCache.get(type);
  let temporal = null;
  if (!type.endsWith("[]")) {
    if (type === "date") temporal = { kind: "date", timezone: false };
    else if (/^(?:timestamptz|timestamp with time zone|timestamp with timezone)$/.test(type)) {
      temporal = { kind: "datetime", timezone: true };
    } else if (/^(?:timestamp|timestamp without time zone|timestamp without timezone|datetime|smalldatetime)$/.test(type)) {
      temporal = { kind: "datetime", timezone: false };
    } else if (/^(?:timetz|time with time zone|time with timezone)$/.test(type)) {
      temporal = { kind: "time", timezone: true };
    } else if (/^(?:time|time without time zone|time without timezone)$/.test(type)) {
      temporal = { kind: "time", timezone: false };
    }
  }
  if (temporalTypeCache.size >= CACHE_LIMIT) temporalTypeCache.clear();
  temporalTypeCache.set(type, temporal);
  return temporal;
}

function fractionalSeconds(raw) {
  const match = raw.match(/\.(\d{1,9})/);
  return match ? Math.min(3, match[1].length) : 0;
}

function dateTimeOptions(context, includeDate, includeZone, timeZone) {
  const options = {
    ...(includeDate ? { year: "numeric", month: "short", day: "numeric" } : {}),
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  };
  const precision = fractionalSeconds(context.raw);
  if (precision) options.fractionalSecondDigits = precision;
  if (includeZone) options.timeZoneName = "short";
  if (timeZone) options.timeZone = timeZone;
  return options;
}

function formatterCacheKey(locale, options) {
  return `${JSON.stringify(locale ?? null)}:${JSON.stringify(options)}`;
}

function cachedIntlFormatter(cache, locale, options, create) {
  const key = formatterCacheKey(locale, options);
  let formatter = cache.get(key);
  if (formatter) return formatter;
  formatter = create(locale, options);
  if (cache.size >= CACHE_LIMIT) cache.clear();
  cache.set(key, formatter);
  return formatter;
}

function formatIntl(date, context, options) {
  try {
    return cachedIntlFormatter(
      dateTimeFormatCache,
      context.locale,
      options,
      (locale, formatOptions) => new Intl.DateTimeFormat(locale, formatOptions),
    ).format(date);
  } catch (_) {
    return "";
  }
}

function floatingDateParts(raw) {
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?)?/);
  if (!match) return null;
  const [, year, month, day, hour = "0", minute = "0", second = "0", fraction = ""] = match;
  const date = new Date(Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
    Number(fraction.padEnd(3, "0").slice(0, 3)),
  ));
  return Number.isNaN(date.getTime()) ? null : date;
}

function floatingTimeParts(raw) {
  const match = raw.match(/(?:^|[T\s])(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:?\d{2})?$/i);
  if (!match) return null;
  const [, hour, minute, second = "0", fraction = "", zone = ""] = match;
  const date = new Date(Date.UTC(
    1970,
    0,
    1,
    Number(hour),
    Number(minute),
    Number(second),
    Number(fraction.padEnd(3, "0").slice(0, 3)),
  ));
  return Number.isNaN(date.getTime()) ? null : { date, zone: zone.toUpperCase() };
}

function formatTemporal(context) {
  const temporal = temporalType(context.type);
  if (!temporal) return null;

  if (temporal.kind === "date") {
    const date = floatingDateParts(context.raw);
    if (!date) return result("date", context.raw, context);
    const display = formatIntl(date, context, {
      year: "numeric",
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    });
    return result("date", display || context.raw, context);
  }

  if (temporal.kind === "time") {
    const parsed = floatingTimeParts(context.raw);
    if (!parsed) return result("time", context.raw, context);
    const display = formatIntl(
      parsed.date,
      context,
      dateTimeOptions(context, false, false, "UTC"),
    );
    const zone = temporal.timezone && parsed.zone
      ? parsed.zone === "Z" ? " UTC" : ` UTC${parsed.zone}`
      : "";
    return result("time", `${display || context.raw}${zone}`, context);
  }

  if (temporal.timezone) {
    const date = new Date(context.raw);
    if (Number.isNaN(date.getTime())) return result("datetime", context.raw, context);
    const display = formatIntl(
      date,
      context,
      dateTimeOptions(context, true, true, context.timeZone),
    );
    return result("datetime", display || context.raw, context);
  }

  const date = floatingDateParts(context.raw);
  if (!date) return result("datetime", context.raw, context);
  const display = formatIntl(
    date,
    context,
    dateTimeOptions(context, true, false, "UTC"),
  );
  return result("datetime", display || context.raw, context);
}

function decimalSeparator(locale) {
  const key = JSON.stringify(locale ?? null);
  const cached = decimalSeparatorCache.get(key);
  if (cached !== undefined) return cached;
  try {
    const separator = cachedIntlFormatter(
      numberFormatCache,
      locale,
      {},
      (numberLocale, options) => new Intl.NumberFormat(numberLocale, options),
    ).formatToParts(1.1)
      .find(part => part.type === "decimal")?.value || ".";
    decimalSeparatorCache.set(key, separator);
    return separator;
  } catch (_) {
    return ".";
  }
}

function formatExactDecimal(raw, locale) {
  const match = raw.match(/^([+-]?)(\d+)(?:\.(\d+))?$/);
  if (!match) return raw;
  const [, sign, integer, fraction] = match;
  try {
    const options = { useGrouping: true, maximumFractionDigits: 0 };
    const grouped = cachedIntlFormatter(
      numberFormatCache,
      locale,
      options,
      (numberLocale, formatOptions) => new Intl.NumberFormat(numberLocale, formatOptions),
    ).format(BigInt(integer));
    return `${sign}${grouped}${fraction === undefined ? "" : `${decimalSeparator(locale)}${fraction}`}`;
  } catch (_) {
    return raw;
  }
}

function formatNumber(context) {
  if (typeof context.value === "number" && Number.isFinite(context.value)) {
    try {
      const options = { useGrouping: true, maximumFractionDigits: 20 };
      return cachedIntlFormatter(
        numberFormatCache,
        context.locale,
        options,
        (locale, formatOptions) => new Intl.NumberFormat(locale, formatOptions),
      ).format(context.value);
    } catch (_) {
      return context.raw;
    }
  }
  return formatExactDecimal(context.raw, context.locale);
}

function parseJSON(context) {
  if (typeof context.value === "object" && context.value !== null) return context.value;
  try {
    return JSON.parse(context.raw);
  } catch (_) {
    return undefined;
  }
}

function byteLength(value) {
  if (textEncoder) return textEncoder.encode(value).length;
  return value.length;
}

export const databaseValueFormatters = Object.freeze([
  {
    id: "null",
    matches: context => context.value === null || context.value === undefined,
    format: context => result("null", "NULL", context),
  },
  {
    id: "boolean",
    matches: context => booleanValue(context) !== null,
    format: context => result("boolean", booleanValue(context) ? "TRUE" : "FALSE", context),
  },
  {
    id: "temporal",
    matches: context => Boolean(temporalType(context.type)),
    format: context => formatTemporal(context),
  },
  {
    id: "numeric",
    matches: context => NUMERIC_TYPE.test(context.type),
    format: context => result("numeric", formatNumber(context), context),
  },
  {
    id: "binary",
    matches: context => BINARY_TYPE.test(context.type),
    format: context => {
      const bytes = byteLength(context.raw);
      return result("binary", `Binary · ${bytes} ${bytes === 1 ? "byte" : "bytes"}`, context);
    },
  },
  {
    id: "json",
    matches: context => JSON_TYPE.test(context.type)
      || typeof context.value === "object"
      || (/^[\[{]/.test(context.raw.trim()) && parseJSON(context) !== undefined),
    format: context => {
      const parsed = parseJSON(context);
      if (parsed === undefined) return result("json", context.raw, context);
      const display = JSON.stringify(parsed);
      const pretty = JSON.stringify(parsed, null, 2);
      return result("json", display ?? context.raw, context, { pretty: pretty ?? "" });
    },
  },
  {
    id: "uuid",
    matches: context => UUID_TYPE.test(context.type) || UUID_VALUE.test(context.raw),
    format: context => result("uuid", context.raw, context),
  },
  {
    id: "text",
    matches: () => true,
    format: context => result("text", context.raw, context),
  },
]);

export function formatDatabaseValue(value, column = {}, options = {}) {
  const context = {
    value,
    column,
    type: baseType(column),
    raw: options.raw === undefined ? rawDatabaseValue(value) : options.raw,
    locale: options.locale,
    timeZone: options.timeZone,
  };
  const formatter = databaseValueFormatters.find(candidate => candidate.matches(context));
  return formatter.format(context);
}
