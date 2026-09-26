import type { CaseDeclarations } from './declaration.ts';

export const bookEditCases: CaseDeclarations = {
  BOOK04: [{
    tier: 'integration',
    file: 'tests/qa/integration/book-edit-semantics.test.ts',
    name: 'BOOK04: a paragraph comment keeps its exact revision and selector after the paragraph is edited and removed',
  }],
  BOOK05: [{
    tier: 'integration',
    file: 'tests/qa/integration/book-edit-semantics.test.ts',
    name: 'BOOK05: concurrent edits from one head yield one head and an explicit conflict, never a lost update',
  }],
  BOOK10: [{
    tier: 'integration',
    file: 'tests/qa/integration/book-edit-semantics.test.ts',
    name: 'BOOK10: offline replay keeps the queued command identity and current CAS and authority decide it',
  }],
};
