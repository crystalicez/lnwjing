import type { ToolCatalogItem, ToolReadinessReason, ToolReadinessStatus, UiLocale } from '@lnwjing/ipc-contracts';
import { createTranslator } from '../../i18n/index.js';
import type { MessageKey } from '../../i18n/messages.js';

const reasonKeys: Readonly<Record<ToolReadinessReason, MessageKey>> = {
  setup_required: 'tools.readiness.setupRequired',
  runtime_not_ready: 'tools.readiness.startRequired',
  probe_failed: 'tools.readiness.probeFailed',
  permission_denied: 'tools.readiness.permissionDenied',
  unsupported_platform: 'tools.readiness.unsupportedPlatform',
  feature_disabled: 'tools.readiness.featureDisabled',
  planned: 'tools.readiness.planned',
  external_unknown: 'tools.readiness.externalUnknown',
};

export function toolReadinessLabel(locale: UiLocale, item: Pick<ToolCatalogItem, 'readiness' | 'readinessReason'>): string {
  const t = createTranslator(locale);
  if (item.readinessReason !== undefined) return t(reasonKeys[item.readinessReason]);
  const legacyKeys: Readonly<Record<ToolReadinessStatus, MessageKey>> = {
    ready: 'tools.readiness.ready',
    needs_setup: 'tools.readiness.setupRequired',
    blocked: 'tools.filter.blocked',
    disabled: 'tools.filter.disabled',
    unsupported: 'tools.filter.unsupported',
    unknown: 'tools.filter.unknown',
  };
  return t(legacyKeys[item.readiness]);
}

export function coarseReadinessLabel(locale: UiLocale, readiness: ToolReadinessStatus): string {
  const t = createTranslator(locale);
  const keys: Readonly<Record<ToolReadinessStatus, MessageKey>> = {
    ready: 'tools.readiness.ready',
    needs_setup: 'tools.filter.actionRequired',
    blocked: 'tools.filter.blocked',
    disabled: 'tools.filter.disabled',
    unsupported: 'tools.filter.unsupported',
    unknown: 'tools.filter.unknown',
  };
  return t(keys[readiness]);
}
