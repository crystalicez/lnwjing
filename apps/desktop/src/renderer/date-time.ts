import type { UiLocale } from '@lnwjing/ipc-contracts';
import { formatDisplayDateTime } from '@lnwjing/shared/date-time-display';

/** Renderer compatibility wrapper around the shared cross-platform display contract. */
export function formatDateTime(
  value: string | number | Date | null | undefined,
  fallback = '—',
  locale: UiLocale = 'th',
): string {
  return formatDisplayDateTime(value, locale, { fallback });
}
