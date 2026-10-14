import { expect, test } from 'bun:test';
import { aboutDiscussionAddress, retainedAboutPost } from './about-discussion-intent.ts';
import type { AboutPostIntent } from './about-discussion-api.ts';

const reference = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const actor = reference(1), zone = reference(2), path = '/chapters/first';
const intent: AboutPostIntent = { key: 'retained-discussion-intent', actingSubject: actor,
  basis: { realm: reference(3), about: reference(4), targetRevision: reference(5),
    zone, path, routeRevision: reference(6) }, body: '第一章の結末について\nExact second line.', language: 'ja', spoiler: true };
const load = (value: unknown, author = actor, atZone = zone, atPath = path) =>
  retainedAboutPost(JSON.stringify(value), author, atZone, atPath);

test('reload retains the complete accepted intent and frozen basis after the live page changes', () => {
  const today = { ...intent.basis, realm: reference(10), about: reference(11),
    targetRevision: reference(12), routeRevision: reference(13) };
  const restored = load(intent);
  expect(restored).toEqual(intent);
  expect(restored?.basis).not.toEqual(today);
  expect(restored?.key).toBe(intent.key);
  expect(restored?.body).toBe(intent.body);
  expect(restored?.language).toBe('ja');
  expect(restored?.spoiler).toBe(true);
  // Parsing returns an independent snapshot; refreshing the current read cannot mutate it.
  if (!restored) throw new Error('Expected retained discussion intent');
  restored.basis.routeRevision = today.routeRevision;
  expect(intent.basis.routeRevision).toBe(reference(6));
});

test('device recovery is isolated by the exact Person, Zone and route path', () => {
  expect(load(intent, reference(9))).toBeNull();
  expect(load(intent, actor, reference(9))).toBeNull();
  expect(load(intent, actor, zone, '/chapters/second')).toBeNull();
  expect(load(intent, actor, zone, `${path}?position=old`)).toBeNull();
  expect(load({ ...intent, actingSubject: reference(9) })).toBeNull();
  expect(load({ ...intent, basis: { ...intent.basis, zone: reference(9) } })).toBeNull();
  expect(load({ ...intent, basis: { ...intent.basis, path: '/chapters/second' } })).toBeNull();
});

test('malformed retained data cannot become a frozen, unrepairable post', () => {
  expect(retainedAboutPost('{broken', actor, zone, path)).toBeNull();
  for (const value of [null, [], 'text', 4, { ...intent, key: '' }, { ...intent, key: 'x'.repeat(129) },
    { ...intent, body: 7 }, { ...intent, body: '' }, { ...intent, body: ' \n\t' },
    { ...intent, language: false }, { ...intent, language: '' }, { ...intent, language: 'not a language' },
    { ...intent, key: 'bad\nheader' }, { ...intent, key: 'non ascii 日本語' },
    { ...intent, spoiler: 'true' }, { ...intent, basis: null }]) {
    expect(load(value)).toBeNull();
  }
  for (const field of ['realm', 'about', 'targetRevision', 'zone', 'routeRevision'] as const) {
    for (const value of [null, undefined, 'https://outside.test/id', reference(8).replace('4000', 'bad!')]) {
      expect(load({ ...intent, basis: { ...intent.basis, [field]: value } })).toBeNull();
    }
  }
});

test('retained content is bounded by UTF-8 bytes, including multibyte content at the exact limit', () => {
  const exact = { ...intent, body: '😀'.repeat(2048) };
  expect(new TextEncoder().encode(exact.body).length).toBe(8192);
  expect(load(exact)).toEqual(exact);
  const tooLarge = { ...intent, body: '😀'.repeat(2049) };
  expect(tooLarge.body.length).toBeLessThan(8192);
  expect(load(tooLarge)).toBeNull();
});

test('retained language tags use the shared RFC 5646 parser within the operation length bound', () => {
  for (const language of ['x-personal', 'i-klingon', 'en-GB-oed', 'zh-cmn-Hans-CN', 'abcdefgh']) {
    expect(load({ ...intent, language })).toEqual({ ...intent, language });
  }
  for (const language of ['ja-x-' + 'abcdefgh-'.repeat(4) + 'a', 'en-a-abc-a-def', 'sl-rozaj-rozaj', 'ja-JP-日', ' ja']) {
    expect(load({ ...intent, language })).toBeNull();
  }
});

test('site home, Work and entity addresses select live route paths without reading coordinates', () => {
  for (const [href, expectedPath] of [
    // ast-grep-ignore: web-links-use-address -- Raw address inputs are the route extraction oracle.
    ['/z/reading-house', '/'],
    // ast-grep-ignore: web-links-use-address -- Raw address inputs are the route extraction oracle.
    ['/z/reading-house/', '/'],
    // ast-grep-ignore: web-links-use-address -- Raw address inputs are the route extraction oracle.
    ['/z/reading-house/w/work-key', '/w/work-key'],
    // ast-grep-ignore: web-links-use-address -- Raw address inputs are the route extraction oracle.
    ['/z/reading-house/chapters/work-key', '/chapters/work-key'],
    // ast-grep-ignore: web-links-use-address -- Raw address inputs are the route extraction oracle.
    ['/z/reading-house/characters/entity-key', '/characters/entity-key'],
  ]) {
    expect(aboutDiscussionAddress(href!)).toEqual({ spaceRef: 'reading-house', path: expectedPath });
    expect(aboutDiscussionAddress(`${href}?position=old&main=retained&context=question&realm=other`))
      .toEqual({ spaceRef: 'reading-house', path: expectedPath });
    expect(aboutDiscussionAddress(`${href}#discussion`)).toEqual({ spaceRef: 'reading-house', path: expectedPath });
  }
});

test('standalone and external addresses never invent a Zone discussion context', () => {
  const invalid = [
    // ast-grep-ignore: web-links-use-address -- Negative address inputs must not use the valid-link builder.
    '/w/work-key',
    // ast-grep-ignore: web-links-use-address -- Negative address inputs must not use the valid-link builder.
    '/e/entity-key',
    // ast-grep-ignore: web-links-use-address -- Negative address inputs must not use the valid-link builder.
    '/r/community',
    // ast-grep-ignore: web-links-use-address -- Negative address inputs must not use the valid-link builder.
    '/a/person', '/z', '/', '',
    // ast-grep-ignore: web-links-use-address -- This external URL must be rejected without becoming a local link.
    'https://outside.test/z/reading-house/w/work-key', '//outside.test/z/reading-house/w/work-key',
  ];
  for (const href of invalid) {
    expect(aboutDiscussionAddress(href)).toBeNull();
  }
});
