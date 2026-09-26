import { expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { FusekiClient, fusekiReadBudget }
  from '../../../services/main/src/infrastructure/fuseki.ts';
import type { NativeWorkSourceAdoption, NativeWorkSourceSupport,
  NativeWorkSourceSupportWithdrawal, NativeWorkSourceTitleApplication }
  from '../../../services/main/src/modules/source/native-work-adoption.ts';

export type SourceApiCall = (method: string, path: string, token: string,
  body?: object, key?: string) => Promise<Response>;

/** Shares the real Account/API fixture; this helper does not seed authority or mock owners. */
export async function assertSourceSupportWithdrawal(input: {
  call: SourceApiCall; pool: Pool; fuseki: FusekiClient;
  adoption: NativeWorkSourceAdoption; application: NativeWorkSourceTitleApplication;
  humanRevision: string; sourceAdoptToken: string; readToken: string;
  fullToken: string; otherToken: string; otherWork: string;
  actor: string;
  titlePath: string; titleBody: object; loseNextWithdrawalResponse: () => void;
  failNextAcquisition: () => void;
}): Promise<{ path: string; body: object; key: string }> {
  const { call, pool, fuseki, adoption, application, humanRevision } = input;
  const supportPath = `/v1/works/${adoption.work.split('/').at(-1)}/source-support`;
  const path = `${supportPath}/withdrawal`;
  const body = { profile: 'native-work-source-support-withdrawal-v1',
    binding: adoption.binding, expectedSupport: application.application,
    reason: 'I withdraw this recorded title support.' };
  const key = `withdraw-${randomUUID()}`;
  const before = await (await call('GET', supportPath, input.readToken)).json() as NativeWorkSourceSupport;
  expect(before).toMatchObject({ state: 'recorded', supportIdentity: application.application,
    latestApplication: application, withdrawal: null, currentHead: humanRevision });
  const revisionPath = `/v1/revisions/${humanRevision.split('/').at(-1)}`
    + `?actingSubject=${encodeURIComponent(input.actor)}`;
  const nativeBefore = await call('GET', revisionPath, input.fullToken);
  expect(nativeBefore.status).toBe(200);
  const native = await nativeBefore.json();
  const otherPath = `/v1/works/${input.otherWork.split('/').at(-1)}/source-support`;
  const otherBefore = await (await call('GET', otherPath, input.readToken)).json();
  expect((await call('POST', path, input.readToken, body, key)).status).toBe(401);
  expect((await call('POST', path, input.otherToken, body, key)).status).toBe(404);
  expect((await call('POST', path, input.sourceAdoptToken,
    { ...body, binding: `https://rezics.com/id/${randomUUID()}` }, key)).status).toBe(409);
  const stale = await call('POST', path, input.sourceAdoptToken,
    { ...body, expectedSupport: adoption.binding }, key);
  expect(stale.status).toBe(409);
  expect(await stale.json()).toMatchObject({ code: 'source_support_changed' });
  expect((await call('POST', path, input.sourceAdoptToken,
    { ...body, reason: ' ' }, key)).status).toBe(400);

  // A narrower source observation and a failed acquisition cannot dispose support.
  const narrow = await call('POST', '/v1/sources/intakes', input.fullToken, {
    profile: 'source-manual-intake-v1', provider: 'open-library', namespace: 'work',
    externalId: 'OL45804W', sourceRevision: null, mediaType: 'application/json',
    retention: 'retained', rawBytesBase64: Buffer.from('{}').toString('base64'),
    coverage: { scope: 'partial-work-response', complete: false, omittedFields: ['title'] },
    rightsEvidence: { basis: 'unknown', note: '' },
  });
  expect(narrow.status).toBe(201);
  input.failNextAcquisition();
  expect((await call('POST', '/v1/sources/acquisitions/open-library/works', input.fullToken,
    { profile: 'open-library-work-acquisition-v1', workId: 'OL45804W' })).status).toBe(503);
  expect(await (await call('GET', supportPath, input.readToken)).json()).toEqual(before);

  const graphCut = () => fuseki.query(`SELECT ?p ?o WHERE { GRAPH <urn:rezics:graph:control> {
    <urn:rezics:dataset:product> ?p ?o } } ORDER BY ?p ?o`);
  const cut = await graphCut();
  input.loseNextWithdrawalResponse();
  expect((await call('POST', path, input.sourceAdoptToken, body, key)).status).toBe(503);
  const budget = { signal: AbortSignal.timeout(15_000), callsLeft: 32, bytesLeft: 262_144 };
  const response = await fusekiReadBudget.run(budget,
    () => call('POST', path, input.sourceAdoptToken, body, key));
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  const saved = await response.json() as { withdrawal: NativeWorkSourceSupportWithdrawal;
    replayed: boolean };
  expect(saved).toMatchObject({ replayed: true, withdrawal: {
    state: 'withdrawn', binding: adoption.binding, work: adoption.work,
    supportIdentity: application.application, proposal: application.proposal,
    workRevision: application.workRevision, receipt: application.receipt,
    adoptionReceipt: adoption.receipt, adoptedAtRevision: adoption.workRevision,
    reason: body.reason } });
  expect(32 - budget.callsLeft).toBeGreaterThan(0);
  expect(32 - budget.callsLeft).toBeLessThanOrEqual(20);
  expect(262_144 - budget.bytesLeft).toBeLessThan(65_536);
  const replays = await Promise.all([call('POST', path, input.sourceAdoptToken, body, key),
    call('POST', path, input.sourceAdoptToken, body, key)]);
  for (const replay of replays) {
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(saved);
  }
  const changed = await call('POST', path, input.sourceAdoptToken,
    { ...body, reason: 'A different reason' }, key);
  expect(changed.status).toBe(409);
  expect(await changed.json()).toMatchObject({ code: 'source_withdrawal_intent_conflict' });
  expect((await call('POST', path, input.sourceAdoptToken, body, `other-${key}`)).status).toBe(409);
  const after = await call('GET', supportPath, input.readToken);
  expect(after.status).toBe(200);
  expect(await after.json()).toEqual({ ...before, state: 'withdrawn', withdrawal: saved.withdrawal });
  expect(await (await call('GET', revisionPath, input.fullToken)).json()).toEqual(native);
  expect(await graphCut()).toEqual(cut);
  expect(await (await call('GET', otherPath, input.readToken)).json()).toEqual(otherBefore);
  expect(await (await call('GET', input.titlePath, input.readToken)).json()).toEqual(application);
  expect((await call('POST', input.titlePath, input.fullToken, input.titleBody)).status).toBe(409);
  const receiptId = saved.withdrawal.withdrawal.split('/').at(-1)!;
  expect((await pool.query(`SELECT id FROM source.native_work_support_withdrawal
    WHERE binding_id = $1`, [adoption.binding.split('/').at(-1)!])).rowCount).toBe(1);
  await expect(pool.query(`UPDATE source.native_work_support_withdrawal SET reason = 'rewrite'
    WHERE id = $1`, [receiptId])).rejects.toThrow('immutable');
  await expect(pool.query('DELETE FROM source.native_work_support_withdrawal WHERE id = $1',
    [receiptId])).rejects.toThrow('immutable');
  return { path, body, key };
}
