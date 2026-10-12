import { fromPlainText } from '@rezics/document';
import type { ZoneHomePage } from './home-document.tsx';
import { collectionPreview } from './home-modules.fixtures.ts';

export function defaultShowcase() {
  const selected = collectionPreview();
  selected.presentation.modules = [];
  selected.presentation.slides = [{ id: 'default-slide', title: 'The default Showcase', href: '/exhibition' }];
  selected.moduleData = [];
  const document = structuredClone(fromPlainText('Prose beside the default Showcase', 'blocks'));
  const definition = 'https://rezics.com/definition/showcase-block-v1';
  document.doc.content!.push({ type: 'extensionBlock', attrs: { id: 'default-block', definition, version: '1',
    payload: {}, fallback: 'Default Showcase fallback' } });
  const page: ZoneHomePage = { document, blocks: [{ id: 'default-block', definition, version: '1',
    fallback: 'Default Showcase fallback', status: 'resolved', kind: 'showcase', showcase: '$default' }],
  showcases: [{ id: '$default', module: null, sources: [] }],
  showcaseData: { slides: selected.presentation.slides, slideMedia: [] } };
  return { selected, page };
}
