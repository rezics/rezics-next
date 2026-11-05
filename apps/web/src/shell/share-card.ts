import { publicCardImage, type PublicCardImage } from '../media/public-card';
import { shareCardId, shareCardSize, type ShareCardProjection } from '../media/share-card';

/** Optional head boundary: consume only the same current anonymous projection as the public page. */
export function shareCardImage(projection?: ShareCardProjection): PublicCardImage {
  if (projection?.kind === 'ready' && shareCardId.test(projection.page.id)) {
    const page = projection.page;
    return (
      publicCardImage(page.cover, page.title) ?? {
        url: `/${page.locale}/cards/${page.id}.png`,
        ...shareCardSize,
        alt: page.title,
      }
    );
  }
  return { url: '/cards/default.png', ...shareCardSize, alt: 'REZICS' };
}
