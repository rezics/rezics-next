import type { CaseDeclarations } from './declaration.ts';

/** Explicit retention plus physical backup/restore proof for one Content erasure. */
export const opsErasureCases: CaseDeclarations = {
  OPS11: [
    { tier: 'integration', file: 'tests/qa/integration/erasure-api.test.ts',
      name: 'OPS11: Content erasure journals exact targets with receipts, denial, stale and recovery outcomes and explicit per-store retention' },
    { tier: 'fault/recovery', file: 'tests/qa/fault-recovery/erasure-restore.test.ts',
      name: 'OPS11/OPS12/IAM11: restored backups keep erased payloads and credentials offline until the retained erasure journal reconciles' },
  ],
  OPS12: [
    { tier: 'fault/recovery', file: 'tests/qa/fault-recovery/erasure-restore.test.ts',
      name: 'OPS11/OPS12/IAM11: restored backups keep erased payloads and credentials offline until the retained erasure journal reconciles' },
  ],
};
