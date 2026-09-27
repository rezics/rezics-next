import { Elysia, t } from 'elysia';
import { websocket } from 'elysia/websocket';
import type { FusekiClient } from '../infrastructure/fuseki.ts';
import type { VerifiedPrincipal } from '../modules/access/admission.ts';
import { PrivateSearchConnection, privateSearchProblem, type PrivateSearchSocketDependencies }
  from '../modules/contribution/private-search-socket.ts';
import { queryPublicMainClassifiedPhrase, queryPublicMainPhrase, queryPublicRealmClassifiedPhrase,
  queryPublicRealmPhrase } from '../modules/work/search-public.ts';
import { InvalidSearchContinuation, pageCompletePublicRelation, SearchContinuationRestart }
  from '../modules/work/search-continuation.ts';
import { queryPublicRealmClassifiedRatedPhrase } from '../modules/work/search-joined.ts';
import { queryPublicMainTitleBody } from '../modules/work/search-multifield.ts';
import { queryPublicDisclosedFields } from '../modules/work/search-disclosed-fields.ts';
import { queryPublicGroupedStatementPhrase } from '../modules/work/search-grouped.ts';
import { referenceReader } from '../modules/semantic/admitted.ts';
import { DEFAULT_MEDIA_CONTEXT } from '../modules/media/store.ts';
import { withStableSearchSnapshot, SearchIndexUnavailable, type SearchAttemptDiagnostic }
  from '../modules/work/search-readiness.ts';
import { SearchSnapshotMoved } from '../modules/work/search-readiness.ts';
import { applyWorkSearchMutes } from '../modules/work/search-presentation.ts';
import type { ActivePresentationMute } from '../modules/presentation/realm-mutes.ts';
import { ContentProjectionUnavailable } from '../modules/content-publication/relay.ts';
import { queryPublicContentPhrase } from '../modules/content-publication/search.ts';
import { pageCompleteContentRelation } from '../modules/content-publication/search-continuation.ts';
import { checkJudgmentProtection } from '../modules/judgment/protection.ts';
import { PublicQueryBudgetExceeded, PublicQueryUnavailable } from '../modules/work/search-budget.ts';
import { problemResult, publicPhrasePageRequest, publicPhrasePageResult, publicQueryResult,
  unsupportedPublicSearchSelectors } from '../api-contract.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { commandError, problem } from './problems.ts';

const groupedNative = t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' });
const groupedReference = t.String({ pattern: '^https?://[^\\s<>"{}|\\\\^`]{1,2040}$' });
const groupedStatementRequest = t.Object({
  profile: t.Literal('public-grouped-statement-phrase-v1'),
  ...unsupportedPublicSearchSelectors,
  actingSubject: groupedNative,
  context: t.Object({ kind: t.Literal('realm-local'), id: groupedNative }, { additionalProperties: false }),
  phrase: t.String({ minLength: 2, maxLength: 80 }),
  language: t.String({ minLength: 2, maxLength: 35,
    pattern: '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$' }),
  relation: t.Object({ definition: groupedNative,
    workRole: t.String({ pattern: '^[A-Za-z][A-Za-z0-9_-]{0,31}$' }),
    participantRole: t.String({ pattern: '^[A-Za-z][A-Za-z0-9_-]{0,31}$' }) },
  { additionalProperties: false }),
  conditions: t.Array(t.Object({ predicate: groupedReference, relationDefinition: groupedReference,
    value: groupedNative, context: groupedNative, semanticRevision: groupedNative,
    applicability: t.Array(groupedNative, { maxItems: 8 }) }, { additionalProperties: false }),
  { minItems: 1, maxItems: 2 }),
  countGrain: t.Union([t.Literal('work'), t.Literal('participant'), t.Literal('occurrence'),
    t.Literal('qualifiedFact'), t.Literal('supportingStatement')]),
  facetMode: t.Optional(t.Union([t.Literal('fully-filtered'), t.Literal('self-filter-excluding')])),
  rating: t.Optional(t.Object({ context: groupedNative,
    minimumMeanTimes10: t.Integer({ minimum: 10, maximum: 100 }) },
  { additionalProperties: false })),
}, { additionalProperties: false });

function logLoadSearchFailure(profile: string, error: unknown,
  diagnostics: SearchAttemptDiagnostic[] | undefined): void {
  if (!process.env.REZICS_LOAD_RUN_ID || !(error instanceof SearchIndexUnavailable)) return;
  console.error(JSON.stringify({ event: 'load-search-failure', profile,
    error: error.constructor.name, message: error.message,
    cause: error.cause instanceof Error ? { error: error.cause.constructor.name,
      message: error.cause.message } : undefined,
    attempts: diagnostics }));
}

function unsupportedSearchSelection(body: { sourcePolicy?: unknown; asOf?: unknown }) {
  if (body.sourcePolicy !== undefined) {
    return problem(422, 'search_source_policy_unsupported',
      'Multi-dataset public search is unsupported');
  }
  if (body.asOf !== undefined) {
    return problem(422, 'historical_search_unsupported',
      'Historical public search is unsupported');
  }
  return null;
}

/** Badge checks use the exact supporting Statement and its decision population.
 * The bounded relation and the request deadline also bound Access hydration. */
export async function protectClassifiedResults<T extends { total: number; results: Array<{ classification: {
  meaningKey?: string; concept?: string; supportingStatements?: string[];
  supportingStatementCount?: number; source: string } }> }>(work: SearchRouteDependencies, relation: T,
  realm?: string) {
  const targets = new Map<string, { support: string; concept: string;
    context: { kind: 'global' } | { kind: 'realm'; realm: string } }>();
  for (const match of relation.results) {
    const classification = match.classification;
    if (!classification.meaningKey) continue; // pre-cutover direct classification
    if (!classification.concept || !classification.supportingStatements?.length) {
      throw new PublicQueryUnavailable('classified search has no exact support');
    }
    if (classification.source === 'local' && !realm) {
      throw new PublicQueryUnavailable('local decision has no Realm judgment population');
    }
    const context = classification.source === 'local' && realm
      ? { kind: 'realm' as const, realm } : { kind: 'global' as const };
    for (const support of classification.supportingStatements) {
      targets.set(`${support}\0${context.kind === 'realm' ? context.realm : 'global'}\0${classification.concept}`,
        { support, concept: classification.concept, context });
    }
  }
  if (targets.size > 512) throw new PublicQueryBudgetExceeded('judgment hydration exceeds support budget');
  if (targets.size && !work.judgments) {
    throw new PublicQueryUnavailable('Access judgment protection owner is unavailable');
  }
  const checked = new Map<string, Awaited<ReturnType<typeof checkJudgmentProtection>>>();
  const entries = [...targets];
  for (let offset = 0; offset < entries.length; offset += 16) {
    await Promise.all(entries.slice(offset, offset + 16).map(async ([key, target]) => {
      try {
        const badge = await checkJudgmentProtection(work.judgments!, target.support,
          target.context, target.concept);
        if (badge.statement !== target.support || badge.context.kind !== target.context.kind
          || (badge.context.kind === 'realm' && target.context.kind === 'realm'
            && badge.context.realm !== target.context.realm)) {
          throw new Error('judgment protection target differs');
        }
        checked.set(key, badge);
      } catch {
        throw new PublicQueryUnavailable('Access judgment protection check is unavailable');
      }
    }));
  }
  const visible = relation.results.flatMap(match => {
    const classification = match.classification;
    if (!classification.meaningKey) return [match];
    const contextKey = classification.source === 'local' && realm ? realm : 'global';
    const protectionChecks = classification.supportingStatements!.map(support => {
        const badge = checked.get(`${support}\0${contextKey}\0${classification.concept}`);
        if (!badge) throw new PublicQueryUnavailable('judgment protection check is incomplete');
        return badge;
      }).filter(badge => badge.protection === 'show-all');
    if (!protectionChecks.length) return [];
    return [{ ...match, classification: { ...classification,
      supportingStatements: protectionChecks.map(check => check.statement),
      supportingStatementCount: protectionChecks.length, protectionChecks } }];
  });
  return { ...relation, total: visible.length, results: visible };
}

/** Private delivery owners. A replica without them keeps the profile closed. */
export interface SearchRouteDependencies extends MainWorkDependencies {
  privateSearch?: PrivateSearchSocketDependencies;
}

export function searchRoutes(fuseki: FusekiClient, work: SearchRouteDependencies) {
  const principals = new WeakMap<Request, VerifiedPrincipal>();
  const connections = new Map<string, PrivateSearchConnection>();
  async function presentationSelection(request: Request) {
    if (!request.headers.has('authorization')) return null;
    const principal = await work.account.verify(request, ['work:read']);
    if (!work.accessPolicy) throw new PublicQueryUnavailable('Access mute owner is unavailable');
    const rows = await work.accessPolicy.interactions.listMutes(principal);
    const mutes: ActivePresentationMute[] = rows.map(row => ({
      targetKind: row.target_kind, target: row.target, match: row.match }));
    return { principal, rows, mutes, generation: JSON.stringify(rows) };
  }
  async function present<T extends { results: Array<{ contribution: string; reason?: string }>;
    total: number; context: 'main-version-default' | { kind: 'realm-local'; id: string };
    sourcePosition: { dataEpoch: string; sequence: string } }>(
    selection: Awaited<ReturnType<typeof presentationSelection>>, relation: T,
  ): Promise<T> {
    if (!selection) return relation;
    const owner = work.accessPolicy;
    if (!owner) throw new PublicQueryUnavailable('Access mute owner is unavailable');
    const filtered = await applyWorkSearchMutes(work.environment, relation, selection.mutes,
      (authors, realms) => owner.interactions.searchAuthorMemberships(authors, realms));
    const after = await owner.interactions.listMutes(selection.principal);
    if (JSON.stringify(after) !== selection.generation) {
      throw new SearchSnapshotMoved('Access mute selection changed during public search');
    }
    return filtered as T;
  }
  return new Elysia()
    .use(websocket({ sendPings: false }))
    .post('/v1/private-queries', {
      body: t.Object({ profile: t.Literal('private-contribution-phrase-v1'),
        contribution: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
        actingSubject: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
        phrase: t.String({ minLength: 2, maxLength: 80 }),
      }, { additionalProperties: false }),
      response: { 400: problemResult(400), 426: problemResult(426), 503: problemResult(503) },
    }, () => work.privateSearch
      // An HTTP response has no per-response receipt or cancellation in this
      // runtime; results travel only over the receipt-fenced socket below.
      ? problem(426, 'private_search_socket_required',
        'Private phrase results require the WebSocket operation', { upgrade: 'websocket' })
      : problem(503, 'private_search_unavailable', 'Private phrase delivery is unavailable'))
    // OpenAPI cannot describe this message protocol; the POST entry names it.
    .ws('/v1/private-queries', {
      detail: { hide: true },
      maxPayloadLength: 4_096,
      idleTimeout: 30,
      async beforeHandle({ request }) {
        if (!work.privateSearch) {
          return problem(503, 'private_search_unavailable', 'Private phrase delivery is unavailable');
        }
        try { principals.set(request, await work.account.verify(request, ['work:read'])); }
        catch (error) {
          const failure = privateSearchProblem(error);
          return problem(failure.status, failure.code, failure.title,
            failure.status === 401 ? { 'www-authenticate': 'Bearer' } : undefined);
        }
      },
      open(ws) {
        const principal = principals.get(ws.request);
        if (!work.privateSearch || !principal) return ws.close(4503, 'private_search_unavailable');
        connections.set(ws.id, new PrivateSearchConnection(work.environment, work.privateSearch,
          principal, { send: frame => ws.send(frame), close: (code, reason) => ws.close(code, reason),
            terminate: () => ws.terminate() }));
      },
      async message(ws, body) { await connections.get(ws.id)?.message(body); },
      async close(ws) {
        const connection = connections.get(ws.id);
        connections.delete(ws.id);
        await connection?.closed();
      },
    })
    .post('/v1/queries', {
      body: t.Union([groupedStatementRequest, t.Object({ profile: t.Literal('public-disclosed-fields-phrase-v1'),
        ...unsupportedPublicSearchSelectors,
        phrase: t.String({ minLength: 2, maxLength: 80 }),
        contexts: t.Array(t.String({ pattern: '^(https://rezics\\.com/id/[0-9a-f-]{36}|urn:rezics:semantic-context:global)$' }),
          { maxItems: 8 }),
        statements: t.Array(t.Object({ statement: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
          acceptance: t.Union([t.Object({ kind: t.Literal('global') }, { additionalProperties: false }),
            t.Object({ kind: t.Literal('realm'), realm: t.String({
              pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }) }, { additionalProperties: false })]),
        }, { additionalProperties: false }), { maxItems: 16 }),
        resources: t.Array(t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
          { maxItems: 32 }),
        mediaContext: t.Union([t.Literal(DEFAULT_MEDIA_CONTEXT),
          t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' })]),
        language: t.Union([t.String({ pattern: '^[a-z]{2,3}(-[A-Za-z0-9]{1,8})*$',
          maxLength: 35 }), t.Null()]),
      }, { additionalProperties: false }), t.Object({ profile: t.Literal('public-content-phrase-v1'),
        ...unsupportedPublicSearchSelectors,
        phrase: t.String({ minLength: 2, maxLength: 80 }),
        language: t.Union([
          t.String({ minLength: 2, maxLength: 35,
            pattern: '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$' }), t.Null(),
        ]) }, { additionalProperties: false }), t.Object({ profile: t.Literal('public-main-title-body-v1'),
        ...unsupportedPublicSearchSelectors,
        titleTerm: t.String({ minLength: 2, maxLength: 80 }),
        bodyTerm: t.String({ minLength: 2, maxLength: 80 }),
        language: t.Union([t.String({ minLength: 2, maxLength: 35,
          pattern: '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$' }), t.Null()]),
        author: t.Optional(t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' })),
      }, { additionalProperties: false }), t.Object({ profile: t.Literal('public-main-phrase-v1'),
        ...unsupportedPublicSearchSelectors,
        phrase: t.String({ minLength: 2, maxLength: 80 }),
        language: t.Union([
          t.String({ minLength: 2, maxLength: 35,
            pattern: '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$' }), t.Null(),
        ]), author: t.Optional(t.String({
          pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$',
        })) }, { additionalProperties: false }), t.Object({
        profile: t.Literal('public-realm-phrase-v1'),
        ...unsupportedPublicSearchSelectors,
        context: t.Object({ kind: t.Literal('realm-local'),
          id: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }) },
        { additionalProperties: false }),
        phrase: t.String({ minLength: 2, maxLength: 80 }),
        language: t.Union([
          t.String({ minLength: 2, maxLength: 35,
            pattern: '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$' }), t.Null(),
        ]), author: t.Optional(t.String({
          pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$',
        })) }, { additionalProperties: false }), t.Object({
        profile: t.Literal('public-main-classified-phrase-v1'),
        ...unsupportedPublicSearchSelectors,
        phrase: t.String({ minLength: 2, maxLength: 80 }),
        language: t.Union([
          t.String({ minLength: 2, maxLength: 35,
            pattern: '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$' }), t.Null(),
        ]),
        author: t.Optional(t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' })),
        sense: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
      }, { additionalProperties: false }), t.Object({
        profile: t.Literal('public-realm-classified-phrase-v1'),
        ...unsupportedPublicSearchSelectors,
        context: t.Object({ kind: t.Literal('realm-local'),
          id: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }) },
        { additionalProperties: false }),
        phrase: t.String({ minLength: 2, maxLength: 80 }),
        language: t.Union([
          t.String({ minLength: 2, maxLength: 35,
            pattern: '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$' }), t.Null(),
        ]),
        author: t.Optional(t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' })),
        sense: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
      }, { additionalProperties: false }), t.Object({
        profile: t.Literal('public-realm-classified-rated-phrase-v1'),
        ...unsupportedPublicSearchSelectors,
        context: t.Object({ kind: t.Literal('realm-local'),
          id: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }) },
        { additionalProperties: false }),
        phrase: t.String({ minLength: 2, maxLength: 80 }),
        language: t.Union([
          t.String({ minLength: 2, maxLength: 35,
            pattern: '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$' }), t.Null(),
        ]),
        author: t.Optional(t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' })),
        sense: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
        ratingContext: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
        minimumMeanTimes10: t.Integer({ minimum: 10, maximum: 100 }),
      }, { additionalProperties: false })]),
      response: { 200: publicQueryResult, 400: problemResult(400),
        404: problemResult(404), 422: problemResult(422),
        500: problemResult(500), 503: problemResult(503) },
    }, async ({ body, request }) => {
      const diagnostics: SearchAttemptDiagnostic[] | undefined = process.env.REZICS_LOAD_RUN_ID ? [] : undefined;
      try {
        const unsupported = unsupportedSearchSelection(body);
        if (unsupported) return unsupported;
        if (body.profile === 'public-content-phrase-v1' && !work.contentProjection) {
          return problem(503, 'content_projection_unavailable', 'Public Content projection is unavailable');
        }
        const result = await withStableSearchSnapshot(fuseki, async () => {
          if (body.profile === 'public-grouped-statement-phrase-v1') {
            if (!work.judgments || !work.access.canReadSemanticResource) {
              throw new PublicQueryUnavailable('grouped search admission owner is unavailable');
            }
            const selection = await presentationSelection(request);
            const principal = selection?.principal ?? await work.account.verify(request, ['work:read']);
            return queryPublicGroupedStatementPhrase(work.environment, work.judgments,
              referenceReader(work.access, principal, body.actingSubject), body,
              relation => present(selection, relation));
          }
          if (body.profile === 'public-disclosed-fields-phrase-v1') {
            if ((body.resources.length || body.statements.length)
              && (!work.media?.store || !work.governance?.store)) {
              throw new PublicQueryUnavailable('public resource disclosure owner is unavailable');
            }
            return queryPublicDisclosedFields(work.environment, work.media?.store, work.judgments,
              body, work.governance?.store
                ? (heads, context) => work.governance!.store.restrictedTitles(heads, context)
                : undefined);
          }
          if (body.profile === 'public-content-phrase-v1') {
            return queryPublicContentPhrase(work.environment, work.contentProjection!.content,
              work.contentProjection!.cursor, work.contentProjection!.consumer, body);
          }
          const selection = await presentationSelection(request);
          const relation = body.profile === 'public-main-title-body-v1'
            ? await queryPublicMainTitleBody(work.environment, body)
            : body.profile === 'public-realm-classified-rated-phrase-v1'
            ? await protectClassifiedResults(work,
              await queryPublicRealmClassifiedRatedPhrase(work.environment, body), body.context.id)
            : body.profile === 'public-realm-phrase-v1'
            ? await queryPublicRealmPhrase(work.environment, body)
            : body.profile === 'public-main-phrase-v1'
              ? await queryPublicMainPhrase(work.environment, body)
              : body.profile === 'public-realm-classified-phrase-v1'
                ? await protectClassifiedResults(work,
                  await queryPublicRealmClassifiedPhrase(work.environment, body), body.context.id)
                : await protectClassifiedResults(work,
                  await queryPublicMainClassifiedPhrase(work.environment, body));
          return present(selection, relation);
        }, undefined, diagnostics);
        return Response.json(result, {
          headers: { 'cache-control': 'no-store' },
        });
      } catch (error) {
        logLoadSearchFailure(body.profile, error, diagnostics);
        return commandError(error);
      }
    })
    .post('/v1/queries/page', {
      body: publicPhrasePageRequest,
      response: { 200: publicPhrasePageResult, 400: problemResult(400),
        404: problemResult(404), 409: problemResult(409), 422: problemResult(422),
        500: problemResult(500), 503: problemResult(503) },
    }, async ({ body, request }) => {
      const diagnostics: SearchAttemptDiagnostic[] | undefined = process.env.REZICS_LOAD_RUN_ID ? [] : undefined;
      try {
        const unsupported = unsupportedSearchSelection(body);
        if (unsupported) return unsupported;
        const page = await withStableSearchSnapshot(fuseki, async () => {
          if (body.profile === 'public-content-phrase-page-v1') {
            if (!work.contentProjection) {
              throw new ContentProjectionUnavailable('Public Content projection is unavailable');
            }
            const relation = await queryPublicContentPhrase(work.environment,
              work.contentProjection.content, work.contentProjection.cursor,
              work.contentProjection.consumer, body);
            return pageCompleteContentRelation(body, relation);
          }
          const selection = await presentationSelection(request);
          if (body.profile === 'public-main-phrase-page-v1') {
            const relation = await present(selection, await queryPublicMainPhrase(work.environment, body));
            return pageCompletePublicRelation(body, relation, Date.now(), selection?.generation);
          }
          if (body.profile === 'public-main-title-body-page-v1') {
            const relation = await present(selection, await queryPublicMainTitleBody(work.environment, body));
            return pageCompletePublicRelation(body, relation, Date.now(), selection?.generation);
          }
          if (body.profile === 'public-realm-phrase-page-v1') {
            const relation = await present(selection, await queryPublicRealmPhrase(work.environment, body));
            return pageCompletePublicRelation(body, relation, Date.now(), selection?.generation);
          }
          if (body.profile === 'public-main-classified-phrase-page-v1') {
            const relation = await present(selection, await protectClassifiedResults(work,
              await queryPublicMainClassifiedPhrase(work.environment, body)));
            return { ...pageCompletePublicRelation(body, relation, Date.now(), selection?.generation),
              classificationSense: relation.classificationSense };
          }
          if (body.profile === 'public-realm-classified-phrase-page-v1') {
            const relation = await present(selection, await protectClassifiedResults(work,
              await queryPublicRealmClassifiedPhrase(work.environment, body), body.context.id));
            return { ...pageCompletePublicRelation(body, relation, Date.now(), selection?.generation),
              classificationSense: relation.classificationSense };
          }
          const relation = await present(selection, await protectClassifiedResults(work,
            await queryPublicRealmClassifiedRatedPhrase(work.environment, body), body.context.id));
          return { ...pageCompletePublicRelation(body, relation, Date.now(), selection?.generation),
            classificationSense: relation.classificationSense,
            ratingCriterion: relation.ratingCriterion,
            ratingPopulation: relation.ratingPopulation };
        }, undefined, diagnostics);
        return Response.json(page, { headers: { 'cache-control': 'no-store' } });
      } catch (error) {
        if (error instanceof SearchContinuationRestart) {
          return problem(409, 'search_restart_required', 'Public search changed; restart at page one');
        }
        if (error instanceof InvalidSearchContinuation) {
          return problem(422, 'invalid_search_continuation', 'Public search continuation is invalid');
        }
        logLoadSearchFailure(body.profile, error, diagnostics);
        return commandError(error);
      }
    });
}
