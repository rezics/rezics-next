import { proved, rowOutcomes } from '../../outcome-cells.ts';

export default rowOutcomes(
  'anime/anime-manga-and-vn-hub-parts-wholes-and-relations',
  {
    visitor: proved(
      'reads typed anime, manga and VN hubs and all disclosed parts, wholes and relations with author credit',
    ),
    stranger: proved('reads typed anime, manga and VN hubs without widening private inventories'),
    member: proved('reads typed anime, manga and VN hubs without widening private inventories'),
    owner: proved(
      'reads public hubs and explicitly authorized private compositions and participants',
    ),
    moderator: proved('reads disclosed hubs and relations without a private Work grant'),
    operator: proved('reads disclosed hubs and relations without a private Work grant'),
  },
  {
    rights: {
      basis: 'original-contribution',
      credit:
        'Original synthetic animated story, manga and visual-novel descriptions and text by Outcome owner; explicit native author credits and published contribution authors.',
    },
  },
);
