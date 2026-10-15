import {
  flushTelemetryTraces,
  shutdownTelemetry,
  startTelemetry,
} from '@rezics/observability/runtime';
import {
  profileRequest,
  startWorkProfileSink,
  type WorkProfile,
} from '../support/work-profile.ts';
import { runWorkProfileChild } from '../support/work-profile-child.ts';

import {
  assertRecipeObjectBudget, assertRecipePageComplete, assertRecipeSeriesCosts, budgetRecipeProfile, coldRecipeRequest,
  finishRecipeGrowth, RECIPE_GROWTH_COVERAGE, recipeCostSample, recipeReaderRequest,
  recipeRemoteCost, recipeSectionDepthTodo,
  type RecipePage, type RecipeTreeCensus, type RecipeCostSeries, type RecipeReader,
} from '../support/recipe-page-growth-contract.ts';

// Start the SDK before loading pg or Main; otherwise SQL descendants can be unobserved.
if (Bun.env.REZICS_RECIPE_GROWTH_CHILD === '1') {
  const { expect } = await import('bun:test');
  const sink = startWorkProfileSink({ settleMs: 25 });
  const cleanup: Array<{ name: string; run: () => unknown | Promise<unknown> }> = [];
  let primaryFailure: { error: unknown } | undefined;
  const evidence: Array<Record<string, unknown>> = [];
  let phase = 'setup';
  const fetchBeforeEvidence = globalThis.fetch;
  try {
    const { trace } = await import('@opentelemetry/api');
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
    const { checkStructurePage } = await import('../../../services/main/src/modules/structure/format.ts');
    const { readCompositionSnapshot } = await import('../../../services/main/src/modules/structure/read.ts');
    const { recordTree, orderTree, structureObjects } = await import('../../../services/main/src/modules/structure/change.ts');
    const { withoutVerifiedImmutableObjectCache } =
      await import('../../../services/main/src/infrastructure/immutable-objects.ts');
    // K comes from the request's owner. Restored depth/node count come from
    // independent owner reads below, never from the measured request's GETs.
    const recipePageSize = RECIPE_WORK_PAGE_OCCURRENCES;
    const structureObjectPrefix = '/rezics-semantic/semantic/structure/sha256/';
    type ObjectRead = ReturnType<typeof budgetRecipeProfile>['budget'] & {
      scale: string; read: string; reader: RecipeReader;
    };
    // Remote counters retain the owner's absolute caps and constant class with
    // the shared 1.20 margin. Only exact keys from the independent census receive
    // the owner's min(nodeCount, K * (depth + 1)) distinct immutable-key allowance.
    const recipePageCost = recipeRemoteCost(RECIPE_WORK_PAGE_READ_BOUND);
    const { growth } = recipePageCost;
    const retained = readRetainedSeed();
    const qaRunId = Bun.env.REZICS_QA_RUN_ID;
    if (!qaRunId) throw new Error('Run through goalctl integration QA');
    const directory = join(root, '.temp/work-profiles', `recipe-page-growth-${qaRunId}`);
    mkdirSync(directory, { recursive: true });
    const evidencePath = join(directory, 'measurements.json');
    cleanup.push({ name: 'write evidence', run: () => {
      writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + '\n');
      console.log('recipe-page-growth-evidence', evidencePath);
    } });
    const cuts = retained.axes.recipeOccurrences.map(cut => {
      // The restore owner requires a local .temp path. Copy only the retained
      // descriptor/object bundle; its stopped Docker volumes remain the source.
      const local = join(directory, 'backups', cut.manifest.id);
      cpSync(dirname(cut.manifest.backup), local, { recursive: true, errorOnExist: true });
      return { ...cut, manifest: { ...cut.manifest, backup: join(local, 'backup.json') } };
    });
    const series: RecipeCostSeries = {
      'published-reader': { firstPages: [], continuations: [] },
      'author-preview': { firstPages: [], continuations: [] },
    };
    const objectReads: ObjectRead[] = [];
    let verifying = cuts[0]!;
    let copy: {
      stack: Awaited<ReturnType<typeof startMediaStack>>;
      token: string;
      principalId: string;
      ownerOrigins: Record<string, string>;
    } | undefined;
    let meterQualified = false;
    phase = 'restore';
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
      if (profile.otherFetches === null) throw new Error('Fetch inventory is unobserved');
      expect(inventory.filter(item => item.peer === 'other').reduce((sum, item) => sum + item.count, 0))
        .toBe(profile.otherFetches);
      expect(inventory.filter(item => item.peer === 'unclassified').reduce((sum, item) => sum + item.count, 0))
        .toBe(profile.unclassifiedFetches);
      return inventory;
    };
    const censusRestoredTree = async (recipe: typeof cuts[number]['population']['recipe']) => {
      if (!copy) throw new Error('Restored Recipe fixture is unavailable for independent census');
      const { stack } = copy;
      return withoutVerifiedImmutableObjectCache(async (): Promise<RecipeTreeCensus> => {
        const source = structureObjects(stack.env);
        const digests = new Set<string>();
        const snapshot = await readCompositionSnapshot(stack.env, {
          structure: recipe.structure, revision: recipe.revision,
          objects: {
            put: source.put.bind(source),
            async get(digest, maxBytes, signal) {
              const bytes = await source.get(digest, maxBytes, signal);
              digests.add(digest);
              return bytes;
            },
          },
        });
        expect(snapshot.header.profile).toBe('recipe-composition');
        const { records: recordRoot, order: orderRoot } = snapshot.manifest;
        expect(recordRoot.count).toBe(recipe.occurrences.length);
        expect(orderRoot.count).toBe(recipe.occurrences.length);
        // Read actual root-node depth with the owner's format validator, rather
        // than estimating height from occupancy or trusting request counters.
        const recordRootNode = checkStructurePage(await snapshot.objects.get(recordRoot.page.slice(7)));
        const orderRootNode = checkStructurePage(await snapshot.objects.get(orderRoot.page.slice(7)));
        expect(recordRootNode.tree).toBe('record');
        expect(orderRootNode.tree).toBe('order');
        expect(recordRootNode.level).toBe(recordRoot.level);
        expect(orderRootNode.level).toBe(orderRoot.level);
        const manifestNodes = snapshot.cost.pagesRead;
        expect(manifestNodes).toBe(1);
        // Complete owner ranges visit the reachable nodes once. They share this
        // fresh TreeCost; census I/O is outside the request trace and bypasses the
        // verified-object cache without filling it. Historical/index-only blobs
        // are outside the Recipe page's manifest/record/order read scope.
        const records = await recordTree(snapshot.objects).range(recordRoot, '', '\uffff', recordRoot.count, snapshot.cost);
        const recordNodes = snapshot.cost.pagesRead - manifestNodes;
        const ordering = await orderTree(snapshot.objects).range(orderRoot, '', '\uffff', orderRoot.count, snapshot.cost);
        const orderNodes = snapshot.cost.pagesRead - manifestNodes - recordNodes;
        expect(records).toHaveLength(recordRoot.count);
        expect(ordering).toHaveLength(orderRoot.count);
        expect(new Set(records.map(item => item.occurrence)).size).toBe(recipe.occurrences.length);
        expect(records.map(item => item.occurrence).sort()).toEqual([...recipe.occurrences].sort());
        expect(ordering.map(item => item.occurrence).sort()).toEqual([...recipe.occurrences].sort());
        // This seed is flat: tree ordering is the Recipe's page ordering. Nested
        // sections require their own depth axis, explicitly named by the todo.
        expect(records.every(item => item.parent === recipe.structure && item.role === 'ingredient')).toBe(true);
        expect(ordering.every(item => item.parent === recipe.structure)).toBe(true);
        expect(digests.size).toBe(snapshot.cost.pagesRead);
        expect(recordNodes).toBeGreaterThan(0);
        expect(orderNodes).toBeGreaterThan(0);
        return { structure: recipe.structure, revision: recipe.revision, occurrences: recipe.occurrences.length,
          depth: Math.max(recordRootNode.level, orderRootNode.level), nodeCount: snapshot.cost.pagesRead,
          manifestNodes, recordNodes, orderNodes, recordDepth: recordRootNode.level, orderDepth: orderRootNode.level,
          objectPaths: [...digests].sort().map(digest => structureObjectPrefix + digest),
          occurrenceOrder: ordering.map(item => item.occurrence) };
      });
    };
    const budgetedRead = (profile: WorkProfile, inventory: ReturnType<typeof fetchInventory>,
      scale: string, read: string, reader: RecipeReader, census: RecipeTreeCensus) => {
      const budgeted = budgetRecipeProfile(profile, inventory, census, copy!.ownerOrigins.MAIN_S3_ENDPOINT!, recipePageSize);
      const budget = { scale, read, reader, ...budgeted.budget };
      objectReads.push(budget);
      return { budget, profile: budgeted.profile };
    };
    const measuredRead = async <T>(request: (headers: Headers) => Request) => {
      if (!copy) throw new Error('Restored Recipe fixture is unavailable');
      const { stack } = copy;
      const measured = await coldRecipeRequest(() => profileRequest(sink, async headers => {
        const response = await stack.main.handle(request(headers));
        const body = await response.text();
        expect(response.status, body).toBe(200);
        return JSON.parse(body) as T;
      }, { service: 'main', flush: flushTelemetryTraces }));
      // A blind meter cannot produce a passing cost verdict.
      expect(measured.profile.postgresStatements).toBeGreaterThan(0);
      expect(measured.profile.fusekiRequests).toBeGreaterThan(0);
      expect(measured.profile.fusekiSentBytes).toBeGreaterThan(0);
      expect(measured.profile.fusekiReceivedBytes).toBeGreaterThan(0);
      expect(measured.profile.unclassifiedFetches).toBe(0);
      return measured;
    };
    const publishRestoredRecipe = async (recipe: typeof cuts[number]['population']['recipe']) => {
      if (!copy) throw new Error('Restored Recipe fixture is unavailable');
      const { stack, token, principalId } = copy;
      const { grantFixtureAuthority } = await import('../../../services/main/src/modules/access/fixture-authority.ts');
      const api = seedApi(stack, token);
      const header = await api.read<{ revision: string; mainVersion: string; publicationState: string }>(
        `/v1/works/${recipe.work.slice(-36)}?actingSubject=${encodeURIComponent(retained.actor)}`);
      expect(header.mainVersion).toBe(recipe.mainVersion);
      if (header.publicationState !== 'published') {
        await grantFixtureAuthority(stack.accessPool, {
          scope: `work:publish:${recipe.work}`, requireDispatch: true,
          representations: [{ principalId, actor: retained.actor, action: 'work.publish', lifetime: '7 days' }],
          grant: { actor: retained.actor, action: 'work.publish', lifetime: '7 days' },
        });
        // Publish the existing restored snapshot through its owner API. This is
        // access/selection preparation, not a second corpus build or seed.
        await api.command(`recipe-growth-publication-${qaRunId}`, {
          method: 'POST', path: '/v1/work-publications', body: {
            profile: 'work-structure-publication-v1', operation: 'publish', work: recipe.work,
            actingSubject: retained.actor, expectedWorkHead: header.revision,
            expectedMainVersion: recipe.mainVersion, structure: recipe.structure,
            expectedStructureHead: recipe.revision, expectedPublicationHead: null,
            disclosure: 'public', rightsBasis: 'original-contribution',
          },
        });
      }
      // Follow the reading page's selected section href as the browser does.
      const response = await stack.main.handle(new Request(`http://main.local/v1/resources/${recipe.work.slice(-36)}/page`,
        { credentials: 'omit' }));
      const body = await response.text();
      expect(response.status, body).toBe(200);
      const page = JSON.parse(body) as { profile: string; work: { publicationState: string };
        sections: Array<{ id: string; href: string }> };
      expect(page.profile).toBe('entity-page-v1');
      expect(page.work.publicationState).toBe('published');
      const section = page.sections.find(item => item.id === 'recipe');
      if (!section) throw new Error('Published reading page did not select a Recipe section');
      return section.href;
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
          copy = { stack, token: member.token, principalId: member.principalId,
            ownerOrigins: Object.fromEntries(['MAIN_S3_ENDPOINT', 'FUSEKI_URL', 'ACCOUNT_ORIGIN',
              'ACCOUNT_JWKS_URL', 'ACCOUNT_INTROSPECT_URL', 'MAIN_ORIGIN', 'CONTENT_ORIGIN']
              .filter(key => input.apps[key]).map(key => [key, new URL(input.apps[key]!).origin])) };
          // A known selected-text page qualifies the restored-stack meter independently
          // of Recipe traversal and must produce nonzero SQL, Fuseki and byte costs.
          if (!meterQualified) {
            phase = 'meter qualification';
            const known = await measuredRead(headers => {
              headers.set('authorization', `Bearer ${member.token}`);
              return new Request(`http://main.local${seedSelection(work.mainVersion)}`, { headers });
            });
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
    // Free the harness's empty persistent project before restoring each cut alone.
    await stream('task', ['stack:down', '--', '--profile', 'qa', '--run-id', qaRunId, '--persistent'], dockerEnvironment());
    for (const cut of cuts) {
      phase = `${cut.manifest.scale} restore`;
      verifying = cut;
      const target = `recipe-${cut.manifest.scale}-${qaRunId}`;
      cleanup.splice(1, 0, { name: `stop ${target}`, run: () => driver.stop(target) });
      const preparationMs = await restoreWorkProfileCorpus(cut.manifest, target, driver);
      expect(preparationMs).toBeLessThan(600_000);
      const recipe = cut.population.recipe;
      const expectedOccurrences = cut.manifest.dimensions.recipeOccurrences!;
      expect(recipe.occurrences).toHaveLength(expectedOccurrences);
      phase = `${cut.manifest.scale} independent tree census`;
      const treeCensus = await censusRestoredTree(recipe);
      evidence.push({ independentTreeCensus: treeCensus, scale: cut.manifest.scale,
        source: 'Owner full-range TreeCost plus root-node levels; cache bypass; outside profiled request' });
      console.log('recipe-page-growth-tree-census', JSON.stringify({ scale: cut.manifest.scale, ...treeCensus }));
      for (const reader of ['author-preview', 'published-reader'] as const) {
        const href = reader === 'published-reader'
          ? await publishRestoredRecipe(recipe) : `/v1/recipes/works/${recipe.work.slice(-36)}`;
        const row: Record<string, unknown> = {
          scale: cut.manifest.scale, cut: cut.manifest.id, reader,
          dimensions: cut.manifest.dimensions, preparationMs, ownerOrigins: copy!.ownerOrigins,
          pages: [], coverage: RECIPE_GROWTH_COVERAGE,
        };
        evidence.push(row);
        const pages = row.pages as Array<Record<string, unknown>>;
        let cursor: string | undefined;
        // Medium provides page 2; large provides pages 2 and 3. Three actual
        // continuation samples let the existing pairwise checker compare the
        // two available populations without fabricating a small continuation.
        const pageLimit = cut.manifest.scale === 'large' ? 3 : 2;
        for (let pageIndex = 0; pageIndex < pageLimit; pageIndex++) {
          const read = pageIndex === 0 ? 'first page' : `continuation page ${pageIndex + 1}`;
          phase = `${cut.manifest.scale} ${reader} ${read}`;
          const measured = await measuredRead<RecipePage>(headers => recipeReaderRequest(href, reader,
            { token: copy!.token, actor: retained.actor }, headers, cursor));
          const pageRow: Record<string, unknown> = { read, offset: pageIndex * recipePageSize,
            counters: counters(measured.profile), cost: measured.result.cost };
          pages.push(pageRow);
          const fetches = fetchInventory(measured.profile);
          pageRow.fetches = fetches;
          const budgeted = budgetedRead(measured.profile, fetches, cut.manifest.scale, read, reader, treeCensus);
          pageRow.objectReadBudget = budgeted.budget;
          series[reader][pageIndex === 0 ? 'firstPages' : 'continuations'].push(
            recipeCostSample(budgeted.profile, cut.manifest.dimensions.recipeOccurrences!));
          expect(measured.profile.request.route).toBe('/v1/recipes/works/:id');
          assertRecipePageComplete(measured.result, treeCensus, pageIndex * recipePageSize, recipePageSize);
          expect(measured.result.cost.pages).toBeLessThanOrEqual(RECIPE_WORK_PAGE_READ_BOUND);
          expect(measured.result.occurrences.every(item => item.role === 'ingredient')).toBe(true);
          cursor = measured.result.next;
          if (!cursor) {
            expect(expectedOccurrences).toBe(recipePageSize);
            row.continuationMissingReason = 'Small cut ends on its first occurrence page';
            break;
          }
        }
        console.log('recipe-page-growth-checkpoint', JSON.stringify(row));
      }
      await driver.stop(target);
    }
    expect(meterQualified).toBe(true);
    const ratiosFor = (profiles: typeof series['author-preview']['firstPages']) =>
      profiles.flatMap((smaller, index) => profiles.slice(index + 1).map(larger => ({
        scales: [smaller.dimensions.threads, larger.dimensions.threads],
        counters: Object.fromEntries(Object.keys(growth!).map(key => {
          // Recipe declares direct counters; the shared contract also permits
          // dotted native-visit fields that cannot index a WorkProfile.
          const field = key as Extract<keyof NonNullable<typeof growth>, keyof WorkProfile>;
          const before = smaller[field], after = larger[field];
          return [key, before === null || after === null ? null
            : before === 0 ? after === 0 ? 1 : 'Infinity' : after / before];
        })),
      })));
    const ratios = Object.fromEntries(Object.entries(series).map(([reader, profiles]) => [reader, {
      firstPage: ratiosFor(profiles.firstPages), continuation: ratiosFor(profiles.continuations),
    }]));
    evidence.push({ ratios, coverage: RECIPE_GROWTH_COVERAGE });
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
    check('GET /v1/recipes/works/:id both readers, first pages and cold continuations', () =>
      assertRecipeSeriesCosts(series, recipePageCost));
    for (const objectRead of objectReads)
      check(`GET /v1/recipes/works/:id ${objectRead.scale} ${objectRead.reader} ${objectRead.read} Structure object budget`, () =>
        assertRecipeObjectBudget(objectRead));
    const largeReads = objectReads.filter(item => item.scale === 'large');
    for (const objectRead of largeReads)
      if (objectRead.fullWalkDetectable)
        check(`GET /v1/recipes/works/:id large ${objectRead.reader} ${objectRead.read} excludes a full tree walk`, () =>
          expect(objectRead.distinctKeys).toBeLessThan(objectRead.nodeCount));
    const large = largeReads[0]!;
    const registryNote = large.fullWalkDetectable
      ? 'Large tree exceeds the keyed-path budget; a full node walk must fail the check'
      : 'Large tree nodeCount is within the keyed-path budget: this cut cannot distinguish a full walk from a bounded read; a fourth cut is needed';
    evidence.push({ registryNote, largeNodeCount: large.nodeCount, keyedPathBudget: large.keyedPathBudget });
    console.log('recipe-page-growth-registry-note', registryNote);
    if (failures.length) throw new AggregateError(failures, 'Recipe page cost contracts failed');
    evidence.push({ verdict: 'pass', coverage: RECIPE_GROWTH_COVERAGE });
  } catch (error) {
    evidence.push({ verdict: phase === 'growth verdict' ? 'fail' : 'unavailable', phase, error: String(error),
      ...(phase === 'growth verdict' ? {
        owner: 'kernel: services/main/src/modules/recipe/work-page.ts readRecipeWorkPage; services/main/src/modules/structure/read.ts',
      } : {}) });
    primaryFailure = { error };
  } finally {
    await finishRecipeGrowth([...cleanup,
      { name: 'shutdown telemetry', run: shutdownTelemetry },
      { name: 'restore fetch', run: () => { globalThis.fetch = fetchBeforeEvidence; } },
      { name: 'stop sink', run: () => sink.stop() },
    ], primaryFailure);
  }
} else {
  const { test } = await import('bun:test');
  const { STRUCTURE_LIMITS } = await import('../../../services/main/src/modules/structure/format.ts');
  test.todo(recipeSectionDepthTodo(STRUCTURE_LIMITS.maxDepth), () => {});
  test.todo('unrelatedPosts at 4/16/64 through the product API; expected class: constant; posts: not covered', () => {});
  test('Recipe Work page meets remote and immutable-object budgets on published growth cuts', async () => {
    const { stdout } = await runWorkProfileChild('tests/qa/integration/recipe-page-growth.test.ts', {
      env: { REZICS_RECIPE_GROWTH_CHILD: '1' }, timeoutMs: 1_800_000,
    });
    console.log(stdout);
  }, 1_850_000);
}
