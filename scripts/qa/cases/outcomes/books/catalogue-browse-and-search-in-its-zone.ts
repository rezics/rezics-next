import { proved, rowOutcomes } from '../../outcome-cells.ts';

export default rowOutcomes(
  'books/catalogue-browse-and-search-in-its-zone',
  {
    visitor: proved(
      'traverses public Book adoptions and title search in every sort with honest totals',
    ),
    stranger: proved(
      'traverses public Book adoptions and title search in every sort with honest totals',
    ),
    member: proved(
      'traverses public Book adoptions and title search in every sort with honest totals',
    ),
    owner: proved(
      'traverses public Book adoptions and title search in every sort with honest totals',
    ),
    moderator: proved(
      'traverses public Book adoptions and title search in every sort with honest totals',
    ),
    operator: proved(
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
