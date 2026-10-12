import {
  flushTelemetryTraces,
  shutdownTelemetry,
  startTelemetry,
} from '@rezics/observability/runtime';
import {
  assertWorkCost,
  assertWorkCostAtScales,
  profileRequest,
  startWorkProfileSink,
  type WorkCostContract,
  type WorkProfile,
} from '../support/work-profile.ts';
import { runWorkProfileChild } from '../support/work-profile-child.ts';

type RecipePage = {
  profile: 'recipe-work-page-v1';
  structure: string;
  revision: string;
  occurrences: Array<{ occurrence: string; role: string }>;
  next?: string;
  cost: { pages: number; pagesRead: number; occurrences: number };
};

// Start the SDK before loading pg or Main; otherwise SQL descendants can be unobserved.
if (Bun.env.REZICS_RECIPE_GROWTH_CHILD === '1') {
  const { expect } = await import('bun:test');
  const sink = startWorkProfileSink({ settleMs: 25 });
  const { trace } = await import('@opentelemetry/api');
  const fetchBeforeEvidence = globalThis.fetch;
  const fetchPaths = new Map<string, { traceId: string; origin: string; path: string }>();
  // The telemetry exporter intentionally strips paths. Keep a test-local
  // sidecar keyed by the meter's existing client span IDs, beneath instrumentFetch.
  // Query strings and signed credentials never enter this evidence.
  globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const span = trace.getActiveSpan()?.spanContext();
    if (url.origin !== sink.url && span) fetchPaths.set(span.spanId, {
      traceId: span.traceId, origin: url.origin, path: url.pathname,
    });
    return fetchBeforeEvidence(input, init);
  }, fetchBeforeEvidence);
  startTelemetry('main', { ...Bun.env, ...sink.env, OTEL_SERVICE_NAME: 'main' });
  const { cpSync, mkdirSync, writeFileSync } = await import('node:fs');
  const { dirname, join } = await import('node:path');
  const { root, stream, dockerEnvironment } = await import('../../../scripts/fixture/stack.ts');
  const { createCorpusBackupDriver } = await import('../../../scripts/load/corpus-backup-driver.ts');
  const { restoreWorkProfileCorpus } = await import('../../../scripts/load/work-profile-corpus.ts');
  const { startMediaStack } = await import('./media-support.ts');
  const { readRetainedSeed, seedAuthorName, seedApi, seedSelection } =
    await import('../support/seed-checkpoints.ts');
  const { RECIPE_WORK_PAGE_OCCURRENCES, RECIPE_WORK_PAGE_READ_BOUND } =
    await import('../../../services/main/src/modules/recipe/work-page.ts');
  const { STRUCTURE_LIMITS } = await import('../../../services/main/src/modules/structure/format.ts');
  // Recipe work-page.ts supplies K; tree.ts chunks both leaves and interior
  // nodes using format.ts's pageEntries. Neither bound is duplicated here.
  const recipePageSize = RECIPE_WORK_PAGE_OCCURRENCES;
  const structureNodeFanout = STRUCTURE_LIMITS.pageEntries;
  const structureObjectPrefix = '/rezics-semantic/semantic/structure/sha256/';
  const objectReadBudget = (occurrences: number) => {
    const logDepth = Math.log(occurrences) / Math.log(structureNodeFanout);
    const treeDepth = Math.ceil(logDepth);
    return { occurrences, pageSize: recipePageSize, fanout: structureNodeFanout,
      logDepth, treeDepth, maximumGets: recipePageSize * (treeDepth + 1) };
  };
  type ObjectRead = ReturnType<typeof objectReadBudget> & {
    scale: string; read: string; gets: number; unknownOtherFetches: number;
  };

  // Owner contract: readRecipeWorkPage follows only the Work basis and its Structure.
  // Content posts are never read. The published cuts co-grow unrelatedWorks (4/16/64)
  // and recipeOccurrences (100/400/1600). Remote Fuseki/SQL work stays constant;
  // exact-origin immutable Structure GETs use the owner's keyed-tree budget.
  // Every remaining other fetch retains the zero cap below.
  // Carry unrelatedWorks in mainCalls for the existing verdict's numeric dimension,
  // retaining the measured mainCalls separately in the evidence.
  const recipePageCost: WorkCostContract = {
    fusekiRequests: RECIPE_WORK_PAGE_READ_BOUND * 4 + 16,
    fusekiSentBytes: 1_048_576,
    fusekiReceivedBytes: 16_777_216,
    postgresStatements: 256,
    accountCalls: 0,
    otherFetches: 0,
    unclassifiedFetches: 0,
    growth: {
      fusekiRequests: { class: 'constant', dimension: 'mainCalls' },
      fusekiSentBytes: { class: 'constant', dimension: 'mainCalls' },
      fusekiReceivedBytes: { class: 'constant', dimension: 'mainCalls' },
      postgresStatements: { class: 'constant', dimension: 'mainCalls' },
      accountCalls: { class: 'constant', dimension: 'mainCalls' },
      otherFetches: { class: 'constant', dimension: 'mainCalls' },
      unclassifiedFetches: { class: 'constant', dimension: 'mainCalls' },
    },
  };
  const { growth, ...absoluteCaps } = recipePageCost;
  const retained = readRetainedSeed();
  const qaRunId = Bun.env.REZICS_QA_RUN_ID;
  if (!qaRunId) throw new Error('Run through goalctl integration QA');
  const directory = join(root, '.temp/work-profiles', `recipe-page-growth-${qaRunId}`);
  mkdirSync(directory, { recursive: true });
  const evidencePath = join(directory, 'measurements.json');
  const cuts = retained.cuts.map(cut => {
    // The restore owner requires a local .temp path. Copy only the retained
    // descriptor/object bundle; its stopped Docker volumes remain the source.
    const local = join(directory, 'backups', cut.manifest.id);
    cpSync(dirname(cut.manifest.backup), local, { recursive: true, errorOnExist: true });
    return { ...cut, manifest: { ...cut.manifest, backup: join(local, 'backup.json') } };
  });
  const targets: string[] = [];
  const firstProfiles: WorkProfile[] = [];
  const continuationProfiles: Array<{ scale: string; unrelatedWorks: number; profile: WorkProfile }> = [];
  const objectReads: ObjectRead[] = [];
  const evidence: Array<Record<string, unknown>> = [];
  let verifying = cuts[0]!;
  let copy: {
    stack: Awaited<ReturnType<typeof startMediaStack>>;
    token: string;
    ownerOrigins: Record<string, string>;
  } | undefined;
  let meterQualified = false;
  let phase = 'restore';
  const counters = (profile: WorkProfile) => ({
    mainCalls: profile.mainCalls,
    fusekiRequests: profile.fusekiRequests,
    fusekiSentBytes: profile.fusekiSentBytes,
    fusekiReceivedBytes: profile.fusekiReceivedBytes,
    fusekiEngineMs: profile.fusekiEngineMs,
    postgresStatements: profile.postgresStatements,
    accountCalls: profile.accountCalls,
    otherFetches: profile.otherFetches,
    unclassifiedFetches: profile.unclassifiedFetches,
  });
  const fetchInventory = (profile: WorkProfile) => {
    const grouped = new Map<string, {
      peer: string; origin: string; path: string; method: string; count: number;
    }>();
    for (const span of profile.spans) {
      if (span.kind !== 2 || !span.attributes['http.request.method']) continue;
      const tag = span.attributes['rezics.peer.service'];
      const peer = typeof tag === 'string' && ['fuseki', 'account', 'main', 'other'].includes(tag)
        ? tag : 'unclassified';
      const metadata = fetchPaths.get(span.spanId);
      if (!metadata || metadata.traceId !== span.traceId)
        throw new Error(`Missing local fetch path evidence for client span ${span.spanId}`);
      const entry = { peer, origin: metadata.origin, path: metadata.path,
        method: String(span.attributes['http.request.method']), count: 0 };
      const key = JSON.stringify([entry.peer, entry.origin, entry.path, entry.method]);
      const existing = grouped.get(key) ?? entry;
      existing.count++;
      grouped.set(key, existing);
    }
    const inventory = [...grouped.values()].sort((left, right) =>
      left.peer.localeCompare(right.peer) || left.origin.localeCompare(right.origin) || left.path.localeCompare(right.path));
    expect(inventory.filter(item => item.peer === 'other').reduce((sum, item) => sum + item.count, 0))
      .toBe(profile.otherFetches);
    expect(inventory.filter(item => item.peer === 'unclassified').reduce((sum, item) => sum + item.count, 0))
      .toBe(profile.unclassifiedFetches);
    return inventory;
  };
  const budgetedRead = (profile: WorkProfile, inventory: ReturnType<typeof fetchInventory>,
    scale: string, read: string, occurrences: number) => {
    const gets = inventory.filter(item => item.peer === 'other' && item.method === 'GET'
      && item.origin === copy!.ownerOrigins.MAIN_S3_ENDPOINT && item.path.startsWith(structureObjectPrefix))
      .reduce((sum, item) => sum + item.count, 0);
    const budget = { scale, read, ...objectReadBudget(occurrences), gets,
      unknownOtherFetches: profile.otherFetches! - gets };
    objectReads.push(budget);
    return { budget, profile: { ...profile, otherFetches: budget.unknownOtherFetches } };
  };
  const measuredRead = async <T>(path: string) => {
    if (!copy) throw new Error('Restored Recipe fixture is unavailable');
    const { stack, token } = copy;
    const measured = await profileRequest(sink, async headers => {
      headers.set('authorization', `Bearer ${token}`);
      const response = await stack.main.handle(new Request(`http://main.local${path}`, { headers }));
      const body = await response.text();
      expect(response.status, body).toBe(200);
      return JSON.parse(body) as T;
    }, { service: 'main', flush: flushTelemetryTraces });
    // Refuse an empty meter on every measured read, before any cost verdict.
    expect(measured.profile.postgresStatements).toBeGreaterThan(0);
    expect(measured.profile.fusekiRequests).toBeGreaterThan(0);
    expect(measured.profile.fusekiSentBytes).toBeGreaterThan(0);
    expect(measured.profile.fusekiReceivedBytes).toBeGreaterThan(0);
    expect(measured.profile.unclassifiedFetches).toBe(0);
    return measured;
  };
  const driver = createCorpusBackupDriver({
    sourceRunId: retained.sourceRunId,
    directory,
    resumeSource: false,
    restoreResourceClass: 'ordinary',
    quiesce: async () => { throw new Error('Recipe growth only restores retained checkpoints'); },
    async smokeRead(input) {
      const env = { ...input.apps, REZICS_QA_RUN_ID: input.runId,
        REZICS_QA_STACK_MODE: 'scale', REZICS_QA_STACK_TIER: 'integration', REZICS_STACK_PROFILE: 'qa' };
      const previous = new Map(Object.keys(env).map(key => [key, Bun.env[key]]));
      Object.assign(Bun.env, env);
      const stack = await (async () => {
        try {
          return await startMediaStack('recipe-page-growth-copy', { library: true,
            ownerUrls: { access: input.apps.ACCESS_DATABASE_URL!, content: input.apps.CONTENT_DATABASE_URL!,
              relay: input.apps.ACCOUNT_RELAY_DATABASE_URL! } });
        } finally {
          for (const [key, value] of previous) {
            if (value === undefined) delete Bun.env[key]; else Bun.env[key] = value;
          }
        }
      })();
      try {
        const member = await stack.member(seedAuthorName, { stable: true, verified: true });
        // The seed provisions a separate corpus Agent; this login principal
        // retains its representation of that Agent in the restored Access store.
        const work = verifying.works[0]!;
        copy = { stack, token: member.token,
          ownerOrigins: Object.fromEntries(['MAIN_S3_ENDPOINT', 'FUSEKI_URL', 'ACCOUNT_ORIGIN',
            'ACCOUNT_JWKS_URL', 'ACCOUNT_INTROSPECT_URL', 'MAIN_ORIGIN', 'CONTENT_ORIGIN']
            .filter(key => input.apps[key]).map(key => [key, new URL(input.apps[key]!).origin])) };
        // A known selected-text page qualifies the restored-stack meter independently
        // of Recipe traversal and must produce nonzero SQL, Fuseki and byte costs.
        if (!meterQualified) {
          phase = 'meter qualification';
          const known = await measuredRead(seedSelection(work.mainVersion));
          expect(known.result).toMatchObject({ work: work.work, mainVersion: work.mainVersion,
            body: 'Checkpoint selected text 0' });
          const qualification: Record<string, unknown> = { meterQualification: counters(known.profile) };
          evidence.push(qualification);
          console.log('recipe-page-growth-meter', JSON.stringify(counters(known.profile)));
          qualification.fetches = fetchInventory(known.profile);
          meterQualified = true;
        } else {
          expect(await seedApi(stack, member.token).read(seedSelection(work.mainVersion)))
            .toMatchObject({ work: work.work, body: 'Checkpoint selected text 0' });
        }
        input.signal.throwIfAborted();
        return async () => { copy = undefined; await stack.stop(); };
      } catch (error) { copy = undefined; await stack.stop(); throw error; }
    },
  });
  try {
    // Free the harness's empty persistent project before restoring each cut alone.
    await stream('task', ['stack:down', '--', '--profile', 'qa', '--run-id', qaRunId, '--persistent'], dockerEnvironment());
    for (const cut of cuts) {
      phase = `${cut.manifest.scale} restore`;
      verifying = cut;
      const target = `recipe-${cut.manifest.scale}-${qaRunId}`;
      targets.push(target);
      const preparationMs = await restoreWorkProfileCorpus(cut.manifest, target, driver);
      expect(preparationMs).toBeLessThan(600_000);
      const recipe = cut.population.recipe;
      const expectedOccurrences = cut.manifest.dimensions.recipeOccurrences!;
      expect(recipe.occurrences).toHaveLength(expectedOccurrences);
      const path = `/v1/recipes/works/${recipe.work.slice(-36)}?${new URLSearchParams({ actingSubject: retained.actor })}`;
      phase = `${cut.manifest.scale} first page`;
      const first = await measuredRead<RecipePage>(path);
      expect(first.profile.request.route).toBe('/v1/recipes/works/:id');
      expect(first.result).toMatchObject({ profile: 'recipe-work-page-v1',
        structure: recipe.structure, revision: recipe.revision });
      expect(first.result.occurrences).toHaveLength(RECIPE_WORK_PAGE_OCCURRENCES);
      expect(first.result.cost.pages).toBeLessThanOrEqual(RECIPE_WORK_PAGE_READ_BOUND);
      expect(first.result.occurrences.every(item => item.role === 'ingredient')).toBe(true);
      const row: Record<string, unknown> = {
        scale: cut.manifest.scale, cut: cut.manifest.id, dimensions: cut.manifest.dimensions, preparationMs,
        ownerOrigins: copy!.ownerOrigins,
        firstPage: { counters: counters(first.profile), cost: first.result.cost },
        continuation: null,
        sectionDepth: { measured: false, reason: 'Published Recipe contains only root ingredient lines' },
      };
      // Retain every cut before assertions that can stop the run. A failed
      // cost contract must not discard the page that demonstrated the failure.
      evidence.push(row);
      const firstFetches = fetchInventory(first.profile);
      (row.firstPage as Record<string, unknown>).fetches = firstFetches;
      const budgetedFirst = budgetedRead(first.profile, firstFetches, cut.manifest.scale, 'first page', expectedOccurrences);
      (row.firstPage as Record<string, unknown>).objectReadBudget = budgetedFirst.budget;
      firstProfiles.push({ ...budgetedFirst.profile, mainCalls: cut.manifest.dimensions.unrelatedWorks });
      if (first.result.next) {
        phase = `${cut.manifest.scale} continuation`;
        const next = await measuredRead<RecipePage>(`${path}&${new URLSearchParams({ cursor: first.result.next })}`);
        expect(next.result).toMatchObject({ profile: 'recipe-work-page-v1',
          structure: recipe.structure, revision: recipe.revision });
        expect(next.result.occurrences).toHaveLength(RECIPE_WORK_PAGE_OCCURRENCES);
        expect(next.result.cost.pages).toBeLessThanOrEqual(RECIPE_WORK_PAGE_READ_BOUND);
        expect(new Set([...first.result.occurrences, ...next.result.occurrences].map(item => item.occurrence)).size)
          .toBe(RECIPE_WORK_PAGE_OCCURRENCES * 2);
        // Keep absolute caps; two available continuations cannot provide the
        // existing verdict's required three scales. Do not invent a third cursor.
        row.continuation = { counters: counters(next.profile), cost: next.result.cost };
        const continuationFetches = fetchInventory(next.profile);
        (row.continuation as Record<string, unknown>).fetches = continuationFetches;
        const budgetedContinuation = budgetedRead(next.profile, continuationFetches,
          cut.manifest.scale, 'continuation', expectedOccurrences);
        (row.continuation as Record<string, unknown>).objectReadBudget = budgetedContinuation.budget;
        continuationProfiles.push({ scale: cut.manifest.scale,
          unrelatedWorks: cut.manifest.dimensions.unrelatedWorks, profile: budgetedContinuation.profile });
      } else {
        expect(expectedOccurrences).toBe(RECIPE_WORK_PAGE_OCCURRENCES);
        row.continuationMissingReason = 'Small cut ends on its first 100-occurrence page';
      }
      console.log('recipe-page-growth-checkpoint', JSON.stringify(row));
      await driver.stop(target);
    }
    expect(meterQualified).toBe(true);
    const ratiosFor = (profiles: WorkProfile[]) => profiles.flatMap((smaller, index) => profiles.slice(index + 1).map(larger => ({
      scales: [smaller.mainCalls, larger.mainCalls],
      counters: Object.fromEntries(Object.keys(growth!).map(key => {
        const field = key as keyof typeof absoluteCaps;
        const before = smaller[field], after = larger[field];
        return [key, before === null || after === null ? null
          : before === 0 ? after === 0 ? 1 : 'Infinity' : after / before];
      })),
    })));
    const ratios = { firstPage: ratiosFor(firstProfiles),
      continuation: ratiosFor(continuationProfiles.map(item => ({ ...item.profile, mainCalls: item.unrelatedWorks }))) };
    evidence.push({ ratios });
    console.log('recipe-page-growth-ratios', JSON.stringify(ratios));
    // The shared verdict retains all remote caps/classes. The owner's immutable
    // object allowance is asserted separately, without opening other fetches.
    phase = 'growth verdict';
    const failures: Error[] = [];
    const check = (read: string, assertion: () => void) => {
      try { assertion(); }
      catch (error) {
        evidence.push({ verdict: 'fail', read, error: String(error),
          owner: 'kernel: services/main/src/modules/recipe/work-page.ts readRecipeWorkPage; services/main/src/modules/structure/read.ts' });
        failures.push(new Error(`${read}: ${String(error)}`, { cause: error }));
      }
    };
    check('GET /v1/recipes/works/:id first page', () =>
      assertWorkCostAtScales(firstProfiles, recipePageCost, 'recipe-work-page-unrelated-works-first-page'));
    for (const continuation of continuationProfiles)
      check(`GET /v1/recipes/works/:id ${continuation.scale} continuation`, () =>
        assertWorkCost(continuation.profile, absoluteCaps));
    for (const objectRead of objectReads)
      check(`GET /v1/recipes/works/:id ${objectRead.scale} ${objectRead.read} Structure object budget`, () =>
        expect(objectRead.gets).toBeLessThanOrEqual(objectRead.maximumGets));
    const firstObjectReads = objectReads.filter(item => item.read === 'first page');
    const objectIncrements = firstObjectReads.slice(1).map((larger, index) => {
      const smaller = firstObjectReads[index]!;
      return { scales: [smaller.scale, larger.scale],
        occurrences: [smaller.occurrences, larger.occurrences],
        gets: [smaller.gets, larger.gets], treeDepths: [smaller.treeDepth, larger.treeDepth],
        observedIncrement: larger.gets - smaller.gets,
        maximumIncrement: recipePageSize * (larger.treeDepth - smaller.treeDepth),
        rule: 'pageSize * (larger ceil(log_fanout(N)) - smaller ceil(log_fanout(N)))' };
    });
    evidence.push({ structureObjectIncrements: objectIncrements });
    console.log('recipe-page-growth-object-increments', JSON.stringify(objectIncrements));
    for (const increment of objectIncrements)
      check(`GET /v1/recipes/works/:id ${increment.scales.join(' to ')} Structure object increment`, () =>
        expect(increment.observedIncrement).toBeLessThanOrEqual(increment.maximumIncrement));
    if (failures.length) throw new AggregateError(failures, 'Recipe page cost contracts failed');
    evidence.push({ verdict: 'pass', coverage: 'first page at three cuts; continuation at medium/large; no nested sections' });
  } catch (error) {
    evidence.push({ verdict: phase === 'growth verdict' ? 'fail' : 'unavailable', phase, error: String(error),
      ...(phase === 'growth verdict' ? {
        owner: 'kernel: services/main/src/modules/recipe/work-page.ts readRecipeWorkPage; services/main/src/modules/structure/read.ts',
      } : {}) });
    throw error;
  } finally {
    writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + '\n');
    console.log('recipe-page-growth-evidence', evidencePath);
    try {
      for (const target of targets.toReversed()) await driver.stop(target);
    } finally {
      await shutdownTelemetry();
      globalThis.fetch = fetchBeforeEvidence;
      await sink.stop();
    }
  }
} else {
  const { test } = await import('bun:test');
  test('Recipe Work page meets remote and immutable-object budgets on published growth cuts', async () => {
    const { stdout } = await runWorkProfileChild('tests/qa/integration/recipe-page-growth.test.ts', {
      env: { REZICS_RECIPE_GROWTH_CHILD: '1' }, timeoutMs: 1_800_000,
    });
    console.log(stdout);
  }, 1_850_000);
}
