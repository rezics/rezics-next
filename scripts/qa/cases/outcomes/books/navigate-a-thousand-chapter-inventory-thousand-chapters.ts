import { proved, rowOutcomes } from '../../outcome-cells.ts';

export default rowOutcomes(
  'books/navigate-a-thousand-chapter-inventory-thousand-chapters',
  {
    visitor: proved(
      'finds distant numbered and CJK chapters and traverses all 1000 disclosed entries with credit and bound cursors',
    ),
    stranger: proved(
      'finds distant numbered and CJK chapters and traverses all 1000 disclosed entries with credit and bound cursors',
    ),
    member: proved(
      'finds distant numbered and CJK chapters and traverses all 1000 disclosed entries with credit and bound cursors',
    ),
    owner: proved(
      'traverses the complete credited chapter inventory and retains its explicit private Work authority',
    ),
    moderator: proved(
      'traverses the complete credited chapter inventory without a private Work bypass',
    ),
    operator: proved(
      'traverses the complete credited chapter inventory without a private Work bypass',
    ),
  },
  {
    rights: {
      basis: 'original-contribution',
      credit:
        'Original story and multilingual chapter labels by Outcome owner, the explicitly credited Work and contribution author.',
    },
  },
);
