import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { expect, test } from 'bun:test';
import { catalogueIntakePath } from '../../../tests/fixtures/catalogue/intake.ts';
import { loadVndbSlice } from '../../../tests/fixtures/vndb/load.ts';
import { seedKey } from './plan.ts';
import { applyVnCatalogue, type HttpResult, type SeedPort } from './vn-catalogue-step.ts';

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
