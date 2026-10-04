import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { authorCreditFixture, author, shortId } from '../fixtures/author-credit.ts';
import { sourceChildOccurrence } from '../../../services/main/src/modules/source/child-correspondence.ts';
import { GRAPHS, RV } from '../../../services/main/src/modules/work/activate.ts';
import { nativeChildSupportDigest } from '../../../services/main/src/modules/source/child-native-support.ts';
import { fusekiReadBudget } from '../../../services/main/src/infrastructure/fuseki.ts';
import { assertCommandRace } from '../support/command-race.ts';

test('LIVE04: subject children retain native identity across reorder and require explicit reused-key correspondence', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through isolated integration tier');
  const directory = join(resolve(import.meta.dir, '../../..'), '.temp', `native-child-${randomUUID()}`);
  const h = await authorCreditFixture(Bun.env as Record<string, string>, directory);
  try {
    const first = await h.propose('OL993602W', [author('/authors/OL1A')],
      'Subject Work', undefined, ['river', 'mountain', 'river']);
    const work = await h.adoptWork(first);
    await h.grant(`work:edit:${work.work}`, 'work.edit');
    await h.grant(`work:read:${work.work}`, 'work.read');
    const path = `/v1/works/${shortId(work.work)}/source-children`;
    const input = (proposal: typeof first, ordinal: number, key: string) => ({
      profile: 'source-native-child-adoption-v1' as const,
      field: 'subjects' as const, proposal: proposal.proposal, conversion: proposal.conversion,
      occurrence: sourceChildOccurrence(proposal.observation, 'subjects', ordinal),
      sourceOrdinal: ordinal, confirmedSourceKey: key, nativeOrdinal: ordinal,
      expectedHead: work.workRevision, actingSubject: h.actor,
      baseSupport: null as string | null, correspondence: null as string | null,
      confirmedUse: 'factual-reference-only' as const });
    const original = input(first, 0, 'river');
    expect(nativeChildSupportDigest(work.work, original)).toHaveLength(64);
    expect((await h.call('POST', path, original, randomUUID(), h.account.noScope)).status).toBe(401);
    expect((await h.call('POST', path, original, randomUUID(), h.account.tokenB)).status).toBe(404);
    h.loseChildGraph(); h.failChildCertificate();
    const childKey = randomUUID();
    const interrupted = await h.call('POST', path, original, childKey);
    expect(interrupted.status).toBe(503);
    const adopted = await h.json<{ support: { support: string; child: { child: string;
      revision: string; state: string }; nativeReceipt: string }; replayed: boolean }>(
      await h.call('POST', path, original, childKey), 200);
    expect(adopted.replayed).toBe(true);
    expect(adopted.support.child).toMatchObject({ state: 'active' });
    const other = await h.json<typeof adopted>(await h.call('POST', path,
      input(first, 2, 'river')), 201);
    expect(other.support.child.child).not.toBe(adopted.support.child.child);
    const concurrentCommands = [randomUUID(), randomUUID()].map((key) =>
      h.call.bind(h, 'POST', path, input(first, 1, 'mountain'), key),
    );
    await assertCommandRace(
      await Promise.all(concurrentCommands.map((send) => send())),
      201,
      (index) => concurrentCommands[index]!(),
    );
    const refreshed = await h.propose('OL993602W', [author('/authors/OL1A')],
      'Subject Work', undefined, ['mountain', 'river', 'river']);
    const ambiguous = { ...input(refreshed, 1, 'river'), nativeOrdinal: 0,
      baseSupport: adopted.support.support };
    expect((await h.call('POST', path, ambiguous)).status).toBe(409);
    const decision = await h.json<{ correspondence: { correspondence: string } }>(await h.call('POST',
      '/v1/sources/correspondences', { profile: 'source-child-correspondence-v1',
        baseConversion: shortId(first.conversion), candidateConversion: shortId(refreshed.conversion),
        field: 'subjects', baseOccurrence: original.occurrence,
        candidateOccurrence: ambiguous.occurrence, confirmedSameSourceChild: true }), 201);
    const supported = await h.json<typeof adopted>(await h.call('POST', path,
      { ...ambiguous, correspondence: decision.correspondence.correspondence }), 201);
    expect(supported.support.child.child).toBe(adopted.support.child.child);
    expect(supported.support.child.revision).toBe(adopted.support.child.revision);
    expect(supported.support.child.nativeOrdinal).toBe(0);
    const selected = shortId(supported.support.support);
    const plan = (await h.pool.query<{ 'QUERY PLAN': Array<{ Plan: {
      'Actual Rows': number; 'Shared Hit Blocks': number; 'Shared Read Blocks': number;
      'Temp Read Blocks': number } }> }>(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON, TIMING OFF)
      SELECT * FROM source.native_child_intent WHERE id = $1 AND principal_id = $2`,
    [selected, h.principalId])).rows[0]!['QUERY PLAN'][0]!.Plan;
    expect(plan['Actual Rows']).toBe(1);
    expect(plan['Shared Hit Blocks'] + plan['Shared Read Blocks']).toBeLessThan(48);
    expect(plan['Temp Read Blocks']).toBe(0);
    const readBudget = { signal: AbortSignal.timeout(10_000), callsLeft: 64, bytesLeft: 262_144 };
    expect((await fusekiReadBudget.run(readBudget, () => h.call('GET',
      `/v1/sources/native-child-supports/${selected}`))).status).toBe(200);
    expect(64 - readBudget.callsLeft).toBeLessThanOrEqual(32);
    expect(262_144 - readBudget.bytesLeft).toBeLessThan(128_000);
    expect((await h.call('POST', path, { ...ambiguous, sourceOrdinal: 2 })).status).toBe(409);
    const withdrawn = await h.json<{ support: { kind: string; support: {
      state: string; child: { child: string } } } }>(
      await h.call('POST', '/v1/sources/withdrawals', {
        profile: 'source-support-withdrawal-v1', support: adopted.support.support,
        expectedSupport: adopted.support.support,
        reason: 'Withdraw one source observation' }), 201);
    expect(withdrawn.support).toMatchObject({ kind: 'native-child',
      support: { state: 'withdrawn', child: { child: adopted.support.child.child } } });
    expect((await h.call('GET', `/v1/sources/native-child-supports/${shortId(supported.support.support)}`)).status).toBe(200);
    const current = await h.env.fuseki.query(`PREFIX rv: <${RV}> ASK { GRAPH <${GRAPHS.current}> {
      <${adopted.support.child.child}> a rv:NativeChild ; rv:childRevision <${adopted.support.child.revision}> .
      <${other.support.child.child}> a rv:NativeChild . } }`);
    expect(current.boolean).toBe(true);
    const retirementPath = `/v1/works/${shortId(work.work)}/native-children/${shortId(adopted.support.child.child)}/retirements`;
    const retirementInput = { profile: 'work-native-child-retirement-v1',
      revision: adopted.support.child.revision,
      expectedHead: work.workRevision, actingSubject: h.actor,
      reason: 'Human retirement of one subject occurrence' };
    const retirementKey = randomUUID();
    expect((await h.call('POST', retirementPath, { ...retirementInput,
      revision: other.support.child.revision })).status).toBe(409);
    const retirement = await h.json<{ retirement: { retirement: string; state: string;
      child: string }; replayed: boolean }>(await h.call('POST', retirementPath,
        retirementInput, retirementKey), 201);
    expect(retirement.retirement).toMatchObject({ state: 'retired',
      child: adopted.support.child.child });
    expect((await h.json<typeof retirement>(await h.call('POST', retirementPath,
      retirementInput, retirementKey), 200)).replayed).toBe(true);
    expect((await h.call('POST', retirementPath, { ...retirementInput,
      reason: 'Different retirement' })).status).toBe(409);
    const readRetirement = await h.json<{ state: string }>(await h.call('GET',
      `${retirementPath}?actingSubject=${encodeURIComponent(h.actor)}`), 200);
    expect(readRetirement.state).toBe('retired');
    const remaining = await h.json<{ state: string }>(await h.call('GET',
      `/v1/works/${shortId(work.work)}/native-children/${shortId(other.support.child.child)}`
      + `/revisions/${shortId(other.support.child.revision)}?actingSubject=${encodeURIComponent(h.actor)}`), 200);
    expect(remaining.state).toBe('active');
  } finally { await h.close(); rmSync(directory, { recursive: true, force: true }); }
}, 120_000);
