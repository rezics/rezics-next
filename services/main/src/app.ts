import { Elysia, ParseError, ValidationError, t } from 'elysia';
import { FusekiClient } from './infrastructure/fuseki.ts';
import { AdmissionConflict, AdmissionDenied, AdmissionUnavailable } from './modules/access/admission.ts';
import type { AccessAdmissionRegistry } from './modules/access/admission.ts';
import { AccountAssertionDenied, AccountAssertionUnavailable } from './modules/account/verify-assertion.ts';
import type { AccountAssertionVerifier } from './modules/account/verify-assertion.ts';
import { createAdmittedMetadataWork, PendingAdmittedWork } from './modules/work/create-admitted.ts';
import { editAdmittedMetadataWork } from './modules/work/edit-admitted.ts';
import { StaleWorkHead, WorkEditUnavailable } from './modules/work/edit.ts';
import { readExactWorkRevision, RevisionCorrupt, RevisionNotFound,
  RevisionUnavailable } from './modules/work/history.ts';
import { CancelledActivation, IdempotencyConflict, iri, type WorkActivationEnvironment } from './modules/work/activate.ts';

export interface MainWorkDependencies {
  environment: WorkActivationEnvironment;
  account: Pick<AccountAssertionVerifier, 'verify'>;
  access: Pick<AccessAdmissionRegistry, 'register' | 'claim' | 'recordGraphOutcome' | 'canReadWork'>;
}

function problem(status: number, code: string, title: string, headers?: HeadersInit): Response {
  return Response.json({ type: `https://rezics.com/problems/${code}`, title, status, code }, {
    status, headers: { 'content-type': 'application/problem+json', 'cache-control': 'no-store', ...headers },
  });
}

function commandError(error: unknown): Response {
  if (error instanceof PendingAdmittedWork) {
    return Response.json({ operationId: error.operationId, status: 'reconciling', phase: error.phase,
      result: null, retry: { allowed: true, afterMs: 1000 } }, {
      status: 202, headers: { 'cache-control': 'no-store', 'retry-after': '1' },
    });
  }
  if (error instanceof AccountAssertionDenied) {
    return problem(401, 'account_assertion_denied', 'Account assertion is invalid or inactive',
      { 'www-authenticate': 'Bearer' });
  }
  if (error instanceof AdmissionDenied) return problem(403, 'authority_denied', 'Authority is not admitted');
  if (error instanceof AdmissionConflict || error instanceof IdempotencyConflict) {
    return problem(409, 'idempotency_conflict', 'Idempotency key conflicts with an earlier request');
  }
  if (error instanceof CancelledActivation) return problem(409, 'operation_cancelled', 'Work operation was cancelled');
  if (error instanceof StaleWorkHead) return problem(409, 'stale_head', 'Expected Work revision is stale');
  if (error instanceof WorkEditUnavailable) return problem(404, 'work_unavailable', 'Work is unavailable');
  if (error instanceof RevisionNotFound) return problem(404, 'revision_unavailable', 'Revision is unavailable');
  if (error instanceof RevisionUnavailable || error instanceof RevisionCorrupt) {
    return problem(503, 'revision_unavailable', 'Committed revision bytes are unavailable');
  }
  if (error instanceof AccountAssertionUnavailable || error instanceof AdmissionUnavailable) {
    return problem(503, 'dependency_unavailable', 'A required authority service is unavailable',
      { 'retry-after': '1' });
  }
  return problem(503, 'dependency_unavailable', 'Work operation could not be completed', { 'retry-after': '1' });
}

export function createMainApp(fuseki: FusekiClient, work?: MainWorkDependencies) {
  const app = new Elysia()
    .error(({ error }) => {
      if (error instanceof ValidationError || error instanceof ParseError) {
        return problem(400, 'invalid_request', 'Request does not match the Work contract');
      }
      return problem(500, 'internal_error', 'Request could not be processed');
    })
    .get('/health/live', {
      response: t.Object({ status: t.Literal('ok') }),
    }, () => ({ status: 'ok' as const }))
    .get('/health/ready', {
      response: {
        200: t.Object({ status: t.Literal('ready') }),
        503: t.Object({ status: t.Literal('unavailable') }),
      },
    }, async ({ status }) => {
      try {
        const result = await fuseki.query('ASK {}');
        if (result.boolean !== true) throw new Error('unexpected Fuseki result');
        if (work) {
          const lineage = await fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
            ASK { GRAPH <urn:rezics:graph:control> {
              <urn:rezics:dataset:product> rv:dataEpoch ${JSON.stringify(work.environment.lineage.dataEpoch)} ;
                rv:routingEpoch ${JSON.stringify(work.environment.lineage.routingEpoch)} .
            } }`);
          if (lineage.boolean !== true) throw new Error('Main graph lineage differs');
        }
        return { status: 'ready' as const };
      } catch {
        return status(503, { status: 'unavailable' as const });
      }
    });
  if (work) {
    app.post('/v1/works', {
      body: t.Object({
        profile: t.Literal('metadata-only-v1'),
        title: t.String({ minLength: 1, maxLength: 200, pattern: '^[^\\u0000-\\u001f\\u007f]+$' }),
        actingSubject: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
      }, { additionalProperties: false }),
    }, async ({ request, body }) => {
      const idempotencyKey = request.headers.get('idempotency-key');
      if (!idempotencyKey || !/^[A-Za-z0-9:_./-]{1,128}$/.test(idempotencyKey)) {
        return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key header is required');
      }
      try {
        const receipt = await createAdmittedMetadataWork(work.environment, work.account, work.access,
          request, { title: body.title, actingSubject: body.actingSubject, idempotencyKey });
        return Response.json({ work: receipt.work, mainVersion: receipt.mainVersion,
          workRevision: receipt.workRevision, mainRevision: receipt.mainRevision,
          sourcePosition: { datasetId: 'product', dataEpoch: receipt.dataEpoch, sequence: receipt.sequence },
          replayed: receipt.replayed }, {
          status: receipt.replayed ? 200 : 201, headers: { 'cache-control': 'no-store' },
        });
      } catch (error) {
        return commandError(error);
      }
    });
    app.post('/v1/content-edits', {
      body: t.Object({
        profile: t.Literal('metadata-only-v1'),
        work: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
        expectedHead: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
        title: t.String({ minLength: 1, maxLength: 200, pattern: '^[^\\u0000-\\u001f\\u007f]+$' }),
        actingSubject: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
      }, { additionalProperties: false }),
    }, async ({ request, body }) => {
      const idempotencyKey = request.headers.get('idempotency-key');
      if (!idempotencyKey || !/^[A-Za-z0-9:_./-]{1,128}$/.test(idempotencyKey)) {
        return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key header is required');
      }
      try {
        const receipt = await editAdmittedMetadataWork(work.environment, work.account, work.access,
          request, { work: body.work, expectedHead: body.expectedHead, title: body.title,
            actingSubject: body.actingSubject, idempotencyKey });
        return Response.json({ work: receipt.work, revision: receipt.revision,
          predecessor: receipt.predecessor,
          sourcePosition: { datasetId: 'product', dataEpoch: receipt.dataEpoch, sequence: receipt.sequence },
          replayed: receipt.replayed }, {
          status: 200, headers: { 'cache-control': 'no-store' },
        });
      } catch (error) {
        return commandError(error);
      }
    });
    app.get('/v1/revisions/:revision', {
      params: t.Object({ revision: t.String({ pattern: '^[0-9a-f-]{36}$' }) }),
      query: t.Object({ actingSubject: t.String({
        pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$',
      }) }, { additionalProperties: false }),
    }, async ({ request, params, query }) => {
      try {
        const principal = await work.account.verify(request, ['work:read']);
        const revision = await readExactWorkRevision(work.environment,
          `https://rezics.com/id/${params.revision}`, async workId => {
            if (!await work.access.canReadWork(principal, query.actingSubject, workId)) return false;
            const current = await fuseki.query(`PREFIX schema: <https://schema.org/>
              ASK { GRAPH <urn:rezics:graph:current> { ${iri(workId)} a schema:CreativeWork } }`);
            return current.boolean === true;
          });
        return Response.json(revision, { headers: { 'cache-control': 'no-store' } });
      } catch (error) {
        return commandError(error);
      }
    });
  }
  return app;
}
