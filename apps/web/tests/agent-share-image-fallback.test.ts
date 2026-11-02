import { expect, test } from 'bun:test';
import { agentPageHead, type AgentPage } from '../src/features/pages/agent-page';
import type { ShareCardProjection } from '../src/media/share-card';
import recording from '../src/kernel/recorded/agent-page.json';

const origin = 'https://rezics.example.test';
const cover = {
  ...recording.reads.r1.body.accounts[0]!.avatar,
  media: 'published-cover',
  width: 640,
  height: 960,
  variants: (['avif', 'webp'] as const).map((format) => ({ format, width: 2560 })),
};
const avatar = { ...cover, media: 'published-avatar' };

function check(avatar: unknown, subject: unknown, path: string, size = [2560, 3840], card?: ShareCardProjection) {
  const page = structuredClone(recording);
  page.reads.r1.body.accounts[0]!.avatar = avatar as (typeof page.reads.r1.body.accounts)[0]['avatar'];
  Object.assign(page.reads.r0.body, { summary: { cover: subject } });
  const result = agentPageHead(
    { ...page, account: { id: page.account, handle: page.handle } } as AgentPage,
    'en',
    origin,
    undefined,
    undefined,
    undefined,
    card,
  );
  const meta = Object.fromEntries(
    result.meta.flatMap((item) => ('content' in item ? [[item.property ?? item.name, item.content]] : [])),
  );
  expect([meta['og:image'], meta['twitter:image']]).toEqual([`${origin}${path}`, `${origin}${path}`]);
  expect([meta['og:image:width'], meta['og:image:height']]).toEqual(size.map(String));
  const entity = JSON.parse(result.scripts[0]!.children)['@graph'][0].mainEntity;
  expect(entity.image).toBe(path.startsWith('/media/') ? `${origin}${path}` : undefined);
}

test('account sharing keeps avatar priority, published formats and actual aspect ratios', () => {
  check(avatar, cover, '/media/published-avatar/webp-2560', [2560, 3840]);
  check({ ...avatar, width: 1e308, height: 1e308 }, cover, '/media/published-avatar/webp-2560', [2560, 2560]);
  check({ ...avatar, height: 0.01 }, cover, '/media/published-avatar/webp-2560', [2560, 1]);
  check(null, { ...cover, variants: [{ format: 'avif', width: 319 }] }, '/media/published-cover/avif-319', [319, 479]);
  const variants = [
    null,
    { format: 'webp', width: 1280.5 },
    { format: 'webp', width: 1200 },
    { format: 'jpeg', width: 2560 },
    { format: 'avif', width: 640 },
  ];
  check({ ...avatar, variants }, cover, '/media/published-avatar/avif-640', [640, 960]);
});

test('incomplete or unusable published images fall through without exposing withheld media', () => {
  const unusable = [
    null,
    { ...avatar, withheld: 'suitability' },
    ...[undefined, NaN, Infinity, -Infinity, 0, -1, '640'].flatMap((value) => [
      { ...avatar, width: value },
      { ...avatar, height: value },
    ]),
    ...['', '../private', 'bad image', 'image/other'].map((media) => ({ ...avatar, media })),
    ...[
      undefined,
      [],
      [null],
      [{ format: 'webp', width: 1280.5 }],
      [{ format: 'webp', width: 1200 }],
      [{ format: 'webp', width: Infinity }],
      [{ format: 'avif', width: Number.MAX_SAFE_INTEGER + 1 }],
    ].map((variants) => ({ ...avatar, variants })),
    { ...avatar, width: Number.MIN_VALUE, height: Number.MAX_VALUE },
  ];
  for (const value of unusable) {
    check(value, cover, '/media/published-cover/webp-2560', [2560, 3840]);
    check(null, value, '/cards/default.png', [1200, 630]);
  }
  const page = { id: recording.subject, locale: 'en' as const, title: 'Public card', types: [] };
  check(null, { ...cover, withheld: 'suitability' }, `/en/cards/${page.id}.png`, [1200, 630], { kind: 'ready', page });
  for (const value of [
    { ...cover, width: 1e308, height: 1e308 },
    { ...cover, variants: [{ format: 'webp' as const, width: 1200 }] },
  ]) {
    check(null, null, '/cards/default.png', [1200, 630], { kind: 'ready', page: { ...page, cover: value } });
  }
});
