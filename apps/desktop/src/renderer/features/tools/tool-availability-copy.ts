import type { ToolCatalogItem, UiLocale } from '@lnwjing/ipc-contracts';
import { createTranslator } from '../../i18n/index.js';

export function toolAvailabilityLabel(locale: UiLocale, item: ToolCatalogItem): string {
  const t = createTranslator(locale);
  if (item.userPreference === 'disabled') {
    if (item.readiness === 'ready') return t('toolAvailability.readyDisabled');
    return t('toolAvailability.disabledByUser');
  }
  if (item.userPreference === 'enabled' && !item.systemEligible) {
    if (item.readinessReason === 'feature_disabled') return t('toolAvailability.settingGateOff');
    return t('toolAvailability.systemNotReady');
  }
  if (item.userPreference === 'enabled') return t('toolAvailability.enabledByUser');
  return item.effectiveExposed
    ? t('toolAvailability.enabledDefault')
    : t('toolAvailability.disabledDefault');
}

export function effectiveExposureLabel(locale: UiLocale, item: ToolCatalogItem): string {
  const t = createTranslator(locale);
  return item.effectiveExposed ? t('toolAvailability.exposed') : t('toolAvailability.hidden');
}
