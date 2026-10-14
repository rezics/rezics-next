import { pending, rowOutcomes } from '../../outcome-cells.ts';

export default rowOutcomes(
  'anime/navigate-a-thousand-episode-inventory-thousand-chapters',
  {
    visitor: pending(
      'finds distant numbered and CJK episodes through label search and traverses all 1000 disclosed entries with credit',
    ),
    stranger: pending(
      'finds distant numbered and CJK episodes and traverses all 1000 entries with identity-bound continuation',
    ),
    member: pending(
      'finds distant numbered and CJK episodes and traverses all 1000 entries with identity-bound continuation',
    ),
    owner: pending(
      'traverses the complete credited episode inventory and its explicitly authorized private Work',
    ),
    moderator: pending(
      'traverses the complete credited episode inventory without a private Work bypass',
    ),
    operator: pending(
      'traverses the complete credited episode inventory without a private Work bypass',
    ),
  },
  {
    rights: {
      basis: 'original-contribution',
      credit:
        'An original synthetic series story and four intentionally repeated episode Works by Outcome owner, explicitly credited as Work and contribution author; all 1000 appearances have distinct occurrence identities and numbered labels.',
    },
  },
);
