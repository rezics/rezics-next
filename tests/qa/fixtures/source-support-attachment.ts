import { expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { fusekiReadBudget, type FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { iri, lit } from '../../../services/main/src/modules/work/activate.ts';
import type { NativeWorkSourceAdoption } from '../../../services/main/src/modules/source/native-work-adoption.ts';
import type { NativeWorkSourceAttachment, NativeWorkSupportCollection }
  from '../../../services/main/src/modules/source/native-work-attachment.ts';
import type { SourceApiCall } from './source-support-withdrawal.ts';

export async function sourceTitleProposal(call: SourceApiCall, token: string, workId: string, title: string): Promise<string> {
  const observed = await call('POST', '/v1/sources/acquisitions/open-library/works', token, {
    profile: 'open-library-work-acquisition-v1', workId,
  });
  expect(observed.status).toBe(201);
  const observation = (await observed.json() as { observation: { observation: string } }).observation.observation;
  const converted = await call('POST', `/v1/sources/observations/${observation.split('/').at(-1)}/conversions/open-library-work`,
    token, { profile: 'open-library-work-map-v1' });
  expect(converted.status).toBe(201);
  const conversion = (await converted.json() as { conversion: { conversion: string } }).conversion.conversion.split('/').at(-1)!;
  expect((await call('POST', `/v1/sources/conversions/${conversion}/source-graph`, token,
    { profile: 'source-open-library-work-v1' })).status).toBe(200);
  const response = await call('POST', `/v1/sources/conversions/${conversion}/proposals/native-work`, token,
    { profile: 'open-library-native-work-proposal-v1' });
  expect(response.status).toBe(201);
  const proposed = (await response.json() as { proposal: { proposal: string; candidateTitle: string } }).proposal;
  expect(proposed.candidateTitle).toBe(title);
  return proposed.proposal;
}

/** Uses real Account bearers, current Access mandates, Main and both owner databases. */
export async function assertSourceSupportAttachment(input: {
  call: SourceApiCall; pool: Pool; accessPool: Pool; fuseki: FusekiClient; adoption: NativeWorkSourceAdoption;
  humanRevision: string; actor: string; fullToken: string; readToken: string;
  sourceAdoptToken: string; otherToken: string; otherWork: string;
  loseNextAttachmentCommitResponse: () => void;
  beforeNextAuthority: (callback: () => Promise<void>) => void;
}): Promise<{ path: string; finish: () => Promise<void> }> {
  const { call, pool, accessPool, adoption, fullToken, readToken } = input;
  const path = `/v2/works/${adoption.work.split('/').at(-1)}/source-supports`;
  const singular = `/v1/works/${adoption.work.split('/').at(-1)}/source-support`;
  const before = await (await call('GET', singular, readToken)).json();
  const title = 'Source title refreshed';
  const proposal = await sourceTitleProposal(call, fullToken, 'OL991401W', title);
  const different = await sourceTitleProposal(call, fullToken, 'OL991402W', 'Conflicting title');
  const body = { profile: 'native-work-source-title-attachment-v2', proposal,
    expectedHead: input.humanRevision, confirmedTitle: title, titleLanguage: 'en', actingSubject: input.actor };
  const key = `attachment-${randomUUID()}`;
  expect((await call('POST', path, readToken, body, key)).status).toBe(401);
  expect((await call('POST', path, input.sourceAdoptToken, body, key)).status).toBe(401);
  expect((await call('GET', path, input.otherToken)).status).toBe(404);
  expect((await call('POST', path, input.otherToken, body, key)).status).toBe(404);
  expect((await call('POST', path, fullToken, { ...body, proposal: adoption.proposal }, key)).status).toBe(409);
  expect((await call('POST', path, fullToken,
    { ...body, proposal: different, confirmedTitle: 'Conflicting title' }, key)).status).toBe(409);
  expect((await call('POST', path, fullToken, { ...body, expectedHead: adoption.workRevision }, key)).status).toBe(409);
  expect((await call('POST', path, fullToken,
    { ...body, actingSubject: `https://rezics.com/id/${randomUUID()}` }, key)).status).toBe(403);
  const scope = `work:edit:${adoption.work}`;
  await accessPool.query('UPDATE access.permission_grant SET active = false WHERE scope_id = $1', [scope]);
  expect((await call('POST', path, fullToken, body, key)).status).toBe(403);
  await accessPool.query('UPDATE access.permission_grant SET active = true WHERE scope_id = $1', [scope]);

  input.loseNextAttachmentCommitResponse();
  const first = await call('POST', path, fullToken, body, key);
  expect(first.status).toBe(503);
  const retries = await Promise.all([call('POST', path, fullToken, body, key), call('POST', path, fullToken, body, key)]);
  for (const response of retries) expect(response.status).toBe(200);
  const saved = await retries[0]!.json() as { attachment: NativeWorkSourceAttachment; replayed: boolean };
  expect(await retries[1]!.json()).toEqual(saved);
  expect(saved).toMatchObject({ replayed: true, attachment: { originalBinding: adoption.binding,
    work: adoption.work, verifiedHead: input.humanRevision, title,
    headGuarantee: 'verified-before-commit', rightsStatus: 'undetermined',
    authority: { action: 'work.edit', scope, actingSubject: input.actor } } });
  expect(saved.attachment.binding).not.toBe(adoption.binding);
  expect(saved.attachment.sourceRecord).not.toBe(adoption.sourceRecord);
  expect((await call('POST', path, fullToken, body, `changed-${key}`)).status).toBe(409);
  expect((await call('POST', path, fullToken, { ...body, proposal: different }, key)).status).toBe(409);
  expect((await call('POST', `/v2/works/${input.otherWork.split('/').at(-1)}/source-supports`,
    fullToken, body, key)).status).toBe(409);
  // Attaching a proposal reserves it against later native adoption as well.
  expect((await call('POST', `/v1/sources/proposals/${proposal.split('/').at(-1)}/adoption/native-work`,
    fullToken, { profile: 'source-native-work-adoption-v1', actingSubject: input.actor,
      confirmedTitle: title, titleLanguage: 'en' })).status).toBe(409);
  expect(await (await call('GET', singular, readToken)).json()).toEqual(before);
  const budget = { signal: AbortSignal.timeout(15_000), callsLeft: 32, bytesLeft: 262_144 };
  const collection = await fusekiReadBudget.run(budget, () => call('GET', path, readToken));
  expect(collection.status).toBe(200);
  expect(collection.headers.get('cache-control')).toBe('no-store');
  const supports = await collection.json() as NativeWorkSupportCollection;
  expect(supports.supports).toHaveLength(2);
  expect(supports.supports[0]).toEqual({ kind: 'adoption', support: before });
  expect(supports.supports[1]).toMatchObject({ kind: 'attachment', support: {
    state: 'recorded', attachment: saved.attachment, currentHead: input.humanRevision,
    verifiedRevisionIsHead: true, withdrawal: null } });
  expect(32 - budget.callsLeft).toBeLessThanOrEqual(20);
  expect(262_144 - budget.bytesLeft).toBeLessThan(100_000);
  const exactPath = `${path}/${saved.attachment.binding.split('/').at(-1)}`;
  expect(await (await call('GET', exactPath, readToken)).json()).toEqual(supports.supports[1]);
  expect((await call('GET', exactPath, input.otherToken)).status).toBe(404);
  const replaceTitle = (from: string, to: string) => input.fuseki.update(`
    DELETE DATA { GRAPH <urn:rezics:graph:source> { ${iri(saved.attachment.sourceConversion)}
      <https://rezics.com/vocab/sourceTitle> ${lit(from)} } };
    INSERT DATA { GRAPH <urn:rezics:graph:source> { ${iri(saved.attachment.sourceConversion)}
      <https://rezics.com/vocab/sourceTitle> ${lit(to)} } }`);
  await replaceTitle(title, 'Altered retained graph evidence');
  try {
    expect((await call('GET', path, readToken)).status).toBe(503);
    expect((await call('POST', path, fullToken, body, key)).status).toBe(503);
  } finally { await replaceTitle('Altered retained graph evidence', title); }
  await expect(pool.query('UPDATE source.native_work_support_attachment SET title = $1 WHERE id = $2',
    ['Changed', saved.attachment.binding.split('/').at(-1)])).rejects.toThrow('immutable');

  // Force a human edit between completed Jena preflight and the Access/Source
  // lock envelope. The resulting attachment must explicitly remain historical.
  const raceTitle = 'Historical title acknowledgement';
  const raceProposal = await sourceTitleProposal(call, fullToken, 'OL991403W', raceTitle);
  const raceAdopted = await call('POST', `/v1/sources/proposals/${raceProposal.split('/').at(-1)}/adoption/native-work`,
    fullToken, { profile: 'source-native-work-adoption-v1', actingSubject: input.actor,
      confirmedTitle: raceTitle, titleLanguage: 'en' });
  expect(raceAdopted.status).toBe(201);
  const raceWork = (await raceAdopted.json() as { adoption: NativeWorkSourceAdoption }).adoption;
  const raceScope = `work:edit:${raceWork.work}`;
  await accessPool.query('INSERT INTO access.scope_gate (id) VALUES ($1)', [raceScope]);
  await accessPool.query(`INSERT INTO access.permission_grant
    (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
    VALUES ($1,$2,$2,$3,'work.edit',now() + interval '1 hour')`, [randomUUID(), input.actor, raceScope]);
  const raceSecond = await sourceTitleProposal(call, fullToken, 'OL991404W', raceTitle);
  const racePath = `/v2/works/${raceWork.work.split('/').at(-1)}/source-supports`;
  let laterHead = '';
  input.beforeNextAuthority(async () => {
    const edit = await call('POST', '/v1/content-edits', fullToken,
      { profile: 'metadata-only-v1', work: raceWork.work, expectedHead: raceWork.workRevision,
        title: raceTitle, actingSubject: input.actor });
    expect(edit.status).toBe(200);
    laterHead = (await edit.json() as { revision: string }).revision;
  });
  const raceBody = { ...body, proposal: raceSecond, expectedHead: raceWork.workRevision, confirmedTitle: raceTitle };
  const raced = await Promise.all([call('POST', racePath, fullToken, raceBody, 'same-race-attachment'),
    call('POST', racePath, fullToken, raceBody, 'same-race-attachment')]);
  // Depending on preflight timing the second caller either replays or sees stale
  // native head. Exactly one immutable attachment is possible in both orders.
  expect(raced.filter(response => response.status === 201)).toHaveLength(1);
  expect(raced.every(response => [200, 201, 409].includes(response.status))).toBe(true);
  const raceCollection = await (await call('GET', racePath, readToken)).json() as NativeWorkSupportCollection;
  expect(raceCollection.currentHead).toBe(laterHead);
  expect(raceCollection.supports[1]).toMatchObject({ kind: 'attachment', support: {
    verifiedRevisionIsHead: false, attachment: { verifiedHead: raceWork.workRevision,
      headGuarantee: 'verified-before-commit' } } });
  expect((await pool.query('SELECT id FROM source.native_work_support_attachment WHERE work = $1', [raceWork.work])).rowCount).toBe(1);

  return { path, finish: async () => {
    const afterA = await (await call('GET', path, readToken)).json() as NativeWorkSupportCollection;
    expect(afterA.supports[0]).toMatchObject({ kind: 'adoption', support: { state: 'withdrawn' } });
    expect(afterA.supports[1]).toEqual(supports.supports[1]);
    const withdrawPath = `${exactPath}/withdrawal`;
    const intent = { profile: 'native-work-source-support-withdrawal-v2',
      expectedSupport: saved.attachment.binding, reason: 'Withdraw only this independent support' };
    expect((await call('POST', withdrawPath, readToken, intent, key)).status).toBe(401);
    expect((await call('POST', withdrawPath, input.otherToken, intent, key)).status).toBe(404);
    expect((await call('POST', withdrawPath, input.sourceAdoptToken,
      { ...intent, expectedSupport: adoption.binding }, key)).status).toBe(409);
    const withdrawals = await Promise.all([call('POST', withdrawPath, input.sourceAdoptToken, intent, key),
      call('POST', withdrawPath, input.sourceAdoptToken, intent, key)]);
    expect(withdrawals.map(response => response.status).sort()).toEqual([200, 201]);
    const receipts = await Promise.all(withdrawals.map(response => response.json())) as Array<{ withdrawal: object }>;
    expect(receipts[0]!.withdrawal).toEqual(receipts[1]!.withdrawal);
    expect((await call('POST', withdrawPath, input.sourceAdoptToken, intent, `changed-${key}`)).status).toBe(409);
    expect((await call('POST', path, fullToken, body, key)).status).toBe(200);
    const afterB = await (await call('GET', path, readToken)).json() as NativeWorkSupportCollection;
    expect(afterB.currentHead).toBe(input.humanRevision);
    expect(afterB.supports[0]).toEqual(afterA.supports[0]);
    expect(afterB.supports[1]).toMatchObject({ kind: 'attachment', support: { state: 'withdrawn',
      attachment: saved.attachment, withdrawal: receipts[0]!.withdrawal } });
    const legacy = afterB.supports[0]!;
    if (legacy.kind !== 'adoption' || !legacy.support.withdrawal) throw new Error('missing v1 withdrawal');
    const replayA = await call('POST', `${path}/${adoption.binding.split('/').at(-1)}/withdrawal`,
      input.sourceAdoptToken, { profile: 'native-work-source-support-withdrawal-v2',
        expectedSupport: legacy.support.supportIdentity, reason: legacy.support.withdrawal.reason },
      (await pool.query('SELECT idempotency_key FROM source.native_work_support_withdrawal WHERE binding_id = $1',
        [adoption.binding.split('/').at(-1)])).rows[0].idempotency_key);
    expect(replayA.status).toBe(200);
    expect(await replayA.json()).toEqual({ kind: 'adoption', withdrawal: legacy.support.withdrawal, replayed: true });
  } };
}
