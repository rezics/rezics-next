import { expect, mock, test } from 'bun:test';
import { createKernelClient, type KernelClient } from '@rezics/client';
import definitions from '../../../packages/definitions/release/rezics.json';
import { qualifiedRelationsPage } from '../src/kernel/fake/qualified-relations';
import type { GuideRelease } from '../src/features/catalogue/definition-guide';
import type { ConnectionGroup, ConnectionVisit, ConnectionWork } from '../src/features/pages/subject-connections';
import { createConnectionWindow } from '../src/features/pages/subject-connections-window';
import {
  connectionReturnHref,
  subjectVisitReturn,
  withSubjectVisitReturn,
} from '../src/features/pages/subject-visit-navigation';

mock.module('cloudflare:workers', () => ({ env: { PUBLIC_ORIGIN: 'https://rezics.test' } }));
const { readConnectionVisit, connectionStreams } = await import('../src/features/pages/subject-connections');
const { subjectBody } = await import('../src/features/pages/subject');
const { holderItems } = await import('../src/features/pages/overview');
const release = { ...definitions, digest: 'a'.repeat(64) } as unknown as GuideRelease;
const page = qualifiedRelationsPage();
const address = { id: page.subject!, locale: 'en' };
const subject = subjectBody(page)!.subject;
const success = (): Extract<ConnectionVisit, { ok: true }> => ({
  ok: true,
  id: address.id,
  release: release.digest,
  streams: [],
  sections: {},
});

test('installed definitions expose both directions, appearances and character-qualified voice credits', () => {
  const work = connectionStreams(release, subject.type, address.id, 'en');
  expect(work.some((stream) => stream.property === 'rezics:crossMediaCounterpart')).toBe(true);
  expect(work.some((stream) => stream.property === 'schema:character' && stream.direction === 'out')).toBe(true);
  expect(work.some((stream) => stream.group === 'credits')).toBe(true);
  const character = connectionStreams(release, 'wd:Q95074', address.id, 'ja');
  expect(character.some((stream) => stream.property === 'schema:character' && stream.direction === 'in')).toBe(true);
  expect(character.some((stream) => stream.property === 'wdt:P725' && stream.filter === address.id)).toBe(true);
  const person = connectionStreams(release, 'schema:Person', address.id, 'en');
  expect(person.some((stream) => stream.group === 'credits' && stream.direction === 'in')).toBe(true);
});

test('real Web boundary work stays bounded at 32/256/2048 unrelated records, including concealed sparse pages', async () => {
  const observations: ConnectionWork[] = [];
  for (const type of ['schema:TVSeries', 'wd:Q95074', 'schema:Person']) {
    for (const size of [32, 256, 2048]) {
      const selectedPage = structuredClone(page);
      subjectBody(selectedPage)!.subject.type = type;
      // A native-format boundary double, not native execution or a database scan measurement.
      const catalogue = Array.from({ length: size }, (_, index) => ({ target: `unrelated-${index}` }));
      const requests: Request[] = [];
      const client = createKernelClient('https://native-boundary.test', {
        fetch: (async (input, init) => {
          const request = new Request(input, init);
          requests.push(request);
          expect(request.headers.get('authorization')).toBe('original credential');
          const url = new URL(request.url);
          if (url.pathname.endsWith('/pages:read')) return Response.json(selectedPage);
          if (url.pathname.includes('/definitions'))
            return Response.json(
              url.pathname.endsWith('active') ? { digest: release.digest } : { digest: release.digest, release },
            );
          expect(Number(url.searchParams.get('limit'))).toBe(12);
          return Response.json({
            relations: catalogue.slice(0, 12).map((row) => ({ ...row, summary: null })),
            links: [],
            count: { value: 1000, exact: false },
            next: 'opaque-native-cursor',
          });
        }) as typeof fetch,
      });
      const dependencies = { observe: (work: Readonly<ConnectionWork>) => observations.push({ ...work }) };
      const visit = await readConnectionVisit(client, address, 'original credential', undefined, dependencies);
      expect(visit.ok).toBe(true);
      if (!visit.ok) throw new Error('Reader unavailable');
      const groups = Object.keys(visit.sections) as ConnectionGroup[];
      expect(groups.length).toBeGreaterThan(0);
      expect(groups.length).toBeLessThanOrEqual(3);
      for (const current of Object.values(visit.sections))
        if (current.section.ok && current.stream.direction === 'in') {
          const projection = holderItems(current.section.body, 12, 'en', 0);
          expect(projection.items).toEqual([]);
          expect(projection.more).toBe(true);
        }
      expect(requests).toHaveLength(4 + groups.length);
      expect(observations.at(-1)!.calls).toBe(4 + groups.length);
      expect(observations.at(-1)!.values).toBeLessThanOrEqual(36);
      expect(observations.at(-1)!.bytes).toBeLessThanOrEqual(3 * 1_048_576);
      const group = groups[0]!;
      const stream = visit.sections[group]!.stream;
      const continued = await readConnectionVisit(
        client,
        {
          ...address,
          release: release.digest,
          only: group,
          selection: { [group]: { stream: stream.key, cursor: 'opaque-native-cursor' } },
        },
        'original credential',
        undefined,
        dependencies,
      );
      expect(continued.ok).toBe(true);
      expect(observations.at(-1)!.calls).toBe(5);
      expect(requests).toHaveLength(9 + groups.length);
      expect(
        requests.some((request) => new URL(request.url).searchParams.get('cursor') === 'opaque-native-cursor'),
      ).toBe(true);
    }
    const samples = observations
      .slice(-6)
      .filter((_, index) => index % 2 === 0)
      .map((work) => [work.calls, work.values, work.bytes]);
    expect(samples).toEqual(Array(3).fill(samples[0]));
  }
});

test('current release or representation replacement refuses the whole prior reading; native failures remain independent', async () => {
  let reads = 0;
  const client = {
    subjects: () => ({
      relations: { get: async () => ({ status: 403 }) },
      links: {
        get: async () => ({ status: 200, data: { links: [], next: 'sparse-next', count: { value: 1, exact: true } } }),
      },
    }),
  } as unknown as KernelClient;
  const dependencies = { page: async () => ({ kind: 'page' as const, page }), release: async () => release };
  const result = await readConnectionVisit(client, address, undefined, undefined, dependencies);
  expect(result.ok).toBe(true);
  if (result.ok)
    expect(Object.values(result.sections).some((row) => !row.section.ok && row.section.status === 403)).toBe(true);
  expect(
    await readConnectionVisit(client, { ...address, release: 'b'.repeat(64) }, undefined, undefined, dependencies),
  ).toEqual({ ok: false, status: 409 });
  const changed = await readConnectionVisit(client, address, undefined, undefined, {
    ...dependencies,
    page: async () => ({ kind: 'page' as const, page: ++reads === 1 ? page : { ...page, profile: 'replacement' } }),
  });
  expect(changed).toEqual({ ok: false, status: 409 });
});

test('one visit replaces sparse pages and retires late private rows, pending requests and cursors', async () => {
  const pending: Array<{ signal: AbortSignal; resolve: (visit: ConnectionVisit) => void }> = [];
  const window = createConnectionWindow(
    address,
    (_input, signal) => new Promise((resolve) => pending.push({ signal, resolve })),
  );
  const first = window.load();
  const stream = connectionStreams(release, subject.type, address.id, 'en').find(
    (stream) => stream.group === 'credits',
  )!;
  const section = {
    stream,
    section: {
      ok: true as const,
      body: { links: ['original private row'], next: 'original' },
      read: { kind: 'links' as const, id: address.id, property: stream.property, limit: 12 },
    },
  };
  pending[0]!.resolve({ ...success(), sections: { credits: section, relations: section } });
  await first;
  const more = window.load('credits', { stream: 'in:wdt:P725', cursor: 'original' });
  expect(window.snapshot().visit?.sections.credits).toBeUndefined();
  expect(window.snapshot().visit?.sections.relations).toBe(section);
  const graph = window.load(undefined, undefined, { properties: ['wdt:P144'], depth: 2 });
  expect(window.snapshot().pending.size).toBe(2);
  window.retire();
  expect(pending.slice(1).every((request) => request.signal.aborted)).toBe(true);
  for (const request of pending.slice(1)) request.resolve(success());
  await Promise.all([more, graph]);
  expect(window.snapshot()).toEqual({ pending: new Set() });
  await window.load();
  expect(pending).toHaveLength(3);
});

test('return navigation retains one canonical public destination and Realm, with no authority or chained history', () => {
  const from = connectionReturnHref(address.id, 'A work', 'en', '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e99');
  expect(subjectVisitReturn(from, 'en')).toBe(from);
  const target = connectionReturnHref(address.id, 'A character', 'en');
  const linked = new URL(withSubjectVisitReturn(target, from, 'en'), 'https://rezics.test');
  expect(linked.searchParams.get('via')).toBe(from);
  for (const unsafe of [
    '//attacker.test/en/subjects/x/y',
    '/en/settings',
    `${from.split('#')[0]}&cursor=private`,
    `${from.split('#')[0]}&via=nested`,
    '/en/subjects/not-a-uuid/work',
    from.replace('/en/', '/ja/'),
  ]) {
    expect(subjectVisitReturn(unsafe, 'en')).toBeUndefined();
  }
});
