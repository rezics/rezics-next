import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { expect, test } from 'bun:test';
import { catalogueIntakePath } from '../../../tests/fixtures/catalogue/intake.ts';
import { cataloguePlan } from '../../../tests/fixtures/catalogue/load.ts';
import { SHOWCASE } from '../../../tests/fixtures/vndb/load.ts';
import { applyLnVnZones, createSpace } from './ln-vn-zones-step.ts';
import { seedKey } from './plan.ts';
import type { HttpResult, SeedPort } from './vn-catalogue-step.ts';

const native = (suffix: string) => `https://rezics.com/id/00000000-0000-4000-a000-${suffix.padStart(12, '0')}`;
const zone = native('1');
const spec = { id: 'light-novels', name: 'Light novels', language: 'en', routeSegment: 'light-novels', preset: 'editorial' as const,
  mountSegment: 'catalogue', navigation: [], browse: [], announcement: '', sharedMember: '' };

function port(create: HttpResult, pages: Record<string, HttpResult> = {}) {
  const calls: string[] = [];
  const fake: SeedPort = {
    actingSubject: native('9'),
    request: async (method, path) => {
      calls.push(`${method} ${path.split('?')[0]}`);
      if (method === 'POST') return create;
      return pages[path.split('?')[0]!] ?? { status: 404, body: {} };
    },
    grant: async (scope, action) => { calls.push(`grant ${action} ${scope}`); },
  };
  return { fake, calls };
}
const conflict: HttpResult = { status: 409, body: { code: 'idempotency_conflict' } };
const existing = {
  [`/v1/zones/${zone.slice(-36)}/configuration`]: { status: 200,
    body: { configuration: { space: native('2'), defaultRealm: native('3') } } },
  [`/v1/realms/${native('3').slice(-36)}`]: { status: 200, body: { id: native('3'), space: native('2') } } };

test('a new Space is the create receipt, with no further reads', async () => {
  const { fake, calls } = port({ status: 200, body: { space: native('2'), realm: native('3') } });
  expect(await createSpace(fake, spec, zone)).toEqual({ space: native('2'), realm: native('3') });
  expect(calls).toEqual(['POST /v1/spaces']);
});

test('a Space recorded under an earlier body is adopted through its Zone after the Zone grant, with no second create', async () => {
  const { fake, calls } = port(conflict, existing);
  expect(await createSpace(fake, spec, zone)).toMatchObject({ space: native('2'), realm: native('3') });
  expect(calls[0]).toBe('POST /v1/spaces');
  expect(calls[1]).toBe(`grant zone.official zone:official:${zone}`);
  expect(calls.filter(call => call.startsWith('POST'))).toHaveLength(1);
});

test('a conflict whose Zone does not name the Space stays a failure', async () => {
  const { fake } = port(conflict);
  await expect(createSpace(fake, spec, zone)).rejects.toThrow('POST /v1/spaces HTTP 409');
});

const SHELF = ['Light novel shelf: completed', 'Light novel shelf: ongoing', 'Light novel shelf: hiatus'];

function catalogueKey(suffix: string): string {
  return `catalogue:v1:${suffix.toLowerCase().replace(/[^a-z0-9:_./-]+/g, '-').replace(/^-|-$/g, '')}`;
}

test('seeded light-novel shelf samples carry no author credit for the acting account', async () => {
  const actor = native('9');
  const epoch = `ln-vn-zones-${randomUUID()}`;
  const writes: { method: string; path: string; body: unknown }[] = [];
  const grants: string[] = [];
  const collections = new Set<string>();
  const id = () => `https://rezics.com/id/${randomUUID()}`;
  const fake: SeedPort = {
    actingSubject: actor,
    grant: async (scope, action) => { grants.push(`${action} ${scope}`); },
    request: async (method, path, body) => {
      const pathname = path.split('?')[0]!;
      writes.push({ method, path: pathname, body });
      const ok = (payload: unknown, status = 200): HttpResult => ({ status, body: payload });
      if (method === 'POST' && pathname === '/v1/catalogue/candidates') {
        return ok({ candidateReceipt: randomUUID(), sourcePosition: { dataEpoch: epoch } });
      }
      if (method === 'POST' && pathname === '/v1/works') {
        return ok({ work: id(), mainVersion: id(), workRevision: id(), mainRevision: id(), replayed: false }, 201);
      }
      if (method === 'GET' && pathname.endsWith('/metadata')) return { status: 404, body: {} };
      if (method === 'PUT' && pathname.endsWith('/metadata')) return ok({ revision: id() });
      if (method === 'POST' && pathname === '/v1/contributions') return ok({ contribution: id(), draftRevision: id() });
      if (method === 'POST' && pathname === '/v1/contribution-publications') return ok({ publicationDecision: id() });
      if (method === 'POST' && pathname === '/v1/publication-selections') return ok({});
      if (method === 'POST' && pathname === '/v1/spaces') return ok({ space: id(), realm: id() });
      if (method === 'POST' && pathname === '/v1/zones') return ok({});
      if (method === 'POST' && pathname === '/v1/collections') {
        const collection = (body as { collection?: string } | undefined)?.collection;
        if (collection) collections.add(collection);
        return ok({ structure: id(), revision: id() });
      }
      if (method === 'POST' && /^\/v1\/collections\/[^/]+\/changes$/.test(pathname)) {
        const { operations } = body as { operations: { target?: string }[] };
        if (operations.some(operation => operation.target && !grants.includes(`work.read work:read:${operation.target}`)))
          return { status: 404, body: { code: 'collection_unavailable' } };
        return ok({ revision: id() });
      }
      if (method === 'GET' && pathname.endsWith('/configuration')) {
        return ok({ revision: id(), name: '', language: '', configuration: {
          defaultRealm: null, official: null, presentation: null } });
      }
      if (method === 'PUT' && pathname.endsWith('/configuration')) return ok({});
      if (method === 'GET' && pathname.startsWith('/v1/collections/')) {
        return ok({ structure: id(), revision: id(), next: null, occurrences: [] });
      }
      if (method === 'POST' && pathname.endsWith('/changes')) return ok({ revision: id() });
      if (method === 'GET' && pathname.startsWith('/v1/zones/')) {
        return ok({ revision: id(), mounts: [...collections].map(target => ({ target, state: 'active' })) });
      }
      if (method === 'GET' && pathname.endsWith('/reader-state')) return ok({ status: { status: 'reading', version: 1 } });
      throw new Error(`unhandled ${method} ${pathname}`);
    },
  };
  const showcase = id();
  const privateBook = id();
  try {
    await applyLnVnZones({
      port: fake, vnWorks: [{ vndb: SHOWCASE.vn, iri: showcase }], showcaseIri: showcase, extraBooks: [privateBook],
    });
    const created = writes.filter(item => item.method === 'POST' && item.path === '/v1/works');
    const samples = created.filter(item => SHELF.includes((item.body as { title?: string }).title ?? ''));
    expect(samples).toHaveLength(SHELF.length);
    for (const item of samples) {
      expect(item.body).toMatchObject({
        profile: 'metadata-only-v1', authoring: 'catalogue', grain: 'new-creative-scope', actingSubject: actor,
      });
    }
    for (const item of created) expect((item.body as { authoring?: string }).authoring).not.toBe('own-work');
    const credits = writes.filter(item => item.method === 'POST' && item.path.endsWith('/agent-credits'));
    expect(credits).toEqual([]);
    expect(grants).toContain('catalogue.verify catalogue:verify:root');
    expect(grants).toContain(`work.read work:read:${privateBook}`);
    expect(grants).toContain(`work.read work:read:${showcase}`);
  } finally {
    for (const sample of ['completed', 'ongoing', 'hiatus']) {
      rmSync(catalogueIntakePath(epoch, actor, seedKey('vndb-sample', sample)), { force: true });
    }
    for (const item of cataloguePlan().works) {
      rmSync(catalogueIntakePath(epoch, actor, catalogueKey(`work:${item.id}`)), { force: true });
    }
  }
});

test('other refusals are never adopted', async () => {
  const { fake, calls } = port({ status: 403, body: { code: 'forbidden' } }, existing);
  await expect(createSpace(fake, spec, zone)).rejects.toThrow('HTTP 403');
  expect(calls).toEqual(['POST /v1/spaces']);
});
