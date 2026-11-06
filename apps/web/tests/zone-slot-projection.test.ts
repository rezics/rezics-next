import { expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createKernelClient } from '@rezics/client';
import { createFakeKernelFetch } from '../src/kernel/fake.ts';
import fixtures from '../src/kernel/fixtures.json';
import {
  composedZoneAlicePrivateFake,
  composedZoneCollectionFake,
  composedZoneEditorFake,
  composedZoneEmptyFake,
  composedZoneMembersFake,
  composedZonePrivateMountFake,
  composedZoneSparseFake,
  composedZoneWithheldFake,
} from '../src/zones/static-fakes';
import { isolatePublicZonePage, receiveZonePage } from '../src/zones/receive';
import { projectZoneSlots, zoneTypeListTarget } from '../src/zones/slots';

mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('../src/paraglide/runtime.js', () => ({
  locales: ['en', 'zh-Hant', 'zh-Hans', 'ja', 'ko', 'de', 'fr', 'es'],
  getLocale: () => 'en',
}));
mock.module('../src/paraglide/messages.js', () => ({
  m: new Proxy(
    {},
    {
      get: () => () => '',
    },
  ),
}));

const { readZonePage } = await import('../src/zones/zone-read');
const { ZoneComposedPage } = await import('../src/zones/page');

const zoneId = composedZoneMembersFake.zone.id;
const privateId = composedZonePrivateMountFake.zone.id;
const subjectId = '01a17a3b-0884-721b-91ef-d7ffd7bb58e4';

test('routed Zone TypeList keeps native order, one canonical card and Zone continuation', async () => {
  const client = createKernelClient('https://kernel.example.test', {
    fetch: createFakeKernelFetch(fixtures) as typeof fetch,
  });
  const outcome = await readZonePage(client as never, zoneId, { target: { route: '' }, languages: ['en'] });
  expect(outcome.kind).toBe('page');
  if (outcome.kind !== 'page') throw new Error('expected composed page');
  const received = receiveZonePage(outcome.page)!;
  const slots = projectZoneSlots(received, { locale: 'en', zoneId, target: { kind: 'route', route: '' } });
  const body = slots.reads.r0?.body as { subjects: { id: string }[]; next: string | null };
  expect(body.subjects.map((row) => row.id)).toEqual([subjectId]);
  expect(body.next).toBe('next_members-2');
  expect(slots.listHref('books', body.next ?? undefined)).toBe(`/en/zones/${zoneId}?cursor=next_members-2`);
  expect(slots.memberHref({ id: subjectId, label: 'The Little Prince' })).toBe(
    `/en/zones/${zoneId}/subjects/${subjectId}`,
  );
  expect(zoneTypeListTarget(received)).toBeUndefined();

  const html = renderToStaticMarkup(
    createElement(ZoneComposedPage, {
      page: received,
      visit: { locale: 'en', zoneId, target: { kind: 'route', route: '' } },
    }),
  );
  expect(html).toContain(`href="/en/zones/${zoneId}/subjects/${subjectId}"`);
  expect(html).toContain(`href="/en/zones/${zoneId}?cursor=next_members-2"`);
  expect(html).not.toContain('/search/list');
  expect(html.match(new RegExp(subjectId, 'g'))?.length).toBeGreaterThan(0);
});

test('routed Zone Members keep the first native occurrence and continue on the Zone URL', async () => {
  const client = createKernelClient('https://kernel.example.test', {
    fetch: createFakeKernelFetch(fixtures) as typeof fetch,
  });
  const outcome = await readZonePage(client as never, composedZoneCollectionFake.zone.id, {
    target: { route: '' },
    languages: ['en'],
  });
  expect(outcome.kind).toBe('page');
  if (outcome.kind !== 'page') throw new Error('expected collection page');
  const received = receiveZonePage(outcome.page)!;
  const slots = projectZoneSlots(received, {
    locale: 'en',
    zoneId: composedZoneCollectionFake.zone.id,
    target: { kind: 'route', route: '' },
  });
  const body = slots.reads.r0?.body as { members: { subjectId: string }[]; next: string | null };
  expect(body.members.map((row) => row.subjectId)).toEqual([subjectId]);
  expect(body.next).toBe('next_collection-2');
  expect(slots.listHref('mounted', body.next ?? undefined)).toBe(
    `/en/zones/${composedZoneCollectionFake.zone.id}?cursor=next_collection-2`,
  );
  expect(zoneTypeListTarget(received)).toBeUndefined();
});

test('anonymous SSR conceals a private Zone that a session reread can admit', async () => {
  const requests: string[] = [];
  const client = createKernelClient('https://kernel.example.test', {
    fetch: (async (input, init) => {
      const request = new Request(input, init);
      const actor = request.headers.get('authorization') ?? 'anonymous';
      requests.push(`${actor}:${new URL(request.url).pathname}`);
      return createFakeKernelFetch(fixtures)(request);
    }) as typeof fetch,
  });
  const anonymous = await readZonePage(client as never, privateId, { target: { route: '' } });
  expect(anonymous).toEqual({ kind: 'missing' });
  const bob = await readZonePage(
    client as never,
    privateId,
    { target: { route: '' } },
    { authorization: 'Bearer bob' },
  );
  expect(bob).toEqual({ kind: 'missing' });
  const owner = await readZonePage(
    client as never,
    privateId,
    { target: { route: '' } },
    { authorization: 'Bearer owner', session: true },
  );
  expect(owner.kind).toBe('page');
  if (owner.kind !== 'page') throw new Error('expected owner page');
  expect(isolatePublicZonePage(receiveZonePage(owner.page)!, false).zone.visibility).toBe('private');
  expect(requests).toEqual([
    `anonymous:/v1/zones/${privateId}:readPage`,
    `Bearer bob:/v1/zones/${privateId}:readPage`,
    `Bearer owner:/v1/zones/${privateId}:readPage`,
  ]);
});

test('sparse and empty Zone continuations stay on the Zone reader', async () => {
  const client = createKernelClient('https://kernel.example.test', {
    fetch: createFakeKernelFetch(fixtures) as typeof fetch,
  });
  const sparse = await readZonePage(client as never, composedZoneSparseFake.zone.id, {
    target: { route: '' },
    languages: ['en'],
  });
  expect(sparse.kind).toBe('page');
  if (sparse.kind !== 'page') throw new Error('expected sparse page');
  const sparseSlots = projectZoneSlots(receiveZonePage(sparse.page)!, {
    locale: 'en',
    zoneId: composedZoneSparseFake.zone.id,
    target: { kind: 'route', route: '' },
  });
  const sparseBody = sparseSlots.reads.r0?.body as { subjects: unknown[]; next: string | null };
  expect(sparseBody.subjects).toEqual([]);
  expect(sparseBody.next).toBe('next_sparse-2');
  expect(sparseSlots.listHref('books', sparseBody.next ?? undefined)).toBe(
    `/en/zones/${composedZoneSparseFake.zone.id}?cursor=next_sparse-2`,
  );

  const empty = await readZonePage(client as never, composedZoneEmptyFake.zone.id, { target: { route: '' } });
  expect(empty.kind).toBe('page');
  if (empty.kind !== 'page') throw new Error('expected empty page');
  const emptyHtml = renderToStaticMarkup(
    createElement(ZoneComposedPage, {
      page: receiveZonePage(empty.page)!,
      visit: { locale: 'en', zoneId: composedZoneEmptyFake.zone.id, target: { kind: 'route', route: '' } },
    }),
  );
  expect(emptyHtml).not.toContain('/search/list');
  expect(emptyHtml).not.toContain('cursor=');
});

test('anonymous isolation drops leaked owner mount facts', () => {
  const received = receiveZonePage(composedZoneMembersFake)!;
  const leaked = {
    ...received,
    reads: {
      ...received.reads,
      owner: { status: 200, body: { ownerId: '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e12', mounts: [] } },
    },
  };
  expect(isolatePublicZonePage(leaked, false).reads.owner).toBeUndefined();
  expect(isolatePublicZonePage(leaked, true).reads.owner).toBeUndefined();
});

test('Alice admits a private mount that Bob, banned and anonymous readers cannot see', async () => {
  const client = createKernelClient('https://kernel.example.test', {
    fetch: createFakeKernelFetch(fixtures) as typeof fetch,
  });
  const aliceId = composedZoneAlicePrivateFake.zone.id;
  expect(await readZonePage(client as never, aliceId, { target: { route: '' } })).toEqual({ kind: 'missing' });
  expect(
    await readZonePage(client as never, aliceId, { target: { route: '' } }, { authorization: 'Bearer bob' }),
  ).toEqual({ kind: 'missing' });
  expect(
    await readZonePage(client as never, aliceId, { target: { route: '' } }, { authorization: 'Bearer banned' }),
  ).toEqual({ kind: 'missing' });
  const alice = await readZonePage(
    client as never,
    aliceId,
    { target: { route: '' } },
    { authorization: 'Bearer alice', session: true },
  );
  expect(alice.kind).toBe('page');
  if (alice.kind !== 'page') throw new Error('expected Alice private page');
  expect(alice.page.zone.id).toBe(aliceId);
});

test('a suspended credential conceals the current Zone read', async () => {
  const client = createKernelClient('https://kernel.example.test', {
    fetch: createFakeKernelFetch(fixtures) as typeof fetch,
  });
  expect(
    await readZonePage(
      client as never,
      composedZoneMembersFake.zone.id,
      { target: { route: '' } },
      { authorization: 'Bearer suspended' },
    ),
  ).toEqual({ kind: 'missing' });
});

test('an editor and anonymous visitor share the public ordered Zone list', async () => {
  const client = createKernelClient('https://kernel.example.test', {
    fetch: createFakeKernelFetch(fixtures) as typeof fetch,
  });
  const editorId = composedZoneEditorFake.zone.id;
  const anonymous = await readZonePage(client as never, editorId, { target: { route: '' } });
  const editor = await readZonePage(
    client as never,
    editorId,
    { target: { route: '' } },
    { authorization: 'Bearer editor', session: true },
  );
  expect(anonymous.kind).toBe('page');
  expect(editor.kind).toBe('page');
  if (anonymous.kind !== 'page' || editor.kind !== 'page') throw new Error('expected public editor list');
  const anonymousSlots = projectZoneSlots(receiveZonePage(anonymous.page)!, {
    locale: 'en',
    zoneId: editorId,
    target: { kind: 'route', route: '' },
  });
  const editorSlots = projectZoneSlots(receiveZonePage(editor.page)!, {
    locale: 'en',
    zoneId: editorId,
    target: { kind: 'route', route: '' },
  });
  expect((anonymousSlots.reads.r0?.body as { subjects: { id: string }[] }).subjects.map((row) => row.id)).toEqual(
    (editorSlots.reads.r0?.body as { subjects: { id: string }[] }).subjects.map((row) => row.id),
  );
});

test('withheld Zone members keep their locators and do not invent summaries', async () => {
  const client = createKernelClient('https://kernel.example.test', {
    fetch: createFakeKernelFetch(fixtures) as typeof fetch,
  });
  const withheldId = composedZoneWithheldFake.zone.id;
  const outcome = await readZonePage(client as never, withheldId, { target: { route: '' } });
  expect(outcome.kind).toBe('page');
  if (outcome.kind !== 'page') throw new Error('expected withheld page');
  const slots = projectZoneSlots(receiveZonePage(outcome.page)!, {
    locale: 'en',
    zoneId: withheldId,
    target: { kind: 'route', route: '' },
  });
  const body = slots.reads.r0?.body as { subjects: { id: string; summary: unknown }[] };
  expect(body.subjects).toHaveLength(2);
  expect(body.subjects[1]?.summary).toBeNull();
  expect(body.subjects[0]?.summary).not.toBeNull();
});

test('an unusable source-replacement cursor restarts the current Zone read', async () => {
  const client = createKernelClient('https://kernel.example.test', {
    fetch: createFakeKernelFetch(fixtures) as typeof fetch,
  });
  const outcome = await readZonePage(client as never, zoneId, { target: { route: '' } }, { cursor: 'stale-source' });
  expect(outcome.kind).toBe('page');
  if (outcome.kind !== 'page') throw new Error('expected restart');
  expect(outcome.page.zone.id).toBe(zoneId);
});
