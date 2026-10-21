import { expect, spyOn, test } from 'bun:test';
import { Elysia } from 'elysia';
import { FusekiClient, FusekiHttpError, FusekiQueryResponseTooLarge,
  FusekiReadBudgetExceeded, FusekiReadDeadlineExceeded } from '../src/infrastructure/fuseki.ts';
import { AdmissionDenied, AdmissionUnavailable } from '../src/modules/access/admission.ts';
import { AccountAssertionDenied, AccountAssertionUnavailable } from '../src/modules/account/verify-assertion.ts';
import { SearchSnapshotMoved } from '../src/modules/work/search-readiness.ts';
import { WorkReadExpired, WorkReadInvalid, WorkReadLimit, WorkReadMissing,
  WorkReadMoved } from '../src/modules/work/read-session.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import { workContentsRoutes } from '../src/routes/work-contents.ts';
import { workHeaderModels, workHeaderOperation } from '../src/routes/work-header.contract.ts';
import { workHeaderHandler } from '../src/routes/work-header.handler.ts';
import { workReadError } from '../src/routes/work-reads.ts';
import { operationPolicies } from '../src/routes/operation-policies.ts';

const id = '00000000-0000-4000-8000-000000000001';
const paths = [`/v1/works/${id}`, `/v1/works/${id}/contents`, `/v1/chapters/${id}`];

function readerRoutes(graph: FusekiClient) {
  const work = { environment: { fuseki: graph,
    lineage: { dataEpoch: 'fixture', routingEpoch: 'fixture' } } } as MainWorkDependencies;
  return new Elysia().use(operationPolicies(work)).model(workHeaderModels)
    [workHeaderOperation.method](workHeaderOperation.path, workHeaderOperation.options, workHeaderHandler(work))
    .use(workContentsRoutes(work));
}

test('graph HTTP server failures preserve the Work read unavailable problem on every Reader surface', async () => {
  const graph = new FusekiClient('http://graph.invalid/rezics');
  let status = 503;
  const unavailable = Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    expect(String(input)).toBe('http://graph.invalid/rezics/query');
    expect(init?.method).toBe('POST');
    return new Response('Graph service is unavailable', { status });
  }, { preconnect: fetch.preconnect });
  const transport = spyOn(globalThis, 'fetch').mockImplementation(unavailable);
  try {
    // Retain the production transport exception, rather than a stand-in Error.
    await expect(graph.query('ASK {}')).rejects.toBeInstanceOf(FusekiHttpError);
    const app = readerRoutes(graph);
    for (status of [502, 503, 504]) {
      for (const path of paths) {
        const response = await app.handle(new Request(`http://main.test${path}`));
        expect(response.status).toBe(503);
        expect(await response.json()).toMatchObject({ status: 503, code: 'work_read_unavailable' });
      }
    }
    expect(transport).toHaveBeenCalledTimes(10);
  } finally { transport.mockRestore(); }
});

test('Work read limits and basis changes keep their distinct problems', async () => {
  for (const [error, status, code] of [
    [new WorkReadInvalid(), 400, 'invalid_work_read'],
    [new WorkReadMissing(), 404, 'work_unavailable'],
    [new WorkReadMoved(), 409, 'read_basis_changed'],
    [new WorkReadExpired(), 409, 'read_basis_changed'],
    [new SearchSnapshotMoved(), 409, 'read_basis_changed'],
    [new WorkReadLimit(), 422, 'work_read_budget_exceeded'],
    [new FusekiReadBudgetExceeded(), 422, 'work_read_budget_exceeded'],
    [new FusekiQueryResponseTooLarge(), 422, 'work_read_budget_exceeded'],
    [new FusekiReadDeadlineExceeded(), 503, 'work_read_unavailable'],
  ] as const) {
    const response = workReadError(error);
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ status, code });
  }
});

test('graph failures do not replace Account or authority refusals or classify unrelated errors', async () => {
  for (const [error, status, code, header, value] of [
    [new AccountAssertionDenied(), 401, 'account_assertion_denied', 'www-authenticate', 'Bearer'],
    [new AccountAssertionUnavailable(), 503, 'dependency_unavailable', 'retry-after', '1'],
    [new AdmissionDenied(), 403, 'authority_denied', null, null],
    [new AdmissionUnavailable(), 503, 'dependency_unavailable', 'retry-after', '1'],
  ] as const) {
    const response = workReadError(error);
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ status, code });
    if (header) expect(response.headers.get(header)).toBe(value);
  }
  for (const error of [new Error('unrelated failure'),
    ...[400, 401, 403, 404, 429].map(status => new FusekiHttpError('Graph request refused', status, 'Refused'))]) {
    const response = workReadError(error);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'dependency_unavailable' });
  }
});
