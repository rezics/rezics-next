export const DISCLOSURE_SUBMISSION_LIMIT = 2_048;

export const DISCLOSURE_COST = { submissionLimit: DISCLOSURE_SUBMISSION_LIMIT, batch: 64, ownerStatements: 1, recoveryStatements: 1,
  graphParents: 2, parentEdges: 128, parentHeadBatch: 64,
  nameOwnerQueries: 1, namePreferenceStatements: 1 } as const;
