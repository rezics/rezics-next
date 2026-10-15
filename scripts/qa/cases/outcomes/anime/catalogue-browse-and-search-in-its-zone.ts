import { proved, rowOutcomes } from '../../outcome-cells.ts';

export default rowOutcomes('anime/catalogue-browse-and-search-in-its-zone', {
  visitor: proved('traverses every eligible Anime Realm Work, title search and direct format, status and publication-year Conditions'),
  stranger: proved('traverses the same public Anime catalogue; signing in does not disclose drafts'),
  member: proved('traverses public Anime adoptions; membership does not enlarge the public inventory'),
  owner: proved('traverses published Anime adoptions while its unselected draft stays outside the public catalogue'),
  moderator: proved('joined moderation does not enlarge the public Anime catalogue'),
  operator: proved('platform authority without subject grants does not enlarge the public Anime catalogue'),
}, { rights: { basis: 'original-contribution',
  credit: 'Original animation scripts, catalogue facts and format vocabulary by the fixture owner Person; each Work retains native author credit.' } });

