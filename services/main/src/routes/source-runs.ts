import { Elysia, t } from 'elysia';
import { problemResult } from '../api-contract.ts';
import { authorizedReadProblems, writeProblems } from '../api-responses.ts';
import { GO_PROXY_ORIGIN, goProxyResponseLoader } from '../modules/package/go-live-mvs.ts';
import { GO_PROXY_CAPTURE_BYTES, GO_PROXY_LIVE_RUN, runGoProxyLive }
  from '../modules/package/go-refresh.ts';
import { SourceFeedStale } from '../modules/source/acquisition-feed.ts';
import { OPEN_LIBRARY_WORKS_RUN, SourceRunBusy, SourceRunConflict, SourceRunInvalid,
  SourceRunUnavailable } from '../modules/source/acquisition-run.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import type { VerifiedPrincipal } from '../modules/access/admission.ts';
import { AdmissionDenied, AdmissionUnavailable } from '../modules/access/admission.ts';
import { commandError, problem } from './problems.ts';
import { groupUuid } from './shared.ts';

export const openApiOperations = {
  '/v1/sources/acquisitions': { post: { bearer: true } },
  '/v1/sources/runs/{run}': { get: { bearer: true } },
  '/v1/sources/runs/{base}/drift/{candidate}': { get: { bearer: true } },
  '/v1/sources/feeds': { post: { bearer: true } },
  '/v1/sources/feeds/{feed}': { get: { bearer: true } },
  '/v1/sources/feeds/{feed}/baselines': { post: { bearer: true } },
  '/v1/sources/feeds/{feed}/windows': { post: { bearer: true } },
};

const nullableString = t.Nullable(t.String());
const surfaceOutcome = t.Union([t.Literal('qualified'), t.Literal('unqualified'), t.Literal('failed')]);
const runState = t.Union([t.Literal('running'), t.Literal('completed'), t.Literal('incomplete'),
  t.Literal('abandoned')]);

const worksRunBody = t.Object({ profile: t.Literal(OPEN_LIBRARY_WORKS_RUN),
  workIds: t.Array(t.String({ pattern: '^OL[1-9][0-9]{0,11}W$' }), { minItems: 1, maxItems: 8, uniqueItems: true }),
  editions: t.Boolean(), ratings: t.Boolean(), frontier: t.Boolean(),
  bookshelves: t.Optional(t.Boolean()) }, { additionalProperties: false });
const goLiveRunBody = t.Object({ profile: t.Literal(GO_PROXY_LIVE_RUN),
  mainModule: t.String({ minLength: 1, maxLength: GO_PROXY_CAPTURE_BYTES }) }, { additionalProperties: false });
const goLiveStatus = t.Union([t.Literal('solved'), t.Literal('incomplete-source-data'),
  t.Literal('unsupported-semantics'), t.Literal('budget-exhausted'), t.Literal('cancelled')]);
const goLiveModule = t.Object({ path: t.String(), version: t.String(), goVersion: nullableString,
  retracted: t.Nullable(t.Array(t.String())), update: nullableString, latest: nullableString });
const goLiveResolution = t.Object({ status: goLiveStatus, mainModule: nullableString, goDirective: nullableString,
  roots: t.Array(t.Object({ path: t.String(), version: t.String() })), buildList: t.Array(goLiveModule),
  loaded: t.Array(t.String()), missing: t.Array(t.String()), unsupportedClauses: t.Array(t.String()),
  ignoredClauses: t.Array(t.String()),
  budget: t.Nullable(t.Object({ kind: t.Union([t.Literal('fetches'), t.Literal('bytes'), t.Literal('modules'),
    t.Literal('rounds'), t.Literal('time')]), limit: t.Number(), used: t.Number() })),
  cost: t.Object({ fetches: t.Number(), bytes: t.Number(), modFiles: t.Number(), lists: t.Number(),
    graphRounds: t.Number(), graphVisits: t.Number() }) });
const runResult = t.Object({ profile: t.Literal('source-acquisition-run-v1'), run: t.String(),
  acquisitionProfile: t.String(), provider: t.String(), state: runState, createdAt: t.String(),
  surfaces: t.Array(t.Object({ surface: t.String(), required: t.Boolean(), captureLimit: t.Number(),
    retention: t.Object({ requested: t.String(), terms: t.String(), effective: t.String(), limited: t.Boolean(),
      termsReference: t.String() }),
    outcome: t.Nullable(t.Object({ outcome: surfaceOutcome, reason: t.String(), captureCount: t.Number(),
      captureSetDigest: nullableString, detail: t.Record(t.String(), t.Unknown()), settledAt: t.String() })),
    captures: t.Array(t.Object({ ordinal: t.Number(), role: t.String(), requestKey: t.String(),
      observation: t.String(), record: t.String(), namespace: t.String(), externalId: t.String(),
      sourceRevision: nullableString, retention: t.String(), byteDigest: nullableString,
      byteLength: t.Nullable(t.Number()), url: t.String(), fetchedAt: t.String() })) })),
  completion: t.Nullable(t.Object({ outcome: t.Union([t.Literal('completed'), t.Literal('incomplete'),
    t.Literal('abandoned')]), qualified: t.Number(), unqualified: t.Number(), failed: t.Number(),
  missing: t.Number(), completedAt: t.String() })) });
const goRunResponse = t.Object({ run: runResult, resolution: t.Nullable(goLiveResolution), replayed: t.Boolean() });

const driftResult = t.Object({ profile: t.Literal('source-run-drift-v1'), baseRun: t.String(),
  candidateRun: t.String(), acquisitionProfile: t.String(), mappingRevision: t.String(),
  surfaces: t.Array(t.Object({ surface: t.String(), grain: t.String(),
    status: t.Union([t.Literal('compared'), t.Literal('unavailable')]),
    base: t.Nullable(t.Object({ outcome: surfaceOutcome, reason: t.String() })),
    candidate: t.Nullable(t.Object({ outcome: surfaceOutcome, reason: t.String() })),
    itemsPaired: t.Number(), itemsAdded: t.Number(), itemsRemoved: t.Number(),
    fields: t.Array(t.Object({ field: t.String(), status: t.Union([t.Literal('added'), t.Literal('removed'),
      t.Literal('changed'), t.Literal('unchanged')]), baseItems: t.Number(), candidateItems: t.Number(),
    changedItems: t.Number(), disposition: t.String(), reason: t.String() })) })) });

const checkpoint = t.Object({ checkpoint: t.String(), seq: t.Number(), kind: t.String(), continuity: t.String(),
  from: t.String(), to: t.String(), itemCount: t.Number(), run: t.String(), observation: nullableString });
const feedResult = t.Object({ profile: t.Literal('source-feed-v1'), feed: t.String(), acquisitionProfile: t.String(),
  pageItems: t.Number(), head: t.Nullable(t.Object({ seq: t.Number(), position: t.String(), checkpoint: t.String(),
    resumeToken: nullableString })),
  openGaps: t.Array(t.Object({ checkpoint: t.String(), from: t.String(), to: t.String() })),
  recent: t.Array(checkpoint) });
const windowResult = t.Object({ profile: t.Literal('source-feed-window-v1'), feed: t.String(), run: t.String(),
  state: t.Union([t.Literal('committed'), t.Literal('failed'), t.Literal('stale-head')]), floor: nullableString,
  checkpoints: t.Array(checkpoint),
  changes: t.Array(t.Object({ position: t.String(), records: t.Array(t.String()) })) });

const runProblems = { ...writeProblems, 404: problemResult(404), 429: problemResult(429) };
const noStore = { 'cache-control': 'no-store' };
const RUN_IRI = /^https:\/\/rezics\.com\/id\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

function runError(error: unknown): Response {
  if (error instanceof SourceRunInvalid) return problem(400, 'invalid_source_run', 'Source run does not match its profile');
  if (error instanceof SourceRunConflict) return problem(409, 'idempotency_conflict', 'Source run key binds another intent');
  if (error instanceof SourceRunBusy) {
    return problem(409, 'source_run_in_progress', 'Source run is already executing', { 'retry-after': '1' });
  }
  if (error instanceof SourceFeedStale) return problem(409, 'source_feed_stale', 'Source feed state does not admit this step');
  if (error instanceof SourceRunUnavailable) return problem(503, 'source_run_unavailable', 'Source run evidence is unavailable');
  return commandError(error);
}

/** All Source import entry points require catalogue creation authority before
 * any provider fetch or owner write. Discovery's contributor baseline is excluded. */
export async function requireSourceImportAuthority(work: MainWorkDependencies, caller: VerifiedPrincipal) {
  if (!work.actingContexts || !work.access.hasNonBaselineWorkCreateAuthority) {
    throw new AdmissionUnavailable('Access discovery is unavailable');
  }
  const discovered = await work.actingContexts.discover(caller);
  for (const context of discovered.contexts) {
    if (await work.access.hasNonBaselineWorkCreateAuthority(caller, context.actingSubject)) return;
  }
  for (const context of discovered.directContexts) {
    if (await work.access.hasNonBaselineWorkCreateAuthority(caller, context.actingSubject, 'direct-principal')) return;
  }
  throw new AdmissionDenied('Source imports require catalogue creation authority');
}

/** General source acquisition runs, their field drift and dump/change feeds. */
export function sourceRunRoutes(work: MainWorkDependencies) {
  const principal = async (request: Request, scope: 'source:acquire' | 'source:read') => {
    const caller = await work.account.verify(request, [scope]);
    if (scope === 'source:acquire') await requireSourceImportAuthority(work, caller);
    return work.access.activePrincipalId(caller);
  };
  const unavailable = () => problem(503, 'source_run_unavailable', 'Source acquisition owner is unavailable');
  const inactive = () => problem(403, 'authority_denied', 'Source principal is inactive');
  return new Elysia()
    .post('/v1/sources/acquisitions', {
      body: t.Union([worksRunBody, goLiveRunBody]), response: { 200: t.Union([
        t.Object({ run: runResult, replayed: t.Boolean() }), goRunResponse ]),
        201: t.Union([t.Object({ run: runResult, replayed: t.Boolean() }), goRunResponse]), ...runProblems },
    }, async ({ request, body }) => {
      try {
        const services = work.sourceAcquisitions;
        if (!services) return unavailable();
        const key = request.headers.get('idempotency-key');
        if (!key) return problem(400, 'invalid_idempotency_key', 'Idempotency-Key is required');
        const caller = await work.account.verify(request, ['source:acquire']);
        const principalId = await work.access.activePrincipalId(caller);
        if (!principalId) return inactive();
        await requireSourceImportAuthority(work, caller);
        const result = body.profile === OPEN_LIBRARY_WORKS_RUN
          ? await services.runs.runOpenLibraryWorks(principalId, key, body)
          : await runGoProxyLive(services.runs, principalId, key, body,
            goProxyResponseLoader(GO_PROXY_ORIGIN, services.runs.fetcher, GO_PROXY_CAPTURE_BYTES));
        if (await work.access.activePrincipalId(caller) !== principalId) return inactive();
        await requireSourceImportAuthority(work, caller);
        return Response.json(result, { status: result.replayed ? 200 : 201, headers: noStore });
      } catch (error) { return runError(error); }
    })
    .get('/v1/sources/runs/:run', {
      params: t.Object({ run: groupUuid }), response: { 200: runResult, ...authorizedReadProblems },
    }, async ({ request, params }) => {
      try {
        const services = work.sourceAcquisitions;
        if (!services) return unavailable();
        const principalId = await principal(request, 'source:read');
        if (!principalId) return inactive();
        const run = await services.runs.read(principalId, params.run);
        if (!run) return problem(404, 'source_run_unavailable', 'Source run is unavailable');
        return Response.json(run, { headers: noStore });
      } catch (error) { return runError(error); }
    })
    .get('/v1/sources/runs/:base/drift/:candidate', {
      params: t.Object({ base: groupUuid, candidate: groupUuid }),
      response: { 200: driftResult, ...authorizedReadProblems, 409: problemResult(409) },
    }, async ({ request, params }) => {
      try {
        const services = work.sourceAcquisitions;
        if (!services) return unavailable();
        const principalId = await principal(request, 'source:read');
        if (!principalId) return inactive();
        const drift = await services.drift.compare(principalId, params.base, params.candidate);
        if (!drift) return problem(404, 'source_run_unavailable', 'Source run is unavailable');
        return Response.json(drift, { headers: noStore });
      } catch (error) { return runError(error); }
    })
    .post('/v1/sources/feeds', {
      body: t.Object({ profile: t.Literal('open-library-recent-changes-v1'),
        pageItems: t.Integer({ minimum: 1, maximum: 100 }) }, { additionalProperties: false }),
      response: { 200: t.Object({ feed: feedResult, created: t.Boolean() }),
        201: t.Object({ feed: feedResult, created: t.Boolean() }), ...runProblems },
    }, async ({ request, body }) => {
      try {
        const services = work.sourceAcquisitions;
        if (!services) return unavailable();
        const principalId = await principal(request, 'source:acquire');
        if (!principalId) return inactive();
        const result = await services.feeds.create(principalId, body.pageItems);
        return Response.json(result, { status: result.created ? 201 : 200, headers: noStore });
      } catch (error) { return runError(error); }
    })
    .get('/v1/sources/feeds/:feed', {
      params: t.Object({ feed: groupUuid }), response: { 200: feedResult, ...authorizedReadProblems },
    }, async ({ request, params }) => {
      try {
        const services = work.sourceAcquisitions;
        if (!services) return unavailable();
        const principalId = await principal(request, 'source:read');
        if (!principalId) return inactive();
        const feed = await services.feeds.read(principalId, params.feed);
        if (!feed) return problem(404, 'source_feed_unavailable', 'Source feed is unavailable');
        return Response.json(feed, { headers: noStore });
      } catch (error) { return runError(error); }
    })
    .post('/v1/sources/feeds/:feed/baselines', {
      params: t.Object({ feed: groupUuid }),
      body: t.Object({ profile: t.Literal('source-feed-baseline-v1'), run: t.String({ maxLength: 100 }) },
        { additionalProperties: false }),
      response: { 200: t.Object({ feed: feedResult, checkpoint, replayed: t.Boolean() }),
        201: t.Object({ feed: feedResult, checkpoint, replayed: t.Boolean() }), ...runProblems },
    }, async ({ request, params, body }) => {
      try {
        const services = work.sourceAcquisitions;
        if (!services) return unavailable();
        const run = RUN_IRI.exec(body.run)?.[1];
        if (!run) return problem(400, 'invalid_source_run', 'Baseline run must be an exact run identity');
        const principalId = await principal(request, 'source:acquire');
        if (!principalId) return inactive();
        const result = await services.feeds.baseline(principalId, params.feed, run);
        if (!result) return problem(404, 'source_feed_unavailable', 'Source feed or run is unavailable');
        return Response.json(result, { status: result.replayed ? 200 : 201, headers: noStore });
      } catch (error) { return runError(error); }
    })
    .post('/v1/sources/feeds/:feed/windows', {
      params: t.Object({ feed: groupUuid }),
      body: t.Object({ profile: t.Literal('source-feed-window-v1'), maxPages: t.Integer({ minimum: 1, maximum: 8 }) },
        { additionalProperties: false }),
      response: { 200: t.Object({ window: windowResult, replayed: t.Boolean() }),
        201: t.Object({ window: windowResult, replayed: t.Boolean() }), ...runProblems },
    }, async ({ request, params, body }) => {
      try {
        const services = work.sourceAcquisitions;
        if (!services) return unavailable();
        const key = request.headers.get('idempotency-key');
        if (!key) return problem(400, 'invalid_idempotency_key', 'Idempotency-Key is required');
        const principalId = await principal(request, 'source:acquire');
        if (!principalId) return inactive();
        const result = await services.feeds.advance(principalId, params.feed, key, body.maxPages);
        if (!result) return problem(404, 'source_feed_unavailable', 'Source feed is unavailable');
        return Response.json(result, { status: result.replayed ? 200 : 201, headers: noStore });
      } catch (error) { return runError(error); }
    });
}
