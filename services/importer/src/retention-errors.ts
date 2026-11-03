export type RetentionFailureKind =
  | 'usage'
  | 'unsafe-file'
  | 'missing'
  | 'incompatible'
  | 'stale'
  | 'ineligible'
  | 'busy'
  | 'cancelled'
  | 'failed';

export class RetentionFailure extends Error {
  readonly kind: RetentionFailureKind;
  readonly code: number;

  constructor(message: string, kind: RetentionFailureKind, code?: number) {
    super(message);
    this.name = 'RetentionFailure';
    this.kind = kind;
    this.code = code ?? retentionExitCode(kind);
  }
}

export function retentionExitCode(kind: RetentionFailureKind): number {
  if (kind === 'cancelled') return 130;
  if (kind === 'busy') return 5;
  if (kind === 'failed') return 1;
  return 2;
}
