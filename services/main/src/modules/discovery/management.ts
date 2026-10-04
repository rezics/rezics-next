import { Elysia, t } from 'elysia';
import type { MainWorkDependencies } from '../../routes/dependencies.ts';
import { problem } from '../../routes/problems.ts';
import { workReadError, workReadProblems } from '../../routes/work-reads.ts';
import {
  digest,
  RecommendationConflict,
  RecommendationDenied,
  RecommendationMissing,
  RecommendationRestart,
  RecommendationStale,
  RecommendationUnavailable,
  type ManageContext,
} from '../recommendation/derived-generation.ts';
import { readId, readUuid } from '../work/read-contract.ts';
import {
  workRead,
  WorkReadInvalid,
  WorkReadUnavailable,
  type WorkReadSession,
} from '../work/read-session.ts';
import { discoveryBasis, type DiscoveryBasis } from './contract.ts';
import { admitDiscoveryBasis, projectDiscoveryBatch } from './source.ts';
import type { DiscoveryGeneration } from './store.ts';

export function discoveryError(error: unknown): Response {
  if (error instanceof RecommendationDenied)
    return problem(403, 'discovery_denied', 'Discovery management is not granted');
  if (error instanceof RecommendationConflict)
    return problem(409, 'discovery_conflict', 'Discovery build or idempotency key conflicts');
  if (error instanceof RecommendationStale || error instanceof RecommendationRestart) {
    return problem(409, 'read_basis_changed', 'Restart from a current discovery generation');
  }
  if (error instanceof RecommendationMissing)
    return problem(404, 'discovery_unavailable', 'Resource is unavailable');
  if (error instanceof RecommendationUnavailable)
    return problem(503, 'discovery_unavailable', 'Discovery projection is unavailable');
  return workReadError(error);
}
const decimal = t.String({ pattern: '^(0|[1-9][0-9]{0,19})$' });
const viewSchema = t.Object({
  generation: readUuid,
  state: t.String(),
  checkpoint: t.String(),
  complete: t.Boolean(),
  works: decimal,
  activeHeadRevision: t.Nullable(decimal),
  replayed: t.Boolean(),
});
const view = (row: DiscoveryGeneration, replayed = false) => ({
  generation: row.generation_id,
  state: row.state,
  checkpoint: row.checkpoint,
  complete: row.complete,
  works: row.work_count,
  activeHeadRevision: row.active_head,
  replayed,
});
const noStore = { headers: { 'cache-control': 'private, no-store' } };
function key(request: Request, body: unknown) {
  const idempotencyKey = request.headers.get('idempotency-key');
  if (!idempotencyKey || idempotencyKey.length > 128 || idempotencyKey.includes('\0')) {
    throw new WorkReadInvalid('A bounded idempotency key is required');
  }
  return { idempotencyKey, requestDigest: digest(body) };
}
async function operator(
  work: MainWorkDependencies,
  request: Request,
  actingSubject: string,
): Promise<ManageContext> {
  // Own rebuilds use the same OAuth read scope as Mine. Shared generations also
  // require the Access recommendation-management grant in the storage boundary.
  return { principal: await work.account.verify(request, ['work:read']), actingSubject };
}
function sourceRead<T>(
  work: MainWorkDependencies,
  request: Request,
  operator: ManageContext,
  basis: DiscoveryBasis,
  operation: (session: WorkReadSession) => Promise<T>,
) {
  return workRead(
    work,
    new Request(request.url, { method: request.method }),
    { scope: basis.scope, realm: basis.realm ?? undefined },
    async (session) => {
      session.principal = operator.principal;
      return operation(session);
    },
  );
}
const detail: { security: Record<string, string[]>[] } = { security: [{ bearerAuth: [] }] };

export function discoveryManagementRoutes(work: MainWorkDependencies) {
  const owner = () => {
    if (!work.discovery) throw new WorkReadUnavailable('Discovery owner is unavailable');
    return work.discovery;
  };
  return new Elysia()
    .post(
      '/v1/discovery/generation-builds',
      {
        detail,
        body: t.Object(
          {
            profile: t.Literal('discovery-generation-build-v1'),
            actingSubject: readId,
            basis: discoveryBasis,
          },
          { additionalProperties: false },
        ),
        response: { 200: viewSchema, ...workReadProblems },
      },
      async ({ request, body }) => {
        try {
          const context = await operator(work, request, body.actingSubject);
          const receipt = key(request, body);
          const result = await sourceRead(work, request, context, body.basis, async (session) => {
            await admitDiscoveryBasis(session, body.basis);
            return owner().register(context, body.basis, session.position, receipt);
          });
          return Response.json(view(result, result.replayed), noStore);
        } catch (error) {
          return discoveryError(error);
        }
      },
    )
    .get(
      '/v1/discovery/generations/:generation',
      {
        detail,
        params: t.Object({ generation: readUuid }),
        query: t.Object({ actingSubject: readId }, { additionalProperties: false }),
        response: { 200: viewSchema, ...workReadProblems },
      },
      async ({ request, params, query }) => {
        try {
          return Response.json(
            view(
              await owner().view(
                await operator(work, request, query.actingSubject),
                params.generation,
              ),
            ),
            noStore,
          );
        } catch (error) {
          return discoveryError(error);
        }
      },
    )
    .post(
      '/v1/discovery/generations/:generation/advance',
      {
        detail,
        params: t.Object({ generation: readUuid }),
        body: t.Object(
          { actingSubject: readId, expectedCheckpoint: t.String({ maxLength: 128 }) },
          { additionalProperties: false },
        ),
        response: { 200: viewSchema, ...workReadProblems },
      },
      async ({ request, params, body }) => {
        try {
          const context = await operator(work, request, body.actingSubject);
          const { row, lease } = await owner().beginStep(
            context,
            params.generation,
            body.expectedCheckpoint,
          );
          const basis: DiscoveryBasis = {
            scope: row.scope,
            realm: row.realm,
            context: row.context,
          };
          const projected = await sourceRead(work, request, context, basis, async (session) => {
            if (
              row.source_epoch !== session.position.dataEpoch ||
              row.source_sequence !== session.position.sequence
            ) {
              throw new RecommendationRestart('Discovery graph changed');
            }
            return projectDiscoveryBatch(session, basis, row.checkpoint, {
              works: row.changed_works ?? undefined,
              sequence: row.source_sequence,
            });
          });
          const result = await owner().commitBatch(
            context,
            row.generation_id,
            lease,
            row.checkpoint,
            projected,
            { dataEpoch: row.source_epoch, sequence: row.source_sequence },
          );
          return Response.json(view(result), noStore);
        } catch (error) {
          return discoveryError(error);
        }
      },
    )
    .post(
      '/v1/discovery/generations/:generation/cancel',
      {
        detail,
        params: t.Object({ generation: readUuid }),
        body: t.Object({ actingSubject: readId }, { additionalProperties: false }),
        response: { 200: viewSchema, ...workReadProblems },
      },
      async ({ request, params, body }) => {
        try {
          return Response.json(
            view(
              await owner().cancel(
                await operator(work, request, body.actingSubject),
                params.generation,
              ),
            ),
            noStore,
          );
        } catch (error) {
          return discoveryError(error);
        }
      },
    )
    .post(
      '/v1/discovery/generation-activations',
      {
        detail,
        body: t.Object(
          {
            profile: t.Literal('discovery-generation-activation-v1'),
            actingSubject: readId,
            generation: readUuid,
            expectedHeadRevision: t.Nullable(decimal),
          },
          { additionalProperties: false },
        ),
        response: {
          200: t.Object({ generation: readUuid, headRevision: decimal, replayed: t.Boolean() }),
          ...workReadProblems,
        },
      },
      async ({ request, body }) => {
        try {
          const context = await operator(work, request, body.actingSubject);
          const receipt = key(request, body);
          const row = await owner().view(context, body.generation);
          const result = await sourceRead(
            work,
            request,
            context,
            { scope: row.scope, realm: row.realm, context: row.context },
            (session) =>
              owner().activate(
                context,
                body.generation,
                body.expectedHeadRevision,
                session.position,
                receipt,
              ),
          );
          if (result.outcome !== 'succeeded')
            return problem(
              409,
              'discovery_activation_conflict',
              'Generation is not ready or its head changed',
            );
          return Response.json(
            {
              generation: result.generation,
              headRevision: result.headRevision,
              replayed: result.replayed,
            },
            noStore,
          );
        } catch (error) {
          return discoveryError(error);
        }
      },
    );
}
