import { useEffect, useRef, useState, type ReactElement } from 'react';
import type { CheckpointCleanupPreview, NativeStorageCleanupRequest, ProfileStorageInventory, StorageOverview, StoragePolicy, UiLocale } from '@lnwjing/ipc-contracts';
import { ActionButton, SettingsCardHeading, StatusMessage } from '../ui/UiPrimitives.js';
import { SettingSwitch } from './SettingSwitch.js';
import { createTranslator } from '../../i18n/index.js';

const MIB = 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;
type NativeCategory = NativeStorageCleanupRequest['category'];

function sizeLabel(bytes: number): string {
  return bytes >= MIB ? (bytes / MIB).toFixed(1) + ' MiB' : (bytes / 1024).toFixed(1) + ' KiB';
}

/** Metadata-only admission estimate: SQLite main used pages minus the MCP
 * five-percent receipt reserve. This is not a promise that every future write
 * fits, and does not include WAL or disk space outside the SQLite file. */
export function storageAdmissionHeadroom(overview: StorageOverview): {
  readonly usedBytes: number;
  readonly headroomBytes: number;
  readonly checkpointSharePercent: number | null;
} {
  const limitBytes = overview.policy.sqliteHardLimitMiB * MIB;
  const usedBytes = Math.max(0, overview.sqliteAllocatedBytes - overview.sqliteFreeBytes);
  const reservation = Math.max(16 * MIB, Math.floor(limitBytes * 0.05));
  const headroomBytes = Math.max(0, limitBytes - reservation - usedBytes);
  const payload = overview.checkpointStorage?.payloadBytes;
  const checkpointSharePercent = payload !== undefined && usedBytes > 0
    && Number.isSafeInteger(payload) && payload >= 0
    ? Math.min(100, Math.round(100 * payload / usedBytes))
    : null;
  return { usedBytes, headroomBytes, checkpointSharePercent };
}

interface Props {
  readonly locale: UiLocale;
  readonly autoBackupEnabled: boolean;
  readonly onChanged?: () => Promise<void>;
}

export function StorageManagementPanel({ locale, autoBackupEnabled, onChanged }: Props): ReactElement {
  const t = createTranslator(locale);
  const [overview, setOverview] = useState<StorageOverview | null>(null);
  const [inventory, setInventory] = useState<ProfileStorageInventory | null>(null);
  const [inventoryPending, setInventoryPending] = useState(false);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [maxMiB, setMaxMiB] = useState(256);
  const [olderDays, setOlderDays] = useState(3);
  const [preview, setPreview] = useState<CheckpointCleanupPreview | null>(null);
  const [previewRequest, setPreviewRequest] = useState<{ maxBytes: number; deleteBefore: string } | null>(null);
  const [category, setCategory] = useState<NativeCategory>('tasks');
  const [globalQuotaDraft, setGlobalQuotaDraft] = useState<number | null>(null);
  const [cursors, setCursors] = useState<Partial<Record<NativeCategory, string | null>>>({});
  const policyRefreshTimer = useRef<number | null>(null);
  useEffect(() => {
    return (): void => {
      if (policyRefreshTimer.current !== null) window.clearTimeout(policyRefreshTimer.current);
    };
  }, []);

  useEffect(() => {
    let active = true;
    void window.lnwjing.getStorageOverview().then((result) => {
      if (active) setOverview(result);
    }).catch((cause: unknown) => {
      if (active) setError(cause instanceof Error ? cause.message : String(cause));
    });
    return (): void => { active = false; };
  }, []);

  // Poll only during an active, cooperative cleanup. Never wake SQLite
  // continuously while Settings is open or the window is hidden.
  useEffect(() => {
    if (overview?.hardLimitRecovery?.state !== 'running' || pending) return;
    let active = true;
    const timer = window.setInterval(() => {
      if (!active || document.visibilityState !== 'visible') return;
      void window.lnwjing.getStorageOverview().then((next) => {
        if (active) setOverview(next);
      }).catch(() => {
        // The user can still use Refresh; avoid a repeating error banner.
      });
    }, 3_000);
    return (): void => { active = false; window.clearInterval(timer); };
  }, [overview?.hardLimitRecovery?.state, pending]);

  async function scanProfile(): Promise<void> {
    if (inventoryPending || pending) return;
    setInventoryPending(true);
    setInventory(null);
    setError(null);
    try {
      setInventory(await window.lnwjing.getProfileStorageInventory());
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setInventoryPending(false);
    }
  }

  async function refresh(): Promise<void> {
    setError(null);
    setPending(true);
    try {
      setOverview(await window.lnwjing.getStorageOverview());
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setPending(false); }
  }

  async function updatePolicy(changes: Partial<StoragePolicy> & { readonly globalQuotaMiB?: number }): Promise<void> {
    if (pending || overview === null) return;
    const enablingCompression = changes.compressionEnabledOnNextStart === true;
    if (changes.checkpointCreationMode === 'git-aware' && !window.confirm(t('storagePanel.confirmGitAware'))) return;
    if (changes.globalQuotaMiB !== undefined && changes.globalQuotaMiB > 0 && !window.confirm(t('storagePanel.globalConfirm'))) return;
    const enablingNoBackupAudit = changes.auditPruneWithoutBackup === true;
    const enablingAutomaticRetention = changes.automaticCheckpointRetention === true;
    if (enablingAutomaticRetention && !window.confirm(t('storagePanel.confirmAuto'))) return;
    if (enablingCompression && !window.confirm(t('storagePanel.confirmCompression'))) return;
    if (enablingNoBackupAudit && !window.confirm(t('storagePanel.confirmAuditNoBackup'))) return;
    setPending(true); setError(null); setNotice(null);
    try {
      const result = await window.lnwjing.setStoragePolicy({ userConfirmed: true, ...changes });
      setOverview(result.overview);
      if (changes.sqliteHardLimitMiB !== undefined || changes.automaticHardLimitRecovery === true) {
        // Backend intentionally starts emergency recovery after Save responds.
        // One delayed read lets the normal running-only poll observe its state.
        if (policyRefreshTimer.current !== null) window.clearTimeout(policyRefreshTimer.current);
        policyRefreshTimer.current = window.setTimeout(() => {
          policyRefreshTimer.current = null;
          void window.lnwjing.getStorageOverview().then(setOverview).catch(() => undefined);
        }, 1_000);
      }
      setPreview(null); setPreviewRequest(null);
      if (changes.globalQuotaMiB !== undefined) setGlobalQuotaDraft(null);
      setNotice(result.restartRequired
        ? (t('storagePanel.restartRequired'))
        : (t('storagePanel.policySaved')));
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setPending(false); }
  }

  async function previewCleanup(): Promise<void> {
    if (!Number.isSafeInteger(maxMiB) || maxMiB < 0 || maxMiB > 1024 * 1024
      || !Number.isSafeInteger(olderDays) || olderDays < 1 || olderDays > 3650) {
      setError(t('storagePanel.invalidBudget'));
      return;
    }
    const request = { maxBytes: maxMiB * MIB, deleteBefore: new Date(Date.now() - olderDays * DAY_MS).toISOString() };
    setPending(true); setError(null); setNotice(null); setPreview(null); setPreviewRequest(null);
    try {
      const result = await window.lnwjing.previewCheckpointCleanup(request);
      setPreviewRequest(request); setPreview(result);
      // Explicit metadata preparation may have completed; refresh its status
      // without invoking an additional full-file walk.
      setOverview(await window.lnwjing.getStorageOverview());
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setPending(false); }
  }

  async function applyCleanup(): Promise<void> {
    if (pending || previewRequest === null || preview === null || preview.checkpointIds.length === 0) return;
    const agreed = window.confirm(t('storagePanel.confirmCheckpointDelete', { count: preview.checkpointIds.length }));
    if (!agreed) return;
    setPending(true); setError(null); setNotice(null);
    try {
      const result = await window.lnwjing.applyCheckpointCleanup({ ...previewRequest, expectedPreviewToken: preview.previewToken, userConfirmed: true });
      setPreview(null); setPreviewRequest(null);
      setOverview(await window.lnwjing.getStorageOverview());
      await onChanged?.();
      setNotice(t('storagePanel.deletedResult', { count: result.deleted, backupId: result.backupId ?? '—' }));
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setPending(false); }
  }

  async function cleanNative(): Promise<void> {
    if (pending || !window.confirm(t('storagePanel.confirmNative'))) return;
    setPending(true); setError(null); setNotice(null);
    try {
      const cursor = cursors[category];
      const result = await window.lnwjing.pruneNativeStorage({
        category, userConfirmed: true, maxDirectories: 32,
        ...(cursor === undefined || cursor === null ? {} : { afterName: cursor }),
      });
      setCursors((current) => ({ ...current, [category]: result.nextCursor }));
      setNotice(t('storagePanel.nativeResult', { count: result.inspected, removed: result.removedFiles }));
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setPending(false); }
  }

  const pressure = overview === null ? null : storageAdmissionHeadroom(overview);
  return (
    <section className="panel settings-card settings-card-polished" aria-label={t('storagePanel.title')}>
      <SettingsCardHeading icon="▤" title={t('storagePanel.title')}
        subtitle={t('storagePanel.subtitle')} />
      <div className="setting-field">
        <strong>{t('storagePanel.sqliteTitle')}</strong>
        <p>{overview === null ? (t('storagePanel.notLoaded')) :
          `${sizeLabel(overview.sqliteAllocatedBytes)} · ${t('storagePanel.freePages')} ${sizeLabel(overview.sqliteFreeBytes)}`}</p>
        {overview === null ? null : <p>{t('storagePanel.walUsage')}: {sizeLabel(overview.sqliteWalBytes)}</p>}
        {overview !== null && overview.sqliteWalBytes >= Math.max(128 * 1024 ** 2,
          Math.min(512 * 1024 ** 2, Math.floor(overview.policy.sqliteHardLimitMiB * 1024 ** 2 / 8)))
          ? <StatusMessage tone="warning" role="alert">{t('storagePanel.walHigh')}</StatusMessage> : null}
        <p className="hint">{t('storagePanel.sqliteNote')}</p>
        {overview?.checkpointStorage === undefined ? null : (
          <p className="hint">
            {t('storagePanel.checkpointMetadataCount', {
              indexed: String(overview.checkpointStorage.indexed),
              total: String(overview.checkpointStorage.total),
            })}
            {overview.checkpointStorage.payloadBytes === undefined
              ? ` · ${t('storagePanel.checkpointPayloadNotReady')}`
              : ` · ${t('storagePanel.checkpointPayloadEstimate', {
                size: sizeLabel(overview.checkpointStorage.payloadBytes),
              })}`}
          </p>
        )}
        {overview?.compactRecommended === true ? <p className="hint">{t('storagePanel.compactionNote')}</p> : null}
      </div>
      {overview?.checkpointMetadataIncomplete === true ? (
        <StatusMessage tone="warning" role="alert" prefix="⚠ ">{t('storagePanel.indexPending')}</StatusMessage>
      ) : null}
      {overview?.hasCompressedV2 === true ? (
        <StatusMessage tone="warning" role="alert" prefix="⚠ ">
          {t('storagePanel.existingV2')}
        </StatusMessage>
      ) : null}
      {overview?.usageCategories?.length ? <div className="setting-field">
        <strong>{t('storagePanel.appdataTitle')}</strong>
        {overview.usageCategories.map((item) => (
          <p key={item.category}>{item.category}: {sizeLabel(item.bytes)}
            {item.truncated ? (t('storagePanel.partialSuffix')) : ''}
          </p>
        ))}
        <p className="hint">{t('storagePanel.appdataNote')}</p>
      </div> : null}
      <div className="setting-field" data-testid="global-quota-settings">
        <strong>{t('storagePanel.globalTitle')}</strong>
        <p className="hint">{t('storagePanel.globalLimitNote')}</p>
        <div className="inline-actions">
          <label htmlFor="storage-global-quota">{t('storagePanel.globalLimitMiB')}
            <input id="storage-global-quota" type="number" min={0} max={65536} step={1}
              value={globalQuotaDraft ?? (overview?.globalQuota === undefined ? 0 : overview.globalQuota.limitBytes / MIB)}
              disabled={pending || overview === null}
              onChange={(event) => setGlobalQuotaDraft(Number(event.target.value))} />
          </label>
          <ActionButton type="button" disabled={pending || overview === null || globalQuotaDraft === null
            || !Number.isSafeInteger(globalQuotaDraft)
            || (globalQuotaDraft !== 0 && (globalQuotaDraft < 512 || globalQuotaDraft > 65536))}
            onClick={() => { if (globalQuotaDraft !== null) void updatePolicy({ globalQuotaMiB: globalQuotaDraft }); }}>
            {t('storagePanel.globalApply')}
          </ActionButton>
        </div>
        {overview?.globalQuota === undefined ? <p className="hint">{t('storagePanel.globalDisabled')}</p> : (
          <>
            <p>{t('storagePanel.globalActive', {
              limit: sizeLabel(overview.globalQuota.limitBytes),
              reserve: sizeLabel(overview.globalQuota.criticalReserveBytes),
              pending: sizeLabel(overview.globalQuota.reservedBytes),
            })}</p>
            <p className="hint" data-testid="global-quota-volume-free">{t('storagePanel.globalVolumeFree', {
              free: sizeLabel(overview.globalQuota.volumeFreeBytes),
              headroom: sizeLabel(overview.globalQuota.volumeUnreservedBytes),
            })}</p>
            {inventory !== null && !inventory.incomplete ? (
              <p>{t('storagePanel.globalLogicalUsed', {
                used: sizeLabel(inventory.logicalBytes),
                left: sizeLabel(Math.max(0, overview.globalQuota.limitBytes
                  - inventory.logicalBytes - overview.globalQuota.reservedBytes)),
              })}</p>
            ) : <p className="hint">{t('storagePanel.globalNeedScan')}</p>}
          </>
        )}
      </div>
      <div className="setting-field" data-testid="profile-storage-inventory">
        <strong>{t('storagePanel.inventoryTitle')}</strong>
        <p className="hint">{t('storagePanel.inventoryScope')}</p>
        {inventory === null ? null : (
          <>
            <p>{t('storagePanel.inventoryTotal', {
              size: sizeLabel(inventory.logicalBytes),
              files: String(inventory.files),
              directories: String(inventory.directories),
            })}</p>
            <p className="hint">{inventory.allocatedBytes === null
              ? t('storagePanel.inventoryAllocationUnknown')
              : t('storagePanel.inventoryAllocated', { size: sizeLabel(inventory.allocatedBytes) })}</p>
            <p className="hint">{t('storagePanel.inventoryCandidates', {
              size: sizeLabel(inventory.potentiallyReclaimableLogicalBytes),
              cache: sizeLabel(inventory.rebuildableLogicalBytes),
            })}</p>
            {inventory.categories.map((item) => (
              <p key={item.id}>{item.id}: {sizeLabel(item.logicalBytes)} · {item.files} {t('storagePanel.inventoryFiles')}
                {' · '}{t(item.retention === 'protected' ? 'storagePanel.inventoryRetentionProtected'
                  : item.retention === 'managed' ? 'storagePanel.inventoryRetentionManaged'
                    : item.retention === 'rebuildable' ? 'storagePanel.inventoryRetentionRebuildable'
                      : 'storagePanel.inventoryRetentionUnknown')}</p>
            ))}
            {inventory.incomplete
              ? <StatusMessage tone="warning" role="alert">{t('storagePanel.inventoryIncomplete', {
                reason: inventory.reason,
                scanned: String(inventory.visitedEntries),
                skipped: String(inventory.skippedLinks + inventory.unreadableEntries),
              })}</StatusMessage>
              : <p className="hint">{t('storagePanel.inventoryComplete')}</p>}
          </>
        )}
        <ActionButton type="button" disabled={pending || inventoryPending} onClick={() => { void scanProfile(); }}>
          {inventoryPending ? t('storagePanel.inventoryScanning') : t('storagePanel.inventoryScan')}
        </ActionButton>
      </div>
      <div className="inline-actions">
        <ActionButton type="button" disabled={pending} onClick={() => { void refresh(); }}>
          {t('storagePanel.refresh')}
        </ActionButton>
      </div>
      {overview === null ? null : (
        <>
          <SettingSwitch label={t('storagePanel.compression')}
            description={t('storagePanel.compressionNote')}
            checked={false} disabled={true}
            onChange={(value) => { void updatePolicy({ compressionEnabledOnNextStart: value }); }} />
          <div className="setting-field">
            <label htmlFor="storage-checkpoint-mode">{t('storagePanel.checkpointMode')}</label>
            <select id="storage-checkpoint-mode" disabled={pending} value={overview.policy.checkpointCreationMode}
              onChange={(event) => { void updatePolicy({ checkpointCreationMode: event.target.value as StoragePolicy['checkpointCreationMode'] }); }}>
              <option value="always">{t('storagePanel.checkpointAlways')}</option>
              <option value="git-aware">{t('storagePanel.checkpointGitAware')}</option>
            </select>
            <p className="hint">{t('storagePanel.checkpointModeNote')}</p>
          </div>
          <div className="setting-field">
            <label htmlFor="storage-sqlite-hard-limit">{t('storagePanel.hardLimit')}</label>
            <select id="storage-sqlite-hard-limit" disabled={pending} value={overview.policy.sqliteHardLimitMiB}
              onChange={(event) => { void updatePolicy({ sqliteHardLimitMiB: Number(event.target.value) }); }}>
              {[512, 1024, 2048, 4096, 8192, 16384].map((size) => <option key={size} value={size}>{size >= 1024 ? size / 1024 + ' GiB' : size + ' MiB'}</option>)}
              {![512, 1024, 2048, 4096, 8192, 16384].includes(overview.policy.sqliteHardLimitMiB)
                ? <option value={overview.policy.sqliteHardLimitMiB}>{overview.policy.sqliteHardLimitMiB} MiB</option> : null}
            </select>
            <p className="hint">{t('storagePanel.hardLimitNote')}</p>
            <p className="hint">{t('storagePanel.effectiveLimit')}: {sizeLabel(overview.sqliteEffectiveHardLimitBytes)}</p>
            <p className="hint" data-testid="sqlite-mutation-headroom">
              {t('storagePanel.mutationHeadroom', {
                used: sizeLabel(pressure!.usedBytes),
                headroom: sizeLabel(pressure!.headroomBytes),
              })}
            </p>
            {overview.sqlitePressureHigh && pressure?.checkpointSharePercent !== null
              && pressure?.checkpointSharePercent !== undefined && pressure.checkpointSharePercent >= 50
              ? <StatusMessage tone="warning" role="alert" prefix="⚠ " data-testid="sqlite-checkpoint-pressure">
                {t('storagePanel.checkpointPressure', {
                  percent: String(pressure.checkpointSharePercent),
                })}
              </StatusMessage> : null}
            {overview.sqliteOverBudget ? <StatusMessage tone="warning" role="alert" prefix="⚠ ">{t('storagePanel.overBudget')}</StatusMessage> : null}
            {overview.sqlitePressureHigh ? <StatusMessage tone="warning" role="alert" prefix="⚠ ">{t('storagePanel.nearLimit')}</StatusMessage> : null}
            {overview.automaticBackupBudget === undefined ? null : (
              <p className="hint">{t('storagePanel.autoBackupBudget')}:
                {' '}{sizeLabel(overview.automaticBackupBudget.usedBytes)} / {sizeLabel(overview.automaticBackupBudget.budgetBytes)}
              </p>
            )}
            {overview.automaticBackupBudget?.blocked === true ? (
              <StatusMessage tone="warning" role="alert" prefix="⚠ ">{t('storagePanel.autoBackupBudgetBlocked')}</StatusMessage>
            ) : null}
            {overview.automaticBackupBudgetUnknown === true ? (
              <StatusMessage tone="warning" role="alert" prefix="⚠ ">{t('storagePanel.autoBackupBudgetUnknown')}</StatusMessage>
            ) : null}
          </div>
          <SettingSwitch label={t('storagePanel.emergencyTrim')}
            description={t('storagePanel.emergencyTrimNote')}
            checked={overview.policy.automaticHardLimitRecovery} disabled={pending}
            onChange={(value) => { void updatePolicy({ automaticHardLimitRecovery: value }); }} />
          {overview.hardLimitRecovery === undefined ? null : (
            <p className="hint" aria-live="polite">
              {t('storagePanel.emergencyTrimStatus', {
                status: t(`storagePanel.emergencyTrim.${overview.hardLimitRecovery.state}`),
                count: String(overview.hardLimitRecovery.deletedRoutineReads),
                checkpoints: String(overview.hardLimitRecovery.deletedCheckpoints ?? 0),
                size: sizeLabel(overview.hardLimitRecovery.reclaimedBytes),
              })}
            </p>
          )}
          <SettingSwitch label={t('storagePanel.autoRetention')}
            description={t('storagePanel.autoRetentionNote')}
            checked={overview.policy.automaticCheckpointRetention} disabled={pending || (!autoBackupEnabled && !overview.policy.automaticCheckpointRetention)}
            onChange={(value) => { void updatePolicy({ automaticCheckpointRetention: value }); }} />
          <SettingSwitch label={t('storagePanel.auditPrune')}
            description={t('storagePanel.auditPruneNote')}
            checked={overview.policy.auditPruneWithoutBackup} disabled={pending}
            onChange={(value) => { void updatePolicy({ auditPruneWithoutBackup: value }); }} />
          <div className="setting-field">
            <label htmlFor="storage-audit-days">{t('storagePanel.auditDays')}</label>
            <select id="storage-audit-days" disabled={pending} value={overview.policy.routineAuditRetentionDays}
              onChange={(event) => { void updatePolicy({ routineAuditRetentionDays: Number(event.target.value) }); }}>
              {[3, 7, 14, 30, 90, 180, 365, 3650].map((days) => <option key={days} value={days}>{days} {t('storagePanel.days')}</option>)}
              {![3, 7, 14, 30, 90, 180, 365, 3650].includes(overview.policy.routineAuditRetentionDays)
                ? <option value={overview.policy.routineAuditRetentionDays}>{overview.policy.routineAuditRetentionDays} {t('storagePanel.days')}</option> : null}
            </select>
          </div>
        </>
      )}
      <div className="settings-mini-heading"><strong>{t('storagePanel.budgetTitle')}</strong></div>
      <p className="hint">{t('storagePanel.budgetNote')}</p>
      <div className="inline-actions">
        <label>{t('storagePanel.budgetMiB')} <input type="number" min={0} max={1048576} step={1}
          value={maxMiB} disabled={pending} onChange={(event) => { setMaxMiB(Number(event.target.value)); setPreview(null); setPreviewRequest(null); }} /></label>
        <label>{t('storagePanel.olderDays')} <input type="number" min={1} max={3650} step={1}
          value={olderDays} disabled={pending} onChange={(event) => { setOlderDays(Number(event.target.value)); setPreview(null); setPreviewRequest(null); }} /></label>
        <ActionButton type="button" disabled={pending || overview === null} onClick={() => { void previewCleanup(); }}>
          {t('storagePanel.preview')}
        </ActionButton>
      </div>
      {preview === null ? null : (
        <div className="setting-field">
          <p>{t('storagePanel.checkpointBytes')}: {sizeLabel(preview.totalBytes)}</p>
          <p>{t('storagePanel.reclaimable')}: {sizeLabel(preview.candidateBytes)} · {preview.checkpointIds.length} {t('storagePanel.snapshots')}</p>
          <p className="hint">{t('storagePanel.spaceWarning')}</p>
          <ActionButton type="button" disabled={pending || preview.checkpointIds.length === 0} onClick={() => { void applyCleanup(); }}>
            {t('storagePanel.confirmCleanup')}
          </ActionButton>
        </div>
      )}
      <div className="settings-mini-heading"><strong>{t('storagePanel.nativeTitle')}</strong></div>
      <div className="inline-actions">
        <select aria-label={t('storagePanel.nativeCategory')} value={category} disabled={pending}
          onChange={(event) => setCategory(event.target.value as NativeCategory)}>
          <option value="tasks">{t('storagePanel.backgroundTasks')}</option>
          <option value="git">Git</option><option value="processes">{t('storagePanel.processes')}</option>
        </select>
        <ActionButton type="button" disabled={pending || cursors[category] === null} onClick={() => { void cleanNative(); }}>
          {t('storagePanel.cleanNative')}
        </ActionButton>
        {cursors[category] === null ? <ActionButton type="button" disabled={pending} onClick={() => setCursors((current) => ({ ...current, [category]: undefined }))}>{t('storagePanel.scanAgain')}</ActionButton> : null}
      </div>
      {error === null ? null : <StatusMessage tone="warning" role="alert" prefix="⚠ ">{error}</StatusMessage>}
      {notice === null ? null : <StatusMessage tone="success" prefix="✓ ">{notice}</StatusMessage>}
    </section>
  );
}
