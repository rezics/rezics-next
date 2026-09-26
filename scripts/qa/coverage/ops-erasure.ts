import type { CaseDeclarations } from './declaration.ts';

/** Explicit retention plus physical backup/restore proof for one Content erasure. */
export const opsErasureCases: CaseDeclarations = {
  WORK10: [
    { tier: 'integration', file: 'tests/qa/integration/content-publication-native.test.ts',
      name: 'WORK09/WORK10/SEARCH03/SEARCH19: Content CAS, private drafts and exact public search' },
    { tier: 'fault/recovery', file: 'tests/qa/fault-recovery/content-publication-recovery.test.ts',
      name: 'WORK10: ambiguous, active and rejected Content publication pins reconcile from exact graph receipts' },
    { tier: 'integration', file: 'tests/qa/integration/erasure-published-search.test.ts',
      name: 'WORK10/SEARCH20/SEARCH08/OPS10: published erasure fences replay and replacement search' },
    { tier: 'fault/recovery', file: 'tests/qa/fault-recovery/erasure-search-rebuild.test.ts',
      name: 'SEARCH20/SEARCH08/WORK10/OPS10: erasure survives lost projection and offline rebuild' },
  ],
  SEARCH08: [
    { tier: 'integration', file: 'tests/qa/integration/public-search-scale.test.ts',
      name: 'SEARCH01/SEARCH02/SEARCH04/SEARCH07/SEARCH08/SEARCH16/SEARCH18: rated Realm join, bounded paging and author switch' },
    { tier: 'integration', file: 'tests/qa/integration/erasure-published-search.test.ts',
      name: 'WORK10/SEARCH20/SEARCH08/OPS10: published erasure fences replay and replacement search' },
    { tier: 'fault/recovery', file: 'tests/qa/fault-recovery/erasure-search-rebuild.test.ts',
      name: 'SEARCH20/SEARCH08/WORK10/OPS10: erasure survives lost projection and offline rebuild' },
  ],
  IAM11: [
    { tier: 'fault/recovery', file: 'tests/qa/fault-recovery/account-erasure-frontier.test.ts',
      name: 'IAM11/OPS03: deletion frontiers preserve unrelated public Work and Content' },
    { tier: 'fault/recovery', file: 'tests/qa/fault-recovery/erasure-restore.test.ts',
      name: 'OPS11/OPS12/IAM11: restored backups keep erased payloads and credentials offline until the retained erasure journal reconciles' },
  ],
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
