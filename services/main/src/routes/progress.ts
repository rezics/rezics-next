import { workRead, decodeReadCursor, encodeReadCursor } from '../modules/work/read-session.ts';
import { resolveTargets } from '../modules/target/resolve.ts';
import { Elysia, t } from 'elysia';
import type { FusekiClient } from '../infrastructure/fuseki.ts';
import { ObjectIntegrityError, ObjectUnavailable } from '../infrastructure/immutable-objects.ts';
import { InvalidStructureProgress, StaleStructureProgress, StructureProgressConflict, STRUCTURE_PROGRESS_COST,
  type ProgressPageKey }
  from '../modules/progress/store.ts';
import { CompositionCorrupt, CompositionUnavailable, readCompositionHeader,
  readPublishedVariants } from '../modules/structure/graph.ts';
import { readCompositionPage } from '../modules/structure/read.ts';
import { canReadCompositionWork, compositionTargetReader } from '../modules/composition/disclosure-read.ts';
import { structureProfileFor } from '../modules/structure/profiles.ts';
import { StructureObjectCorrupt, StructureObjectUnavailable } from '../modules/structure/tree.ts';
import { assertGraphAdmissionOpen } from '../modules/work/restore-lineage.ts';
import { problemResult } from '../api-contract.ts';
import { authorizedReadProblems } from '../api-responses.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { commandError, problem } from './problems.ts';
import { groupUuid } from './shared.ts';
import { workReadError, workReadProblems } from './work-reads.ts';
import { pageFields } from '../modules/work/read-contract.ts';

const ref = t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' });
const contentRevision = t.String({ pattern: '^urn:rezics:content:revision:[0-9a-f-]{36}$' });
const result = t.Object({ structure: ref, occurrence: ref, selectedRevision: t.Nullable(contentRevision),
  completed: t.Boolean(), position: t.Nullable(t.String()), version: t.Integer(),
  replayed: t.Optional(t.Boolean()) });

export const openApiOperations = {
  '/v1/compositions/{id}/progress': {
    get: { exposure: 'public', rateLimitFamily: 'read', bearer: true },
  },
  '/v1/compositions/{id}/occurrences/{occurrence}/progress': {
    get: { exposure: 'public', rateLimitFamily: 'read', bearer: true }, put: { exposure: 'public', rateLimitFamily: 'write', bearer: true, idempotencyKey: true },
  },
} as const;

function failure(error: unknown): Response {
  if (error instanceof InvalidStructureProgress) return problem(400, 'invalid_progress', error.message);
  if (error instanceof StaleStructureProgress) return problem(409, 'stale_progress', error.message);
  if (error instanceof StructureProgressConflict) return problem(409, 'progress_conflict', error.message);
  if (error instanceof CompositionUnavailable) return problem(404, 'occurrence_unavailable',
    'Occurrence is unavailable');
  if (error instanceof CompositionCorrupt || error instanceof StructureObjectCorrupt
    || error instanceof StructureObjectUnavailable
    || error instanceof ObjectUnavailable || error instanceof ObjectIntegrityError) {
    return problem(503, 'occurrence_unavailable', 'Occurrence history is unavailable');
  }
  return commandError(error);
}

/** Reader-private progress follows the stable occurrence, including its tombstone. */
export function progressRoutes(fuseki: FusekiClient, work: MainWorkDependencies) {
  if (work.structureObjects) {
    (work.environment as typeof work.environment & { structureObjects?: typeof work.structureObjects })
      .structureObjects = work.structureObjects;
  }
  const visibleOccurrence = async (request: Request, structure: string, occurrence: string,
    actingSubject: string, selectedRevision: string | null, write = false) => {
    await assertGraphAdmissionOpen(fuseki, work.environment.lineage);
    const principal = await work.account.verify(request, write ? ['work:read', 'library:write'] : ['work:read']);
    const header = await readCompositionHeader(work.environment, structure);
    if (!header || !structureProfileFor(header.profile).componentPredicate) {
      throw new CompositionUnavailable('composition is unavailable');
    }
    const profile = structureProfileFor(header.profile);
    const page = await workRead(work, request, { actingSubject }, async session => {
      if (!await canReadCompositionWork(session, header.work)) {
        throw new CompositionUnavailable('composition is unavailable');
      }
      return readCompositionPage(work.environment, { structure, occurrence, limit: 1,
        canReadTarget: compositionTargetReader(session, profile) });
    });
    const record = page.occurrences[0];
    if (!record || !profile.targetRoles.includes(record.role) || !record.target) {
      throw new CompositionUnavailable('target occurrence is unavailable');
    }
    if (selectedRevision) {
      const selected = record.selection?.mode === 'fixed-revision'
        ? record.selection.revision === selectedRevision
        : record.selection?.mode === 'follow-context'
          && (await readPublishedVariants(work.environment, [record.target]))
            .some(variant => variant.revision === selectedRevision);
      if (!selected) throw new CompositionUnavailable('selected Content revision is unavailable');
    }
    const canonical = await workRead(work, request, { actingSubject }, async session =>
      (await resolveTargets(session, [header.work], 'discussion'))[0]!.resource);
    return { principal, work: canonical };
  };
  return new Elysia()
    .get('/v1/compositions/:id/progress', {
      params: t.Object({ id: groupUuid }),
      query: t.Object({ actingSubject: ref, cursor: t.Optional(t.String({ maxLength: 2048,
        description: 'Continue even an empty page while nextCursor is present. Private progress pages are live, ordered by occurrence and selected revision.' })),
        limit: t.Optional(t.Numeric({ minimum: 1, maximum: STRUCTURE_PROGRESS_COST.pageRows - 1,
          multipleOf: 1 })) }, { additionalProperties: false }),
      response: { 200: t.Object({ structure: ref,
        items: t.Array(t.Object({ ...result.properties, completed: t.Literal(true) }), {
          maxItems: STRUCTURE_PROGRESS_COST.pageRows - 1,
          description: 'This principal\'s completed selection-qualified occurrence states, including tombstones. Any completed selection marks its occurrence complete.' }), ...pageFields,
        consistency: t.Literal('live'), complete: t.Boolean(),
        cost: t.Object({ progressRows: t.Integer({ maximum: STRUCTURE_PROGRESS_COST.pageRows }) }) }),
      ...workReadProblems },
    }, async ({ request, params, query }) => {
      if (!work.progress) return problem(503, 'progress_unavailable', 'Progress owner is unavailable');
      try {
        const structure = `https://rezics.com/id/${params.id}`;
        // A bearer supplies the private owner key even when the parent is public.
        await work.account.verify(request, ['work:read']);
        const page = await workRead(work, request, { actingSubject: query.actingSubject }, async session => {
          const header = await readCompositionHeader(work.environment, structure);
          if (!header || !structureProfileFor(header.profile).componentPredicate
            || !await canReadCompositionWork(session, header.work)) {
            throw new CompositionUnavailable('composition is unavailable');
          }
          const binding = ['completed-occurrences-v1', structure,
            session.principal, query.actingSubject];
          const cursor = decodeReadCursor(query.cursor, binding, session.position);
          let after: ProgressPageKey | undefined;
          if (cursor) {
            try { after = JSON.parse(cursor.after) as ProgressPageKey; }
            catch { throw new InvalidStructureProgress('progress cursor is invalid'); }
            if (!after || typeof after.occurrence !== 'string'
              || !(after.selectedRevision === null || typeof after.selectedRevision === 'string')) {
              throw new InvalidStructureProgress('progress cursor is invalid');
            }
          }
          // These are the reader's saved occurrence keys, including tombstones;
          // no target, label or Content bytes are disclosed by this collection.
          const saved = await work.progress!.completedPage(session.principal!, structure, query.limit ?? 50, after);
          const nextCursor = saved.next ? encodeReadCursor(binding, session.position, JSON.stringify(saved.next)) : null;
          return { structure, items: saved.items, nextCursor, sourcePosition: session.position,
            count: { value: saved.items.length, kind: 'exact-page' as const, total: null },
            consistency: 'live' as const, complete: nextCursor === null,
            cost: { progressRows: (query.limit ?? 50) + 1 } };
        });
        return Response.json(page, { headers: { 'cache-control': 'private, no-store' } });
      } catch (error) {
        if (error instanceof InvalidStructureProgress || error instanceof CompositionUnavailable
          || error instanceof CompositionCorrupt || error instanceof StructureObjectCorrupt
          || error instanceof StructureObjectUnavailable) return failure(error);
        return workReadError(error);
      }
    })
    .get('/v1/compositions/:id/occurrences/:occurrence/progress', {
      params: t.Object({ id: groupUuid, occurrence: groupUuid }),
      query: t.Object({ actingSubject: ref, selectedRevision: t.Optional(contentRevision) },
        { additionalProperties: false }),
      response: { 200: result, ...authorizedReadProblems },
    }, async ({ request, params, query }) => {
      if (!work.progress) return problem(503, 'progress_unavailable', 'Progress owner is unavailable');
      try {
        const structure = `https://rezics.com/id/${params.id}`;
        const occurrence = `https://rezics.com/id/${params.occurrence}`;
        const visible = await visibleOccurrence(request, structure, occurrence,
          query.actingSubject, query.selectedRevision ?? null);
        const value = await work.progress.read(visible.principal, structure, occurrence,
          query.selectedRevision ?? null);
        return Response.json(value, { headers: { 'cache-control': 'private, no-store' } });
      } catch (error) { return failure(error); }
    })
    .put('/v1/compositions/:id/occurrences/:occurrence/progress', {
      params: t.Object({ id: groupUuid, occurrence: groupUuid }),
      body: t.Object({ actingSubject: ref, selectedRevision: t.Optional(contentRevision),
        expectedVersion: t.Integer({ minimum: 0 }), completed: t.Boolean(),
        position: t.Nullable(t.String({ minLength: 1, maxLength: 500 })) },
      { additionalProperties: false }),
      response: { 200: result, 400: problemResult(400), 401: problemResult(401),
        403: problemResult(403), 404: problemResult(404), 409: problemResult(409),
        500: problemResult(500), 503: problemResult(503) },
    }, async ({ request, params, body }) => {
      if (!work.progress) return problem(503, 'progress_unavailable', 'Progress owner is unavailable');
      const idempotencyKey = request.headers.get('idempotency-key');
      if (!idempotencyKey || !/^[A-Za-z0-9:_./-]{1,128}$/.test(idempotencyKey)) {
        return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key is required');
      }
      try {
        const structure = `https://rezics.com/id/${params.id}`;
        const occurrence = `https://rezics.com/id/${params.occurrence}`;
        const visible = await visibleOccurrence(request, structure, occurrence,
          body.actingSubject, body.selectedRevision ?? null, true);
        const value = await work.progress.write({ principal: visible.principal, structure, occurrence,
          library: { agent: body.actingSubject, work: visible.work },
          selectedRevision: body.selectedRevision ?? null, completed: body.completed,
          position: body.position, expectedVersion: body.expectedVersion, idempotencyKey });
        return Response.json(value, { headers: { 'cache-control': 'private, no-store' } });
      } catch (error) { return failure(error); }
    });
}
