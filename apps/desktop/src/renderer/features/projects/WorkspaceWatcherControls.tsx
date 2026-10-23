import { useState, type ReactElement } from 'react';
import type { UiLocale, WorkspaceIndexWatchSummary } from '@lnwjing/ipc-contracts';
import { ActionButton, FormInput } from '../ui/UiPrimitives.js';

interface WorkspaceWatcherControlsProps {
  readonly workspaceId: string;
  readonly locale: UiLocale;
  readonly active: boolean;
}

/**
 * Explicit, project-scoped control: no automatic watcher activation and no
 * background status polling across many registered 20 GiB+ projects.
 */
export function WorkspaceWatcherControls({ workspaceId, locale, active }: WorkspaceWatcherControlsProps): ReactElement {
  const thai = locale === 'th';
  const [status, setStatus] = useState<WorkspaceIndexWatchSummary | null>(null);
  const [debounceMs, setDebounceMs] = useState(1000);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const configured = Number.isInteger(debounceMs) && debounceMs >= 0 && debounceMs <= 60_000;
  const changedSettings = status?.watching === true && status.debounceMs !== debounceMs;
  const degraded = status?.freshness === 'watching_degraded';

  async function run(action: () => Promise<WorkspaceIndexWatchSummary>): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const next = await action();
      // The response is only bounded index/watch telemetry, never the entries.
      setStatus(next);
      if (next.debounceMs !== null) setDebounceMs(next.debounceMs);
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="project-watcher-controls" aria-label={thai ? 'ตัวจัดการ Index Watcher' : 'Index watcher controls'}>
      <div className="project-watcher-heading">
        <strong>Index Watcher</strong>
        <span className="project-watcher-hint">
          {thai ? 'ปิด Active Project จะหยุด Watcher · ไม่ตรวจซ้ำอัตโนมัติ' : 'Deactivating this project stops its watcher · No background polling'}
        </span>
      </div>
      <div className="project-watcher-actions">
        <label htmlFor={`watcher-debounce-${workspaceId}`}>{thai ? 'หน่วงเวลา' : 'Debounce'}</label>
        <FormInput
          id={`watcher-debounce-${workspaceId}`}
          type="number"
          min={0}
          max={60000}
          step={100}
          value={debounceMs}
          disabled={busy}
          onChange={(event) => setDebounceMs(event.target.value === '' ? -1 : Number(event.target.value))}
          aria-label={thai ? 'หน่วงเวลา watcher มิลลิวินาที' : 'Watcher debounce in milliseconds'}
        />
        <span>ms</span>
        <ActionButton type="button" disabled={busy} onClick={() => { void run(() => window.lnwjing.getWorkspaceIndexStatus({ workspaceId })); }}>
          {thai ? 'ดูสถานะ' : 'Refresh status'}
        </ActionButton>
        <ActionButton type="button" variant="primary"
          disabled={busy || !active || status === null || !configured || (status.watching && !changedSettings && !degraded)}
          onClick={() => { void run(() => window.lnwjing.startWorkspaceIndexWatch({ workspaceId, debounceMs })); }}>
          {degraded ? (thai ? 'เริ่ม Watcher ใหม่' : 'Restart watcher') : status?.watching ? (thai ? 'ใช้ค่าใหม่' : 'Apply') : (thai ? 'เปิด Watcher' : 'Start watcher')}
        </ActionButton>
        <ActionButton type="button" disabled={busy || !status?.watching}
          onClick={() => { void run(() => window.lnwjing.stopWorkspaceIndexWatch({ workspaceId })); }}>
          {thai ? 'ปิด Watcher' : 'Stop watcher'}
        </ActionButton>
      </div>
      {status === null ? <p className="project-watcher-meta">{active ? (thai ? 'กดดูสถานะก่อนเปิด watcher เพื่อหลีกเลี่ยงการสแกนโดยไม่จำเป็น' : 'Refresh status before starting to avoid unnecessary rescans.') : (thai ? 'ต้องเปิด Active Project ก่อนจึงจะเริ่ม Watcher ได้' : 'Activate this project before starting its watcher.')}</p> : (
        <p className="project-watcher-meta" role="status">
          {degraded ? (thai ? 'Watcher ขัดข้อง' : 'Watcher degraded') : active && status.watching ? (thai ? 'กำลังเฝ้าดู' : 'Watching') : (thai ? 'ปิดอยู่' : 'Stopped')}
          {' · '}{thai ? 'รายการใน Index' : 'Indexed entries'}: {status.entryCount.toLocaleString()}
          {' · '}{thai ? 'สถานะ' : 'Freshness'}: {status.freshness}
          {' · '}{thai ? 'ค้าง' : 'Pending'}: {status.pendingEvents}
          {' · '}{thai ? 'ผิดพลาด' : 'Failures'}: {status.failedEvents}
          {' · '}{thai ? 'สแกนใหม่จากล้นคิว' : 'Overflow rescans'}: {status.overflowRescans}
          {status.error === null ? null : ` · ${status.error}`}
        </p>
      )}
      {configured && debounceMs < 250 ? <p className="project-watcher-error" role="status">{thai ? 'ค่าต่ำกว่า 250 ms อาจเพิ่ม Disk I/O เมื่อมีไฟล์เปลี่ยนจำนวนมาก' : 'Below 250 ms may increase disk I/O during large bursts.'}</p> : null}
      {!configured ? <p role="alert" className="project-watcher-error">{thai ? 'ตั้งค่าได้ตั้งแต่ 0 ถึง 60,000 ms' : 'Enter a value from 0 to 60,000 ms.'}</p> : null}
      {error === null ? null : <p role="alert" className="project-watcher-error">{error}</p>}
      <p className="project-watcher-note">
        {thai
          ? 'Watcher นี้เป็นของ Desktop process เท่านั้น และไม่เปิด/ปิด watcher ที่ MCP STDIO process อื่นจัดการ'
          : 'Controls this Desktop process only; other MCP STDIO processes manage their own watchers.'}
      </p>
    </div>
  );
}
