import { expect, test } from 'bun:test';
import { Elysia, problem, t } from 'elysia';
import { Value } from 'typebox/value';
import { createMainApp } from '../src/app.ts';
import { FusekiClient } from '../src/infrastructure/fuseki.ts';
import { AccountAssertionDenied, AccountAssertionUnavailable } from '../src/modules/account/verify-assertion.ts';
import { AdmissionConflict, AdmissionControllerContinuity, AdmissionDenied, AdmissionLockBusy } from '../src/modules/access/admission.ts';
import { ActingContextDenied, ActingContextInvalid, ActingContextStale, ActingContextUnavailable } from '../src/modules/access/contexts.ts';
import { IdempotencyConflict } from '../src/modules/work/activate.ts';
import { PendingAdmittedWork } from '../src/modules/work/create-admitted.ts';
import { StaleWorkHead, WorkEditUnavailable } from '../src/modules/work/edit.ts';
import { RecoveryHold } from '../src/modules/work/restore-lineage.ts';
import { InvalidWorkScalarValue } from '../src/modules/work/scalar-value.ts';
import { RATE_LIMIT_V1 } from '../src/modules/rate-limit/budgets.ts';
import { rateLimitHook } from '../src/modules/rate-limit/hook.ts';
import { OperationsBackpressure } from '../src/operations/backpressure.ts';
import { operationsRoutes } from '../src/routes/operations.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import { workScalarModels, workScalarOperation } from '../src/routes/work-scalar.contract.ts';
import { actingContextPreferenceModels, actingContextPreferenceOperation } from '../src/routes/acting-context-preference.contract.ts';
import { workHeaderModels, workHeaderOperation } from '../src/routes/work-header.contract.ts';
import { operationPolicies } from '../src/routes/operation-policies.ts';
import { typedRefusal } from '../src/routes/problems.ts';
import { buildMainOpenApi } from '../../../scripts/api/generate.ts';
import { type ApiDocument, invariantFingerprints, normalized, pilotOperations } from '../../../scripts/api/native-contract-pilot.ts';
import baseline from './fixtures/native-contract-accepted-invariants.json';

import accepted from './fixtures/native-contract-accepted-invariants.json';
const id = '00000000-0000-4000-8000-000000000001';
const resource = `https://rezics.com/id/${id}`;
const preferenceBody = { profile: 'work-create-acting-context-preference-v1', task: 'work.create',
  actingSubject: null, expectedRevision: null, idempotencyKey: 'preference-proof' };
const scalarBody = { profile: 'work-scalar-state-v1', actingSubject: resource, expectedHead: resource };
const principal = { issuer: 'https://account.test', subject: 'reader', emailVerified: true };

// Generate once, but give each assertion/mutation its own resolved copy of the actual pilot contracts.
let generated: Promise<string> | undefined;
async function generatedContract() {
  generated ??= buildMainOpenApi().then(source => {
    const document = JSON.parse(source);
    return JSON.stringify({ paths: Object.fromEntries(pilotOperations.map(([method, path]) =>
      [path, { [method]: normalized(document.paths[path][method], document) }])) });
  });
  return JSON.parse(await generated);
}
function assertAcceptedContract(document: ApiDocument) {
  expect(JSON.stringify(invariantFingerprints(document))).toBe(JSON.stringify(accepted));
}
function headerResponse(document: Awaited<ReturnType<typeof generatedContract>>) {
  return document.paths['/v1/works/{id}'].get.responses['200'];
}
function headerSchema(document: Awaited<ReturnType<typeof generatedContract>>) {
  return headerResponse(document).content['application/json'].schema;
}

function fixture() {
  let fault: Error | undefined;
  let authFault: Error | undefined;
  let replayed = false;
  const verifications: string[][] = [];
  const choices: unknown[] = [];
  let charges = 0;
  let limited = false;
  const graph = { query: async () => ({ boolean: true }) } as unknown as FusekiClient;
  const work = {
    environment: { fuseki: graph, lineage: { dataEpoch: 'one', routingEpoch: 'one' } },
    account: { verify: async (_request: Request, scopes: string[]) => {
      verifications.push([...scopes]);
      if (authFault) throw authFault;
      return principal;
    } },
    access: { register: async () => { throw fault ?? new Error('unexpected dispatch'); } },
    actingContexts: { setPreference: async (_principal: unknown, input: unknown) => {
      choices.push(input);
      if (fault) throw fault;
      return { profile: preferenceBody.profile, task: 'work.create', actingSubject: null, revision: id, replayed };
    } },
    rateLimit: { budgets: RATE_LIMIT_V1, options: {}, store: {
      classify: async () => 'member', consume: async () => { charges++; return { allowed: !limited, retryAfter: 7 }; },
    } },
  } as unknown as MainWorkDependencies;
  const app = createMainApp(graph, work);
  const request = (path: string, method: string, body: unknown, headers?: Record<string, string>) =>
    app.handle(new Request(`http://main.test${path}`, { method,
      headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }));
  return { work, request, verifications, choices, charges: () => charges,
    fault: (error?: Error) => { fault = error; }, authFault: (error?: Error) => { authFault = error; },
    limit: () => { limited = true; },
    replay: () => { replayed = true; } };
}

test('native preference binding delegates current auth, preserves nullable choice/replay and charges once', async () => {
  const f = fixture();
  for (const replayed of [false, true]) {
    if (replayed) f.replay();
    const response = await f.request(actingContextPreferenceOperation.path, 'PUT', preferenceBody);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(await response.json()).toEqual({ profile: preferenceBody.profile, task: 'work.create',
      actingSubject: null, revision: id, replayed });
  }
  expect(f.verifications).toEqual([['work:create'], ['work:create']]);
  expect(f.choices).toEqual(Array.from({ length: 2 }, () => ({ actingSubject: null,
    expectedRevision: null, idempotencyKey: preferenceBody.idempotencyKey })));
  expect(f.charges()).toBe(2);
});

test('shared policy enforcement keeps public reads exempt and returns the write budget Problem once', async () => {
  const f = fixture();
  f.limit();
  const response = await f.request(actingContextPreferenceOperation.path, 'PUT', preferenceBody);
  expect(response.status).toBe(429);
  expect(response.headers.get('retry-after')).toBe('7');
  expect(await response.json()).toEqual({ type: 'about:blank', status: 429,
    code: 'rate_limited', title: 'Request budget exhausted', family: 'write' });
  expect(f.charges()).toBe(1);
  expect(f.verifications).toEqual([]);
  const app = new Elysia().use(rateLimitHook(f.work.account, f.work.rateLimit)).use(operationPolicies(f.work)).model(workHeaderModels)
    .get(workHeaderOperation.path, workHeaderOperation.options, () => problem(404, {
      code: 'work_unavailable', type: 'https://rezics.com/problems/work_unavailable', title: 'Resource is unavailable',
    }));
  const read = await app.handle(new Request(`http://main.test/v1/works/${id}`));
  expect(read.status).toBe(404);
  expect(f.charges()).toBe(1);
});

test('global backpressure refuses native validated commands before their handlers', async () => {
  for (const unavailable of [false, true]) {
    const f = fixture();
    let effects = 0;
    const budget = new OperationsBackpressure({ broker: async () => {
      if (unavailable) throw new Error('checkpoint unavailable');
      return { dataEpoch: 'one', head: 1000n, delivered: 0n };
    } });
    const app = new Elysia().onError(() => new Response('invalid refusal', { status: 500 }))
      .use(operationsRoutes(f.work, budget))
      .post('/v1/works', { response: { 503: t.Object({ type: t.String(), title: t.String(),
        status: t.Literal(503), code: t.Union([t.Literal('backpressure_saturated'),
          t.Literal('backpressure_unavailable')]) }, { additionalProperties: false }) } }, () => { effects++; });
    const response = await app.handle(new Request('http://main.test/v1/works', { method: 'POST' }));
    expect(response.status).toBe(503);
    expect(response.headers.get('content-type')).toContain('application/problem+json');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('retry-after')).toBe(unavailable ? null : '5');
    const code = unavailable ? 'backpressure_unavailable' : 'backpressure_saturated';
    expect(await response.json()).toEqual({ type: `https://rezics.com/problems/${code}`, status: 503,
      code, title: unavailable ? 'The broker budget cannot be observed' : 'The broker budget is saturated; retry later' });
    expect(effects).toBe(0);
  }
});

test('preference domain refusals keep their exact Problem identity, status and opaque fallback', async () => {
  const f = fixture();
  for (const [error, status, code] of [
    [new ActingContextInvalid(), 400, 'invalid_request'],
    [new ActingContextDenied(), 403, 'acting_context_denied'],
    [new ActingContextStale(), 409, 'stale_context'],
    [new ActingContextUnavailable(), 503, 'acting_context_unavailable'],
    [new Error('private storage details'), 503, 'dependency_unavailable'],
  ] as const) {
    f.fault(error);
    const response = await f.request(actingContextPreferenceOperation.path, 'PUT', preferenceBody);
    expect(response.status).toBe(status);
    expect(response.headers.get('content-type')).toContain('application/problem+json');
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.json();
    expect(body).toMatchObject({ status, code, type: `https://rezics.com/problems/${code}` });
    expect(JSON.stringify(body)).not.toContain('private storage details');
  }
  f.fault();
  f.authFault(new AccountAssertionDenied());
  let response = await f.request(actingContextPreferenceOperation.path, 'PUT', preferenceBody);
  expect(response.status).toBe(401);
  expect(response.headers.get('www-authenticate')).toBe('Bearer');
  f.authFault(new AccountAssertionUnavailable());
  response = await f.request(actingContextPreferenceOperation.path, 'PUT', preferenceBody);
  expect(response.status).toBe(503);
  expect(response.headers.get('retry-after')).toBe('1');
  f.authFault();
  f.work.actingContexts = undefined;
  response = await f.request(actingContextPreferenceOperation.path, 'PUT', preferenceBody);
  expect(response.status).toBe(503);
  expect(await response.json()).toHaveProperty('code', 'acting_context_unavailable');
});

test('scalar binding preserves each same-status refusal, header validation and accepted envelope', async () => {
  const f = fixture();
  const path = `/v1/works/${id}/scalar-value`;
  for (const key of [undefined, '', 'bad key', 'x'.repeat(129)]) {
    const response = await f.request(path, 'POST', scalarBody, key === undefined ? {} : { 'idempotency-key': key });
    expect(response.status).toBe(400);
    expect(await response.json()).toHaveProperty('code', 'invalid_idempotency_key');
  }
  for (const [error, status, code] of [
    [new StaleWorkHead(), 409, 'stale_head'],
    [new IdempotencyConflict(), 409, 'idempotency_conflict'],
    [new AdmissionConflict(), 409, 'idempotency_conflict'],
    [new AdmissionLockBusy(), 409, 'admission_busy'],
    [new AdmissionControllerContinuity(), 409, 'controller_continuity'],
    [new AdmissionDenied(), 403, 'authority_denied'],
    [new InvalidWorkScalarValue(), 400, 'invalid_scalar_value'],
    [new WorkEditUnavailable(), 404, 'work_unavailable'],
    [new RecoveryHold(), 503, 'recovery_hold'],
  ] as const) {
    f.fault(error);
    const response = await f.request(path, 'POST', scalarBody, { 'idempotency-key': 'scalar-proof' });
    expect(response.status).toBe(status);
    expect(response.headers.get('content-type')).toContain('application/problem+json');
    expect(await response.json()).toMatchObject({ status, code });
    if (code === 'admission_busy') expect(response.headers.get('retry-after')).toBe('1');
  }
  const pending = new PendingAdmittedWork(id, 'work-edit');
  f.fault(pending);
  const response = await f.request(path, 'POST', scalarBody, { 'idempotency-key': 'scalar-proof' });
  expect(response.status).toBe(202);
  expect(response.headers.get('retry-after')).toBe('1');
  expect(response.headers.get('content-type')).toContain('application/json');
  expect(await response.json()).toEqual({ operationId: pending.operationId, status: 'reconciling', phase: 'work-edit',
    result: null, retry: { allowed: true, afterMs: 1000 } });
  expect((await typedRefusal(new PendingAdmittedWork(id, 'work-edit'))!).headers.get('content-type')).toContain('application/json');
});

test('native runtime validators reject a wrong success body and wrong code for the actual contracts', async () => {
  const f = fixture();
  // Intentionally hostile implementations simulate unchecked external data.
  const invalidSuccess = () => ({ leaked: 'invalid-success-marker' }) as never;
  const base = () => new Elysia().use(operationPolicies(f.work)).onError(() => new Response('rejected', { status: 500 }));
  for (const [operation, app] of [
    [workHeaderOperation, base().model(workHeaderModels).get(workHeaderOperation.path, workHeaderOperation.options, invalidSuccess)],
    [actingContextPreferenceOperation, base().model(actingContextPreferenceModels)
      .put(actingContextPreferenceOperation.path, actingContextPreferenceOperation.options, invalidSuccess)],
    [workScalarOperation, base().model(workScalarModels).post(workScalarOperation.path, workScalarOperation.options, invalidSuccess)],
  ] as const) {
    const response = await app.handle(new Request(`http://main.test${operation.path.replace(':id', id)}`, {
      method: operation.method.toUpperCase(),
      ...(operation.method === 'get' ? {} : { headers: { 'content-type': 'application/json' },
        body: JSON.stringify(operation.method === 'put' ? preferenceBody : scalarBody) }),
    }));
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(await response.text()).not.toContain('invalid-success-marker');
  }
  const app = base().model(workScalarModels)
    .post(workScalarOperation.path, workScalarOperation.options,
      () => problem(409, { code: 'wrong-code-marker' }) as never);
  const response = await app.handle(new Request(`http://main.test/v1/works/${id}/scalar-value`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(scalarBody),
  }));
  expect(response.status).toBeGreaterThanOrEqual(400);
  expect(response.status).not.toBe(409);
  expect(await response.text()).not.toContain('wrong-code-marker');
  expect(Value.Check(workScalarModels.WorkScalarConflict, { type: 'about:blank', title: 'Conflict',
    status: 409, code: 'wrong-code-marker' })).toBe(false);
});

test('generated OpenAPI preserves baseline requests, operation IDs, success, policy, media and headers', async () => {
  const document = JSON.parse(await buildMainOpenApi());
  expect(JSON.stringify(invariantFingerprints(document))).toBe(JSON.stringify(baseline));
  // The native header shares the publication rights and attribution extensions.
  const header = workHeaderModels.WorkHeader;
  expect(header.properties.rights.properties.basis.const).toBe('public-domain');
  expect(header.properties.rights.properties.source.required).toContain('author');
  expect(header.properties.factObligations).toBeDefined();
  expect(header.required).not.toContain('rights');
  expect(header.required).not.toContain('factObligations');
  const conflict = document.paths['/v1/works/{id}/scalar-value'].post.responses['409'];
  expect(conflict.content).toHaveProperty('application/problem+json');
  expect(conflict.content).not.toHaveProperty('application/json');
});
