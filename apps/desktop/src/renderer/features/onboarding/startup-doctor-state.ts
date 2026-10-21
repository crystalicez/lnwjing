import type { DoctorReport } from '@lnwjing/ipc-contracts';
import type { Screen } from '../shell/AppShell.js';

export const STARTUP_DOCTOR_STORAGE_KEY = 'lnwjing.startup-doctor.passed-version.v1';

export const STARTUP_CORE_CHECK_IDS = ['os', 'database', 'executable_ripgrep', 'mcp-port'] as const;
const startupCoreCheckIdSet = new Set<string>(STARTUP_CORE_CHECK_IDS);

export function startupDoctorCorePassed(report: Pick<DoctorReport, 'checks'>): boolean {
  const coreChecks = report.checks.filter((check) => startupCoreCheckIdSet.has(check.id));
  return coreChecks.length === STARTUP_CORE_CHECK_IDS.length
    && coreChecks.every((check) => check.required && check.status !== 'fail' && check.status !== 'unknown');
}

export function startupDoctorRequired(storage: Pick<Storage, 'getItem'>, appVersion: string): boolean {
  if (appVersion.trim().length === 0) return true;
  try {
    return storage.getItem(STARTUP_DOCTOR_STORAGE_KEY) !== appVersion;
  } catch {
    return true;
  }
}

export function markStartupDoctorPassed(storage: Pick<Storage, 'setItem'>, appVersion: string): void {
  if (appVersion.trim().length === 0) return;
  storage.setItem(STARTUP_DOCTOR_STORAGE_KEY, appVersion);
}

export function startupDoctorNavigationTarget(_ready: boolean, requested: Screen): Screen {
  return requested;
}
