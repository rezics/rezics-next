import { expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createKernelClient } from '@rezics/client';
import { createFakeKernelFetch } from '../src/kernel/fake.ts';
import fixtures from '../src/kernel/fixtures.json';
import {
  composedZoneEmptyFake,
  composedZoneMembersFake,
  composedZonePrivateMountFake,
  composedZoneSparseFake,
} from '../src/zones/static-fakes';
import { isolatePublicZonePage, receiveZonePage } from '../src/zones/receive';
import { projectZoneSlots } from '../src/zones/slots';
import { ZoneComposedPage } from '../src/zones/page';

mock.module('cloudflare:workers', () => ({ env: {} }));

const { readZonePage } = await import('../src/zones/zone-read');

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
  expect(isolatePublicZonePage(leaked, true).reads.owner?.body).toEqual({
    ownerId: '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e12',
    mounts: [],
  });
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
