export const BACKUP_STATUSES = [
  'ready',
  'busy',
  'unsafe-file',
  'corrupt',
  'truncated',
  'mismatched',
  'incompatible',
  'cancelled',
  'failed-output',
] as const;

export type BackupStatus = (typeof BACKUP_STATUSES)[number];

const EXIT_CODES: Record<BackupStatus, number> = {
  ready: 0,
  busy: 5,
  'unsafe-file': 2,
  corrupt: 1,
  truncated: 1,
  mismatched: 1,
  incompatible: 1,
  cancelled: 130,
  'failed-output': 1,
};

export class StateBackupFailure extends Error {
  readonly status: BackupStatus;
  readonly code: number;
  constructor(message: string, status: BackupStatus, code = EXIT_CODES[status]) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function backupExitCode(status: BackupStatus): number {
  return EXIT_CODES[status];
}
