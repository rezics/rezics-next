import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import { catalogueIntakePath } from '../../../tests/fixtures/catalogue/intake.ts';
import { loadVndbSlice } from '../../../tests/fixtures/vndb/load.ts';
import { seedKey } from './plan.ts';
import { applyVnCatalogue, call, type HttpResult, type SeedPort } from './vn-catalogue-step.ts';

afterEach(() => mock.restore());

test('catalogue Work commands wait for broker admission with the same body and key', async () => {
  const sleep = spyOn(Bun, 'sleep').mockResolvedValue(undefined);
  const body = { title: 'A catalogue Work', actingSubject: native() };
  const requests: { method: string; path: string; body: unknown; key?: string }[] = [];
  const fake: SeedPort = {
    actingSubject: native(), grant: async () => {},
    request: async (method, path, sent, key) => {
      requests.push({ method, path, body: sent, key });
      return requests.length < 4
        ? { status: 503, body: { code: 'backpressure_saturated' } }
        : { status: 201, body: { work: 'created' } };
    },
  };
  expect(await call<{ work: string }>(fake, 'POST', '/v1/works', body, 'catalogue-work'))
    .toEqual({ work: 'created' });
  expect(requests).toEqual(Array.from({ length: 4 }, () => ({
    method: 'POST', path: '/v1/works', body, key: 'catalogue-work',
  })));
  expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([500, 1000, 2000]);
});

test('broker retries are bounded and preserve the final refusal', async () => {
  const sleep = spyOn(Bun, 'sleep').mockResolvedValue(undefined);
  let attempts = 0;
  const fake: SeedPort = {
    actingSubject: native(), grant: async () => {},
    request: async () => { attempts++; return { status: 503, body: { code: 'backpressure_saturated' } }; },
  };
  await expect(call(fake, 'POST', '/v1/works', {}, 'catalogue-work'))
    .rejects.toThrow('POST /v1/works HTTP 503 {"code":"backpressure_saturated"}');
  expect(attempts).toBe(8);
  expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([500, 1000, 2000, 4000, 4000, 4000, 4000]);
});

test('seed commands keep authorization and unrelated unavailable refusals', async () => {
  const sleep = spyOn(Bun, 'sleep').mockResolvedValue(undefined);
  for (const [status, code] of [[403, 'authority_denied'], [503, 'backpressure_unavailable'],
    [503, 'work_read_unavailable']] as const) {
    let attempts = 0;
    const fake: SeedPort = {
      actingSubject: native(), grant: async () => {},
      request: async () => { attempts++; return { status, body: { code } }; },
    };
    await expect(call(fake, 'POST', '/v1/works', {}, 'catalogue-work')).rejects.toThrow(code);
    expect(attempts).toBe(1);
  }
  expect(sleep).not.toHaveBeenCalled();
});

const native = () => `https://rezics.com/id/${randomUUID()}`;

function port(actor: string, epoch: string) {
  const writes: { method: string; path: string; body: unknown }[] = [];
  const grants: string[] = [];
  const request: SeedPort['request'] = async (method, path, body) => {
    const pathname = path.split('?')[0]!;
    writes.push({ method, path: pathname, body });
    return respond(method, pathname, epoch);
  };
  const fake: SeedPort = {
    actingSubject: actor,
    request,
    grant: async (scope, action) => { grants.push(`${action} ${scope}`); },
  };
  return { fake, writes, grants };
}

function respond(method: string, pathname: string, epoch: string): HttpResult {
  const id = native();
  const ok = (body: unknown, status = 200): HttpResult => ({ status, body });
  if (method === 'POST' && pathname === '/v1/catalogue/candidates') {
    return ok({ candidateReceipt: randomUUID(), sourcePosition: { dataEpoch: epoch } });
  }
  if (method === 'POST' && pathname === '/v1/classification-propositions') {
    return ok({ concept: id, sense: native(), definitionRevision: native() });
  }
  if (method === 'POST' && pathname === '/v1/contexts') return ok({ context: id, semanticRevision: native() });
  if (method === 'POST' && pathname.endsWith('/spoiler-hints')) return ok({});
  if (method === 'POST' && pathname === '/v1/agents') return ok({ agent: id, state: 'active' });
  if (method === 'POST' && pathname === '/v1/works') {
    return ok({ work: id, mainVersion: native(), workRevision: native(), mainRevision: native(), replayed: false }, 201);
  }
  if (method === 'GET' && pathname.endsWith('/metadata')) return { status: 404, body: {} };
  if (method === 'PUT' && pathname.endsWith('/metadata')) return ok({ revision: id });
  if (method === 'POST' && pathname === '/v1/contributions') return ok({ contribution: id, draftRevision: native() });
  if (method === 'POST' && pathname === '/v1/contribution-publications') return ok({ publicationDecision: id });
  if (method === 'POST' && pathname === '/v1/publication-selections') return ok({});
  if (method === 'PUT' && pathname.includes('/realizations/')) return ok({ revision: id });
  if (method === 'PUT' && pathname.includes('/releases/')) return ok({});
  if (method === 'GET' && pathname.includes('/agent-credits')) return ok({ items: [], nextCursor: null });
  if (method === 'POST' && pathname.endsWith('/agent-credits')) return ok({});
  if (method === 'GET' && pathname.includes('/releases/')) return ok({ revision: id });
  if (method === 'POST' && pathname === '/v1/classification-resolutions') {
    return ok({ state: 'unset', source: 'none', decision: null });
  }
  if (method === 'POST' && pathname === '/v1/statements') return ok({ statement: id, meaningKey: id });
  if (method === 'POST' && pathname === '/v1/statement-decisions') return ok({});
  if (method === 'POST' && pathname === '/v1/rights/offerings') return ok({ offering: id, revision: native() });
  if (method === 'POST' && pathname === '/v1/rights/use-assessments') return ok({ assessmentId: id, obligations: [] });
  if (method === 'GET' && /\/v1\/works\/[^/]+$/.test(pathname)) return ok({ revision: id, metadataRevision: id });
  throw new Error(`unhandled ${method} ${pathname}`);
}

test('seeded visual novels carry no author credit for the acting account', async () => {
  const actor = native();
  const epoch = `vn-catalogue-${randomUUID()}`;
  const slice = loadVndbSlice();
  const { fake, writes, grants } = port(actor, epoch);
  try {
    const manifest = await applyVnCatalogue(fake);
    expect(manifest.works).toHaveLength(slice.tables.vn.length);
    const created = writes.filter(item => item.method === 'POST' && item.path === '/v1/works');
    expect(created).toHaveLength(slice.tables.vn.length);
    for (const item of created) {
      expect(item.body).toMatchObject({
        profile: 'metadata-only-v1', authoring: 'catalogue', grain: 'new-creative-scope', actingSubject: actor,
      });
      expect(item.body).toEqual(expect.objectContaining({
        candidateReceipt: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
      }));
    }
    const credits = writes.filter(item => item.method === 'POST' && item.path.endsWith('/agent-credits'));
    expect(credits.length).toBeGreaterThan(0);
    for (const item of credits) expect((item.body as { agent: string }).agent).not.toBe(actor);
    expect(grants).toContain('catalogue.verify catalogue:verify:root');
  } finally {
    for (const vn of slice.tables.vn) {
      rmSync(catalogueIntakePath(epoch, actor, seedKey('vndb-work', vn.id)), { force: true });
    }
  }
});
