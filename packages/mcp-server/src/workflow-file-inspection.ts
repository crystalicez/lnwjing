import { cellValue, loadOfficeTable, preflightXlsxZip, safeOfficePath } from './office-file-provider.js';
import ExcelJS from 'exceljs';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

export interface WorkflowFileInspection {
  readonly fileType: 'csv' | 'xlsx';
  readonly sheets: readonly { readonly name: string; readonly columns: readonly string[] }[];
}

/** Read only metadata from an existing workspace-bound Office file, never cell content. */
export async function inspectWorkflowFile(root: string, inputPath: string): Promise<WorkflowFileInspection> {
  const filename = await safeOfficePath(root, path.isAbsolute(inputPath) ? await realpath(inputPath) : inputPath);
  if (path.extname(filename).toLowerCase() === '.csv') {
    const table = await loadOfficeTable(root, filename, { scanCellLimit: 256 });
    return { fileType: 'csv', sheets: [{ name: 'CSV', columns: table.headers.slice(0, 256) }] };
  }
  if (path.extname(filename).toLowerCase() !== '.xlsx') throw new Error('Select an XLSX or CSV file');
  const raw = await readFile(filename);
  preflightXlsxZip(Buffer.from(raw));
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(raw as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  return {
    fileType: 'xlsx',
    sheets: workbook.worksheets.slice(0, 64).map((sheet) => ({
      name: sheet.name,
      columns: Array.from({ length: Math.min(sheet.columnCount, 256) }, (_, i) =>
        cellValue(sheet.getRow(1).getCell(i + 1).value))
        .map((cell) => cell.kind === 'empty' ? '' : cell.value).filter(Boolean),
    })),
  };
}

/** Suggest only a version actually found in a package at the selected workspace root. */
export async function inspectWorkflowProjectVersion(root: string): Promise<string | null> {
  try {
    const file = await safeOfficePath(root, 'package.json');
    const data: unknown = JSON.parse(await readFile(file, 'utf8'));
    if (!data || typeof data !== 'object' || !('version' in data)) return null;
    const version = (data as {version?:unknown}).version;
    return typeof version === 'string' && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version) ? version : null;
  } catch { return null; }
}

export async function inspectWorkflowGitBranches(root: string): Promise<readonly string[]> {
  try {
    const {stdout} = await promisify(execFile)('git',['-C',root,'branch','--all','--format=%(refname:short)'],{
      timeout:2500,maxBuffer:16_384,windowsHide:true,
    });
    return [...new Set(stdout.split(/\r?\n/).map(name=>name.trim()).filter(name=>name.length>0&&name.length<=256))].slice(0,80);
  } catch {return [];}
}

/** Explicit user action: create a new mapping that appends findings below the template's used rows. */
export async function generateWorkflowReportMapping(root: string, templatePath: string, sheetName: string): Promise<string> {
  if (!sheetName || sheetName.length > 31) throw new Error('Select a report worksheet');
  const filename = await safeOfficePath(root, path.isAbsolute(templatePath) ? await realpath(templatePath) : templatePath);
  if (path.extname(filename).toLowerCase() !== '.xlsx') throw new Error('A report template must be XLSX');
  const raw = await readFile(filename);
  preflightXlsxZip(Buffer.from(raw));
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(raw as unknown as Parameters<typeof book.xlsx.load>[0]);
  const sheet = book.getWorksheet(sheetName);
  if (!sheet) throw new Error('Report worksheet not found');
  if ((sheet.model as unknown as {sheetProtection?:unknown}).sheetProtection) throw new Error('Cannot write to protected template sheet');
  const appendRow = Math.max(2, sheet.rowCount + 2);
  if (appendRow > 1_048_570) throw new Error('Not enough rows available in template');
  const target = await safeOfficePath(root, `lnwjing-report-mapping-${randomUUID().slice(0,8)}.json`, true);
  const mapping = {
    schemaVersion: 1,
    cells: [],
    tables: [{sheet:sheetName,startCell:`A${appendRow}`, columns:['sheet','address','kind','message']}],
  };
  await writeFile(target, JSON.stringify(mapping,null,2)+'\n', {encoding:'utf8',flag:'wx'});
  return target;
}
