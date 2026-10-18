import { pending, rowOutcomes } from '../../outcome-cells.ts';

// The matrix and tests specify the proposed public contract; enrollment proves no cell.
export default rowOutcomes('catalogue/supporting-information', {
  visitor: pending('reads source-qualified supporting information and inverse paths without hidden facts'),
  stranger: pending('reads the same public facts with no unrelated draft or evidence disclosure'),
  member: pending('reads public supporting information without treating Realm membership as adoption'),
  owner: pending('keeps the public selection separate from owned drafts and private source evidence'),
  moderator: pending('reads public information without moderation authority widening disclosure'),
  operator: pending('reads public information without platform authority publishing private evidence'),
}, {
  rights: {
    basis: 'source-qualified-factual-extraction',
    credit: 'Exact frozen source bytes, locators and use assessments are prerequisites; withheld expression stays withheld.',
  },
});
