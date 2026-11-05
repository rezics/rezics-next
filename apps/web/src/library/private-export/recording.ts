import captures from './recorded.json';
import {
  isExportPage,
  isExportStatus,
  type ExportCommand,
  type ExportPage,
  type ExportPort,
  type ExportStatus,
} from './contract';

export type ExportRecording = { status: ExportStatus; pages: ExportPage[]; artifact: string };

/** Shared story/test transport for the unmodified HTTP producer recordings. Never used by the live visit. */
export function exportRecording(version: 1 | 4): ExportRecording {
  const capture = captures.find((capture) => capture.status.version === version);
  if (!capture || !isExportStatus(capture.status) || !capture.pages.every(isExportPage))
    throw new Error(`Invalid recorded Library export V${version}`);
  return { status: capture.status, pages: capture.pages as ExportPage[], artifact: capture.artifact };
}

export function recordedExportPort(capture: ExportRecording) {
  const commands: ExportCommand[] = [];
  const pages = new Map<string, ExportPage>();
  let cursor = capture.status.first;
  for (const page of capture.pages) {
    if (cursor === null) throw new Error('Page after terminal recording');
    pages.set(cursor, page);
    cursor = page.next;
  }
  const port: ExportPort = {
    async create(command) {
      commands.push(command);
      return { kind: 'status', status: capture.status };
    },
    async status(command) {
      commands.push(command);
      return { kind: 'status', status: capture.status };
    },
    async page(command) {
      commands.push(command);
      const page = pages.get(command.cursor);
      return page ? { kind: 'page', page } : { kind: 'invalid-cursor' };
    },
    async cancel(command) {
      commands.push(command);
      return { kind: 'cancelled', status: { ...capture.status, state: 'cancelled', first: null } };
    },
  };
  return { port, commands, now: () => Date.parse(capture.status.capturedAt) };
}
