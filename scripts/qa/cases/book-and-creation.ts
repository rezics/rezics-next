import { defineCases } from './types.ts';

export const cases = defineCases('docs/testing/book-and-creation.md', [
  {
    id: 'BOOK01',
    scenario: 'Create/edit/publish/read a native book without sources',
    requiredResult: 'Complete ordinary journey through Main Version.',
  },
  {
    id: 'BOOK02',
    scenario: 'Reuse one Post as two chapter occurrences',
    requiredResult: 'Distinct progress/position, shared content identity.',
  },
  {
    id: 'BOOK03',
    scenario: 'Publish new chapter revision',
    requiredResult: 'Ordinary context follows publication; fixed release stays pinned.',
  },
  {
    id: 'BOOK04',
    scenario: 'Comment on old paragraph then edit/remove it',
    requiredResult: 'Original revision/selector remains exact.',
  },
  {
    id: 'BOOK05',
    scenario: 'Edit from two concurrent heads',
    requiredResult: 'Conflict/explicit merge; no lost update.',
  },
  {
    id: 'BOOK06',
    scenario: 'Publish private transitive embed',
    requiredResult: 'Reject or explicitly authorize before activation.',
  },
  {
    id: 'BOOK07',
    scenario: 'Import/refresh after local edits',
    requiredResult: 'Three-way correspondence preserves or reports conflict.',
  },
  {
    id: 'BOOK08',
    scenario: 'Restore old composition',
    requiredResult: 'New state; no recursive overwrite of referenced content.',
  },
  {
    id: 'BOOK09',
    scenario: 'Use image-only or poll-only publication',
    requiredResult: 'No fabricated text document.',
  },
  {
    id: 'BOOK10',
    scenario: 'Offline edit reconnects after remote edit/revocation',
    requiredResult:
      'Preserve input and exact command identity; current authority/CAS controls replay.',
  },
]);
