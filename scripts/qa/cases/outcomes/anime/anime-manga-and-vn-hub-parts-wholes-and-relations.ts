import { pending, proved, rowOutcomes } from '../../outcome-cells.ts';

export default rowOutcomes(
  'anime/anime-manga-and-vn-hub-parts-wholes-and-relations',
  {
    visitor: proved(
      'reads typed anime, manga and VN hubs and all disclosed parts, wholes and relations with author credit',
    ),
    stranger: pending('reads typed anime, manga and VN hubs without widening private inventories'),
    member: pending('reads typed anime, manga and VN hubs without widening private inventories'),
    owner: pending(
      'reads public hubs and explicitly authorized private compositions and participants',
    ),
    moderator: pending('reads disclosed hubs and relations without a private Work grant'),
    operator: pending('reads disclosed hubs and relations without a private Work grant'),
  },
  {
    rights: {
      basis: 'original-contribution',
      credit:
        'Original synthetic animated story, manga and visual-novel descriptions and text by Outcome owner; explicit native author credits and published contribution authors.',
    },
  },
);
