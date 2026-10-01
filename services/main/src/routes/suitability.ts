import { Elysia, t } from 'elysia';
import {
  ControlConflict,
  ControlDenied,
  ControlInvalid,
  ControlStale,
  ControlUnavailable,
} from '../modules/access/topology-control.ts';
import { command, commandResult, reads, readsResult } from '../modules/suitability/contract.ts';
import { eligible } from '../modules/suitability/policy.ts';
import { AccountAssertionInsufficientScope } from '../modules/account/verify-assertion.ts';
import type { VerifiedPrincipal } from '../modules/access/admission.ts';
import { resolveTargets, TargetNotBound, TargetUnavailable } from '../modules/target/resolve.ts';
import { readUuid } from '../modules/work/read-contract.ts';
import { workRead, WorkReadUnavailable } from '../modules/work/read-session.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { MODERATION_SCOPE } from './reports.ts';
import { problem } from './problems.ts';
import { workReadError, workReadProblems } from './work-reads.ts';

const headers = { 'cache-control': 'private, no-store' };
export const openApiOperations = {
  '/v1/suitability/{target}': { put: { bearer: true, idempotencyKey: true } },
  '/v1/suitability/reads': { post: { bearer: false } },
} as const;
function failure(error: unknown): Response {
  if (error instanceof ControlInvalid) return problem(400, 'invalid_suitability', error.message);
  if (error instanceof ControlDenied) return problem(403, 'suitability_denied', error.message);
  if (error instanceof ControlStale)
    return problem(409, 'suitability_revision_changed', error.message);
  if (error instanceof ControlConflict)
    return problem(409, 'suitability_key_conflict', error.message);
  if (error instanceof ControlUnavailable)
    return problem(503, 'suitability_unavailable', error.message);
  if (error instanceof TargetNotBound) return problem(422, error.code, error.message);
  if (error instanceof TargetUnavailable) return problem(404, error.code, error.message);
  return workReadError(error);
}

export function suitabilityRoutes(work: MainWorkDependencies) {
  return new Elysia()
    .put(
      '/v1/suitability/:target',
      {
        params: t.Object({ target: readUuid }),
        body: command,
        response: { 200: commandResult, ...workReadProblems },
      },
      async ({ request, params, body }) => {
        try {
          if (!work.suitability) throw new WorkReadUnavailable('Suitability owner is unavailable');
          const principal = await work.account.verify(request, [
            body.basis === 'platform' ? MODERATION_SCOPE : 'work:edit',
          ]);
          return Response.json(
            await work.suitability.writeCommand(
              principal,
              `https://rezics.com/id/${params.target}`,
              body,
              request.headers.get('idempotency-key') ?? '',
              work.environment,
            ),
            { headers },
          );
        } catch (error) {
          return failure(error);
        }
      },
    )
    .post(
      '/v1/suitability/reads',
      {
        body: reads,
        detail: { security: [{}, { bearerAuth: [] }] },
        response: { 200: readsResult, ...workReadProblems },
      },
      async ({ request, body }) => {
        try {
          if (!work.suitability) throw new WorkReadUnavailable('Suitability owner is unavailable');
          const result = await workRead(
            work,
            request,
            { actingSubject: body.actingSubject },
            async (session) => {
              const targets = await resolveTargets(session, body.targets, 'suitability');
              let moderator: { principal: VerifiedPrincipal; actingSubject: string } | undefined;
              if (session.principal && body.actingSubject) {
                try {
                  moderator = {
                    principal: await work.account.verify(request, [MODERATION_SCOPE]),
                    actingSubject: body.actingSubject,
                  };
                } catch (error) {
                  if (!(error instanceof AccountAssertionInsufficientScope)) throw error;
                }
              }
              const assessments = await work.suitability!.read(targets, moderator);
              const viewer = session.viewer;
              return {
                viewer: {
                  ...viewer,
                  optIns: {
                    ...viewer.optIns,
                    available: viewer.age !== 'unknown',
                    reason: viewer.age === 'unknown' ? 'age_unknown' : null,
                  },
                },
                items: targets.map((target, index) => {
                  const assessment = assessments[index]!;
                  return {
                    target,
                    assessment,
                    ...eligible({ assessment, viewer, channel: 'read' }),
                  };
                }),
              };
            },
          );
          return Response.json(result, { headers });
        } catch (error) {
          return failure(error);
        }
      },
    );
}
