/** Compatibility entry. Production callers bind to each editorial owner's module. */
export { proposeStatement, writeProposal } from './candidate-proposal.ts';
export { decideCandidate } from './candidate-decision.ts';
export { adoptCandidates } from './candidate-adoption.ts';
export { listCandidates, listRevisions } from './candidate-read.ts';
export { asUniqueContention, BULK_UNIQUE_CONTENTION_CONSTRAINTS, PROPOSAL_UNIQUE_CONTENTION_CONSTRAINTS } from './candidate-command.ts';
export type * from './candidate-contract.ts';
export { SubjectNotFoundError, EditorialConflictError } from './contract/subject-errors.ts';
