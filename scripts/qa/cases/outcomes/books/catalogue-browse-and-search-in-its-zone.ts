import { pending, rowOutcomes } from '../../outcome-cells.ts';

// All six personas receive HTTP 503 work_read_unavailable on the first browse page;
// Main reports zone_browse_backfill_is_not_read on the persona stack.
export default rowOutcomes(
  'books/catalogue-browse-and-search-in-its-zone',
  {
    visitor: pending(
      'traverses public Book adoptions and title search in every sort with honest totals',
    ),
    stranger: pending(
      'traverses public Book adoptions and title search in every sort with honest totals',
    ),
    member: pending(
      'traverses public Book adoptions and title search in every sort with honest totals',
    ),
    owner: pending(
      'traverses public Book adoptions and title search in every sort with honest totals',
    ),
    moderator: pending(
      'traverses public Book adoptions and title search in every sort with honest totals',
    ),
    operator: pending(
      'uses ordinary public catalogue routes; platform authority does not widen inventory',
    ),
  },
  {
    rights: {
      basis: 'original-contribution',
      credit:
        'Original fixture catalogue and text by the fixture owner Person; native author credits accompany public Works.',
    },
  },
);
