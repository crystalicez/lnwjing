export type DisplayDateTimeLocale = 'th' | 'en';

export interface DisplayDateTimeOptions {
  readonly fallback?: string;
  /** Override the shared Asia/Bangkok display timezone, primarily for deterministic tests. */
  readonly timeZone?: string;
}

export const DEFAULT_DISPLAY_TIME_ZONE = 'Asia/Bangkok';
const EXACT_OFFSET_ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * Format one absolute instant for human-facing lnwjing UI/export text.
 *
 * Storage, audit, protocol, deadline and ordering values must stay as their
 * canonical absolute timestamps. This function is presentation-only.
 */
export function formatDisplayDateTime(
  value: string | number | Date | null | undefined,
  _locale: DisplayDateTimeLocale,
  options: DisplayDateTimeOptions = {},
): string {
  const fallback = options.fallback ?? '—';
  if (value === null || value === undefined || value === '') return fallback;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return typeof value === 'string' ? value : fallback;

  const formatter = new Intl.DateTimeFormat('en-GB-u-ca-gregory-nu-latn', {
    calendar: 'gregory',
    numberingSystem: 'latn',
    timeZone: options.timeZone ?? DEFAULT_DISPLAY_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const parts = new Map(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  const datePart = `${requiredPart(parts, 'day')}/${requiredPart(parts, 'month')}/${requiredPart(parts, 'year')}`;
  const timePart = `${requiredPart(parts, 'hour')}:${requiredPart(parts, 'minute')}:${requiredPart(parts, 'second')}`;
  return `${datePart} ${timePart}`;
}

/**
 * Return a machine-parseable ISO-8601 timestamp using the same display timezone
 * as the UI. This keeps incident evidence absolute while avoiding confusing UTC
 * wall-clock values for operators reading the JSON directly.
 */
export function formatOffsetIsoTimestamp(
  value: string | number | Date = new Date(),
  timeZone = DEFAULT_DISPLAY_TIME_ZONE,
): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('Invalid timestamp');
  const formatter = new Intl.DateTimeFormat('en-CA-u-ca-gregory-nu-latn', {
    calendar: 'gregory',
    numberingSystem: 'latn',
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'longOffset',
  });
  const parts = new Map(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  const rawOffset = requiredPart(parts, 'timeZoneName');
  const offset = rawOffset === 'GMT' ? '+00:00' : rawOffset.replace(/^GMT/, '');
  if (!/^[+-]\d{2}:\d{2}$/.test(offset)) throw new Error(`Unsupported timezone offset ${rawOffset}`);
  const milliseconds = String(date.getUTCMilliseconds()).padStart(3, '0');
  return `${requiredPart(parts, 'year')}-${requiredPart(parts, 'month')}-${requiredPart(parts, 'day')}T${requiredPart(parts, 'hour')}:${requiredPart(parts, 'minute')}:${requiredPart(parts, 'second')}.${milliseconds}${offset}`;
}

/**
 * Localize an exact ISO timestamp value embedded in a flattened diagnostic
 * item such as `started_at=2026-09-09T05:23:22.224Z`. Arbitrary text and URLs
 * are intentionally left untouched so presentation cannot rewrite evidence.
 */
export function formatDisplayTimestampItem(
  item: string,
  locale: DisplayDateTimeLocale,
  options: DisplayDateTimeOptions = {},
): string {
  const separator = item.indexOf('=');
  if (separator < 0) {
    return EXACT_OFFSET_ISO_TIMESTAMP.test(item)
      ? formatDisplayDateTime(item, locale, { ...options, fallback: item })
      : item;
  }
  const key = item.slice(0, separator + 1);
  const value = item.slice(separator + 1);
  if (!EXACT_OFFSET_ISO_TIMESTAMP.test(value)) return item;
  return `${key}${formatDisplayDateTime(value, locale, { ...options, fallback: value })}`;
}

export function displayTimeZone(locale: DisplayDateTimeLocale): string {
  void locale;
  return DEFAULT_DISPLAY_TIME_ZONE;
}

function requiredPart(parts: ReadonlyMap<string, string>, name: string): string {
  const value = parts.get(name);
  if (value === undefined || value.length === 0) throw new Error(`Intl.DateTimeFormat omitted required ${name} part`);
  return value;
}
