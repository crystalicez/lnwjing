import { formatOffsetIsoTimestamp } from '@lnwjing/shared/date-time-display';

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/** Copy complete diagnostic evidence with timestamp instants shown in Bangkok time. */
export function diagnosticCopyJson(details: unknown): string {
  return JSON.stringify(details, (key: string, value: unknown): unknown => {
    if (typeof value !== 'string' || !ISO_INSTANT.test(value)) return value;
    if (!/(?:At|Timestamp|_at|_timestamp|^timestamp$)$/i.test(key)) return value;
    return formatOffsetIsoTimestamp(value);
  }, 2);
}
