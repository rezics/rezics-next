import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { bundledDigest, bundledRelease, bundledSources } from '@rezics/definitions/bundled';
import {
  MAX_PAGE_COST,
  MAX_PAGE_READS,
  VIEWS,
  planReads,
  platformRegistry,
  profileDigest,
  readCost,
  templateViews,
  type CompositionDocument,
  type View,
} from '@rezics/composition';
import type { HttpResponse } from '../../../../specs/pages-driver.ts';
import type { Subject } from '../../../../specs/semantic-driver.ts';
import { platformProfile } from '../../src/presentation/setup.ts';
import { createSemanticDriver, type SemanticOutcomeDriver } from '../semantic/outcome-driver.ts';
import { createPagesDriver } from './outcome-driver.ts';

// This is kernel factual-page evidence. Served HTML/JSON-LD is a separate Web cell;
// words/form/diet discovery and recipe instruction producers are separate Semantic cells.
// No synthetic profile, release, index response or vertical page implementation is used.
const launch = {
  book: ['schema:Book', 'bf:Instance'],
  recipe: ['schema:Recipe'],
  'visual-novel': ['wd:Q689445'],
  anime: ['schema:Episode', 'schema:Movie', 'schema:TVSeason', 'schema:TVSeries'],
  manga: ['schema:ComicSeries', 'schema:PublicationVolume'],
  game: ['schema:VideoGame', 'wd:Q20631656', 'wd:Q209163'],
  series: ['wd:Q7725310', 'schema:BookSeries'],
  character: ['wd:Q95074'],
  agents: ['schema:Person', 'schema:Organization', 'schema:SoftwareApplication'],
};
const sources = bundledSources();
const key = () => ({ 'Idempotency-Key': `"${randomUUID()}"` });
const digest = profileDigest(platformProfile);
type Reader = {
  request(
    persona: 'anonymous' | 'editor',
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<HttpResponse>;
};
type Scope = { scope: 'type' | 'base' | 'generic'; key: string | null };
type ReadValue = { status: number; body: Record<string, unknown> };
type Page = {
  subject: string;
  profile: string;
  template: Scope;
  document: CompositionDocument;
  views: View[];
  reads: Record<string, ReadValue>;
};
function status(response: HttpResponse, wanted: number, phase: string) {
  expect(response.status, `${phase}: ${JSON.stringify(response.body)}`).toBe(wanted);
}
function selection(type: string): Scope {
  if (['schema:Person', 'schema:Organization', 'wd:Q95074'].includes(type)) return { scope: 'type', key: type };
  if (['schema:TVSeries', 'schema:ComicSeries', 'schema:BookSeries', 'wd:Q7725310'].includes(type))
    return { scope: 'base', key: 'schema:CreativeWorkSeries' };
  if (['schema:Recipe', 'wd:Q20631656', 'schema:SoftwareApplication'].includes(type))
    return { scope: 'generic', key: null };
  return { scope: 'base', key: 'schema:CreativeWork' };
}
function selectedViews(selected: Scope) {
  if (selected.scope === 'type') {
    const entry = platformProfile.types.find(({ type }) => type === selected.key);
    expect(entry, `bundled type template ${selected.key}`).toBeDefined();
    return templateViews(entry!);
  }
  if (selected.scope === 'base') {
    const entry = platformProfile.bases.find(({ base }) => base === selected.key);
    expect(entry, `bundled structural base template ${selected.key}`).toBeDefined();
    return templateViews(entry!);
  }
  return templateViews(platformProfile.generic);
}
async function published(driver: Reader) {
  const active = await driver.request('anonymous', 'GET', '/v1/presentation/active');
  status(active, 200, 'read actual bundled activation');
  expect(active.body).toEqual({ digest, head: expect.any(Number) });
  const stored = await driver.request('anonymous', 'GET', `/v1/presentation/profiles/${digest}`);
  status(stored, 200, 'read actual immutable bundled profile');
  expect(stored.headers.get('etag')).toBe(`"${digest}"`);
  expect(stored.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
  expect(stored.body).toEqual({ digest, profile: platformProfile });
  return active.body as { digest: string; head: number };
}

// Every record is created, proposed, accepted and adopted through the exported HTTP
// driver, with native grants and returned candidate/head IDs. No SQL fixture writes.
async function record(driver: SemanticOutcomeDriver, type: string) {
  const label = `Released ${type}`;
  const created = await driver.request('editor', 'POST', '/v1/subjects', { type, labels: { en: label } }, key());
  status(created, 201, `native record creation ${type}`);
  const { id } = created.body.subject as Subject;
  expect(id).toMatch(/^[0-9a-f-]{36}$/);
  const path = `/v1/subjects/${id}`;
  const content = { language: 'en', text: `${label} factual name` };
  const proposed = await driver.request(
    'editor',
    'POST',
    `${path}/candidates`,
    { statement: { property: { id: 'schema:name' }, value: { type: 'value', content }, rank: 'normal' } },
    key(),
  );
  status(proposed, 201, `native name proposal ${type}`);
  const candidate = proposed.body.candidate as string;
  const candidates = await driver.request('acceptor', 'GET', `${path}/candidates?property=schema%3Aname`);
  status(candidates, 200, `native candidate/head read ${type}`);
  const pending = (candidates.body.candidates as { id: string; head: number | null }[]).find(
    ({ id }) => id === candidate,
  );
  expect(pending).toBeDefined();
  const accepted = await driver.request(
    'acceptor',
    'POST',
    `${path}/candidates/${candidate}:accept`,
    { context: driver.globalContext, expected_head: pending!.head },
    key(),
  );
  status(accepted, 200, `native candidate acceptance ${type}`);
  const adoption = candidates.body.adoption as { head: number } | null;
  const adopted = await driver.request(
    'acceptor',
    'POST',
    `${path}:adopt`,
    {
      context: driver.globalContext,
      property: 'schema:name',
      mode: 'replace',
      selection: [{ candidate, rank: 'normal' }],
      expected_head: adoption?.head ?? null,
    },
    key(),
  );
  status(adopted, 200, `native Global adoption ${type}`);
  const factual = await driver.request('anonymous', 'GET', path);
  status(factual, 200, `public native factual representation ${type}`);
  expect(factual.body.subject).toMatchObject({
    id,
    type,
    labels: { en: label },
    statements: {
      'schema:name': [expect.objectContaining({ id: candidate, value: { type: 'value', content }, rank: 'normal' })],
    },
  });
  return { id, factual };
}

async function factualPage(
  driver: SemanticOutcomeDriver,
  persona: 'anonymous' | 'editor',
  type: string,
  id: string,
  factual: HttpResponse,
  view: 'overview' | 'details',
) {
  const response = await driver.request(persona, 'POST', '/v1/pages:read', { target: { subject: id, view } });
  status(response, 200, `${persona} released ${type}/${view} page`);
  expect(response.headers.get('content-type')).toContain('application/json');
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  const page = response.body as unknown as Page;
  const expected = selection(type);
  const own = selectedViews(expected);
  const generic = templateViews(platformProfile.generic);
  const document = own[view] ?? generic[view];
  const selected: Scope = own[view] ? expected : { scope: 'generic', key: null };
  expect(page.subject).toBe(id);
  expect(page.profile).toBe(digest);
  expect(page.template).toEqual(selected);
  expect(document).toBeDefined();
  expect(page.document).toEqual(document!);
  const chain = [
    ...platformProfile.types.filter((entry) => entry.type === type),
    ...bundledRelease.types[type]!.bases.flatMap((base) =>
      platformProfile.bases.filter((entry) => entry.base === base),
    ),
    platformProfile.generic,
  ].map(templateViews);
  expect(page.views).toEqual(VIEWS.filter((view) => chain.some((views) => views[view] !== undefined)));
  const plan = planReads(platformRegistry, document!, { subject: id });
  // These are existing composition limits, not a claim about measured engine work.
  expect(Object.keys(plan.reads).length).toBeLessThanOrEqual(MAX_PAGE_READS);
  expect(Object.values(plan.reads).reduce((sum, read) => sum + readCost(read), 0)).toBeLessThanOrEqual(MAX_PAGE_COST);
  expect(Object.keys(page.reads)).toEqual(Object.keys(plan.reads));
  const subjectReads = Object.entries(plan.reads).filter(([, read]) => read.kind === 'subject');
  expect(subjectReads).toHaveLength(1);
  for (const [readKey] of subjectReads) {
    expect(page.reads[readKey]).toEqual({ status: 200, body: factual.body });
  }
  for (const [readKey, value] of Object.entries(page.reads))
    expect(value.status, `${type}/${view} ${persona} ${readKey}: ${JSON.stringify(value.body)}`).toBe(200);
  return page;
}

for (const [vertical, types] of Object.entries(launch)) {
  test(`released ${vertical} resolves public factual pages for anonymous and editor through the bundled profile`, async () => {
    const driver = await createSemanticDriver(undefined, { strictCleanup: true });
    try {
      // Agent kinds live in core presentation; all other verticals enumerate their
      // actual presentation type IDs, including editions, seasons and releases.
      const presentation = Bun.YAML.parse(sources.presentation[`${vertical === 'agents' ? 'core' : vertical}/en`]!) as {
        types: Record<string, string>;
      };
      const configured = Object.keys(presentation.types);
      if (vertical === 'agents') {
        expect(configured.filter((type) => types.includes(type)).sort()).toEqual([...types].sort());
      } else expect(configured.sort()).toEqual([...types].sort());
      const release = await driver.request('anonymous', 'GET', '/v1/definitions/active');
      status(release, 200, 'actual released definition pointer');
      expect(release.body.digest).toBe(bundledDigest);
      await published(driver);
      for (const type of types) {
        expect(bundledRelease.types[type], `configured ${vertical} must be released as ${type}`).toBeDefined();
        const { id, factual } = await record(driver, type);
        for (const view of ['overview', 'details'] as const) {
          const anonymous = await factualPage(driver, 'anonymous', type, id, factual, view);
          const editor = await factualPage(driver, 'editor', type, id, factual, view);
          expect(editor).toEqual(anonymous);
        }
        const missing = await driver.request('anonymous', 'POST', '/v1/pages:read', {
          target: { subject: id, view: 'collections' },
        });
        // Agent type templates configure collections; other launch pages do not.
        expect(missing.status).toBe(['schema:Person', 'schema:Organization'].includes(type) ? 200 : 404);
      }
    } finally {
      await driver.close();
    }
  }, 120_000);
}

test('released profile publication uses curator grants and current-head CAS while route and generic fallback stay immutable', async () => {
  const driver = await createPagesDriver();
  try {
    const before = await published(driver);
    const denied = await driver.request(
      'editor',
      'POST',
      '/v1/presentation/profiles',
      { profile: platformProfile },
      key(),
    );
    status(denied, 403, 'editor lacks presentation publication grant');
    const publication = await driver.request(
      'curator',
      'POST',
      '/v1/presentation/profiles',
      { profile: platformProfile },
      key(),
    );
    status(publication, 200, 'curator republishes actual immutable bundle');
    expect(publication.body).toEqual({ digest });
    const activate = (persona: 'editor' | 'curator', expectedHead: number) =>
      driver.request(
        persona,
        'POST',
        `/v1/presentation/profiles/${digest}:activate`,
        { expected_head: expectedHead },
        key(),
      );
    status(await activate('editor', before.head), 403, 'editor lacks activation grant');
    const activated = await activate('curator', before.head);
    status(activated, 200, 'curator activates with current head');
    expect(activated.body).toEqual({ digest, head: before.head + 1 });
    const stale = await activate('curator', before.head);
    status(stale, 409, 'stale current-head CAS');
    expect(stale.body.code).toBe('stale_editorial_head');
    expect((await published(driver)).head).toBe(before.head + 1);
    for (const persona of ['anonymous', 'editor'] as const) {
      for (const route of ['/', '/released-unconfigured']) {
        const result = await driver.request(persona, 'POST', '/v1/pages:read', { target: { route } });
        status(result, 200, `${persona} actual route ${route}`);
        const explicit = route === '/';
        expect(result.body.profile).toBe(digest);
        expect(result.body.template).toEqual(explicit ? { scope: 'route', key: '/' } : { scope: 'generic', key: null });
        expect(result.body.document).toEqual(
          explicit
            ? templateViews(platformProfile.routes[0]!).overview
            : templateViews(platformProfile.generic).overview,
        );
        expect(result.body).not.toHaveProperty('subject');
      }
    }
  } finally {
    await driver.close();
  }
}, 120_000);
