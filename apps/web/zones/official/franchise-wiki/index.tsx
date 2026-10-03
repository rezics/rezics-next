import { defineZonePackage } from '@rezics/zone-sdk';
import css from './franchise-wiki.css?raw';
import { WikiEntity, WikiHome, WikiMemberIndex } from './slots.tsx';

/**
 * The official franchise wiki Zone (`/z/franchise-wiki`): a home with the franchise's Works, main characters,
 * places, a chapter guide and a timeline; character, place and event pages with an infobox, names by language,
 * relationships as rows and the quotations behind them; chapter pages listing what each chapter reveals. Every
 * read is at the reader's position in the story, and Main withholds what is revealed later.
 */
export default defineZonePackage({
  slug: 'franchise-wiki',
  css,
  positions: { mount: 'franchise' },
  slots: { home: WikiHome, memberIndex: WikiMemberIndex, entity: WikiEntity },
});
