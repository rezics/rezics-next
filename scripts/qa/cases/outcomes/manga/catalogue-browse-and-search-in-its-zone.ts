import { pending, proved, rowOutcomes } from '../../outcome-cells.ts';

export default rowOutcomes('manga/catalogue-browse-and-search-in-its-zone', {
  visitor: pending('traverses the complete public Manga Realm with title, format, status and direct year Conditions'),
  stranger: proved('traverses the same public catalogue; sign-in grants no acceptance or adoption authority'),
  member: proved('traverses the same public catalogue; membership grants no global acceptance authority'),
  owner: proved('traverses attributed own-original adoptions without inferring formats or missing dates'),
  moderator: proved('traverses the public catalogue; joined moderation supplies no global decision or adoption mandate'),
  operator: proved('traverses ordinary public inventory even with separate private Work read authority'),
}, { rights: {
  basis: 'original-contribution',
  credit: 'Original fictional manga catalogue and text by the fixture owner Person, with native author credits.',
} });
