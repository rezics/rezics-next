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
  SEARCH20: [
    { tier: 'fault/recovery', file: 'tests/qa/fault-recovery/content-rebuild-positive.test.ts',
      name: 'SEARCH20/OPS16: lost RDF and erased old Content rebuild from the changed cut' },
    { tier: 'fault/recovery', file: 'tests/qa/fault-recovery/content-rebuild.test.ts',
      name: 'SEARCH20/OPS16: native quarantine survives restart and erased exact Content keeps search unavailable' },
    { tier: 'integration', file: 'tests/qa/integration/erasure-published-search.test.ts',
      name: 'WORK10/SEARCH20/SEARCH08/OPS10: published erasure fences replay and replacement search' },
    { tier: 'fault/recovery', file: 'tests/qa/fault-recovery/erasure-search-command.test.ts',
      name: 'OPS10/SEARCH20/WORK10: graph command suppresses exact public and private units with replay proof' },
    { tier: 'fault/recovery', file: 'tests/qa/fault-recovery/erasure-search-rebuild.test.ts',
      name: 'SEARCH20/SEARCH08/WORK10/OPS10: erasure survives lost projection and offline rebuild' },
    { tier: 'fault/recovery', file: 'tests/qa/fault-recovery/erasure-graph-purge.test.ts',
      name: 'OPS10/SEARCH08/SEARCH20/WORK10: offline sanitized graph and Lucene copy excludes an exact erased revision' },
    { tier: 'fault/recovery', file: 'tests/qa/fault-recovery/erasure-restore.test.ts',
      name: 'OPS11/OPS12/IAM11/SEARCH20: restored backups keep erased payloads and credentials offline until the retained erasure journal reconciles' },
  ],
  OPS10: [
    { tier: 'integration', file: 'tests/qa/integration/erasure-api.test.ts',
      name: 'OPS10/OPS11: Content erasure journals exact targets with receipts, denial, stale and recovery outcomes and explicit per-store retention' },
    { tier: 'fault/recovery', file: 'tests/qa/fault-recovery/erasure-search-command.test.ts',
      name: 'OPS10/SEARCH20/WORK10: graph command suppresses exact public and private units with replay proof' },
    { tier: 'fault/recovery', file: 'tests/qa/fault-recovery/erasure-graph-purge.test.ts',
      name: 'OPS10/SEARCH08/SEARCH20/WORK10: offline sanitized graph and Lucene copy excludes an exact erased revision' },
  ],
  IAM11: [
    { tier: 'fault/recovery', file: 'tests/qa/fault-recovery/account-erasure-frontier.test.ts',
      name: 'IAM11/OPS03: deletion frontiers preserve unrelated public Work and Content' },
    { tier: 'fault/recovery', file: 'tests/qa/fault-recovery/erasure-restore.test.ts',
      name: 'OPS11/OPS12/IAM11/SEARCH20: restored backups keep erased payloads and credentials offline until the retained erasure journal reconciles' },
  ],
  OPS11: [
    { tier: 'integration', file: 'tests/qa/integration/erasure-api.test.ts',
      name: 'OPS10/OPS11: Content erasure journals exact targets with receipts, denial, stale and recovery outcomes and explicit per-store retention' },
    { tier: 'fault/recovery', file: 'tests/qa/fault-recovery/erasure-restore.test.ts',
      name: 'OPS11/OPS12/IAM11/SEARCH20: restored backups keep erased payloads and credentials offline until the retained erasure journal reconciles' },
  ],
  OPS12: [
    { tier: 'fault/recovery', file: 'tests/qa/fault-recovery/erasure-restore.test.ts',
      name: 'OPS11/OPS12/IAM11/SEARCH20: restored backups keep erased payloads and credentials offline until the retained erasure journal reconciles' },
  ],
};
