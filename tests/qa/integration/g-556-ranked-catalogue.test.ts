import { expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { createMainApp } from '../../../services/main/src/app.ts';
import { FusekiClient, fusekiReadBudget, type FusekiReadBudget }
  from '../../../services/main/src/infrastructure/fuseki.ts';
import { AccessAdmissionRegistry, type RegisteredAdmission } from '../../../services/main/src/modules/access/admission.ts';
import { activateTextContribution, textContributionDigest } from '../../../services/main/src/modules/contribution/draft.ts';
import { publishTextContribution, textPublicationDigest } from '../../../services/main/src/modules/contribution/publish.ts';
import { activateMetadataWork, createWorkActivationEnvironment, ID, metadataWorkRequestDigest,
  type WorkActivationEnvironment } from '../../../services/main/src/modules/work/activate.ts';
import { selectMainDefault, mainSelectionDigest } from '../../../services/main/src/modules/work/select-main.ts';
import { capabilities } from '../../../services/main/src/routes/search.ts';
import { SEARCH_PAGE_TTL_MS } from '../../../services/main/src/modules/work/search-continuation.ts';
import { MAX_SEARCH_FUSEKI_BYTES, MAX_SEARCH_FUSEKI_CALLS, MAX_SEARCH_REQUEST_MS,
  MAX_SEARCH_RESPONSE_BYTES } from '../../../services/main/src/modules/work/search-readiness.ts';

class MeasuredFuseki extends FusekiClient {
  budget?: FusekiReadBudget;
  override query(sparql: string, maxResponseBytes?: number) {
    this.budget = fusekiReadBudget.getStore();
    return super.query(sparql, maxResponseBytes);
  }
}

interface Page { profile: string; retrieval: string; population: number;
  count: { value: number; precision: string }; next: string | null;
  results: Array<{ work: string; mainVersion: string; title: { value: string }; score: number }> }

test('G-556: ranked catalogue pages retain their basis through writes, finish exactly and restart after expiry', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.FUSEKI_URL || !Bun.env.MAIN_DATA_EPOCH
    || !Bun.env.MAIN_ROUTING_EPOCH || !Bun.env.ACCESS_DATABASE_URL || !Bun.env.CONTENT_DATABASE_URL) {
    throw new Error('Run through the isolated QA integration tier');
  }
  const state = join(resolve(import.meta.dir, '../../..'), '.temp', `g556-ranked-${randomUUID()}`);
  mkdirSync(state, { recursive: true, mode: 0o700 });
  const actor = ID + randomUUID(), phrase = `catalogue${randomUUID().replaceAll('-', '')}`;
  const fuseki = new MeasuredFuseki(Bun.env.FUSEKI_URL);
  const contentPool = new Pool({ connectionString: Bun.env.CONTENT_DATABASE_URL, max: 2 });
  const env: WorkActivationEnvironment = createWorkActivationEnvironment({ referenceFencePool: contentPool, fuseki,
    lineage: { dataEpoch: Bun.env.MAIN_DATA_EPOCH, routingEpoch: Bun.env.MAIN_ROUTING_EPOCH },
    objectDirectory: join(state, 'objects') });
  const pool = new Pool({ connectionString: Bun.env.ACCESS_DATABASE_URL });
  const app = createMainApp(fuseki, { environment: env, access: new AccessAdmissionRegistry(pool),
    account: { verify: async () => { throw new Error('anonymous catalogue read'); } } });
  function admission(scope: string, action: string, requestDigest: string): RegisteredAdmission {
    const id = randomUUID();
    return { id, principalId: randomUUID(), actingSubject: actor, scope, action,
      idempotencyKey: `g556-${id}`, requestDigest, authorityEpoch: '0',
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      state: 'claimed', dispatchEligible: true, replayed: false };
  }
  async function addWork(index: number, existing?: { work: string; main: string }, language = 'en') {
    const title = `Catalogue HTTP ${index}`;
    const work = existing ? { work: existing.work, mainVersion: existing.main }
      : await activateMetadataWork(env, { title,
        admission: admission('work:create:root', 'work.create', metadataWorkRequestDigest(title)) });
    const draftInput = { work: work.work, language, body: `${phrase} selected article`, actingSubject: actor };
    const draft = await activateTextContribution(env, admission(`contribution:create:${work.work}`,
      'contribution.create', textContributionDigest(draftInput)), draftInput);
    if (draft.outcome !== 'succeeded' || !draft.contribution || !draft.draftRevision) {
      throw new Error('ranked fixture draft failed');
    }
    const publicationInput = { contribution: draft.contribution, expectedDraftHead: draft.draftRevision,
      expectedPublicationHead: null, rightsBasis: 'original-contribution' as const,
      disclosure: 'public' as const, actingSubject: actor };
    const publication = await publishTextContribution(env, admission(`contribution:publish:${draft.contribution}`,
      'contribution.publish', textPublicationDigest(publicationInput)), publicationInput);
    if (publication.outcome !== 'succeeded' || !publication.publicationDecision) {
      throw new Error('ranked fixture publication failed');
    }
    const input = { context: { kind: 'main-version-default' as const, id: work.mainVersion }, work: work.work,
      contribution: draft.contribution, publicationDecision: publication.publicationDecision,
      expectedSelectionHead: null, selectionBasis: 'main-maintainer' as const, actingSubject: actor };
    const selected = await selectMainDefault(env, admission(`publication:select:${work.mainVersion}`,
      'publication.select', mainSelectionDigest(input)), input);
    if (selected.outcome !== 'succeeded') throw new Error('ranked fixture selection failed');
    return { work: work.work, main: work.mainVersion, title };
  }
  const read = (cursor?: string, queryPhrase = phrase) => app.handle(new Request(
    `http://main.local/v1/search/catalogue?q=${encodeURIComponent(queryPhrase)}&limit=2`
      + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '')));
  async function readPage(cursor?: string) {
    const started = performance.now();
    const reply = await read(cursor);
    if (reply.status !== 200) throw new Error(`ranked HTTP ${reply.status}: ${await reply.text()}`);
    expect(performance.now() - started).toBeLessThan(MAX_SEARCH_REQUEST_MS);
    expect(fuseki.budget).toBeDefined();
    expect(MAX_SEARCH_FUSEKI_CALLS - fuseki.budget!.callsLeft).toBeLessThanOrEqual(MAX_SEARCH_FUSEKI_CALLS);
    expect(MAX_SEARCH_FUSEKI_BYTES - fuseki.budget!.bytesLeft).toBeLessThanOrEqual(MAX_SEARCH_FUSEKI_BYTES);
    expect(reply.headers.get('cache-control')).toBe('no-store');
    const body = await reply.text();
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(MAX_SEARCH_RESPONSE_BYTES);
    return JSON.parse(body) as Page;
  }
  try {
    expect(capabilities['/v1/search/catalogue'].get).toMatchObject({ disposition: 'supported',
      mcp: { tool: 'search_catalogue' } });
    const works = [];
    for (let index = 0; index < 4; index++) works.push(await addWork(index));
    // Two selected languages still represent one Main in a language-unfiltered
    // page. Its visibility join must not multiply the native group witness.
    await addWork(0, works[0], 'fr');
    const first = await readPage();
    expect(first).toMatchObject({ profile: 'public-catalogue-ranked-v1', retrieval: 'ranked',
      count: { value: 2, precision: 'lower-bound' } });
    expect(first.population).toBeGreaterThanOrEqual(4);
    expect(first.next).toBeString();
    await addWork(4);
    const second = await readPage(first.next!);
    expect(second.count).toEqual({ value: 4, precision: 'exact' });
    expect(second.next).toBeNull();
    const traversed = [...first.results, ...second.results].map(row => row.work);
    expect([...traversed].sort()).toEqual(works.map(row => row.work).sort());
    expect(new Set(traversed).size).toBe(4);
    for (const row of [...first.results, ...second.results]) {
      expect(row.title.value).toBe(works.find(work => work.work === row.work)!.title);
      expect(Number.isFinite(row.score)).toBe(true);
    }
    await addWork(5);
    expect((await readPage(first.next!)).results).toEqual(second.results);
    expect((await read(first.next!, `${phrase} changed`)).status).toBe(422);
    // The public token has a fixed lifetime; replay never extends it. Move
    // only the application clock so this remains a real stack proof without
    // keeping a QA slot idle for five minutes.
    const clock = spyOn(Date, 'now').mockReturnValue(Date.now() + SEARCH_PAGE_TTL_MS + 1);
    try {
      const expired = await read(first.next!);
      expect(expired.status).toBe(409);
      expect(await expired.json()).toMatchObject({ code: 'search_restart_required' });
    } finally { clock.mockRestore(); }
    const restarted: string[] = [];
    let next: string | undefined;
    do {
      const page = await readPage(next);
      restarted.push(...page.results.map(row => row.work));
      next = page.next ?? undefined;
      expect(restarted.length).toBeLessThanOrEqual(6);
      if (!next) expect(page.count).toEqual({ value: 6, precision: 'exact' });
    } while (next);
    expect(new Set(restarted).size).toBe(6);
  } finally {
    await pool.end();
    await contentPool.end();
    rmSync(state, { recursive: true, force: true });
  }
}, 120_000);
