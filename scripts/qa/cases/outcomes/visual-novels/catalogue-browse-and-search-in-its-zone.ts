import { proved, rowOutcomes } from '../../outcome-cells.ts';

export default rowOutcomes(
  'visual-novels/catalogue-browse-and-search-in-its-zone',
  {
    visitor: proved(
      'traverses public VN Zone routes, adoptions and scoped search with author credit',
    ),
    stranger: proved(
      'traverses the public VN catalogue without adding drafts or unadopted Works',
    ),
    member: proved(
      'traverses public VN catalogue and search with honest continuations and totals',
    ),
    owner: proved(
      'owns the fixture without expanding public VN inventory to drafts',
    ),
    moderator: proved(
      'joined moderation does not widen public VN catalogue or search',
    ),
    operator: proved(
      'uses ordinary public catalogue routes; platform authority does not widen inventory',
    ),
  },
  {
    rights: {
      basis: 'original-contribution',
      credit:
        'Original Lantern Garden visual novel catalogue and text by the fixture owner Person; native author credits accompany public Works.',
    },
  },
);
