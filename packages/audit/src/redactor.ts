import { createHash } from 'node:crypto';
import { stripVTControlCharacters } from 'node:util';
import type { ActivityTargetDetail, ActivityTargetReference } from './audit-types.js';

const SENSITIVE_KEY = /authorization|token|secret|password|api[_-]?key|private[_-]?key|credential/i;
const BEARER_VALUE = /\bBearer\s+[^\s,;]+/gi;
const AUTHORIZATION_HEADER = /(Authorization\s*:\s*Bearer\s+)[^\s,;]+/gi;
const ENV_SECRET_ASSIGNMENT = /\b([A-Z0-9_-]*(?:TOKEN|SECRET|PASSWORD|API[_-]?KEY|PRIVATE[_-]?KEY)[A-Z0-9_-]*)\s*=\s*[^\s,;]+/gi;
const API_KEY_PREFIX = /\b(?:sk-[A-Za-z0-9_-]+|gh[pousr]_[A-Za-z0-9_]+|xox[baprs]-[A-Za-z0-9-]+|AIza[A-Za-z0-9_-]+)\b/g;

export class Redactor {
  public redact(value: unknown): unknown {
    if (typeof value === 'string') return redactString(value);
    if (Array.isArray(value)) return value.map((entry) => this.redact(entry));
    if (typeof value !== 'object' || value === null) return value;
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
      key,
      SENSITIVE_KEY.test(key) ? '[REDACTED]' : this.redact(entry),
    ]));
  }

  public redactRecord(value: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
    const redacted = this.redact(value);
    return isRecord(redacted) ? redacted : {};
  }

  public redactText(value: string): string {
    return redactString(value);
  }
}

export const MAX_ACTIVITY_TARGET_ITEMS = 2_000;
export const MAX_ACTIVITY_TARGET_ITEM_CHARS = 32_768;
export const MAX_ACTIVITY_TARGET_PREVIEW_ITEMS = 3;
export const MAX_ACTIVITY_TARGET_PREVIEW_CHARS = 256;

export function redactActivityTargetDetail(detail: ActivityTargetDetail, redactor = new Redactor()): ActivityTargetDetail {
  const items = detail.items
    .slice(0, MAX_ACTIVITY_TARGET_ITEMS)
    .map((item) => truncate(redactor.redactText(item), MAX_ACTIVITY_TARGET_ITEM_CHARS));
  return { kind: detail.kind, items };
}

export function activityTargetReference(
  detailRef: string | null,
  detail: ActivityTargetDetail | undefined,
  summary: string | undefined,
): ActivityTargetReference {
  const items = detail?.items ?? (summary === undefined || summary.length === 0 ? [] : [summary]);
  const preview = detail?.kind === 'details'
    ? []
    : items.slice(0, MAX_ACTIVITY_TARGET_PREVIEW_ITEMS).map((item) => truncate(item, MAX_ACTIVITY_TARGET_PREVIEW_CHARS));
  const hasAdditionalDetail = detail === undefined
    ? false
    : detail.kind === 'details'
      ? detail.items.some((item) => diagnosticItemAddsInformation(item, summary))
      : detail.items.length > preview.length;
  return {
    detailRef: detail === undefined ? null : detailRef,
    itemCount: items.length,
    preview,
    hasAdditionalDetail,
    legacyIncomplete: false,
  };
}

function diagnosticItemAddsInformation(item: string, summary: string | undefined): boolean {
  const separator = item.indexOf('=');
  const key = separator < 0 ? item : item.slice(0, separator);
  const value = separator < 0 ? '' : item.slice(separator + 1);
  if (/^(?:workspaceId|userConfirmed|goalLease(?:\.|$))/.test(key)) return false;
  if (summary !== undefined && value.length > 0 && summary.includes(value)) return false;
  return true;
}

export function decodeActivityTargetReference(value: unknown, legacySummary?: string): ActivityTargetReference {
  if (isRecord(value)) {
    const detailRef = typeof value.detailRef === 'string' && value.detailRef.length > 0 ? value.detailRef : null;
    const itemCount = typeof value.itemCount === 'number' && Number.isInteger(value.itemCount) && value.itemCount >= 0
      ? Math.min(value.itemCount, MAX_ACTIVITY_TARGET_ITEMS)
      : 0;
    const preview = Array.isArray(value.preview)
      ? value.preview.filter((item): item is string => typeof item === 'string').slice(0, MAX_ACTIVITY_TARGET_PREVIEW_ITEMS).map((item) => truncate(redactString(item), MAX_ACTIVITY_TARGET_PREVIEW_CHARS))
      : [];
    return {
      detailRef,
      itemCount,
      preview,
      ...(typeof value.hasAdditionalDetail === 'boolean' ? { hasAdditionalDetail: value.hasAdditionalDetail } : {}),
      legacyIncomplete: value.legacyIncomplete === true,
    };
  }
  const legacy = legacySummaryItems(legacySummary);
  return { detailRef: null, itemCount: legacy.itemCount, preview: legacy.items, legacyIncomplete: true };
}

export interface CodexInstructionSummary {
  readonly codexTaskId: string;
  readonly instructionLength: number;
  readonly instructionSha256: string;
}

export function codexInstructionSummary(codexTaskId: string, instruction: string): CodexInstructionSummary {
  return {
    codexTaskId,
    instructionLength: Buffer.byteLength(instruction, 'utf8'),
    instructionSha256: createHash('sha256').update(instruction, 'utf8').digest('hex'),
  };
}

function redactString(value: string): string {
  return stripVTControlCharacters(value)
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^/\\?#]*@/gi, '$1[REDACTED]@')
    .replace(AUTHORIZATION_HEADER, '$1[REDACTED]')
    .replace(BEARER_VALUE, 'Bearer [REDACTED]')
    .replace(ENV_SECRET_ASSIGNMENT, '$1=[REDACTED]')
    .replace(API_KEY_PREFIX, '[REDACTED]')
    .replace(/\blnwrt_[a-f0-9]{64}\b/gi, '[REDACTED]');
}

function legacySummaryItems(summary: string | undefined): { readonly items: readonly string[]; readonly itemCount: number } {
  if (summary === undefined || summary.trim().length === 0) return { items: [], itemCount: 0 };
  const marker = /\s*\(\+(\d+)\)\s*$/.exec(summary);
  const base = marker === null ? summary : summary.slice(0, marker.index);
  const separator = base.includes(' + ') ? /\s+\+\s+/ : /\s*,\s*/;
  const baseItems = base.split(separator).filter((item) => item.length > 0);
  const omitted = marker === null ? 0 : Number.parseInt(marker[1] ?? '0', 10);
  return {
    items: baseItems.slice(0, MAX_ACTIVITY_TARGET_PREVIEW_ITEMS).map((item) => truncate(redactString(item), MAX_ACTIVITY_TARGET_PREVIEW_CHARS)),
    itemCount: Math.min(baseItems.length + omitted, MAX_ACTIVITY_TARGET_ITEMS),
  };
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
