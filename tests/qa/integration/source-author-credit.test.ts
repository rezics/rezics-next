import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { authorCreditFixture, author, nativeId, shortId } from '../fixtures/author-credit.ts';
import type { SourceAuthorCreditSupport } from '../../../services/main/src/modules/source/author-credit.ts';
import { adoptAuthorCredit, readAuthorCredit, type AuthorCreditValue }
  from '../../../services/main/src/modules/work/author-credit.ts';
import { fusekiReadBudget, type CommandEnvelope } from '../../../services/main/src/infrastructure/fuseki.ts';
import { GRAPHS, RV, iri } from '../../../services/main/src/modules/work/activate.ts';

test('LIVE04/MODEL05/MODEL06: explicit author occurrences preserve identity, authority, native control and support', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated integration tier');
  const directory = join(resolve(import.meta.dir, '../../..'), '.temp', `author-credit-${randomUUID()}`);
  const fixture = await authorCreditFixture(Bun.env as Record<string, string>, directory);
  const { call, json, grant, propose, adoptWork, input, account, pool, accessPool, actor, env } = fixture;
  type Write = { support: SourceAuthorCreditSupport; replayed: boolean };
  try {
    const workKey = 'OL991801W';
    const proposal = await propose(workKey, [author('/authors/OL1A'), author('/authors/OL1A'),
      author('/authors/OL2A'), author('/authors/OL3A'), author('/authors/OL4A'), author('/authors/OL5A')]);
    const work = await adoptWork(proposal);
    const path = `/v1/works/${shortId(work.work)}/source-author-credits`;
    const first = input(proposal, work, 0), firstKey = randomUUID();
    expect((await call('POST', path, first, firstKey, account.noScope)).status).toBe(401);
    expect((await call('POST', path, first, firstKey, account.tokenB)).status).toBe(404);
    expect((await call('POST', path, first, firstKey)).status).toBe(403);
    expect((await pool.query('SELECT id FROM source.author_credit_intent WHERE work = $1', [work.work])).rowCount).toBe(0);
    const editGrant = await grant(`work:edit:${work.work}`, 'work.edit');
    await grant(`work:read:${work.work}`, 'work.read');
    // A lost graph acknowledgement followed by loss before the Source certificate
    // leaves one exact native effect, repaired by the same authorized intent.
    fixture.loseGraph(); fixture.failCertificate();
    expect((await call('POST', path, first, firstKey)).status).toBe(503);
    const one = await json<Write>(await call('POST', path, first, firstKey), 200);
    expect(one.replayed).toBe(true);
    expect(one.support.credit).toMatchObject({ role: 'author', participantKind: 'external-reference',
      sourceKey: '/authors/OL1A', nativeOrdinal: 0, control: 'human-confirmed', rightsStatus: 'undetermined' });
    expect(await (await call('POST', path, first, firstKey)).json()).toEqual(one);
    expect((await call('POST', path, { ...first, nativeOrdinal: 1 }, firstKey)).status).toBe(409);
    expect((await call('POST', path, first)).status).toBe(409);
    const second = input(proposal, work, 1), secondKey = randomUUID();
    const concurrent = await Promise.all([call('POST', path, second, secondKey), call('POST', path, second, secondKey)]);
    expect(concurrent.map(response => response.status).sort()).toEqual([200, 201]);
    const two = await concurrent[0]!.json() as Write;
    expect((await concurrent[1]!.json() as Write).support).toEqual(two.support);
    expect(two.support.credit.credit).not.toBe(one.support.credit.credit);
    expect(two.support.sourceOccurrence).not.toBe(one.support.sourceOccurrence);
    expect(two.support.sourceKey).toBe(one.support.sourceKey);
    const unique = await json<Write>(await call('POST', path, input(proposal, work, 2, '/authors/OL2A')), 201);
    const selected = `/v1/sources/author-credit-supports/${shortId(one.support.support)}`;
    expect((await call('GET', selected, undefined, randomUUID(), account.tokenB)).status).toBe(404);
    const onlySource = await account.tokenFor(account.a, 'openid source:adopt source:read');
    expect((await call('POST', path, first, firstKey, onlySource)).status).toBe(401);
    const nativePath = `/v1/works/${shortId(work.work)}/author-credits/${shortId(one.support.credit.credit)}`
      + `/revisions/${shortId(one.support.credit.revision)}?actingSubject=${encodeURIComponent(actor)}`;
    expect(await (await call('GET', nativePath)).json()).toEqual(one.support.credit);
    expect((await call('GET', nativePath, undefined, randomUUID(), account.tokenB)).status).toBe(404);

    const reordered = await propose(workKey, [author('/authors/OL2A'), author('/authors/OL1A'), author('/authors/OL1A')]);
    const refresh = { ...input(reordered, work, 2), nativeOrdinal: 0, baseSupport: one.support.support };
    expect((await call('POST', path, { ...refresh, baseSupport: null })).status).toBe(409);
    expect((await call('POST', path, { ...first, conversion: reordered.conversion })).status).toBe(409);
    expect((await call('POST', path, refresh)).status).toBe(409);
    const pairing = await json<{ correspondence: { correspondence: string } }>(await call('POST',
      '/v1/sources/correspondences', { profile: 'source-child-correspondence-v1', confirmedSameSourceChild: true,
        baseConversion: shortId(proposal.conversion),
        candidateConversion: shortId(reordered.conversion), field: 'authors',
        baseOccurrence: first.occurrence, candidateOccurrence: refresh.occurrence }), 201);
    const paired = { ...refresh, correspondence: pairing.correspondence.correspondence };
    const refreshed = await json<Write>(await call('POST', path, paired), 201);
    expect(refreshed.support.credit).toEqual(one.support.credit);
    expect(refreshed.support).toMatchObject({ sourceOrdinal: 2, correspondenceKind: 'explicit' });
    expect((await call('POST', path, { ...paired, baseSupport: two.support.support, nativeOrdinal: 1 })).status).toBe(409);
    const moved = await json<Write>(await call('POST', path, { ...input(reordered, work, 0, '/authors/OL2A'),
      nativeOrdinal: 2, baseSupport: unique.support.support }), 201);
    expect(moved.support.credit).toEqual(unique.support.credit);
    expect(moved.support.correspondenceKind).toBe('unique-key');
    const changedRole = await propose(workKey, [author('/authors/OL1A', '/type/editor_role')]);
    expect((await call('POST', path, { ...input(changedRole, work, 0), baseSupport: one.support.support,
      confirmedRoleKey: '/type/editor_role' })).status).toBe(409);
    for (const authors of [undefined, [{ author: { key: 'unmapped' } }], []]) {
      const missing = await propose(workKey, authors);
      expect((await call('POST', path, { ...input(missing, work, 0), baseSupport: one.support.support })).status).toBe(409);
    }
    expect(await (await call('GET', selected)).json()).toEqual(one.support);

    const otherSource = await propose('OL991802W', [author('/authors/OL1A')]);
    const additional = { ...input(otherSource, work, 0), baseSupport: one.support.support };
    expect((await call('POST', path, additional)).status).toBe(409);
    await json(await call('POST', `/v2/works/${shortId(work.work)}/source-supports`, {
      profile: 'native-work-source-title-attachment-v2', proposal: otherSource.proposal,
      expectedHead: work.workRevision, actingSubject: actor, confirmedTitle: proposal.candidateTitle, titleLanguage: 'en' }), 201);
    const attached = await json<Write>(await call('POST', path, additional), 201);
    expect(attached.support).toMatchObject({ correspondenceKind: 'separate-source', credit: one.support.credit });
    const human = await json<{ revision: string }>(await call('POST', '/v1/content-edits', {
      profile: 'metadata-only-v1', work: work.work, expectedHead: work.workRevision,
      title: 'Human native title', actingSubject: actor }), 200);
    expect(human.revision).not.toBe(work.workRevision);
    expect((await call('POST', path, input(proposal, work, 3, '/authors/OL3A'))).status).toBe(409);
    const withdrawKey = randomUUID();
    const withdrawn = await json<Write>(await call('POST', `${selected}/withdrawals`, { reason: 'Withdraw this evidence' }, withdrawKey, onlySource), 201);
    expect(withdrawn.support.state).toBe('withdrawn');
    expect(withdrawn.support.credit).toEqual(one.support.credit);
    expect(await (await call('POST', `${selected}/withdrawals`, { reason: 'Withdraw this evidence' }, withdrawKey, onlySource)).json())
      .toEqual({ ...withdrawn, replayed: true });
    expect((await call('POST', `${selected}/withdrawals`, { reason: 'Changed reason' }, withdrawKey)).status).toBe(409);
    expect(await (await call('GET', `/v1/sources/author-credit-supports/${shortId(attached.support.support)}`)).json()).toEqual(attached.support);
    expect(await (await call('GET', nativePath)).json()).toEqual(one.support.credit);
    expect((await env.fuseki.query(`ASK { GRAPH <${GRAPHS.current}> { <${work.work}> <${RV}head> <${human.revision}> } }`)).boolean).toBe(true);
    await accessPool.query('UPDATE access.permission_grant SET active = false WHERE id = $1', [editGrant]);
    expect((await call('POST', path, first, firstKey)).status).toBe(403);
    await accessPool.query('UPDATE access.permission_grant SET active = true WHERE id = $1', [editGrant]);
    await expect(pool.query('UPDATE source.author_credit_intent SET source_ordinal = 9 WHERE id = $1', [shortId(one.support.support)]))
      .rejects.toThrow('immutable');

    // One bulk-built owner background; query and native response bounds stay fixed
    // at geometric history sizes. These fixture rows are not extra native claims.
    for (const [from, to, ordinal] of [[1, 8, 3], [9, 64, 4], [65, 512, 5]]) {
      await pool.query(`INSERT INTO source.author_credit_intent
        (id,principal_id,work,idempotency_key,request_digest,request,proposal_id,conversion_id,record_id,
         occurrence,source_ordinal,source_key,source_role_key,credit,credit_revision,authority_proof)
        SELECT gen_random_uuid(),principal_id,work,'background-' || gen_random_uuid(),request_digest,request,
          proposal_id,conversion_id,record_id,'urn:rezics:source-occurrence:' || md5(n::text) || md5(n::text),
          source_ordinal,source_key,source_role_key,'https://rezics.com/id/' || gen_random_uuid(),
          'https://rezics.com/id/' || gen_random_uuid(),authority_proof
        FROM source.author_credit_intent CROSS JOIN generate_series($2::int,$3::int) n WHERE id = $1`,
      [shortId(one.support.support), from, to]);
      await pool.query('ANALYZE source.author_credit_intent');
      const plan = (await pool.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON, TIMING OFF)
        SELECT i.*,a.graph_receipt,w.id FROM source.author_credit_intent i
        JOIN source.author_credit_application a ON a.intent_id = i.id
        LEFT JOIN source.author_credit_withdrawal w ON w.intent_id = i.id
        WHERE i.id = $1 AND i.principal_id = $2`, [shortId(one.support.support), fixture.principalId])).rows[0]['QUERY PLAN'][0].Plan;
      expect(plan['Actual Rows']).toBe(1);
      expect(plan['Shared Hit Blocks'] + plan['Shared Read Blocks']).toBeLessThan(32);
      const budget = { signal: AbortSignal.timeout(10_000), callsLeft: 64, bytesLeft: 262_144 };
      const response = await fusekiReadBudget.run(budget, () => call('GET', selected));
      expect(response.status).toBe(200);
      expect(64 - budget.callsLeft).toBeLessThanOrEqual(16);
      expect(262_144 - budget.bytesLeft).toBeLessThan(64_000);
      const before = (await pool.query(`SELECT (SELECT count(*) FROM source.author_credit_intent) AS intents,
        (SELECT count(*) FROM source.author_credit_application) AS applications`)).rows[0];
      const writesBefore = fixture.creditCommands.length;
      const writeBudget = { signal: AbortSignal.timeout(10_000), callsLeft: 64, bytesLeft: 262_144 };
      const added = await json<Write>(await fusekiReadBudget.run(writeBudget, () => call('POST', path,
        { ...input(proposal, work, ordinal!, `/authors/OL${ordinal}A`), expectedHead: human.revision })), 201);
      const after = (await pool.query(`SELECT (SELECT count(*) FROM source.author_credit_intent) AS intents,
        (SELECT count(*) FROM source.author_credit_application) AS applications`)).rows[0];
      expect(Number(after.intents) - Number(before.intents)).toBe(1);
      expect(Number(after.applications) - Number(before.applications)).toBe(1);
      expect(fixture.creditCommands.length - writesBefore).toBe(1);
      expect(fixture.creditCommands.at(-1)!.focuses).toBe(2);
      expect(fixture.creditCommands.at(-1)!.bytes).toBeLessThan(24_000);
      expect(64 - writeBudget.callsLeft).toBeLessThanOrEqual(24);
      expect(262_144 - writeBudget.bytesLeft).toBeLessThan(64_000);
      expect(added.support.credit.nativeOrdinal).toBe(ordinal!);
    }

    // Native invariants are enforced even if an internal caller drops its shape,
    // invents an Agent, changes a bound value or attempts to overwrite a credit.
    const mutations: Array<(envelope: CommandEnvelope) => CommandEnvelope> = [
      envelope => ({ ...envelope, validations: [] }),
      envelope => ({ ...envelope, validations: envelope.validations.map(entry => ({ ...entry, binding: undefined })) }),
      envelope => ({ ...envelope, update: envelope.update.replaceAll('schema:position 0', 'schema:position 128') }),
      envelope => ({ ...envelope, update: envelope.update.replaceAll('rv:editControl rv:HumanConfirmed', `rv:agent <${actor}> ; rv:editControl rv:HumanConfirmed`) }),
      envelope => ({ ...envelope, validations: envelope.validations.map(entry => ({ ...entry,
        binding: { ...entry.binding, key: '/authors/OL999A' } })) }),
    ];
    for (const mutate of mutations) {
      const value: AuthorCreditValue = { work: work.work, credit: nativeId(), revision: nativeId(),
        expectedHead: human.revision, actingSubject: actor, sourceKey: '/authors/OL1A', sourceRoleKey: null, nativeOrdinal: 0 };
      fixture.mutateCredit(mutate);
      await expect(adoptAuthorCredit(env, account.verifier, fixture.access, new Request('http://main.local/',
        { headers: { authorization: `Bearer ${account.tokenA}` } }), value, nativeId(), randomUUID())).rejects.toThrow();
      expect(await readAuthorCredit(env, value.credit, value.revision)).toBeNull();
    }
    for (const [graph, subject] of [[GRAPHS.current, one.support.credit.credit],
      [GRAPHS.revisions, one.support.credit.revision]]) {
      const receipt = `urn:rezics:receipt:${'c'.repeat(32)}${randomUUID().replaceAll('-', '')}`;
      const overwrite = await fixture.nativeFuseki.commandWithReceipt({ receipt, digest: 'overwrite-credit',
        validations: [], deadlineMs: 10_000, update: `PREFIX rv: <${RV}>
          DELETE { GRAPH <${graph}> { <${subject}> <https://schema.org/position> 0 } }
          INSERT { GRAPH <${graph}> { <${subject}> <https://schema.org/position> 1 }
            GRAPH <${GRAPHS.receipts}> { <${receipt}> rv:requestDigest "overwrite-credit" } }
          WHERE { GRAPH <${graph}> { <${subject}> <https://schema.org/position> 0 } }` });
      expect(overwrite.status).toBe('invalid');
      expect(JSON.stringify(overwrite)).toContain('immutable');
    }
    expect(await readAuthorCredit(env, one.support.credit.credit, one.support.credit.revision)).toEqual(one.support.credit);
    const protectedInput = { ...input(proposal, work, 3, '/authors/OL3A'), expectedHead: human.revision };
    const protection = nativeId();
    await fixture.nativeFuseki.update(`INSERT DATA { GRAPH <${GRAPHS.current}> { ${iri(work.work)} <${RV}protectionHead> ${iri(protection)} } }`);
    expect((await call('POST', path, protectedInput)).status).toBe(409);
    await fixture.nativeFuseki.update(`DELETE DATA { GRAPH <${GRAPHS.current}> { ${iri(work.work)} <${RV}protectionHead> ${iri(protection)} } }`);
    const counts = (await env.fuseki.query(`SELECT (COUNT(?credit) AS ?n) WHERE { GRAPH <${GRAPHS.current}> {
      ?credit a <${RV}AuthorCredit> ; <${RV}work> <${work.work}> . } }`)).results!.bindings;
    expect(counts[0]?.n?.value).toBe('6');
  } finally { await fixture.close(); rmSync(directory, { recursive: true, force: true }); }
}, 60_000);
