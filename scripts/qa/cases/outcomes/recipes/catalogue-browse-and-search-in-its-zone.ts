import { proved, rowOutcomes } from '../../outcome-cells.ts';

export default rowOutcomes('recipes/catalogue-browse-and-search-in-its-zone', {
  visitor: proved('discovers every matching public recipe in every admitted sort while language, type and hidden controls stay excluded'),
  stranger: proved('discovers every matching public recipe in every admitted sort while language, type and hidden controls stay excluded'),
  member: proved('discovers every matching public recipe without membership widening the catalogue'),
  owner: proved('discovers every matching public recipe while own private drafts stay outside the catalogue'),
  moderator: proved('discovers every matching public recipe without moderation widening the catalogue'),
  operator: proved('discovers every matching public recipe without platform authority widening the catalogue'),
}, { rights: { basis: 'original-contribution', credit: 'Original synthetic recipe text and arrangement by the owner Person, with native author credit.' } });
