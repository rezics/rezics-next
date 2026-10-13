import { pending, rowOutcomes } from '../../outcome-cells.ts';

export default rowOutcomes('anime/catalogue-browse-and-search-in-its-zone', {
  visitor: pending('traverses every eligible Anime Realm Work, title search and direct format, status and publication-year Conditions'),
  stranger: pending('traverses the same public Anime catalogue; signing in does not disclose drafts'),
  member: pending('traverses public Anime adoptions; membership does not enlarge the public inventory'),
  owner: pending('traverses published Anime adoptions while its unselected draft stays outside the public catalogue'),
  moderator: pending('joined moderation does not enlarge the public Anime catalogue'),
  operator: pending('platform authority without subject grants does not enlarge the public Anime catalogue'),
}, { rights: { basis: 'original-contribution',
  credit: 'Original animation scripts, catalogue facts and format vocabulary by the fixture owner Person; each Work retains native author credit.' } });

