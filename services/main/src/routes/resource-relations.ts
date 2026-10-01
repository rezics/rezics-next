import { Elysia, t } from 'elysia';
import { fusekiReadBudget, type FusekiClient } from '../infrastructure/fuseki.ts';
import { pendingOperation, problemResult } from '../api-contract.ts';
import { authorizedReadProblems, writeProblems } from '../api-responses.ts';
import { readDefinitionByKey, readExactDefinition } from '../modules/relation/change.ts';
import { readResourceRelations, RELATION_PAGE_COST } from '../modules/relation/traversal.ts';
import { referenceReader } from '../modules/semantic/admitted.ts';
import { WorkReadInvalid } from '../modules/work/read-session.ts';
import { workReadError } from './work-reads.ts';
import { SemanticChangeRejected, SemanticTargetUnavailable, StaleSemanticHead } from '../modules/semantic/command.ts';
import { readResourceSummaries } from '../modules/media/summary.ts';
import { DEFAULT_MEDIA_CONTEXT } from '../modules/media/store.ts';
import { readerLanguages } from '../modules/display-language/select.ts';
import { assertGraphAdmissionOpen } from '../modules/work/restore-lineage.ts';
import { createAdmittedWorkDerivation, type WorkDerivationInput } from '../modules/work/derivations.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { groupUuid } from './shared.ts';
import { problem } from './problems.ts';
import { semanticError } from './semantic.ts';
import { relationRenderingSchema } from './lexicon.ts';
import { resourceSummary } from '../modules/media/summary-contract.ts';
import { readingPositionQuery } from './reading-positions.ts';
import { readingPositionRead } from '../modules/reading-position/read.ts';
import { discloseInventory } from '../modules/disclosure/read.ts';
import { disclosureViewer } from '../modules/disclosure/viewer.ts';

const native = t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' });
const position = t.Object({ datasetId: t.Literal('product'), dataEpoch: t.String(), sequence: t.String() });
const receipt = t.Object({ profile: t.Literal('work-derivation-v2'), derivation: native, receipt: t.String(),
  sourcePosition: position, replayed: t.Boolean() });
const entry = t.Object({ relation: native, kind: t.Union([t.Literal('occurrence'), t.Literal('derivation'), t.Literal('collection')]),
  revision: t.Nullable(native), evidence: t.Nullable(t.String()),
  sourceVersionStatus: t.Optional(t.Union([t.Literal('exact'), t.Literal('unresolved')])),
  sourceMainVersion: t.Optional(t.Nullable(native)), sourceMainRevision: t.Optional(t.Nullable(native)),
  targetMainRevision: t.Optional(native), rendering: t.Nullable(relationRenderingSchema), counterparts: t.Array(resourceSummary) });

export const openApiOperations = {
  '/v1/resources/{resource}/relations': { get: { bearer: false } },
  '/v1/resources/{resource}/derivations': { post: { bearer: true, idempotencyKey: true } },
} as const;

export function resourceRelationRoutes(fuseki: FusekiClient, work: MainWorkDependencies) {
  return new Elysia()
    .post('/v1/resources/:resource/derivations', {
      params: t.Object({ resource: groupUuid }),
      body: t.Object({ profile: t.Literal('work-derivation-v2'), targetMainVersion: native, expectedTargetHead: native,
        sourceWork: native, sourceMainVersion: t.Nullable(native), sourceMainRevision: t.Nullable(native),
        kind: t.String({ maxLength: 128 }), evidence: t.String({ maxLength: 2048 }), actingSubject: native,
        corrects: t.Optional(native) }, { additionalProperties: false }),
      response: { 200: receipt, 201: receipt, 202: pendingOperation, ...writeProblems,
        404: problemResult(404), 422: problemResult(422) },
    }, async ({ request, params, body }) => {
      const key = request.headers.get('idempotency-key');
      if (!key || !/^[A-Za-z0-9:_./-]{1,128}$/.test(key)) return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key header is required');
      try {
        await assertGraphAdmissionOpen(fuseki, work.environment.lineage);
        const principal = await work.account.verify(request, ['work:edit']);
        const targetWork = `https://rezics.com/id/${params.resource}`;
        const canRead = referenceReader(work.access, principal, body.actingSubject);
        if (!await work.access.canReadWork(principal, body.actingSubject, targetWork)
          || !await work.access.canReadWork(principal, body.actingSubject, body.sourceWork)) {
          throw new SemanticTargetUnavailable('Work is unavailable');
        }
        const meaning = body.kind.startsWith('https://') ? await readExactDefinition(work.environment, body.kind, canRead)
          : await readDefinitionByKey(work.environment, body.kind, canRead);
        if (!meaning || !await canRead(meaning.definition)) throw new SemanticTargetUnavailable('derivation kind is unavailable');
        if (!meaning.workSubjectRole || meaning.workSubjectRole === 'source'
          || meaning.roles.length !== 2 || !Object.values(meaning.roleKeys).includes('source')) {
          throw new SemanticChangeRejected('invalid', 'derivation kind requires a source and subject role');
        }
        const result = await createAdmittedWorkDerivation(work.environment, work.account, work.access, request,
          { ...body, targetWork, kind: meaning.revision as WorkDerivationInput['kind'], idempotencyKey: key });
        return Response.json({ profile: 'work-derivation-v2', derivation: result.derivation, receipt: result.receipt,
          sourcePosition: { datasetId: 'product', dataEpoch: result.dataEpoch, sequence: result.sequence }, replayed: result.replayed },
        { status: result.replayed ? 200 : 201, headers: { 'cache-control': 'no-store' } });
      } catch (error) { return semanticError(error); }
    })
    .get('/v1/resources/:resource/relations', {
      params: t.Object({ resource: groupUuid }),
      query: t.Object({ actingSubject: t.Optional(native), position: readingPositionQuery, languages: t.Optional(t.String({ maxLength: 8192 })),
        limit: t.Optional(t.Integer({ minimum: 1, maximum: RELATION_PAGE_COST.pageLimit })),
        after: t.Optional(t.String({ maxLength: 2048 })) }, { additionalProperties: false }),
      response: { 200: t.Object({ profile: t.Literal('resource-relations-v1'), resource: native,
        items: t.Array(entry), next: t.Nullable(t.String()), sourcePosition: position }), ...authorizedReadProblems,
        409: problemResult(409) },
    }, async ({ request, params, query }) => {
      try {
        await assertGraphAdmissionOpen(fuseki, work.environment.lineage);
        if (request.headers.has('authorization') && !query.actingSubject) {
          throw new WorkReadInvalid('actingSubject is required for authenticated reads');
        }
        const principal = request.headers.has('authorization')
          ? await work.account.verify(request, ['work:read']) : null;
        const actor = principal ? query.actingSubject! : null;
        const page = await readingPositionRead(work, request, principal, actor ?? undefined, async boundary => {
          const visibility = (refs: readonly string[]) => boundary.visible(refs);
          const canReadSemantic = (ref: string) => work.access.canReadSemanticResource?.(
            principal, actor, ref, undefined, fuseki) ?? Promise.resolve(false);
          const reader = {
            viewer: disclosureViewer(principal),
            visibleRecords: visibility,
            canReadWork: principal && actor ? (ref: string) => work.access.canReadWork(principal, actor, ref) : undefined,
            canReadSemantic,
            ...(work.governance?.store ? { restrictedTitles: work.governance.store.restrictedTitles.bind(work.governance.store) } : {}),
          };
          const languages = readerLanguages(query.languages, request.headers.get('accept-language'));
          const summarize = async (resources: string[]) => (await readResourceSummaries(work.environment,
            work.media?.store, reader, { resources, context: DEFAULT_MEDIA_CONTEXT,
              language: null, languages, includeCollections: true })).summaries;
          const result = await fusekiReadBudget.run({ signal: AbortSignal.any([request.signal,
            AbortSignal.timeout(RELATION_PAGE_COST.deadlineMs)]), callsLeft: RELATION_PAGE_COST.graphCalls,
            bytesLeft: RELATION_PAGE_COST.graphBytes }, async () => readResourceRelations(work.environment, {
            resource: `https://rezics.com/id/${params.resource}`, languages, limit: query.limit ?? 20, after: query.after,
            canRead: async ref => (await canReadSemantic(ref)
              || (await summarize([ref]))[0]?.status === 'available')
              && (await discloseInventory(work.environment, [{ owner: 'graph', resource: ref,
                component: 'record' }], reader.viewer, 'read'))[0] === 'visible'
              && (await visibility([ref])).has(ref),
            canReadOccurrence: canReadSemantic,
            canReadDraftPresentations: async definition => {
              if (!principal || !actor || !work.mediaAccess) return false;
              const disclosure = await work.mediaAccess.canReadSemantics(principal, actor, [definition], fuseki);
              return 'granted' in disclosure && disclosure.granted.has(definition);
            }, summarize,
            visibleRecords: visibility,
            readingPosition: JSON.stringify([principal, actor, await boundary.binding()]),
          }));
          return result;
        });
        return Response.json(page, { headers: { 'cache-control': 'no-store' } });
      } catch (error) {
        if (error instanceof SemanticChangeRejected || error instanceof SemanticTargetUnavailable
          || error instanceof StaleSemanticHead) return semanticError(error);
        return workReadError(error);
      }
    });
}
