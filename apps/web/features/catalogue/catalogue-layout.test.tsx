import { expect, test } from 'bun:test';
import { renderToString } from 'react-dom/server';
import { MediaImageProvider, mediaImageKey } from '@rezics/ui/media-image';
import { ResourceList } from '../discover/resource-list.tsx';
import { browseId, browseResources } from '../discover/browse-fixtures.ts';
import { resourceWork } from '../discover/resource-card.tsx';
import { WorkGrid, WorkShelf } from './work-shelf.tsx';
import { WorkTile } from './work-tile.tsx';
import { seedServedTypes } from './type-fixtures.ts';
import { CatalogueCover } from './cover.tsx';

seedServedTypes();
const book = { ...browseResources[0]!, types: ['https://schema.org/Book'],
  name: { ...browseResources[0]!.name, value: 'The Lantern Atlas', language: 'en' } };
const game = { ...book, id: browseId(9500), types: ['https://schema.org/VideoGame'],
  name: { ...book.name, value: 'Minecraft' } };
const community = browseResources[1]!;
const coverStyles = (html: string) => [...html.matchAll(/<div\b[^>]*data-slot="work-cover"[^>]*>/gu)]
  .map(([tag]) => tag.match(/style="([^"]*)"/u)?.[1]);

test('mixed results are complete and in API order before hydration, with the same covers as Works', () => {
  const mixed = renderToString(<ResourceList items={[book, community, game]} locale="en" />);
  const works = renderToString(<ResourceList items={[book, game]} locale="en" />);
  expect(mixed.match(/<li\b/gu)).toHaveLength(3);
  const titles = [...mixed.matchAll(/<h3\b[^>]*>(.*?)<\/h3>/gsu)].map(match => match[1]!);
  expect(titles).toHaveLength(3);
  expect(titles[0]).toContain(book.name.value);
  expect(titles[1]).toContain(community.name.value);
  expect(titles[2]).toContain(game.name.value);
  expect(coverStyles(mixed)).toEqual(coverStyles(works));
  expect(coverStyles(mixed)[0]).toContain('aspect-ratio:0.6666666666666666');
  expect(coverStyles(mixed)[1]).toContain('aspect-ratio:1.7777777777777777');
});

test('a landscape preview has no portrait-height slot, including through legacy adapters', () => {
  const html = renderToString(<WorkTile work={resourceWork(game)} slot={2 / 3} locale="en" />);
  expect(html.match(/aspect-ratio:/gu)).toHaveLength(1);
  expect(html).toContain('aspect-ratio:1.7777777777777777');
  expect(html).toContain('Minecraft');
});

test('a lone preview and a full shelf retain the same Work design and scope destinations', () => {
  const work = resourceWork(book);
  const single = renderToString(<WorkGrid works={[work]} locale="en" />);
  const shelf = renderToString(<WorkShelf heading={{ title: 'More by this author' }}
    works={[work, resourceWork(game)]} locale="en" />);
  expect(coverStyles(single)[0]).toEqual(coverStyles(shelf)[0]);
  const realm = browseId(42);
  const scoped = renderToString(<ResourceList items={[book, community]} locale="en"
    scope={{ kind: 'realm', realm }} />);
  expect(scoped).toContain(`scope=realm&amp;realm=${encodeURIComponent(realm)}`);
});

test('preview art stays lazy while a lead detail cover can explicitly load eagerly', () => {
  const imageBook = { ...resourceWork(book), cover: { kind: 'image' as const,
    url: `/v1/media/representations/${browseId(9501).slice(-36)}`, selection: browseId(9502),
    mediaType: 'image/png', crop: null, coverCredit: null,
    basis: { policy: 'story', context: browseId(9503) }, width: 400, height: 600 } };
  const metadata = { representationId: browseId(9501).slice(-36), nsfw: 'sfw' as const,
    ageRating: { status: 'unassessed' as const } };
  const viewer = { ready: true, signedIn: false, age: 'unknown' as const,
    optIns: { general: true, r15: false, sexual: false, grotesque: false } };
  const preview = renderToString(<MediaImageProvider viewer={viewer} images={{ [mediaImageKey(metadata)]: metadata }}>
    <WorkTile work={imageBook} locale="en" />
  </MediaImageProvider>);
  expect(preview).toContain('loading="lazy"');
  expect(preview).not.toContain('fetchPriority="high"');
  const detail = renderToString(<MediaImageProvider viewer={viewer} images={{ [mediaImageKey(metadata)]: metadata }}>
    <CatalogueCover work={imageBook} size="xl" loading="eager" />
  </MediaImageProvider>);
  expect(detail).toContain('loading="eager"');
  expect(detail).toContain('fetchPriority="high"');
});
