import { pending, rowOutcomes } from '../../outcome-cells.ts';

export default rowOutcomes(
  'catalogue/search-intent',
  {
    visitor: pending(
      'SEARCH01 finds public keywords, quoted phrases and named resources with bounded explicit recovery and private controls',
    ),
    stranger: pending(
      'SEARCH01 preserves public search intent, fields, language, scope and continuation without membership authority',
    ),
    member: pending(
      'SEARCH01 preserves public search intent and filters; membership does not disclose private names or suggestions',
    ),
    owner: pending(
      'SEARCH01 keeps ordinary public search separate from explicitly authorized private draft reads',
    ),
    moderator: pending(
      'SEARCH01 searches admitted public labels and summaries without widening disclosure through moderation authority',
    ),
    operator: pending(
      'SEARCH01 uses the ordinary public search contract without platform authority widening results or recovery',
    ),
  },
  {
    rights: {
      basis: 'original-contribution',
      credit:
        'Original search fixture names, summaries and discussion text by the retained fixture owner; publication receipts and private draft controls are required before proof.',
    },
  },
);
