import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { WorkShowcase } from '../features/api/showcase.ts';
import { fixtureArt } from '../features/showcase/fixtures.ts';
import { messages } from '../features/showcase/messages.ts';
import {
  workHeaderLogo,
  WorkArtHero,
  workShowcaseHeader,
} from '../features/showcase/work-header.tsx';
import { work } from '../features/work-page/fixtures.ts';
import { messages as workPageMessages } from '../features/work-page/messages.ts';
import { WorkHeader } from '../features/work-page/work-header.tsx';

const id = '00000000-0000-7000-8000-000000000001';
const image = (role: WorkShowcase['images'][number]['role'], extra = {}): WorkShowcase['images'][number] => ({
  role,
  selection: id,
  asset: id,
  use: id,
  representation: id,
  context: `https://rezics.com/id/${id}`,
  url: `/v1/media/representations/${id}/bytes?use=${id}`,
  mediaType: 'image/png',
  width: 1600,
  height: 900,
  cropWidth: 1600,
  cropHeight: 900,
  crop: null,
  focalArea: null,
  srcset: [{ url: '/v1/media/small.webp', width: 640, height: 360, type: 'image/webp' }],
  ...extra,
});
const item = (images: WorkShowcase['images'], trailer: WorkShowcase['trailer'] = null): WorkShowcase => ({
  reference: `https://rezics.com/id/${id}`,
  status: 'available',
  images,
  trailer,
});

test('a Work opens with art only when it has a background', () => {
  expect(workShowcaseHeader(undefined, messages.en)).toBeNull();
  expect(workShowcaseHeader(item([]), messages.en)).toBeNull();
  // A logo or a trailer alone leaves the plain header.
  expect(
    workShowcaseHeader(
      item([image('logo', { language: 'en', tone: 'light', anchor: 'start-bottom' })], {
        selection: id,
        context: `https://rezics.com/id/${id}`,
        url: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ',
        provider: 'youtube',
      }),
      messages.en,
    ),
  ).toBeNull();
  const header = workShowcaseHeader(
    item([image('background-landscape')], {
      selection: id,
      context: `https://rezics.com/id/${id}`,
      url: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ',
      provider: 'youtube',
    }),
    messages.en,
  )!;
  expect(header.art.landscape?.url).toBe(`/api/main/v1/media/representations/${id}/bytes?use=${id}`);
  expect(header.trailer).toEqual({ href: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ' });
});

test('the logo follows the title language or is language-neutral, never another language', () => {
  const header = { art: fixtureArt, trailer: null, messages: messages.en };
  expect(workHeaderLogo(header, 'en')?.language).toBe('en');
  expect(workHeaderLogo(header, 'ja')?.language).toBe('ja');
  // No English or neutral logo for a French title: the live title stays.
  expect(workHeaderLogo(header, 'fr')).toBeNull();
});

test('the header lies over the art as live text with the title as the page heading', () => {
  const showcase = { art: fixtureArt, trailer: { href: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ' }, messages: messages.en };
  const html = renderToStaticMarkup(
    <WorkArtHero header={showcase}>
      <WorkHeader
        work={work}
        credits={<p>Maren Osei</p>}
        showcase={showcase}
        locale="en"
        messages={workPageMessages.en}
      />
    </WorkArtHero>,
  );
  expect(html).toContain('class="work-hero"');
  // One picture per window shape and no text baked into the art layers.
  expect(html.match(/<source /g)).toHaveLength(4);
  expect(html).toContain('<h1');
  expect(html).toContain('The Cartographer of Tides');
  expect(html).toContain('Maren Osei');
  expect(html).toContain('Watch trailer');
  // Nothing plays until it is asked for.
  expect(html).not.toContain('<iframe');
  expect(html).not.toContain('autoplay');
});

test('without art the header is the plain header', () => {
  const html = renderToStaticMarkup(
    <WorkHeader work={work} credits={<p>Maren Osei</p>} locale="en" messages={workPageMessages.en} />,
  );
  expect(html).not.toContain('work-hero');
  expect(html).not.toContain('Watch trailer');
  expect(html).toContain('<h1');
});
