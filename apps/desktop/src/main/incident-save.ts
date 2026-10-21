import type { IncidentExportResult } from '@lnwjing/ipc-contracts';
import type { IncidentReport } from './incident-report.js';

export interface IncidentSaveCoordinatorOptions {
  readonly capture: () => Promise<IncidentReport>;
  readonly choosePath: (report: IncidentReport) => Promise<string | null>;
  readonly write: (filePath: string, content: string) => Promise<void>;
}

export class IncidentSaveCoordinator {
  private pending: Promise<IncidentExportResult> | null = null;

  public constructor(private readonly options: IncidentSaveCoordinatorOptions) {}

  public captureAndSave(): Promise<IncidentExportResult> {
    if (this.pending !== null) return this.pending;
    this.pending = this.run().finally(() => { this.pending = null; });
    return this.pending;
  }

  private async run(): Promise<IncidentExportResult> {
    const report = await this.options.capture();
    const filePath = await this.options.choosePath(report);
    if (filePath === null) return { exported: false, cancelled: true, classification: report.classification, capturedAt: null };
    await this.options.write(filePath, `${JSON.stringify(report, null, 2)}\n`);
    return { exported: true, cancelled: false, classification: report.classification, capturedAt: report.capturedAt };
  }
}
