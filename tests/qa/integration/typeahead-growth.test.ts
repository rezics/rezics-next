import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { createMainApp } from '../../../services/main/src/app.ts';
import { FusekiClient, fusekiReadBudget, snapshotFusekiReadDiagnostics,
  type FusekiReadCallDiagnostic, type FusekiReadDiagnosticSnapshot, type SparqlResult,
  type TemplateQueryEnvelope } from '../../../services/main/src/infrastructure/fuseki.ts';
import { AccessAdmissionRegistry, type RegisteredAdmission }
  from '../../../services/main/src/modules/access/admission.ts';
import { activateTextContribution, textContributionDigest }
  from '../../../services/main/src/modules/contribution/draft.ts';
import { publishTextContribution, textPublicationDigest }
  from '../../../services/main/src/modules/contribution/publish.ts';
import { SEARCH_FIELD_COST } from '../../../services/main/src/modules/search/fields.ts';
import { prefixWalkExaminedLimit } from '../../../services/main/src/modules/search/prefix-walk.ts';
import { activateMetadataWork, ID, metadataWorkRequestDigest, type WorkActivationEnvironment }
  from '../../../services/main/src/modules/work/activate.ts';
import { commitMetadata } from '../../../services/main/src/modules/work/metadata-command.ts';
import { metadataDigest, type MetadataIntent }
  from '../../../services/main/src/modules/work/metadata-schema.ts';
import { mainSelectionDigest, selectMainDefault }
  from '../../../services/main/src/modules/work/select-main.ts';
import { foregroundCounted } from './support/query-cost-meter.ts';

interface GrowthRead {
  fieldRows: number[];
  nativeExamined: number[];
  diagnostics?: FusekiReadDiagnosticSnapshot;
}

async function growthRequest(app: ReturnType<typeof createMainApp>, prefix: string) {
  const started = performance.now();
  const response = await app.handle(new Request(`http://main.local/v1/search/typeahead?prefix=${prefix}`));
  return { response, text: await response.text(), elapsedMs: Math.round(performance.now() - started) };
}

function assertBoundedDiagnostics(diagnostics: FusekiReadDiagnosticSnapshot | undefined) {
  expect(diagnostics).toBeDefined();
  expect(diagnostics!.history.length).toBeLessThanOrEqual(8);
  expect(diagnostics!.active.length).toBeLessThanOrEqual(8);
  expect(Number.isSafeInteger(diagnostics!.omitted)).toBe(true);
  expect(diagnostics!.omitted).toBeGreaterThanOrEqual(0);
  for (const call of [...diagnostics!.history, ...diagnostics!.active]) {
    expect(['health', 'delta-proof', 'query', 'template-query']).toContain(call.family);
    expect(['read', 'writer-wait']).toContain(call.phase);
    expect(['complete', 'failed', 'aborted', 'active']).toContain(call.status);
    expect(Number.isSafeInteger(call.attempt)).toBe(true);
    expect(call.attempt).toBeGreaterThanOrEqual(1);
    expect(Number.isFinite(call.durationMs)).toBe(true);
    expect(call.durationMs).toBeGreaterThanOrEqual(0);
    expect(Object.keys(call).every(key => ['family', 'durationMs', 'attempt', 'phase', 'status', 'examined'].includes(key))).toBe(true);
  }
  expect(Buffer.byteLength(JSON.stringify(diagnostics))).toBeLessThanOrEqual(4_096);
}

/** Observe the real native visit evidence, never the ten cards Main retains. */
class GrowthFuseki extends FusekiClient {
  read: GrowthRead | undefined;
  private observed = new WeakSet<FusekiReadCallDiagnostic>();

  startRead(): void {
    this.read = { fieldRows: [], nativeExamined: [] };
    this.observed = new WeakSet();
  }

  private capture(): void {
    const budget = fusekiReadBudget.getStore();
    if (!this.read || !budget?.diagnostics || !foregroundCounted()) return;
    this.read.diagnostics = snapshotFusekiReadDiagnostics(budget);
    for (const call of budget.diagnostics.history) {
      if (this.observed.has(call)) continue;
      this.observed.add(call);
      if (call.examined !== undefined) {
        expect(Number.isSafeInteger(call.examined)).toBe(true);
        expect(call.examined).toBeGreaterThanOrEqual(0);
        this.read.nativeExamined.push(call.examined);
      }
    }
  }

  override async query(...args: Parameters<FusekiClient['query']>): Promise<SparqlResult> {
    const result = await super.query(...args);
    if (this.read && foregroundCounted() && fusekiReadBudget.getStore()
      && args[0].includes('?field ?text ?state') && args[0].includes('CONTAINS')) {
      this.read.fieldRows.push(result.results?.bindings.length ?? 0);
    }
    this.capture();
    return result;
  }

  override async templateQuery(input: TemplateQueryEnvelope, maxBytes?: number): Promise<SparqlResult> {
    const result = await super.templateQuery(input, maxBytes);
    this.capture();
    return result;
  }

  override async commandHealth() {
    const result = await super.commandHealth();
    this.capture();
    return result;
  }
}

test('SEARCH18: public typeahead native work follows population before prefix cutover and the page after it', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.FUSEKI_URL || !Bun.env.ACCESS_DATABASE_URL
    || !Bun.env.MAIN_DATA_EPOCH || !Bun.env.MAIN_ROUTING_EPOCH) {
    throw new Error('Run through the isolated QA integration tier');
  }
  const state = join(resolve(import.meta.dir, '../../..'), '.temp', `typeahead-growth-${randomUUID()}`);
  mkdirSync(state, { recursive: true, mode: 0o700 });
  const fuseki = new GrowthFuseki(Bun.env.FUSEKI_URL);
  const env: WorkActivationEnvironment = { fuseki,
    lineage: { dataEpoch: Bun.env.MAIN_DATA_EPOCH, routingEpoch: Bun.env.MAIN_ROUTING_EPOCH },
    objectDirectory: join(state, 'objects') };
  const accessPool = new Pool({ connectionString: Bun.env.ACCESS_DATABASE_URL });
  const app = createMainApp(fuseki, { environment: env,
    account: { verify: async () => { throw new Error('The growth read is anonymous'); } },
    access: new AccessAdmissionRegistry(accessPool) });
  const actor = ID + randomUUID();
  const works = new Set<string>();
  const readings: Array<GrowthRead & { population: number; prefix: string; examined: number;
    rowsRead: number; responseStatus: number; elapsedMs: number }> = [];

  // As in public-search-scale, these are admitted product owner commands. No
  // graph fixture update can bypass publication, selection or name maintenance.
  function admission(scope: string, action: string, requestDigest: string): RegisteredAdmission {
    const id = randomUUID();
    return { id, principalId: randomUUID(), actingSubject: actor, scope, action,
      idempotencyKey: `typeahead-${id}`, requestDigest, authorityEpoch: '0',
      expiresAt: new Date(Date.now() + 20 * 60_000).toISOString(), state: 'claimed',
      dispatchEligible: true, replayed: false };
  }

  async function addWork(index: number): Promise<void> {
    const title = `Book growth ${index} ${randomUUID()}`;
    const created = await activateMetadataWork(env, { title,
      admission: admission('work:create:root', 'work.create', metadataWorkRequestDigest(title)) });
    const metadata: MetadataIntent = { work: created.work, expectedHead: null,
      state: { kind: 'header', originalTitle: { value: `Book alias ${index}`, language: 'en' }, localized: [] } };
    expect(await commitMetadata(env, admission(`work:edit:${created.work}`, 'work.edit',
      metadataDigest(metadata)), metadata)).toBe(true);
    const draftInput = { work: created.work, language: 'en', body: `Selected text ${index}`, actingSubject: actor };
    const draft = await activateTextContribution(env,
      admission(`contribution:create:${created.work}`, 'contribution.create', textContributionDigest(draftInput)),
      draftInput);
    if (draft.outcome !== 'succeeded' || !draft.contribution || !draft.draftRevision) {
      throw new Error('Growth Contribution draft failed');
    }
    const publishInput = { contribution: draft.contribution, expectedDraftHead: draft.draftRevision,
      expectedPublicationHead: null, rightsBasis: 'original-contribution' as const,
      disclosure: 'public' as const, actingSubject: actor };
    const published = await publishTextContribution(env,
      admission(`contribution:publish:${draft.contribution}`, 'contribution.publish',
        textPublicationDigest(publishInput)), publishInput);
    if (published.outcome !== 'succeeded' || !published.publicationDecision) {
      throw new Error('Growth Contribution publication failed');
    }
    const selectionInput = { context: { kind: 'main-version-default' as const, id: created.mainVersion },
      work: created.work, contribution: draft.contribution, publicationDecision: published.publicationDecision,
      expectedSelectionHead: null, selectionBasis: 'main-maintainer' as const, actingSubject: actor };
    const selected = await selectMainDefault(env,
      admission(`publication:select:${created.mainVersion}`, 'publication.select', mainSelectionDigest(selectionInput)),
      selectionInput);
    expect(selected.outcome).toBe('succeeded');
    expect(selected.matchUnit).toBeDefined();
    works.add(created.work);
  }

  try {
    const { prefixWalkAvailable } = await fuseki.commandHealth();
    expect(prefixWalkAvailable).toBe(true);
    for (const population of [16, 64, 256]) {
      while (works.size < population) await addWork(works.size);
      for (const prefix of ['b', 'bo']) {
        fuseki.startRead();
        const { response, text, elapsedMs } = await growthRequest(app, prefix);
        const read = fuseki.read!;
        expect(response.status, text).toBe(200);
        assertBoundedDiagnostics(read.diagnostics);
        expect(read.diagnostics?.history.some(call => call.family === 'query' && call.status === 'complete')).toBe(true);
        expect(read.diagnostics?.active).toEqual([]);
        const examined = read.nativeExamined.reduce((total, count) => total + count, 0);
        readings.push({ ...read, population, prefix, examined,
          rowsRead: read.fieldRows.reduce((total, count) => total + count, 0),
          responseStatus: response.status, elapsedMs });
        fuseki.read = undefined;
        expect(read.fieldRows).toEqual([]);
        // Absence of native visit evidence cannot turn a zero into a pass.
        expect(read.nativeExamined.length).toBeGreaterThan(0);
        expect(examined).toBeGreaterThanOrEqual(SEARCH_FIELD_COST.typeaheadItems);
        expect(examined).toBeLessThanOrEqual(prefixWalkExaminedLimit(SEARCH_FIELD_COST.typeaheadItems));
        const page = JSON.parse(text) as { items: Array<{ work: string; matchedField: string }>; hasMore: boolean };
        expect(page.items).toHaveLength(SEARCH_FIELD_COST.typeaheadItems);
        expect(new Set(page.items.map(item => item.work)).size).toBe(SEARCH_FIELD_COST.typeaheadItems);
        expect(page.items.every(item => works.has(item.work) && item.matchedField === 'title')).toBe(true);
        expect(page.hasMore).toBe(true);
      }
    }
    for (const prefix of ['b', 'bo']) {
      const counts = readings.filter(read => read.prefix === prefix).map(read => read.examined);
      // Adopting named native visit counters in the work-profile verdict is a later step.
      expect(counts).toEqual([counts[0], counts[0], counts[0]]);
    }
    // Keep the evidence outside the disposable object directory for the QA run.
    await Bun.write(join(resolve(import.meta.dir, '../../..'), '.temp',
      `typeahead-growth-${Bun.env.REZICS_QA_RUN_ID}.json`), JSON.stringify({ prefixWalkAvailable,
      pageSize: SEARCH_FIELD_COST.typeaheadItems, examinedLimit: prefixWalkExaminedLimit(SEARCH_FIELD_COST.typeaheadItems),
      readings }, null, 2));
  } finally {
    fuseki.read = undefined;
    await app.stop();
    await accessPool.end();
    rmSync(state, { recursive: true, force: true });
  }
}, 600_000);
