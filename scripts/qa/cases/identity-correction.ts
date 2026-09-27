import type { PendingSubcase } from './types.ts';

// Beyond the installed Work-address redirect and source-identity proposal slices.
export const pendingIdentityCorrectionSubcases = [
  { caseIds: ['LIVE06', 'MODEL19'], scenario: 'Equal names, bytes or external IDs suggest an identity merge',
    requiredResult: 'Require evidence and independent approval; preserve original identities, exact references and provenance.', status: 'pending' },
  { caseIds: ['LIVE06', 'IAM08'], scenario: 'Catalog identity correction touches an Agent with account or participation control',
    requiredResult: 'Do not transfer control through catalog correction; use dedicated recovery authority.', status: 'pending' },
  { caseIds: ['LIVE06', 'MODEL23'], scenario: 'Concurrent resolutions or source rebind crosses expected identity/control heads',
    requiredResult: 'Reject self/cycles and stale epochs; activate versioned bounded resolution only after required approvals.', status: 'pending' },
  { caseIds: ['LIVE06', 'SYS01'], scenario: 'Merge reaches native fields, grants, votes, subscriptions and Main Versions',
    requiredResult: 'Apply each owner policy with per-owner outcomes; preserve original incoming references and approval basis.', status: 'pending' },
  { caseIds: ['LIVE06', 'OPS03'], scenario: 'Split after combined edits, partial reconciliation or restore/replay',
    requiredResult: 'Treat split as a new assignment; expose ambiguous provenance and do not restore erased/private payloads.', status: 'pending' },
] as const satisfies readonly PendingSubcase[];
