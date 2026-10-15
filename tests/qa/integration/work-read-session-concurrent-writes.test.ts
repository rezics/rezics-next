import { expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const short = (id: string) => id.slice(-36);

/** Continuation tokens and opening positions identify a read, not its displayed units. */
function displayed(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(displayed);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== 'sourcePosition' && key !== 'nextCursor')
    .map(([key, child]) => [key, displayed(child)]));
  return value;
}

async function concurrentReadProfiles() {
  const { startTelemetry, flushTelemetryTraces, shutdownTelemetry } =
    await import('@rezics/observability/runtime');
  const { profileRequest, startWorkProfileSink } = await import('../support/work-profile.ts');
  const { decode } = await import('../../../packages/observability/tests/otlp.ts');
  const sink = startWorkProfileSink({ settleMs: 25, maxSpans: 200_000 });
  type WireAttempt = { name: string; traceId: string; spanId: string; parentSpanId?: string;
    startTimeUnixNano: number; endTimeUnixNano: number; attributes?: unknown; status?: unknown; events?: unknown };
  const wireAttempts = new Map<string, WireAttempt[]>();
  const nativeFetch = globalThis.fetch;
  // The shared profile decoder intentionally omits status/events. Retain their
  // actual OTLP fields beside the standard profile when an attempt fails early.
  const telemetryIngress = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (path === '/v1/traces') {
      const message = decode('Traces', bytes) as {
        resourceSpans?: Array<{ scopeSpans?: Array<{ spans?: WireAttempt[] }> }>;
      };
      for (const resource of message.resourceSpans ?? []) for (const scope of resource.scopeSpans ?? []) {
        for (const span of scope.spans ?? []) if (span.name === 'main.work_read.attempt') {
          const traceId = Buffer.from(span.traceId, 'base64').toString('hex');
          const prior = wireAttempts.get(traceId) ?? [];
          if (!prior.some(item => item.spanId === span.spanId)) prior.push(span);
          wireAttempts.set(traceId, prior);
        }
      }
    }
    return nativeFetch(`${sink.url}${path}`, { method: 'POST', headers: request.headers, body: bytes });
  } });
  startTelemetry('main', { ...process.env, ...sink.env,
    OTEL_EXPORTER_OTLP_ENDPOINT: telemetryIngress.url.origin });
  const { foregroundCounted } = await import('./support/operation-cost.ts');
  const { startHomeStack } = await import('./feed-read-support.ts');
  const { seedPublicProfileWork } = await import('../../../scripts/load/work-profile-work.ts');
  const { workProfileCorpusApi } = await import('../../../scripts/load/work-profile-corpus.ts');
  const { grantFixtureAuthority } = await import('../../../services/main/src/modules/access/fixture-authority.ts');
  const { WorkReadSession } = await import('../../../services/main/src/modules/work/read-session.ts');
  const { fusekiReadBudget } = await import('../../../services/main/src/infrastructure/fuseki.ts');
  const { png, sha } = await import('./media-support.ts');
  const { GLOBAL_CONTEXT_SCOPE } = await import('../../../services/main/src/modules/rating/global.ts');
  const { MediaScreenStore } = await import('../../../services/main/src/modules/media-screen/store.ts');
  const { screenVerdict } = await import('../../../services/main/src/modules/media-screen/policy.ts');
  const home = await startHomeStack('work-read-concurrent-writes', { projectionStart: 'current' });
  const { AccessRealmManagement } = await import('../../../services/main/src/modules/access/realm-management.ts');
  const realmAdmin = new AccessRealmManagement(home.stack.accessPool);
  realmAdmin.configureFollowGraph(home.stack.fuseki);
  Object.assign(home.deps, { realmAdmin });
  const actor = await home.provision('Concurrent read author', home.author.token);
  const started = performance.now();
  const evidence: unknown[] = [];
  const directory = join(process.env.REZICS_QA_ARTIFACT_DIR ?? '.temp/work-profiles', 'concurrent-work-reads');
  const sampleContext = new AsyncLocalStorage<{
    path: string; attempts: number[]; observedAttempts: number[]; opening?: { dataEpoch: string; sequence: string };
    reached: () => void; held: Promise<void>; paused: boolean;
    summary?: { resources: string[]; phase: 'closing-position' | 'survivor'; survivor?: string };
    positionReads: number;
    failures: Array<{ phase: string; attempt: number; query?: string; error: unknown }>;
    prefixWalks: unknown[];
    sessions: Map<InstanceType<typeof WorkReadSession>, { done: Promise<void>; close: () => void }>;
  }>();
  const trackSession = (session: InstanceType<typeof WorkReadSession>) => {
    const sample = sampleContext.getStore();
    if (!sample || sample.sessions.has(session)) return;
    let close!: () => void;
    const done = new Promise<void>(resolve => { close = resolve; });
    sample.sessions.set(session, { done, close });
    sample.observedAttempts.push(session.attemptCount);
  };
  const failureDetail = (error: unknown): unknown => error instanceof Error
    ? { name: error.name, message: error.message, stack: error.stack,
      ...(error.cause ? { cause: failureDetail(error.cause) } : {}) } : String(error);
  const originalQuery = WorkReadSession.prototype.query;
  const originalGraphQuery = home.stack.fuseki.query;
  home.stack.fuseki.query = async function (...args) {
    const sample = sampleContext.getStore();
    if (foregroundCounted() && sample?.summary && !sample.paused) {
      const body = args[0];
      const closing = sample.summary.phase === 'closing-position'
        && body.includes('SELECT ?epoch ?sequence WHERE') && ++sample.positionReads === 2;
      const survivor = sample.summary.phase === 'survivor' && body.includes('SELECT ?epoch ?sequence ?hold ?r')
        && !!sample.summary.survivor && body.includes(`<${sample.summary.survivor}>`)
        && !body.includes(`<${sample.summary.resources[0]}>`);
      if (closing || survivor) { sample.paused = true; sample.reached(); await sample.held; }
    }
    return originalGraphQuery.apply(this, args);
  };
  const originalAuthority = WorkReadSession.prototype.fenceAuthority;
  WorkReadSession.prototype.fenceAuthority = async function () {
    trackSession(this);
    try { return await originalAuthority.call(this); }
    finally { sampleContext.getStore()?.sessions.get(this)?.close(); }
  };
  const originalPrefixWalk = home.stack.fuseki.prefixWalk;
  home.stack.fuseki.prefixWalk = async function (input) {
    try {
      const response = await originalPrefixWalk.call(this, input);
      sampleContext.getStore()?.prefixWalks.push({ input, response });
      return response;
    } catch (error) {
      sampleContext.getStore()?.failures.push({ phase: 'prefix-walk',
        attempt: fusekiReadBudget.getStore()?.attempt ?? 1, error: failureDetail(error) });
      throw error;
    }
  };
  WorkReadSession.prototype.query = async function (...args) {
    const counted = foregroundCounted();
    if (counted) trackSession(this);
    try { return await originalQuery.apply(this, args); }
    catch (error) {
      if (counted) sampleContext.getStore()?.failures.push({ phase: 'query', attempt: this.attemptCount,
        query: args[0], error: failureDetail(error) });
      throw error;
    }
  };
  const commandStage = new AsyncLocalStorage<{
    ready: () => void; held: Promise<void>; committed: () => void; failed: (error: unknown) => void;
  }>();
  const originalCommand = home.stack.fuseki.commandWithReceipt;
  home.stack.fuseki.commandWithReceipt = async function (envelope) {
    const stage = commandStage.getStore();
    if (!stage || !envelope.update.includes('rv:WorkEditedEvent')) return originalCommand.call(this, envelope);
    stage.ready();
    await stage.held;
    try {
      const result = await originalCommand.call(this, envelope);
      assert.equal(result.status, 'committed', 'Staged API edit must commit its graph write');
      stage.committed();
      return result;
    } catch (error) { stage.failed(error); throw error; }
  };
  const originalFence = WorkReadSession.prototype.fenceDependencies;
  WorkReadSession.prototype.fenceDependencies = async function () {
    trackSession(this);
    const sample = sampleContext.getStore();
    if (sample && new URL(this.request.url).pathname === new URL(`http://main.local${sample.path}`).pathname) {
      sample.attempts.push(this.attemptCount);
      sample.opening ??= { dataEpoch: this.position.dataEpoch, sequence: this.position.sequence };
      if (!sample.paused) { sample.paused = true; sample.reached(); await sample.held; }
    }
    try { return await originalFence.call(this); }
    catch (error) {
      const failure = { phase: 'dependency-fence', attempt: this.attemptCount, error: failureDetail(error) };
      sample?.failures.push(failure);
      console.error(JSON.stringify({ path: this.request.url, ...failure }));
      throw error;
    }
  };
  try {
    const grant = async (scope: string, action: string,
      holder: { principalId: string; actor: string } = { principalId: home.author.principalId, actor }) => {
      const lifetime = action === 'agent.control' ? 'infinity' : '8 hours';
      const client = await home.stack.accessPool.connect();
      try {
        await client.query('BEGIN');
        await grantFixtureAuthority(client, { scope, requireDispatch: true,
          representations: [{ principalId: holder.principalId, actor: holder.actor, action, lifetime }],
          grant: { actor: holder.actor, action, lifetime } });
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    };
    const command = async <T>(method: string, path: string, body: object, status = 200): Promise<T> =>
      home.json<T>(await home.call(method, path, body, home.author.token), status);
    const api = workProfileCorpusApi('http://main.local', home.author.token, {
      fetch: ((input, init) => home.app.handle(new Request(input, init))) as typeof fetch,
    });
    const unrelatedPublic = await seedPublicProfileWork(api, `unrelated-public:${randomUUID()}`, {
      actingSubject: actor, title: 'Distant rating target', body: 'Unrelated public words',
    });
    const prefix = `Concurrent${randomUUID().replaceAll('-', '')}`;
    const shown = await seedPublicProfileWork(api, `shown:${randomUUID()}`, {
      actingSubject: actor, title: `${prefix} shown Work`, body: 'The selected public words',
    });
    await grant(`work:edit:${shown.work}`, 'work.edit');
    const unrelated: Array<{ work: string; revision: string; next: 'unknown' | 'no-value' }> = [];
    for (let index = 0; index < 32; index++) {
      const created = await command<{ work: string }>('POST', '/v1/works', {
        profile: 'metadata-only-v1', authoring: 'own-work', title: `Unshown draft ${index}`,
        language: 'en', actingSubject: actor,
      }, 201);
      await grant(`work:edit:${created.work}`, 'work.edit');
      const head = await home.json<{ revision: string }>(await home.call('GET',
        `/v1/works/${short(created.work)}?actingSubject=${encodeURIComponent(actor)}`, undefined, home.author.token));
      unrelated.push({ work: created.work, revision: head.revision, next: 'unknown' });
    }
    await grant('space:create:root', 'space.create');
    const space = await command<{ space: string; realm: string }>('POST', '/v1/spaces', {
      profile: 'space-realm-v1', name: 'Concurrent community', language: 'en',
      capabilities: ['realm'], actingSubject: actor,
    }, 201);
    const zone = { zone: `https://rezics.com/id/${randomUUID()}` };
    await grant(`zone:edit:${zone.zone}`, 'zone.edit');
    const zoneCreated = await command<{ revision: string }>('POST', '/v1/zones', {
      ...zone, space: space.space, name: 'Concurrent Zone', language: 'en',
      disclosure: 'public', actingSubject: actor,
    }, 201);
    const collection = `https://rezics.com/id/${randomUUID()}`;
    await grant(`collection:edit:${collection}`, 'collection.edit');
    const list = await command<{ structure: string; revision: string }>('POST', '/v1/collections', {
      collection, name: 'Concurrent reading list', disclosure: 'public', actingSubject: actor,
    }, 201);
    const firstList = await command<{ revision: string }>('POST', `/v1/collections/${short(collection)}/changes`, {
      expectedHead: list.revision, actingSubject: actor,
      operations: [{ op: 'insert', role: 'member', parent: list.structure, position: 'last',
        target: shown.work, selection: { mode: 'follow-context' } }],
    });
    await command('POST', `/v1/zones/${short(zone.zone)}/mounts`, {
      expectedHead: zoneCreated.revision, target: collection, routeSegment: 'catalogue',
      disclosure: 'public', position: 'last', actingSubject: actor,
    });
    await grant(GLOBAL_CONTEXT_SCOPE, 'rating.context.create');
    const context = await command<{ context: string }>('POST', '/v1/global-rating-contexts', {
      profile: 'global-rating-standing-context-v1', question: 'Concurrent unrelated rating', actingSubject: actor,
    }, 201);
    let ratingHead: string | null = null;
    let ratingValue = 1;
    const rateElsewhere = async () => {
      const result = await command<{ observationRevision: string }>('POST', '/v1/global-rating-observations', {
        profile: 'global-rating-standing-observation-v1', context: context.context,
        work: unrelatedPublic.work, mainVersion: unrelatedPublic.mainVersion,
        expectedRevisionHead: ratingHead, value: ratingValue++ % 5 + 1, actingSubject: actor,
      }, 201);
      ratingHead = result.observationRevision;
    };
    await home.project();
    assert(performance.now() - started < 600_000, 'Live preparation exceeded ten minutes');

    const surfaces = [
      { name: 'work', path: `/v1/resources/${short(shown.work)}/page`, resource: shown.work },
      { name: 'zone', path: `/v1/zones/${short(zone.zone)}/routes?path=%2Fcatalogue`, resource: shown.work },
      { name: 'home', path: '/v1/feed?sort=new&kinds=work&limit=1', resource: shown.work },
      { name: 'typeahead', path: `/v1/search/typeahead?prefix=${prefix}`, resource: shown.work },
    ];
    const nativeSearchState = async () => {
      const health = await home.stack.fuseki.commandHealth();
      return { instanceId: health.instanceId, publicSearchWriteEpoch: health.publicSearchWriteEpoch,
        publicSearchWriteActive: health.publicSearchWriteActive, prefixWalkAvailable: health.prefixWalkAvailable };
    };
    const measure = async (path: string, mutate: () => Promise<unknown> = async () => {}, token?: string,
      concurrentWrites?: () => { requested: number; durable: number; finished: number },
      summary?: { resources: string[]; phase: 'closing-position' | 'survivor'; survivor?: string }) => {
      const searchBefore = path.startsWith('/v1/search/typeahead') ? await nativeSearchState() : undefined;
      let reached!: () => void, release!: () => void;
      const entered = new Promise<void>(resolve => { reached = resolve; });
      const held = new Promise<void>(resolve => { release = resolve; });
      const sample = { path, attempts: [] as number[], observedAttempts: [] as number[], reached, held, paused: false,
        summary, positionReads: 0,
        failures: [] as Array<{ phase: string; attempt: number; query?: string; error: unknown }>,
        prefixWalks: [] as unknown[],
        sessions: new Map<InstanceType<typeof WorkReadSession>, { done: Promise<void>; close: () => void }>(),
        opening: undefined as { dataEpoch: string; sequence: string } | undefined };
      let writesAtHydration: ReturnType<NonNullable<typeof concurrentWrites>> | undefined;
      let writesBeforeFence: typeof writesAtHydration, writesAtDelivery: typeof writesAtHydration;
      const measured = profileRequest(sink, headers => sampleContext.run(sample, async () => {
        if (token) headers.set('authorization', `Bearer ${token}`);
        if (summary) headers.set('content-type', 'application/json');
        const response = await home.app.handle(new Request(`http://main.local${path}`, { headers,
          ...(summary ? { method: 'POST', body: JSON.stringify({ profile: 'resource-summary-batch-v1',
            resources: summary.resources }) } : {}) }));
        const text = await response.text();
        writesAtDelivery = concurrentWrites?.();
        // A search deadline can return HTTP while the canceled attempt closes
        // its mandatory authority checks. Export only after those attempts end.
        for (;;) {
          const count = sample.sessions.size;
          await Promise.all([...sample.sessions.values()].map(session => session.done));
          await nextTurn();
          if (sample.sessions.size === count) break;
        }
        return { status: response.status, body: JSON.parse(text) as Record<string, unknown> };
      }), { service: 'main', flush: flushTelemetryTraces });
      let heldMs = 0;
      try {
        await Promise.race([entered, measured.then(result => {
          throw new Error(`Read completed before hydration hook: ${JSON.stringify(result.result)}`);
        })]);
        // This sibling operation starts outside the request's trace and budget.
        writesAtHydration = concurrentWrites?.();
        const heldAt = performance.now();
        try { await mutate(); writesBeforeFence = concurrentWrites?.(); }
        finally { heldMs = Math.round(performance.now() - heldAt); }
      } finally { release(); }
      const result = await measured;
      const searchAfter = searchBefore ? await nativeSearchState() : undefined;
      const attempts = result.profile.spans.filter(span => span.name === 'main.work_read.attempt').length;
      const attemptSpans = wireAttempts.get(result.profile.traceId) ?? [];
      const diagnostic = { path, result: result.result, attempts, fenceAttempts: sample.attempts,
        observedAttempts: sample.observedAttempts,
        failures: sample.failures, attemptSpans, prefixWalks: sample.prefixWalks,
        searchBefore, searchAfter, opening: sample.opening, heldMs,
        writesAtHydration, writesBeforeFence, writesAtDelivery };
      evidence.push({ ...diagnostic, profile: result.profile });
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, 'profiles.json'), JSON.stringify(evidence, null, 2) + '\n');
      wireAttempts.delete(result.profile.traceId);
      console.info(JSON.stringify({ path, attempts, heldMs,
        status: result.result.status, fusekiRequests: result.profile.fusekiRequests }));
      assert.equal(attempts, Math.max(...sample.observedAttempts),
        `Attempt profile must describe the real sessions: ${JSON.stringify(diagnostic)}`);
      assert(result.profile.fusekiRequests !== null && result.profile.fusekiRequests > 0,
        'Request profile must include measured Fuseki calls');
      return { ...result, attempts, opening: sample.opening };
    };
    const scalarEdit = async (target: { work: string; revision: string }, value: 'unknown' | 'no-value') => {
      const changed = await command<{ revision: string }>('POST', `/v1/works/${short(target.work)}/scalar-value`, {
        profile: 'work-scalar-state-v1', expectedHead: target.revision,
        scalarValue: { kind: value }, actingSubject: actor,
      });
      assert.notEqual(changed.revision, target.revision, 'Unrelated edit must actually commit a new Work head');
      target.revision = changed.revision;
    };
    const stageEdits = async (count: number) => {
      let durableCount = 0, finishedCount = 0;
      const gates = unrelated.slice(0, count).map(target => {
        let ready!: () => void, release!: () => void, committed!: () => void, failed!: (error: unknown) => void;
        const prepared = new Promise<void>(resolve => { ready = resolve; });
        const held = new Promise<void>(resolve => { release = resolve; });
        const durable = new Promise<void>((resolve, reject) => {
          committed = () => { durableCount++; resolve(); }; failed = reject;
        });
        const settled = commandStage.run({ ready, held, committed, failed }, async () => {
          await scalarEdit(target, target.next);
          target.next = target.next === 'unknown' ? 'no-value' : 'unknown';
          finishedCount++;
        });
        return { prepared, durable, settled, release };
      });
      const finished = Promise.all(gates.map(gate => gate.settled));
      const committed = Promise.all(gates.map(gate => gate.durable));
      const firstCommitted = Promise.race(gates.map(gate => gate.durable));
      // Admission, manifests and validation preparation precede the measured read;
      // every actual native dispatch remains blocked until hydration has finished.
      try {
        await Promise.race([Promise.all(gates.map(gate => gate.prepared)), finished.then(() => {
          throw new Error('API edit completed before its graph-dispatch barrier');
        })]);
      } catch (error) { gates.forEach(gate => gate.release()); throw error; }
      return { release: () => gates.forEach(gate => gate.release()), committed, firstCommitted, finished,
        progress: () => ({ requested: count, durable: durableCount, finished: finishedCount }) };
    };
    for (const surface of surfaces) {
      // Warm retained manifests before measuring the request's physical calls.
      await home.json(await home.call('GET', surface.path));
      const baseline = await measure(surface.path);
      assert.equal(baseline.result.status, 200, JSON.stringify(baseline.result.body));
      assert.equal(baseline.attempts, 1);
      const text = JSON.stringify(baseline.result.body);
      assert(text.includes(surface.resource), `${surface.name} must show the selected resource`);
      if (surface.name === 'zone') assert(text.includes(zone.zone), 'Zone must show its mounted index');
      if (surface.name === 'home') {
        assert(text.includes(prefix), 'Home must hydrate the shown Work, not an empty inventory');
      }
      for (const count of [8, 32]) {
        const staged = await stageEdits(count);
        let moved: Awaited<ReturnType<typeof measure>>;
        try {
          moved = await measure(surface.path, async () => {
            assert.equal(staged.progress().durable, 0, 'Native edits must remain gated until hydration');
            staged.release();
            await staged.firstCommitted;
            assert(staged.progress().durable >= 1, 'An unrelated API write must commit before the final read fence');
          }, undefined, staged.progress);
        } finally {
          staged.release();
          await Promise.all([staged.committed, staged.finished]);
          evidence.push({ path: surface.path, concurrentWritesFinished: staged.progress() });
        }
        assert.deepEqual(staged.progress(), { requested: count, durable: count, finished: count },
          'Every concurrent product API edit must durably commit and return a new Work head');
        assert.equal(moved.result.status, 200, JSON.stringify(moved.result.body));
        assert.equal(moved.attempts, 1, `${surface.name}, ${count} unrelated writes must never replay`);
        assert.equal(moved.profile.fusekiRequests, baseline.profile.fusekiRequests,
          `${surface.name} call count must stay constant under unrelated writes`);
        assert.deepEqual(displayed(moved.result.body), displayed(baseline.result.body));
        const sourcePosition = moved.result.body.sourcePosition as { dataEpoch: string; sequence: string };
        assert.deepEqual({ dataEpoch: sourcePosition.dataEpoch, sequence: sourcePosition.sequence }, moved.opening,
          'sourcePosition must remain the position where this attempt started');
      }
      const rated = await measure(surface.path, rateElsewhere);
      assert.equal(rated.result.status, 200, JSON.stringify(rated.result.body));
      assert.equal(rated.attempts, 1, `${surface.name} must ignore another Work's rating`);
      assert.equal(rated.profile.fusekiRequests, baseline.profile.fusekiRequests);
      assert.deepEqual(displayed(rated.result.body), displayed(baseline.result.body));
    }

    const interestPath = '/v1/feed?sort=new&kinds=work&interests=recipes&limit=2';
    const interestExcluded = await measure(interestPath);
    assert.equal(interestExcluded.result.status, 200);
    assert.deepEqual(interestExcluded.result.body.items, []);
    const interestHead = await home.json<{ revision: string }>(await home.call('GET',
      `/v1/works/${short(unrelatedPublic.work)}`));
    const interestEdit = await measure(interestPath, () => scalarEdit({ work: unrelatedPublic.work,
      revision: interestHead.revision }, 'unknown'));
    assert.equal(interestEdit.result.status, 200, JSON.stringify(interestEdit.result.body));
    assert.equal(interestEdit.attempts, 1, 'Editing an interest-excluded candidate must never replay');
    assert.equal(interestEdit.profile.fusekiRequests, interestExcluded.profile.fusekiRequests);
    assert.deepEqual(displayed(interestEdit.result.body), displayed(interestExcluded.result.body));

    // Filtered sources remain retained feed candidates, but their Work heads
    // and summaries contribute no displayed values to this reader's page.
    await command('POST', '/v1/me/feed-feedback', {
      actingSubject: actor, kind: 'work', target: unrelatedPublic.work, strength: 'hide',
    });
    const excludedPath = `/v1/feed?scope=all&sort=new&kinds=work&limit=2&actingSubject=${encodeURIComponent(actor)}`;
    const excluded = await measure(excludedPath, undefined, home.author.token);
    assert.equal(excluded.result.status, 200);
    assert(JSON.stringify(excluded.result.body).includes(shown.work));
    assert(!JSON.stringify(excluded.result.body).includes(unrelatedPublic.work));
    const excludedHead = await home.json<{ revision: string }>(await home.call('GET',
      `/v1/works/${short(unrelatedPublic.work)}`));
    const hiddenEdit = await measure(excludedPath, () => scalarEdit({ work: unrelatedPublic.work,
      revision: excludedHead.revision }, 'unknown'), home.author.token);
    assert.equal(hiddenEdit.result.status, 200, JSON.stringify(hiddenEdit.result.body));
    assert.equal(hiddenEdit.attempts, 1, 'Editing an excluded feed candidate must never replay');
    assert.equal(hiddenEdit.profile.fusekiRequests, excluded.profile.fusekiRequests);
    assert.deepEqual(displayed(hiddenEdit.result.body), displayed(excluded.result.body));
    const blockedReader = await home.provision('Blocked-source reader', home.reader.token);
    await home.json(await home.call('PUT', '/v1/me/blocked-people', {
      actingSubject: blockedReader, target: actor, blocked: true,
    }, home.reader.token));
    const blockedPath = `/v1/feed?scope=all&sort=new&kinds=work&limit=2&actingSubject=${encodeURIComponent(blockedReader)}`;
    const blocked = await measure(blockedPath, undefined, home.reader.token);
    assert.equal(blocked.result.status, 200);
    assert.deepEqual(blocked.result.body.items, []);
    const blockedHead = await home.json<{ revision: string }>(await home.call('GET', `/v1/works/${short(shown.work)}`));
    const blockedEdit = await measure(blockedPath, () => scalarEdit({ work: shown.work,
      revision: blockedHead.revision }, 'no-value'), home.reader.token);
    assert.equal(blockedEdit.result.status, 200, JSON.stringify(blockedEdit.result.body));
    assert.equal(blockedEdit.attempts, 1, 'Editing a blocked actor\'s feed candidate must never replay');
    assert.equal(blockedEdit.profile.fusekiRequests, blocked.profile.fusekiRequests);
    assert.deepEqual(displayed(blockedEdit.result.body), displayed(blocked.result.body));

    const assertAffected = (sample: Awaited<ReturnType<typeof measure>>, fresh: string) => {
      if (sample.result.status === 200) {
        assert(sample.attempts > 1, 'A changed shown unit must replay its hydrated attempt');
        assert(JSON.stringify(sample.result.body).includes(fresh), 'Successful replay must show the fresh unit');
      } else {
        assert([409, 503].includes(sample.result.status), JSON.stringify(sample.result));
        assert(['read_basis_changed', 'work_read_unavailable', 'search_index_unavailable', 'query_unavailable',
          'zone_route_stale', 'zone_route_unavailable']
          .includes(String(sample.result.body.code)), 'Affected read must return a typed consistency answer');
      }
    };
    // A Work head is itself a shown unit even when an edit preserves its title.
    const head = await home.json<{ revision: string }>(await home.call('GET', `/v1/works/${short(shown.work)}`));
    const current = { work: shown.work, revision: head.revision };
    const edited = await measure(surfaces[0]!.path, () => scalarEdit(current, 'unknown'));
    assertAffected(edited, current.revision);
    const zoneEdited = await measure(surfaces[1]!.path, () => scalarEdit(current, 'no-value'));
    assertAffected(zoneEdited, current.revision);
    // Home and typeahead render the head's title, so verify the replacement text itself.
    for (const surface of surfaces.slice(2)) {
      const basis = await home.json<import('../../../services/main/src/modules/work/title-control.ts').TitleControlState>(
        await home.call('GET', `/v1/works/${short(shown.work)}/title-control?actingSubject=${encodeURIComponent(actor)}`,
          undefined, home.author.token));
      const title = `${prefix} refreshed ${surface.name}`;
      const titled = await measure(surface.path, () => command('POST', '/v1/content-edits', {
        profile: 'metadata-only-v1', work: shown.work, expectedHead: basis.contentHead,
        titleControl: basis.basis, title, actingSubject: actor,
      }));
      assertAffected(titled, title);
    }
    const zoneState = await home.json<{ revision: string }>(await home.call('GET',
      `/v1/zones/${short(zone.zone)}/configuration?actingSubject=${encodeURIComponent(actor)}`,
      undefined, home.author.token));
    const zoneName = 'Concurrent Zone renamed during hydration';
    const renamed = await measure(surfaces[1]!.path, () => command('PUT',
      `/v1/zones/${short(zone.zone)}/configuration`, {
        expectedHead: zoneState.revision, name: zoneName, language: 'en', actingSubject: actor,
      }));
    assertAffected(renamed, zoneName);

    // Every surface draws its selected cover; changing that row must never return the old image.
    const selectionHeads = new Map<string, string>();
    const prepareImage = async () => {
      const bytes = png(256, 256);
      await grant(`media:owner:${actor}`, 'media.upload');
      await grant(`media:owner:${actor}`, 'media.manage');
      const reserved = await command<{ asset: string; upload: string }>('POST', '/v1/media/uploads', {
        profile: 'media-image-upload-v1', asset: null, mediaType: 'image/png', byteLength: bytes.length,
        sha256: sha(bytes), disclosure: 'public', actingSubject: actor,
      }, 201);
      await home.json(await home.stack.call('PUT', `/v1/media/uploads/${reserved.upload}/bytes`, {
        token: home.author.token, raw: bytes,
      }), 201);
      const screens = new MediaScreenStore(home.stack.contentPool);
      for (let index = 0; index < 100; index++) {
        const lease = await screens.leaseNext();
        if (!lease) break;
        await screens.settle(lease, screenVerdict({ Drawing: 0.05, Hentai: 0.01,
          Neutral: 0.9, Porn: 0.01, Sexy: 0.03 }));
      }
      return reserved.asset;
    };
    for (const surface of surfaces) {
      const asset = await prepareImage();
      await grant(`media:avatar:${surface.resource}`, 'media.avatar');
      let selection = '';
      const covered = await measure(surface.path, async () => {
        const changed = await command<{ selection: string }>('PUT', `/v1/resources/${short(surface.resource)}/avatar`, {
          profile: 'resource-avatar-selection-v1', expectedSelection: selectionHeads.get(surface.resource) ?? null,
          asset, crop: null, actingSubject: actor,
        }, 201);
        selection = changed.selection;
        selectionHeads.set(surface.resource, selection);
      });
      assertAffected(covered, selection);
    }
    // The mounted index and Home list read the same selected Structure independently of Work heads.
    let listHead = firstList.revision, insertedOccurrence = '';
    const changedIndex = await measure(surfaces[1]!.path, async () => {
      const changed = await command<{ revision: string; occurrences: string[] }>('POST',
        `/v1/collections/${short(collection)}/changes`, {
          expectedHead: listHead, actingSubject: actor,
          operations: [{ op: 'insert', role: 'member', parent: list.structure, position: 'last',
            target: unrelatedPublic.work, selection: { mode: 'follow-context' } }],
        });
      listHead = changed.revision;
      insertedOccurrence = changed.occurrences[0]!;
    });
    assertAffected(changedIndex, unrelatedPublic.work);
    const listPath = '/v1/feed?sort=new&kinds=collection&limit=1';
    await home.project();
    const initialList = await measure(listPath);
    assert.equal(initialList.result.status, 200);
    assert(JSON.stringify(initialList.result.body).includes(shown.work), 'List must show its hydrated first member');
    assert(JSON.stringify(initialList.result.body).includes(unrelatedPublic.work), 'List must show its added member');
    const changedList = await measure(listPath, () => command('POST', `/v1/collections/${short(collection)}/changes`, {
      expectedHead: listHead, actingSubject: actor,
      operations: [{ op: 'remove', occurrence: insertedOccurrence }],
    }));
    assertAffected(changedList, shown.work);
    if (changedList.result.status === 200) {
      assert(!JSON.stringify(changedList.result.body).includes(unrelatedPublic.work),
        'Home must omit the member removed during hydration');
    }

    // A public Work selects one exact Structure revision. Editing its private
    // draft keeps that selection; publishing the revision changes the page's basis.
    const structured = await command<{ work: string; mainVersion: string }>('POST', '/v1/works', {
      profile: 'metadata-only-v1', authoring: 'own-work', title: 'Selected structured Work race',
      semanticTypes: ['https://schema.org/Recipe'], language: 'en', actingSubject: actor,
    }, 201);
    for (const [scope, action] of [[`work:edit:${structured.work}`, 'work.edit'],
      [`work:edit:${structured.work}`, 'recipe.edit'], [`work:read:${structured.work}`, 'work.read'],
      [`work:publish:${structured.work}`, 'work.publish'],
      [`work:publish:${structured.work}`, 'work.withdraw-publication']] as const) await grant(scope, action);
    const composition = await command<{ structure: string; revision: string }>('POST', '/v1/compositions', {
      profile: 'recipe-composition', work: structured.work, mainVersion: structured.mainVersion, actingSubject: actor,
    }, 201);
    const structuredHead = await home.json<{ revision: string }>(await home.call('GET',
      `/v1/works/${short(structured.work)}?actingSubject=${encodeURIComponent(actor)}`, undefined, home.author.token));
    const publicationBody = (revision: string, expectedPublicationHead: string | null) => ({
      profile: 'work-structure-publication-v1', operation: 'publish', work: structured.work,
      actingSubject: actor, expectedWorkHead: structuredHead.revision,
      expectedMainVersion: structured.mainVersion, structure: composition.structure,
      expectedStructureHead: revision, expectedPublicationHead,
      disclosure: 'public', rightsBasis: 'original-contribution',
    });
    const firstPublication = await command<{ publicationDecision: string }>('POST', '/v1/work-publications',
      publicationBody(composition.revision, null), 201);
    const { SerialStatisticsProjection } = await import('../../../services/main/src/modules/work/serial-projection.ts');
    const serialStats = new SerialStatisticsProjection(home.stack.accessPool, home.relay,
      home.stack.contentPool, home.stack.env);
    Object.assign(home.deps, { serialStats });
    const materializeStatistics = async () => {
      await home.projectRelay();
      for (let index = 0; index < 1000; index++) {
        if (!await serialStats.tick()) return;
      }
      throw new Error('Serial statistics did not reach the retained fixture cut');
    };
    await materializeStatistics();
    const selectedStatistics = (await serialStats.batch([structured.work])).get(structured.work);
    assert.equal(selectedStatistics?.chapterCount, 0);
    assert.equal(selectedStatistics.wordCount, 0);
    assert(selectedStatistics.lastUpdatedAt, 'The published Recipe must have a materialized publication date');
    const structuredPath = `/v1/resources/${short(structured.work)}/page`;
    const structuredBaseline = await measure(structuredPath);
    assert.equal(structuredBaseline.result.status, 200);
    let draftRevision = '';
    const draftOnly = await measure(structuredPath, async () => {
      const changed = await command<{ revision: string }>('POST', `/v1/compositions/${short(composition.structure)}/changes`, {
        profile: 'recipe-composition', expectedHead: composition.revision, actingSubject: actor,
        operations: [{ op: 'insert', parent: composition.structure, position: 'last', role: 'step',
          qualifier: { type: 'recipe-step', instructionText: { value: 'Cook the refreshed recipe.', language: 'en' },
            usesIngredient: [], media: [], scaling: 'not-scalable' } }],
      });
      draftRevision = changed.revision;
      await materializeStatistics();
    });
    assert.equal(draftOnly.result.status, 200, JSON.stringify(draftOnly.result.body));
    assert.equal(draftOnly.attempts, 1, 'An unselected Structure draft must not move the public Work page');
    assert.equal(draftOnly.profile.fusekiRequests, structuredBaseline.profile.fusekiRequests);
    assert.deepEqual(displayed(draftOnly.result.body), displayed(structuredBaseline.result.body));
    assert.deepEqual((await serialStats.batch([structured.work])).get(structured.work), selectedStatistics,
      'Processing a private Structure command must preserve selected public statistics and date');
    const republished = await measure(structuredPath, () => command('POST', '/v1/work-publications',
      publicationBody(draftRevision, firstPublication.publicationDecision), 201));
    assertAffected(republished, structured.work);
    if (republished.result.status === 200) {
      const position = republished.result.body.sourcePosition as { sequence: string };
      assert(BigInt(position.sequence) > BigInt(republished.opening!.sequence),
        'Successful Work/Structure publication replay must open a fresh source position');
    }
    const selectedRecipe = await home.json<{ revision: string }>(await home.call('GET',
      `/v1/recipes/works/${short(structured.work)}`));
    assert.equal(selectedRecipe.revision, draftRevision, 'The published Work must select the edited Structure exactly');

    await grant(`agent:control:${actor}`, 'agent.control');
    const settings = await home.json<{ generation: string; settings: object }>(await home.call('GET',
      `/v1/spaces/${short(space.space)}/settings?actingSubject=${encodeURIComponent(actor)}`, undefined, home.author.token));
    const realmSummary = { resources: [space.realm], phase: 'closing-position' as const };
    const realmBaseline = await measure('/v1/resources/summaries', undefined, undefined, undefined, realmSummary);
    assert.equal(realmBaseline.result.status, 200, JSON.stringify(realmBaseline.result.body));
    assert(JSON.stringify(realmBaseline.result.body).includes('Concurrent community'));
    const privateRealm = await measure('/v1/resources/summaries', () => command('PUT',
      `/v1/spaces/${short(space.space)}/settings`, { actingSubject: actor,
        expectedGeneration: settings.generation, reason: 'Close the selected Realm',
        settings: { ...settings.settings, visibility: 'private' } }, 201), undefined, undefined, realmSummary);
    assert(!JSON.stringify(privateRealm.result.body).includes('Concurrent community'),
      'A Realm made private after hydration must never deliver its title');
    assert(privateRealm.result.status !== 200 || privateRealm.attempts > 1,
      'The changed Realm summary must replay or return a typed refusal');

    // The redirect is a committed Work merge: a reviewed editorial proposal the
    // product applies through its ordered owner stages. Both the summary request
    // and the concurrent unrelated edit then use the product API. The merged
    // source is a fresh public Work: the title control on `shown` makes the
    // graph command refuse any later write to that Work, a merge included.
    const mergedSource = await seedPublicProfileWork(api, `merged-source:${randomUUID()}`, {
      actingSubject: actor, title: `${prefix} merged source Work`, body: 'The merged source words',
    });
    const reviewer = { member: await home.member('Concurrent merge reviewer'), actor: '' };
    const decider = { member: await home.member('Concurrent merge decider'), actor: '' };
    reviewer.actor = await home.provision('Concurrent merge reviewer', reviewer.member.token);
    decider.actor = await home.provision('Concurrent merge decider', decider.member.token);
    const mergeWorks = [mergedSource.work, unrelatedPublic.work];
    const holders = [{ principalId: home.author.principalId, actor },
      { principalId: reviewer.member.principalId, actor: reviewer.actor },
      { principalId: decider.member.principalId, actor: decider.actor }];
    for (const holder of holders) {
      await grant('editorial:review:urn:rezics:context:global', 'work.review', holder);
      for (const work of mergeWorks) {
        await grant(`work:read:${work}`, 'work.read', holder);
        await grant(`work:edit:${work}`, 'work.edit', holder);
      }
    }
    // Heads come from the graph, which is what the proposal pins.
    const headRows = (await home.stack.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/> SELECT ?work ?head WHERE {
      GRAPH <urn:rezics:graph:current> { VALUES ?work { ${mergeWorks.map(work => `<${work}>`).join(' ')} } ?work rv:head ?head } }`))
      .results!.bindings;
    const heads = headRows.map(row => ({ component: row.work!.value, head: row.head!.value }));
    assert.equal(heads.length, mergeWorks.length, 'Both merged Works must have a current head');
    const pinned = (work: string) => ({ resource: work, revision: heads.find(head => head.component === work)!.head });
    const mergeEvidence = [{ ...pinned(mergedSource.work), locator: 'matching title and grain' }];
    const proposalPath = (id: string, suffix = '') => `/v1/editorial/proposals/${id}${suffix}`;
    const proposed = await home.json<{ proposal: string }>(await home.call('POST', '/v1/editorial/proposals', {
      profile: 'editorial-proposal-create-v1', kind: 'merge', target: { ...pinned(mergedSource.work), context: 'urn:rezics:context:global' },
      candidate: { operation: 'merge', source: pinned(mergedSource.work), survivor: pinned(unrelatedPublic.work), evidence: mergeEvidence },
      evidence: mergeEvidence, actingSubject: actor, baseHeads: heads }, home.author.token), 201);
    await home.json(await home.call('POST', proposalPath(proposed.proposal, '/reviews'), {
      profile: 'editorial-proposal-review-v1', revision: 1, outcome: 'approve',
      message: 'Checked the matching identities', actingSubject: reviewer.actor }, reviewer.member.token));
    const decisionKey = randomUUID();
    for (let attempt = 0; ; attempt++) {
      if (attempt === 16) throw new Error('Bounded native merge stages did not finish');
      const response = await home.call('POST', proposalPath(proposed.proposal, '/decisions'), {
        profile: 'editorial-proposal-decide-v1', revision: 1, outcome: 'applied', approve: true,
        message: 'Apply reviewed merge', actingSubject: decider.actor }, decider.member.token, decisionKey);
      if (response.status === 200) break;
      await home.json(response, 202);
    }
    const mergedSummary = { resources: [mergedSource.work], phase: 'survivor' as const, survivor: unrelatedPublic.work };
    const mergedBaseline = await measure('/v1/resources/summaries', undefined, undefined, undefined, mergedSummary);
    const mergedRace = await measure('/v1/resources/summaries', () => scalarEdit(unrelated[0]!, unrelated[0]!.next),
      undefined, undefined, mergedSummary);
    assert.equal(mergedBaseline.result.status, 200, JSON.stringify(mergedBaseline.result.body));
    assert.equal(mergedRace.result.status, 200, JSON.stringify(mergedRace.result.body));
    assert.equal(mergedRace.attempts, 1, 'Unrelated edits between source and survivor hydration must not replay');
    assert.deepEqual(displayed(mergedRace.result.body), displayed(mergedBaseline.result.body));
  } finally {
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'profiles.json'), JSON.stringify(evidence, null, 2) + '\n');
    WorkReadSession.prototype.fenceDependencies = originalFence;
    WorkReadSession.prototype.query = originalQuery;
    WorkReadSession.prototype.fenceAuthority = originalAuthority;
    home.stack.fuseki.commandWithReceipt = originalCommand;
    home.stack.fuseki.prefixWalk = originalPrefixWalk;
    home.stack.fuseki.query = originalGraphQuery;
    await home.stop();
    await shutdownTelemetry();
    await telemetryIngress.stop(true);
    await sink.stop();
  }
}

if (process.env.WORK_READ_CONCURRENT_PROFILE === '1') {
  await concurrentReadProfiles();
} else {
  test('shown-unit read fences ignore unrelated API writes at 0/8/32 and retain affected head, cover and Structure fences', async () => {
    if (!process.env.REZICS_QA_RUN_ID) throw new Error('Run through goalctl test');
    // Start the SDK before loading Main; another shard test may already own the process tracer.
    const child = Bun.spawn([process.execPath, import.meta.path], {
      env: { ...process.env, WORK_READ_CONCURRENT_PROFILE: '1' }, stdout: 'pipe', stderr: 'pipe',
    });
    const [exit, output, errors] = await Promise.all([child.exited,
      new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(exit, `${errors}\n${output.slice(-4000)}`).toBe(0);
  }, 600_000);
}
