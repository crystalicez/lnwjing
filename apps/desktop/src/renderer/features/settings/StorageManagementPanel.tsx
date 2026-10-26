import { useEffect, useState, type ReactElement } from 'react';
import type { CheckpointCleanupPreview, NativeStorageCleanupRequest, StorageOverview, StoragePolicy, UiLocale } from '@lnwjing/ipc-contracts';
import { ActionButton, SettingsCardHeading, StatusMessage } from '../ui/UiPrimitives.js';
import { SettingSwitch } from './SettingSwitch.js';

const MIB = 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;
type NativeCategory = NativeStorageCleanupRequest['category'];

function sizeLabel(bytes: number): string {
  return bytes >= MIB ? (bytes / MIB).toFixed(1) + ' MiB' : (bytes / 1024).toFixed(1) + ' KiB';
}

interface Props {
  readonly locale: UiLocale;
  readonly autoBackupEnabled: boolean;
  readonly onChanged?: () => Promise<void>;
}

export function StorageManagementPanel({ locale, autoBackupEnabled, onChanged }: Props): ReactElement {
  const th = locale === 'th';
  const [overview, setOverview] = useState<StorageOverview | null>(null);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [maxMiB, setMaxMiB] = useState(256);
  const [olderDays, setOlderDays] = useState(3);
  const [preview, setPreview] = useState<CheckpointCleanupPreview | null>(null);
  const [previewRequest, setPreviewRequest] = useState<{ maxBytes: number; deleteBefore: string } | null>(null);
  const [category, setCategory] = useState<NativeCategory>('tasks');
  const [cursors, setCursors] = useState<Partial<Record<NativeCategory, string | null>>>({});

  useEffect(() => {
    let active = true;
    void window.lnwjing.getStorageOverview().then((result) => {
      if (active) setOverview(result);
    }).catch((cause: unknown) => {
      if (active) setError(cause instanceof Error ? cause.message : String(cause));
    });
    return (): void => { active = false; };
  }, []);

  async function refresh(): Promise<void> {
    setError(null);
    setPending(true);
    try {
      setOverview(await window.lnwjing.getStorageOverview());
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setPending(false); }
  }

  async function updatePolicy(changes: Partial<StoragePolicy>): Promise<void> {
    if (pending || overview === null) return;
    const enablingCompression = changes.compressionEnabledOnNextStart === true;
    const enablingNoBackupAudit = changes.auditPruneWithoutBackup === true;
    const enablingAutomaticRetention = changes.automaticCheckpointRetention === true;
    if (enablingAutomaticRetention && !window.confirm(th
      ? 'เปิดล้าง Checkpoint เก่าตามอายุโดยอัตโนมัติ? ระบบต้องมี Auto Backup และจะเก็บ Checkpoint ล่าสุดของแต่ละโปรเจกต์ไว้'
      : 'Enable automatic age-based checkpoint cleanup? Auto Backup is required and the latest snapshot per workspace is preserved.')) return;
    if (enablingCompression && !window.confirm(th
      ? 'Checkpoint ใหม่ที่บีบอัดอาจกู้คืนด้วย Portable รุ่นเก่าไม่ได้ ยืนยันเปิดและรีสตาร์ตโปรแกรมหรือไม่?'
      : 'Compressed checkpoints may not restore in older Portable versions. Enable and restart?')) return;
    if (enablingNoBackupAudit && !window.confirm(th
      ? 'ลบเฉพาะ Audit ประเภท routine-read ที่หมดอายุ โดยไม่สร้างฐานข้อมูลสำรองก่อน ยืนยันหรือไม่?'
      : 'Prune expired routine-read audit without a new database backup?')) return;
    setPending(true); setError(null); setNotice(null);
    try {
      const result = await window.lnwjing.setStoragePolicy({ userConfirmed: true, ...changes });
      setOverview(result.overview);
      setPreview(null); setPreviewRequest(null);
      setNotice(result.restartRequired
        ? (th ? 'บันทึกแล้ว ต้องรีสตาร์ตเพื่อใช้ค่า Compression ใหม่' : 'Saved. Restart to apply compression changes.')
        : (th ? 'บันทึกนโยบายแล้ว' : 'Storage policy saved.'));
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setPending(false); }
  }

  async function previewCleanup(): Promise<void> {
    if (!Number.isSafeInteger(maxMiB) || maxMiB < 0 || maxMiB > 1024 * 1024
      || !Number.isSafeInteger(olderDays) || olderDays < 1 || olderDays > 3650) {
      setError(th ? 'ค่า Budget หรือจำนวนวันไม่ถูกต้อง' : 'Invalid budget or age');
      return;
    }
    const request = { maxBytes: maxMiB * MIB, deleteBefore: new Date(Date.now() - olderDays * DAY_MS).toISOString() };
    setPending(true); setError(null); setNotice(null); setPreview(null); setPreviewRequest(null);
    try {
      const result = await window.lnwjing.previewCheckpointCleanup(request);
      setPreviewRequest(request); setPreview(result);
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setPending(false); }
  }

  async function applyCleanup(): Promise<void> {
    if (pending || previewRequest === null || preview === null || preview.checkpointIds.length === 0) return;
    const agreed = window.confirm(th
      ? `ลบ Checkpoints เก่าสูงสุด ${preview.checkpointIds.length} รายการ? ระบบจะสร้าง Backup ก่อน แต่รายการอาจกู้คืนได้ผ่าน Backup เท่านั้น`
      : `Delete up to ${preview.checkpointIds.length} old checkpoints? A database backup is required, but recovery may require restoring it.`);
    if (!agreed) return;
    setPending(true); setError(null); setNotice(null);
    try {
      const result = await window.lnwjing.applyCheckpointCleanup({ ...previewRequest, expectedPreviewToken: preview.previewToken, userConfirmed: true });
      setPreview(null); setPreviewRequest(null);
      setOverview(await window.lnwjing.getStorageOverview());
      await onChanged?.();
      setNotice(th ? `ลบแล้ว ${result.deleted} รายการ · Backup: ${result.backupId ?? '—'}`
        : `Removed ${result.deleted} checkpoints · Backup: ${result.backupId ?? '—'}`);
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setPending(false); }
  }

  async function cleanNative(): Promise<void> {
    if (pending || !window.confirm(th
      ? 'ตรวจไม่เกิน 32 งานและลบเฉพาะไฟล์ launcher ที่มีหลักฐานว่าหยุดแล้ว ยืนยันหรือไม่?'
      : 'Check up to 32 tasks and remove only launch files with verified completion receipts?')) return;
    setPending(true); setError(null); setNotice(null);
    try {
      const cursor = cursors[category];
      const result = await window.lnwjing.pruneNativeStorage({
        category, userConfirmed: true, maxDirectories: 32,
        ...(cursor === undefined || cursor === null ? {} : { afterName: cursor }),
      });
      setCursors((current) => ({ ...current, [category]: result.nextCursor }));
      setNotice(th ? `ตรวจ ${result.inspected} งาน · ลบไฟล์ launcher ${result.removedFiles} ไฟล์`
        : `Inspected ${result.inspected} jobs · Removed ${result.removedFiles} one-use launcher files`);
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setPending(false); }
  }

  return (
    <section className="panel settings-card settings-card-polished" aria-label="Storage Management">
      <SettingsCardHeading icon="▤" title={th ? 'จัดการพื้นที่จัดเก็บ' : 'Storage Management'}
        subtitle={th ? 'แสดงข้อมูล SQLite จาก metadata เท่านั้น ไม่สแกนไฟล์ทั้งเครื่อง' : 'SQLite metadata only — no full-file scan'} />
      <div className="setting-field">
        <strong>{th ? 'พื้นที่ฐานข้อมูล SQLite' : 'SQLite Database'}</strong>
        <p>{overview === null ? (th ? 'ยังไม่ได้โหลด' : 'Not loaded') :
          `${sizeLabel(overview.sqliteAllocatedBytes)} · ${th ? 'หน้าว่างภายใน' : 'Free pages'} ${sizeLabel(overview.sqliteFreeBytes)}`}</p>
        <p className="hint">{th
          ? 'แสดงขนาดไฟล์ฐานข้อมูล ไม่รวม Index, Logs, Backups และไฟล์ของงาน'
          : 'Database size only; excludes workspace indexes, logs, backups and task files.'}</p>
        {overview?.compactRecommended === true ? <p className="hint">{th
          ? 'พบหน้าว่างที่อาจคืนพื้นที่ได้ แต่ต้องปิดโปรแกรมและใช้ Offline Compaction ที่มี Backup เท่านั้น'
          : 'Reclaimable pages detected. Compaction requires offline maintenance with a verified backup.'}</p> : null}
      </div>
      {overview?.hasCompressedV2 === true ? (
        <StatusMessage tone="warning" role="alert" prefix="⚠ ">
          {th ? 'พบ Checkpoint v2 ที่บีบอัดอยู่แล้ว: อย่าเปิดโปรไฟล์นี้ด้วย Portable รุ่นเก่า เพราะอาจเข้ารหัสซ้ำจนกู้คืนไม่ได้'
            : 'Existing compressed v2 checkpoints detected. Do not open this profile in older Portable builds: downgrading can corrupt rollback data.'}
        </StatusMessage>
      ) : null}
      {overview?.usageCategories?.length ? <div className="setting-field">
        <strong>{th ? 'สรุปโฟลเดอร์ AppData (อ่าน metadata แบบจำกัด)' : 'AppData folders (bounded metadata sampling)'}</strong>
        {overview.usageCategories.map((item) => (
          <p key={item.category}>{item.category}: {sizeLabel(item.bytes)}
            {item.truncated ? (th ? ' · ประเมินบางส่วน' : ' · partial') : ''}
          </p>
        ))}
        <p className="hint">{th
          ? 'ตัวเลขไม่รวมไฟล์นอกหมวดนี้ และหมวด partial ไม่ใช่ยอดรวมจริง ไม่มีการอ่านเนื้อหาไฟล์'
          : 'Partial counts are not full totals; other files may be excluded. No file contents are read.'}</p>
      </div> : null}
      <div className="inline-actions">
        <ActionButton type="button" disabled={pending} onClick={() => { void refresh(); }}>
          {th ? 'รีเฟรชพื้นที่' : 'Refresh usage'}
        </ActionButton>
      </div>
      {overview === null ? null : (
        <>
          <SettingSwitch label={th ? 'บีบอัด Checkpoint ใหม่' : 'Compress new checkpoints'}
            description={th ? 'ปิดชั่วคราว: Portable รุ่นเก่าอาจเข้ารหัส Checkpoint v2 ซ้ำจนข้อมูลเสียหาย ต้องแยกโปรไฟล์ก่อน' : 'Disabled for shared profiles: older Portable builds can corrupt v2 snapshots'}
            checked={false} disabled={true}
            onChange={(value) => { void updatePolicy({ compressionEnabledOnNextStart: value }); }} />
          <SettingSwitch label={th ? 'ล้าง Checkpoint เก่าตามอายุอัตโนมัติ' : 'Automatic checkpoint age retention'}
            description={th ? 'ต้องเปิด Auto Backup และระบบจะรักษา Checkpoint ล่าสุดต่อโปรเจกต์' : 'Requires auto backup; preserves latest checkpoint per workspace'}
            checked={overview.policy.automaticCheckpointRetention} disabled={pending || (!autoBackupEnabled && !overview.policy.automaticCheckpointRetention)}
            onChange={(value) => { void updatePolicy({ automaticCheckpointRetention: value }); }} />
          <SettingSwitch label={th ? 'ล้าง routine-read Audit โดยไม่สร้าง Backup' : 'Prune routine-read audit without backup'}
            description={th ? 'ลบเฉพาะเหตุการณ์อ่านที่หมดอายุ ไม่รวมการแก้ไข/หลักฐาน Goal' : 'Expired routine reads only; keeps mutation and goal evidence'}
            checked={overview.policy.auditPruneWithoutBackup} disabled={pending}
            onChange={(value) => { void updatePolicy({ auditPruneWithoutBackup: value }); }} />
          <div className="setting-field">
            <label htmlFor="storage-audit-days">{th ? 'เก็บ routine-read Audit' : 'Routine audit retention'}</label>
            <select id="storage-audit-days" disabled={pending} value={overview.policy.routineAuditRetentionDays}
              onChange={(event) => { void updatePolicy({ routineAuditRetentionDays: Number(event.target.value) }); }}>
              {[3, 7, 14, 30, 90, 180, 365, 3650].map((days) => <option key={days} value={days}>{days} {th ? 'วัน' : 'days'}</option>)}
              {![3, 7, 14, 30, 90, 180, 365, 3650].includes(overview.policy.routineAuditRetentionDays)
                ? <option value={overview.policy.routineAuditRetentionDays}>{overview.policy.routineAuditRetentionDays} {th ? 'วัน' : 'days'}</option> : null}
            </select>
          </div>
        </>
      )}
      <div className="settings-mini-heading"><strong>{th ? 'Checkpoint Budget — ล้างเองเท่านั้น' : 'Checkpoint Budget — manual only'}</strong></div>
      <p className="hint">{th
        ? 'Preview คำนวณเฉพาะ Checkpoint เก่า ไม่รวมข้อมูล Goals ที่อาจถูกอ้างอิง; ระบบจะปฏิเสธลบหากตรวจ references ไม่ปลอดภัย'
        : 'Preview estimates old snapshots only. Cleanup fails closed if Goal/audit references cannot be verified.'}</p>
      <div className="inline-actions">
        <label>{th ? 'เพดาน (MiB)' : 'Budget (MiB)'} <input type="number" min={0} max={1048576} step={1}
          value={maxMiB} disabled={pending} onChange={(event) => { setMaxMiB(Number(event.target.value)); setPreview(null); setPreviewRequest(null); }} /></label>
        <label>{th ? 'เก่ากว่า (วัน)' : 'Older than (days)'} <input type="number" min={1} max={3650} step={1}
          value={olderDays} disabled={pending} onChange={(event) => { setOlderDays(Number(event.target.value)); setPreview(null); setPreviewRequest(null); }} /></label>
        <ActionButton type="button" disabled={pending || overview === null} onClick={() => { void previewCleanup(); }}>
          {th ? 'ประเมินก่อนลบ' : 'Preview cleanup'}
        </ActionButton>
      </div>
      {preview === null ? null : (
        <div className="setting-field">
          <p>{th ? 'ข้อมูล Checkpoints ทั้งหมด' : 'Checkpoint data total'}: {sizeLabel(preview.totalBytes)}</p>
          <p>{th ? 'พื้นที่ที่อาจลดได้' : 'Potentially removable'}: {sizeLabel(preview.candidateBytes)} · {preview.checkpointIds.length} {th ? 'รายการ' : 'snapshots'}</p>
          <p className="hint">{th
            ? 'สำคัญ: ระบบต้องสร้าง Backup ของฐานข้อมูลทั้งก้อนก่อนลบ จึงอาจใช้พื้นที่ดิสก์เพิ่มขึ้นชั่วคราว การลบแถวทำให้พื้นที่ SQLite นำกลับมาใช้ได้ แต่ไฟล์ไม่หดทันที ต้องใช้ Offline Compaction ภายหลัง'
            : 'Important: A full database backup is required before deletion, so disk usage may increase first. Deleting rows makes SQLite pages reusable but does not shrink the file; offline compaction is needed later.'}</p>
          <ActionButton type="button" disabled={pending || preview.checkpointIds.length === 0} onClick={() => { void applyCleanup(); }}>
            {th ? 'ยืนยันล้าง Checkpoints ที่ผ่านเงื่อนไข' : 'Confirm eligible checkpoint cleanup'}
          </ActionButton>
        </div>
      )}
      <div className="settings-mini-heading"><strong>{th ? 'ล้างไฟล์เริ่มงานที่ไม่ใช้แล้ว' : 'Verified native launcher cleanup'}</strong></div>
      <div className="inline-actions">
        <select aria-label={th ? 'ประเภทงาน' : 'Task category'} value={category} disabled={pending}
          onChange={(event) => setCategory(event.target.value as NativeCategory)}>
          <option value="tasks">{th ? 'Background tasks' : 'Background tasks'}</option>
          <option value="git">Git</option><option value="processes">{th ? 'โปรเซส' : 'Processes'}</option>
        </select>
        <ActionButton type="button" disabled={pending || cursors[category] === null} onClick={() => { void cleanNative(); }}>
          {th ? 'ล้างไม่เกิน 32 งาน' : 'Clean up to 32 jobs'}
        </ActionButton>
        {cursors[category] === null ? <ActionButton type="button" disabled={pending} onClick={() => setCursors((current) => ({ ...current, [category]: undefined }))}>{th ? 'สแกนใหม่' : 'Scan again'}</ActionButton> : null}
      </div>
      {error === null ? null : <StatusMessage tone="warning" role="alert" prefix="⚠ ">{error}</StatusMessage>}
      {notice === null ? null : <StatusMessage tone="success" prefix="✓ ">{notice}</StatusMessage>}
    </section>
  );
}
