import { proved, rowOutcomes } from '../../outcome-cells.ts';

export default rowOutcomes(
  'anime/navigate-a-thousand-episode-inventory-thousand-chapters',
  {
    visitor: proved(
      'finds distant numbered and CJK episodes through label search and traverses all 1000 disclosed entries with credit',
    ),
    stranger: proved(
      'finds distant numbered and CJK episodes and traverses all 1000 entries with identity-bound continuation',
    ),
    member: proved(
      'finds distant numbered and CJK episodes and traverses all 1000 entries with identity-bound continuation',
    ),
    owner: proved(
      'traverses the complete credited episode inventory and its explicitly authorized private Work',
    ),
    moderator: proved(
      'traverses the complete credited episode inventory without a private Work bypass',
    ),
    operator: proved(
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
