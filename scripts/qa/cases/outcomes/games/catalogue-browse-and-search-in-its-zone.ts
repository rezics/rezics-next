import { proved, rowOutcomes } from '../../outcome-cells.ts';

export default rowOutcomes('games/catalogue-browse-and-search-in-its-zone', {
  visitor: proved("traverses and title-searches only adopted VideoGames in the Zone Realm with exact totals"),
  stranger: proved("reads the same game catalogue; curation requires an explicit publication.adopt mandate"),
  member: proved("reads the same game catalogue; curation requires an explicit publication.adopt mandate"),
  owner: proved("reads its Realm catalogue; Work ownership does not authorize adoption into an unrelated Realm"),
  moderator: proved("reads the same game catalogue; curation requires an explicit publication.adopt mandate"),
  operator: proved("reads the same game catalogue; curation requires an explicit publication.adopt mandate"),
}, {
  rights: { basis: 'original-contribution', credit: 'Original synthetic game descriptions by the fixture owner Person, retained as native author credit; no external artwork or inferred rights.' },
});

