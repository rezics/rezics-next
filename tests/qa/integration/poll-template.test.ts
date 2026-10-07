import { randomUUID } from 'node:crypto';
import { expect, test } from 'bun:test';
import { Pool } from 'pg';
import { createMainApp } from '../../../services/main/src/app.ts';
import { AccessExposure } from '../../../services/main/src/modules/access/exposure.ts';
import { grantRecordedPlatformUse } from '../fixtures/platform-grant.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { AccessAdmissionRegistry } from '../../../services/main/src/modules/access/admission.ts';
import { readMainOutboxEnvelope } from '../../../services/main/src/modules/outbox/relay.ts';
import { AccessVotes, voteReceiptIri } from '../../../services/main/src/modules/vote/access.ts';
import { pollScopeId } from '../../../services/main/src/modules/vote/schema.ts';
import { ID } from '../../../services/main/src/modules/work/activate.ts';
import { assertCommandRace } from '../support/command-race.ts';

const native = () => ID + randomUUID();

test('GOV11/GOV12/GOV13/GOV14/GOV15/GOV16/GOV17/GOV18/GOV19/GOV20/GOV21/GOV22/GOV23: admitted poll, allocation, proxy, mandate and ballot template', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.FUSEKI_URL || !Bun.env.MAIN_DATA_EPOCH
    || !Bun.env.MAIN_ROUTING_EPOCH || !Bun.env.ACCESS_DATABASE_URL) {
    throw new Error('Run through the isolated QA integration tier');
  }
  const pool = new Pool({ connectionString: Bun.env.ACCESS_DATABASE_URL });
  const fuseki = new FusekiClient(Bun.env.FUSEKI_URL);
  const body = native(), administrator = native(), holder = native(), poll = native();
  const principalId = randomUUID();
  const representationId = randomUUID();
  const grantId = randomUUID();
  const scope = pollScopeId(poll);
  try {
    await pool.query(`INSERT INTO access.principal (id, account_issuer, account_subject)
      VALUES ($1, 'https://vote-template.test', 'administrator')`, [principalId]);
    await grantRecordedPlatformUse(pool, principalId, ['institutional-voting']);
    for (const subject of [body, administrator, holder]) {
      await pool.query("INSERT INTO access.authority_subject (id, kind) VALUES ($1, 'agent')", [subject]);
    }
    await pool.query('INSERT INTO access.scope_gate (id) VALUES ($1)', [scope]);
    await pool.query(`INSERT INTO access.representation
      (id, principal_id, subject_id, action, valid_until)
      VALUES ($1,$2,$3,'governance.poll.administer', now() + interval '1 hour')`,
    [representationId, principalId, administrator]);
    await pool.query(`INSERT INTO access.permission_grant
      (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
      VALUES ($1,$2,$3,$4,'governance.poll.administer', now() + interval '1 hour')`,
    [grantId, body, administrator, scope]);
    let loseSeal = true;
    class InterruptedVotes extends AccessVotes {
      override async seal(...args: Parameters<AccessVotes['seal']>): Promise<void> {
        if (loseSeal) { loseSeal = false; throw new Error('lost Access seal response'); }
        await super.seal(...args);
      }
    }
    const votes = new InterruptedVotes(pool);
    const app = createMainApp(fuseki, { environment: { fuseki,
      lineage: { dataEpoch: Bun.env.MAIN_DATA_EPOCH, routingEpoch: Bun.env.MAIN_ROUTING_EPOCH },
      objectDirectory: `.temp/vote-template-${randomUUID()}` },
    account: { verify: async request => {
      const token = request.headers.get('authorization')?.slice('Bearer '.length) ?? 'stranger';
      return { issuer: 'https://vote-template.test', subject: token };
    } }, access: new AccessAdmissionRegistry(pool), votes,
    platformAccess: new AccessExposure(pool) });
    const request = (method: string, path: string, bearer: string, payload?: object, key?: string) =>
      app.handle(new Request(`http://main.local${path}`, { method,
        headers: { authorization: `Bearer ${bearer}`,
          ...(payload ? { 'content-type': 'application/json' } : {}),
          ...(key ? { 'idempotency-key': key } : {}) },
        ...(payload ? { body: JSON.stringify(payload) } : {}) }));
    const eventFor = async (receipt: string) => {
      const rows = await fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
        SELECT ?batch ?event ?sequence WHERE {
          GRAPH <urn:rezics:graph:outbox> { ?batch rv:event ?event . ?event rv:receipt <${receipt}> }
          GRAPH <urn:rezics:graph:receipts> { <${receipt}> rv:sequence ?sequence }
        }`);
      const row = rows.results?.bindings[0];
      expect(rows.results?.bindings).toHaveLength(1);
      return readMainOutboxEnvelope(fuseki, { batchId: row!.batch!.value,
        eventIds: [row!.event!.value], dataEpoch: Bun.env.MAIN_DATA_EPOCH!,
        routingEpoch: Bun.env.MAIN_ROUTING_EPOCH!, sequence: row!.sequence!.value }, row!.event!.value);
    };
    const input = { profile: 'poll-prepare-v1', poll, body, actingSubject: administrator,
      representationId, grantId,
      charter: { ruleRevision: native(), unitScale: 1, countingUnit: 'weight',
        admittedSeatClasses: ['organization'], allocation: true, quorumThreshold: 1,
        abstention: 'counts', passNumerator: 1, passDenominator: 2, invalidation: 'declared' },
      question: { text: 'Choose', language: 'en' },
      options: [{ key: 'yes', role: 'approve', label: 'Yes' },
        { key: 'no', role: 'reject', label: 'No' }],
      entitlements: [{ holder, seatClass: 'organization', units: 100 }] };
    expect((await request('POST', '/v1/polls', 'administrator', input)).status).toBe(400);
    expect((await request('POST', '/v1/polls', 'stranger', input, 'vote-denied')).status).toBe(403);
    const first = await request('POST', '/v1/polls', 'administrator', input, 'vote-template');
    expect(first.status).toBe(202);
    const pending = await first.json() as { operationId: string };
    expect(pending.operationId).toStartWith('urn:rezics:operation:');
    const graphRead = await request('GET', `/v1/polls/${poll.slice(ID.length)}`, 'administrator');
    expect(graphRead.status).toBe(200);
    expect(await graphRead.json()).toMatchObject({ profile: 'poll-snapshot-v1', poll,
      state: 'draft', issuedUnits: 100, entitlementCount: 1 });
    const retry = await request('POST', '/v1/polls', 'administrator', input, 'vote-template');
    expect(retry.status).toBe(200);
    const committed = await retry.json() as { receipt: string; replayed: boolean; revision: string };
    expect(committed.replayed).toBe(true);
    const admitted = (await pool.query<{ id: string }>(`SELECT id FROM access.admission
      WHERE principal_id = $1 AND action = 'governance.poll.administer' AND idempotency_key = 'vote-template'`,
    [principalId])).rows[0]!;
    expect(committed.receipt).toBe(voteReceiptIri(admitted.id, 'poll.prepare'));
    expect((await eventFor(committed.receipt)).type).toBe('com.rezics.vote.poll-prepared.v1');
    expect((await pool.query(`SELECT 1 FROM access.admission WHERE id = $1
      AND state = 'sealed'`, [admitted.id])).rowCount).toBe(1);
    const conflict = await request('POST', '/v1/polls', 'administrator',
      { ...input, question: { ...input.question, text: 'Changed' } }, 'vote-template');
    expect(conflict.status).toBe(409);
    const secondKey = await request('POST', '/v1/polls', 'administrator', input, 'vote-another-key');
    expect(secondKey.status).toBe(409);
    const cancelledId = (await pool.query<{ id: string }>(`SELECT id FROM access.admission
      WHERE principal_id = $1 AND action = 'governance.poll.administer'
        AND idempotency_key = 'vote-another-key'`, [principalId])).rows[0]!.id;
    expect((await eventFor(voteReceiptIri(cancelledId, 'poll.prepare'))).type)
      .toBe('com.rezics.vote.poll-cancelled.v1');
    const path = `/v1/polls/${poll.slice(ID.length)}`;
    const tally = await request('GET', `${path}/tallies`, 'administrator');
    expect(tally.status).toBe(404);
    // No duplicate poll or weight was created by either retry or conflicting command.
    const count = await fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
      SELECT (COUNT(?e) AS ?n) WHERE { GRAPH <urn:rezics:graph:revisions> {
        ?e a rv:SourceEntitlement ; rv:poll <${poll}> } }`);
    expect(Number(count.results?.bindings[0]?.n?.value)).toBe(1);
    const seat = ID + randomUUID();
    // The root identity is deterministic from poll and the Access counting slot.
    const roots = await fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
      SELECT ?seat WHERE { GRAPH <urn:rezics:graph:revisions> {
        ?seat a rv:SourceEntitlement ; rv:poll <${poll}> ; rv:holder <${holder}> } }`);
    const root = roots.results?.bindings[0]?.seat?.value;
    expect(root).toBeTruthy();
    expect(root).not.toBe(seat);
    const [repOne, repTwo] = [randomUUID(), randomUUID()];
    const [mandateOne, mandateTwo, seatManager] = [randomUUID(), randomUUID(), randomUUID()];
    for (const [principal, subject] of [[repOne, 'representative-one'], [repTwo, 'representative-two']] as const) {
      await pool.query(`INSERT INTO access.principal (id, account_issuer, account_subject)
        VALUES ($1, 'https://vote-template.test', $2)`, [principal, subject]);
      await grantRecordedPlatformUse(pool, principal, ['institutional-voting']);
    }
    for (const [mandate, principal] of [[mandateOne, repOne], [mandateTwo, repTwo]] as const) {
      await pool.query(`INSERT INTO access.representation
        (id, principal_id, subject_id, action, resource_subject, valid_until)
        VALUES ($1,$2,$3,'governance.ballot.operate',$4,now() + interval '1 hour')`,
      [mandate, principal, holder, body]);
    }
    await pool.query(`INSERT INTO access.representation
      (id, principal_id, subject_id, action, valid_until)
      VALUES ($1,$2,$3,'governance.seat.manage',now() + interval '1 hour')`,
    [seatManager, repOne, holder]);
    const charterWrite = await request('POST', `${path}/holder-charters`, 'representative-one', {
      profile: 'holder-charter-v1', entitlement: root, holder, expectedHead: null,
      ruleRevision: native(), rule: 'any-admitted', threshold: null, aggregation: 'whole',
      representationId: seatManager }, 'holder-charter');
    expect(charterWrite.status).toBe(201);
    const charterRead = await request('GET', `${path}/holder-charters/${root!.slice(ID.length)}`,
      'administrator');
    expect(charterRead.status).toBe(200);
    expect(await charterRead.json()).toMatchObject({ rule: 'any-admitted', aggregation: 'whole' });
    const opening = await request('POST', `${path}/openings`, 'administrator', {
      profile: 'poll-opening-v1', actingSubject: administrator, representationId, grantId }, 'open');
    expect(opening.status).toBe(201);
    expect((await request('GET', path, 'administrator')).status).toBe(200);
    const pollRead: { options: { key: string; option: string }[] } =
      await (await request('GET', path, 'administrator')).json();
    const option = pollRead.options;
    expect(option.map(value => value.key)).toEqual(['no', 'yes']);
    const castBody = { profile: 'ballot-v1', seat: root, holder, representationId: mandateOne,
      expectedHead: null, availability: 'cast', shares: [{ option: 'yes', units: 100 }],
      internalPoll: null, approvals: [] };
    loseSeal = true;
    const cast = await request('POST', `${path}/ballots`, 'representative-one', castBody, 'cast-one');
    expect(cast.status).toBe(202);
    const castRetry = await request('POST', `${path}/ballots`, 'representative-one', castBody, 'cast-one');
    expect(castRetry.status).toBe(200);
    const castReceipt = await castRetry.json() as { revision: string };
    const ballot = await request('GET', `${path}/ballots/${root!.slice(ID.length)}`, 'administrator');
    expect(ballot.status).toBe(200);
    expect(await ballot.json()).toMatchObject({ revision: castReceipt.revision,
      availability: 'cast', countedUnits: 100 });
    const changed = { ...castBody, expectedHead: castReceipt.revision,
      shares: [{ option: 'no', units: 100 }] };
    const competing = { ...castBody, representationId: mandateTwo,
      expectedHead: castReceipt.revision };
    const ballotCommands = [
      request.bind(null, 'POST', `${path}/ballots`, 'representative-one', changed, 'change-one'),
      request.bind(null, 'POST', `${path}/ballots`, 'representative-two', competing, 'change-two'),
    ];
    await assertCommandRace(await Promise.all(ballotCommands.map((send) => send())), 201, (index) =>
      ballotCommands[index]!(),
    );
    const finalTally = await request('GET', `${path}/tallies`, 'administrator');
    expect(finalTally.status).toBe(200);
    const distribution = await finalTally.json() as { castSeats: number; castUnits: number;
      options: { key: string; units: number }[] };
    expect(distribution.castSeats).toBe(1);
    expect(distribution.castUnits).toBe(100);
    expect(distribution.options.reduce((sum, item) => sum + item.units, 0)).toBe(100);
    const currentBallot = await (await request('GET', `${path}/ballots/${root!.slice(ID.length)}`,
      'administrator')).json() as { revision: string };
    const withdrawn = await request('POST', `${path}/ballots`, 'representative-two', {
      ...castBody, representationId: mandateTwo, expectedHead: currentBallot.revision,
      availability: 'withdrawn', shares: [] }, 'withdraw-current');
    expect(withdrawn.status).toBe(201);
    const withdrawnRetry = await request('POST', `${path}/ballots`, 'representative-two', {
      ...castBody, representationId: mandateTwo, expectedHead: currentBallot.revision,
      availability: 'withdrawn', shares: [] }, 'withdraw-current');
    expect(withdrawnRetry.status).toBe(200);
    expect(await (await request('GET', `${path}/tallies`, 'administrator')).json())
      .toMatchObject({ castSeats: 0, castUnits: 0, uncastUnits: 100 });

    // A second poll exercises activation before opening and the root/leaf race boundary.
    const splitPoll = native(), child = native(), splitScope = pollScopeId(splitPoll), splitGrant = randomUUID();
    await pool.query('INSERT INTO access.scope_gate (id) VALUES ($1)', [splitScope]);
    await pool.query("INSERT INTO access.authority_subject (id, kind) VALUES ($1, 'agent')", [child]);
    await pool.query(`INSERT INTO access.permission_grant
      (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
      VALUES ($1,$2,$3,$4,'governance.poll.administer',now() + interval '1 hour')`,
    [splitGrant, body, administrator, splitScope]);
    const splitPath = `/v1/polls/${splitPoll.slice(ID.length)}`;
    const splitPrepared = await request('POST', '/v1/polls', 'administrator',
      { ...input, poll: splitPoll, grantId: splitGrant }, 'split-prepare');
    expect(splitPrepared.status).toBe(201);
    const splitRoots = await fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
      SELECT ?seat WHERE { GRAPH <urn:rezics:graph:revisions> {
        ?seat a rv:SourceEntitlement ; rv:poll <${splitPoll}> ; rv:holder <${holder}> } }`);
    const splitRoot = splitRoots.results?.bindings[0]?.seat?.value!;
    const allocationBody = {
      profile: 'poll-allocation-v1', rootEntitlement: splitRoot, holder,
      representationId: seatManager, leaves: [{ holder: child, seatClass: 'organization', units: 40 },
        { holder: child, seatClass: 'organization', units: 40 }],
    };
    loseSeal = true;
    const allocation = await request('POST', `${splitPath}/allocations`, 'representative-one',
      allocationBody, 'split-allocation');
    expect(allocation.status).toBe(202);
    expect((await request('POST', `${splitPath}/allocations`, 'representative-one',
      allocationBody, 'split-allocation')).status).toBe(200);
    const duplicate = await request('POST', `${splitPath}/allocations`, 'representative-one', {
      profile: 'poll-allocation-v1', rootEntitlement: splitRoot, holder,
      representationId: seatManager, leaves: [{ holder: child, seatClass: 'organization', units: 40 }],
    }, 'split-duplicate');
    expect(duplicate.status).toBe(409);
    const splitOpened = await request('POST', `${splitPath}/openings`, 'administrator', {
      profile: 'poll-opening-v1', actingSubject: administrator,
      representationId, grantId: splitGrant }, 'split-open');
    expect(splitOpened.status).toBe(201);
    expect((await request('POST', `${splitPath}/allocations`, 'representative-one',
      allocationBody, 'split-allocation')).status).toBe(200);
    const rootAttempt = await request('POST', `${splitPath}/ballots`, 'representative-one', {
      ...castBody, seat: splitRoot, representationId: mandateOne }, 'split-root-cast');
    expect(rootAttempt.status).toBe(409);
    const splitLeaves = await fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
      SELECT ?seat ?holder ?units WHERE { GRAPH <urn:rezics:graph:revisions> {
        ?seat a rv:AllocationLeaf ; rv:sourceEntitlement <${splitRoot}> ;
          rv:holder ?holder ; rv:leafUnits ?units } }`);
    expect(splitLeaves.results?.bindings).toHaveLength(2);
    const childMandate = randomUUID();
    await pool.query(`INSERT INTO access.representation
      (id, principal_id, subject_id, action, resource_subject, valid_until)
      VALUES ($1,$2,$3,'governance.ballot.operate',$4,now() + interval '1 hour')`,
    [childMandate, repTwo, child, body]);
    for (const leaf of splitLeaves.results!.bindings) {
      const leafHolder = leaf.holder!.value;
      const units = Number(leaf.units!.value);
      const castLeaf = await request('POST', `${splitPath}/ballots`,
        leafHolder === child ? 'representative-two' : 'representative-one', {
          ...castBody, seat: leaf.seat!.value, holder: leafHolder,
          representationId: leafHolder === child ? childMandate : mandateOne,
          shares: [{ option: 'yes', units }] }, `split-${units}`);
      expect(castLeaf.status).toBe(201);
    }
    const splitTally = await request('GET', `${splitPath}/tallies`, 'administrator');
    expect(splitTally.status).toBe(200);
    expect(await splitTally.json()).toMatchObject({ seatCount: 2, countedUnits: 100,
      castSeats: 2, castUnits: 100, uncastUnits: 0 });

    // Opening and activation must serialize: either the root or its leaves freeze.
    const racePoll = native(), raceScope = pollScopeId(racePoll), raceGrant = randomUUID(),
      raceChild = native();
    await pool.query('INSERT INTO access.scope_gate (id) VALUES ($1)', [raceScope]);
    await pool.query("INSERT INTO access.authority_subject (id, kind) VALUES ($1, 'agent')", [raceChild]);
    await pool.query(`INSERT INTO access.permission_grant
      (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
      VALUES ($1,$2,$3,$4,'governance.poll.administer',now() + interval '1 hour')`,
    [raceGrant, body, administrator, raceScope]);
    const racePath = `/v1/polls/${racePoll.slice(ID.length)}`;
    expect((await request('POST', '/v1/polls', 'administrator',
      { ...input, poll: racePoll, grantId: raceGrant }, 'race-prepare')).status).toBe(201);
    const raceRoots = await fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
      SELECT ?seat WHERE { GRAPH <urn:rezics:graph:revisions> {
        ?seat a rv:SourceEntitlement ; rv:poll <${racePoll}> ; rv:holder <${holder}> } }`);
    const raceRoot = raceRoots.results?.bindings[0]?.seat?.value!;
    const [raceActivation, raceOpening] = await Promise.all([
      request('POST', `${racePath}/allocations`, 'representative-one', {
        profile: 'poll-allocation-v1', rootEntitlement: raceRoot, holder,
        representationId: seatManager, leaves: [{ holder: child, seatClass: 'organization', units: 40 },
          { holder: raceChild, seatClass: 'organization', units: 60 }],
      }, 'race-allocate'),
      request('POST', `${racePath}/openings`, 'administrator', {
        profile: 'poll-opening-v1', actingSubject: administrator,
        representationId, grantId: raceGrant }, 'race-open'),
    ]);
    expect([raceActivation.status, raceOpening.status].every(status => status === 201 || status === 409))
      .toBe(true);
    expect([raceActivation.status, raceOpening.status]).toContain(201);
    const racedPoll = await (await request('GET', racePath, 'administrator')).json() as { state: string };
    if (raceActivation.status === 201 && raceOpening.status === 409) {
      expect(racedPoll.state).toBe('draft');
      expect((await request('POST', `${racePath}/openings`, 'administrator', {
        profile: 'poll-opening-v1', actingSubject: administrator,
        representationId, grantId: raceGrant }, 'race-open-after-allocation')).status).toBe(201);
    } else expect(racedPoll.state).toBe('open');
    const raceTally = await (await request('GET', `${racePath}/tallies`, 'administrator')).json() as {
      seatCount: number; countedUnits: number };
    expect(raceTally.countedUnits).toBe(100);
    expect(raceTally.seatCount).toBe(raceActivation.status === 201 ? 2 : 1);
    expect((await request('POST', `${racePath}/ballots`, 'representative-one', {
      ...castBody, seat: raceRoot }, 'race-root-ballot')).status)
      .toBe(raceActivation.status === 201 ? 409 : 201);

    const approvalPoll = native(), approvalScope = pollScopeId(approvalPoll),
      approvalGrant = randomUUID();
    await pool.query('INSERT INTO access.scope_gate (id) VALUES ($1)', [approvalScope]);
    await pool.query(`INSERT INTO access.permission_grant
      (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
      VALUES ($1,$2,$3,$4,'governance.poll.administer',now() + interval '1 hour')`,
    [approvalGrant, body, administrator, approvalScope]);
    const approvalPath = `/v1/polls/${approvalPoll.slice(ID.length)}`;
    expect((await request('POST', '/v1/polls', 'administrator',
      { ...input, poll: approvalPoll, grantId: approvalGrant }, 'approval-prepare')).status).toBe(201);
    const approvalRoots = await fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
      SELECT ?seat WHERE { GRAPH <urn:rezics:graph:revisions> {
        ?seat a rv:SourceEntitlement ; rv:poll <${approvalPoll}> ; rv:holder <${holder}> } }`);
    const approvalRoot = approvalRoots.results?.bindings[0]?.seat?.value!;
    const charterSet = await request('POST', `${approvalPath}/holder-charters`, 'representative-one', {
      profile: 'holder-charter-v1', entitlement: approvalRoot, holder, expectedHead: null,
      ruleRevision: native(), rule: 'k-of-n', threshold: 2, aggregation: 'whole',
      representationId: seatManager }, 'approval-charter');
    expect(charterSet.status).toBe(201);
    const charterRevision = (await charterSet.json() as { revision: string }).revision;
    const duplicatePrincipalMandate = randomUUID();
    await pool.query(`INSERT INTO access.representation
      (id, principal_id, subject_id, action, resource_subject, valid_until)
      VALUES ($1,$2,$3,'governance.ballot.operate',$4,now() + interval '1 hour')`,
    [duplicatePrincipalMandate, repOne, holder, body]);
    const duplicatePolicy = await request('POST', `${approvalPath}/representative-policies`,
      'representative-one', { profile: 'vote-representative-policy-v1',
        entitlement: approvalRoot, holder, representationId: seatManager,
        expectedRevision: null, holderCharterRevision: charterRevision,
        members: [{ role: 'approver', representationId: mandateOne },
          { role: 'approver', representationId: duplicatePrincipalMandate },
          { role: 'approver', representationId: mandateTwo }] }, 'duplicate-policy');
    expect(duplicatePolicy.status).toBe(403);
    const policySet = await request('POST', `${approvalPath}/representative-policies`,
      'representative-one', { profile: 'vote-representative-policy-v1',
        entitlement: approvalRoot, holder, representationId: seatManager,
        expectedRevision: null, holderCharterRevision: charterRevision,
        members: [{ role: 'approver', representationId: mandateOne },
          { role: 'approver', representationId: mandateTwo }] }, 'approval-policy');
    expect(policySet.status).toBe(201);
    expect((await request('POST', `${approvalPath}/openings`, 'administrator', {
      profile: 'poll-opening-v1', actingSubject: administrator,
      representationId, grantId: approvalGrant }, 'approval-open')).status).toBe(201);
    const candidate = { expectedHead: null, availability: 'cast',
      shares: [{ option: 'yes', units: 100 }], internalPoll: null };
    const wrongChoice = { ...candidate, shares: [{ option: 'no', units: 100 }] };
    const approve = (who: string, mandate: string, proposed: typeof candidate, key: string) =>
      request('POST', `${approvalPath}/mandate-approvals`, who, {
        profile: 'mandate-approval-v1', seat: approvalRoot, holder,
        representationId: mandate, candidate: proposed }, key);
    const approvalOne = await approve('representative-one', mandateOne, candidate, 'approve-one');
    const samePrincipal = await approve('representative-one', mandateOne,
      candidate, 'approve-same-principal');
    const mixed = await approve('representative-two', mandateTwo, wrongChoice, 'approve-wrong');
    expect(approvalOne.status).toBe(201);
    expect(samePrincipal.status).toBe(409);
    expect(mixed.status).toBe(201);
    const approvalOneIri = (await approvalOne.json() as { revision: string }).revision;
    const mixedIri = (await mixed.json() as { revision: string }).revision;
    const ballotBody = { ...castBody, seat: approvalRoot,
      approvals: [approvalOneIri, mixedIri] };
    expect((await request('POST', `${approvalPath}/ballots`, 'representative-one',
      ballotBody, 'mixed-ballot')).status).toBe(409);
    const approvalTwo = await approve('representative-two', mandateTwo, candidate, 'approve-two');
    expect(approvalTwo.status).toBe(201);
    const approvalTwoIri = (await approvalTwo.json() as { revision: string }).revision;
    const approvedBallot = await request('POST', `${approvalPath}/ballots`, 'representative-one',
      { ...ballotBody, approvals: [approvalOneIri, approvalTwoIri] }, 'approved-ballot');
    expect(approvedBallot.status).toBe(201);
    const approvalHead = (await approvedBallot.json() as { revision: string }).revision;
    expect((await request('POST', `${approvalPath}/ballots`, 'representative-one', {
      ...ballotBody, expectedHead: approvalHead, approvals: [approvalOneIri, approvalTwoIri],
    }, 'stale-approvals')).status).toBe(409);
    expect(await (await request('GET', `${approvalPath}/tallies`, 'administrator')).json())
      .toMatchObject({ castSeats: 1, castUnits: 100 });
    expect((await request('POST', `${approvalPath}/closures`, 'administrator', {
      profile: 'poll-closure-v1', actingSubject: administrator,
      representationId, grantId: approvalGrant }, 'approval-close')).status).toBe(201);
    expect((await request('POST', `${approvalPath}/resolutions`, 'administrator', {
      profile: 'poll-resolution-v1', actingSubject: administrator,
      representationId, grantId: approvalGrant }, 'approval-finalize')).status).toBe(201);
    const approvalResolution = await fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
      SELECT ?seats WHERE { GRAPH <urn:rezics:graph:current> {
        <${approvalPoll}> rv:pollResolution ?resolution }
        GRAPH <urn:rezics:graph:revisions> { ?resolution rv:countedSeats ?seats } }`);
    expect(approvalResolution.results?.bindings[0]?.seats?.value).toBe('1');

    const abstainPoll = native(), abstainScope = pollScopeId(abstainPoll), abstainGrant = randomUUID();
    await pool.query('INSERT INTO access.scope_gate (id) VALUES ($1)', [abstainScope]);
    await pool.query(`INSERT INTO access.permission_grant
      (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
      VALUES ($1,$2,$3,$4,'governance.poll.administer',now() + interval '1 hour')`,
    [abstainGrant, body, administrator, abstainScope]);
    const abstainPath = `/v1/polls/${abstainPoll.slice(ID.length)}`;
    expect((await request('POST', '/v1/polls', 'administrator', {
      ...input, poll: abstainPoll, grantId: abstainGrant,
      charter: { ...input.charter, abstention: 'excluded', quorumThreshold: 1 },
      options: [...input.options, { key: 'abstain', role: 'abstain', label: 'Abstain' }],
      entitlements: [{ holder, seatClass: 'organization', units: 40 },
        { holder: child, seatClass: 'organization', units: 60 }],
    }, 'abstain-prepare')).status).toBe(201);
    const abstainRoots = await fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
      SELECT ?seat WHERE { GRAPH <urn:rezics:graph:revisions> {
        ?seat a rv:SourceEntitlement ; rv:poll <${abstainPoll}> ; rv:holder <${holder}> } }`);
    const abstainSeat = abstainRoots.results?.bindings[0]?.seat?.value!;
    expect((await request('POST', `${abstainPath}/openings`, 'administrator', {
      profile: 'poll-opening-v1', actingSubject: administrator,
      representationId, grantId: abstainGrant }, 'abstain-open')).status).toBe(201);
    expect((await request('POST', `${abstainPath}/ballots`, 'representative-two', {
      ...castBody, seat: abstainSeat, representationId: mandateTwo,
      shares: [{ option: 'abstain', units: 40 }] }, 'abstain-cast')).status).toBe(201);
    expect(await (await request('GET', `${abstainPath}/tallies`, 'administrator')).json())
      .toMatchObject({ seatCount: 2, countedUnits: 100, castSeats: 1,
        castUnits: 40, abstainUnits: 40, uncastUnits: 60 });
    expect((await request('POST', `${abstainPath}/closures`, 'administrator', {
      profile: 'poll-closure-v1', actingSubject: administrator,
      representationId, grantId: abstainGrant }, 'abstain-close')).status).toBe(201);
    expect((await request('POST', `${abstainPath}/resolutions`, 'administrator', {
      profile: 'poll-resolution-v1', actingSubject: administrator,
      representationId, grantId: abstainGrant }, 'abstain-finalize')).status).toBe(201);
    expect(await (await request('GET', `${abstainPath}/resolutions`, 'administrator')).json())
      .toMatchObject({ outcome: 'no-quorum', winningOption: null });

    const internalPoll = native(), internalScope = pollScopeId(internalPoll),
      internalGrant = randomUUID(), another = native();
    await pool.query('INSERT INTO access.scope_gate (id) VALUES ($1)', [internalScope]);
    await pool.query("INSERT INTO access.authority_subject (id, kind) VALUES ($1, 'agent')", [another]);
    await pool.query(`INSERT INTO access.permission_grant
      (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
      VALUES ($1,$2,$3,$4,'governance.poll.administer',now() + interval '1 hour')`,
    [internalGrant, holder, administrator, internalScope]);
    const internalPath = `/v1/polls/${internalPoll.slice(ID.length)}`;
    expect((await request('POST', '/v1/polls', 'administrator', {
      ...input, poll: internalPoll, body: holder, grantId: internalGrant,
      entitlements: [{ holder: child, seatClass: 'organization', units: 40 },
        { holder: another, seatClass: 'organization', units: 60 }],
    }, 'internal-prepare')).status).toBe(201);
    const internalRoots = await fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
      SELECT ?seat ?holder ?units WHERE { GRAPH <urn:rezics:graph:revisions> {
        ?seat a rv:SourceEntitlement ; rv:poll <${internalPoll}> ;
          rv:holder ?holder ; rv:issuedUnits ?units } }`);
    expect(internalRoots.results?.bindings).toHaveLength(2);
    const internalChildMandate = randomUUID(), internalOtherMandate = randomUUID();
    for (const [mandate, principal, subject] of [
      [internalChildMandate, repTwo, child], [internalOtherMandate, repOne, another],
    ]) {
      await pool.query(`INSERT INTO access.representation
        (id, principal_id, subject_id, action, resource_subject, valid_until)
        VALUES ($1,$2,$3,'governance.ballot.operate',$4,now() + interval '1 hour')`,
      [mandate, principal, subject, holder]);
    }
    expect((await request('POST', `${internalPath}/openings`, 'administrator', {
      profile: 'poll-opening-v1', actingSubject: administrator,
      representationId, grantId: internalGrant }, 'internal-open')).status).toBe(201);
    for (const rootSeat of internalRoots.results!.bindings) {
      const rootHolder = rootSeat.holder!.value;
      const units = Number(rootSeat.units!.value);
      const castInternal = await request('POST', `${internalPath}/ballots`,
        rootHolder === child ? 'representative-two' : 'representative-one', {
          ...castBody, seat: rootSeat.seat!.value, holder: rootHolder,
          representationId: rootHolder === child ? internalChildMandate : internalOtherMandate,
          shares: [{ option: rootHolder === child ? 'no' : 'yes', units }],
        }, `internal-${units}`);
      expect(castInternal.status).toBe(201);
    }
    const internalClosure = {
      profile: 'poll-closure-v1', actingSubject: administrator,
      representationId, grantId: internalGrant };
    expect((await request('POST', `${internalPath}/closures`, 'administrator',
      internalClosure, 'internal-close')).status).toBe(201);
    const internalFinalization = {
      profile: 'poll-resolution-v1', actingSubject: administrator,
      representationId, grantId: internalGrant };
    const finalized = await request('POST', `${internalPath}/resolutions`, 'administrator',
      internalFinalization, 'internal-finalize');
    expect(finalized.status).toBe(201);
    expect((await request('POST', `${internalPath}/closures`, 'administrator',
      internalClosure, 'internal-close')).status).toBe(200);
    expect((await request('POST', `${internalPath}/resolutions`, 'administrator',
      internalFinalization, 'internal-finalize')).status).toBe(200);
    const internalResolution = await request('GET', `${internalPath}/resolutions`, 'administrator');
    expect(internalResolution.status).toBe(200);
    expect(await internalResolution.json()).toMatchObject({ outcome: 'adopted' });

    for (const aggregation of ['whole', 'proportional'] as const) {
      const externalPoll = native(), externalScope = pollScopeId(externalPoll),
        externalGrant = randomUUID();
      await pool.query('INSERT INTO access.scope_gate (id) VALUES ($1)', [externalScope]);
      await pool.query(`INSERT INTO access.permission_grant
        (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
        VALUES ($1,$2,$3,$4,'governance.poll.administer',now() + interval '1 hour')`,
      [externalGrant, body, administrator, externalScope]);
      const externalPath = `/v1/polls/${externalPoll.slice(ID.length)}`;
      expect((await request('POST', '/v1/polls', 'administrator',
        { ...input, poll: externalPoll, grantId: externalGrant }, `${aggregation}-prepare`)).status).toBe(201);
      const externalRoots = await fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
        SELECT ?seat WHERE { GRAPH <urn:rezics:graph:revisions> {
          ?seat a rv:SourceEntitlement ; rv:poll <${externalPoll}> ; rv:holder <${holder}> } }`);
      const externalRoot = externalRoots.results?.bindings[0]?.seat?.value!;
      expect((await request('POST', `${externalPath}/holder-charters`, 'representative-one', {
        profile: 'holder-charter-v1', entitlement: externalRoot, holder,
        expectedHead: null, ruleRevision: native(), rule: 'internal-decision',
        threshold: null, aggregation, representationId: seatManager },
      `${aggregation}-charter`)).status).toBe(201);
      expect((await request('POST', `${externalPath}/openings`, 'administrator', {
        profile: 'poll-opening-v1', actingSubject: administrator,
        representationId, grantId: externalGrant }, `${aggregation}-open`)).status).toBe(201);
      const externalBallot = { ...castBody, seat: externalRoot, internalPoll,
        shares: [{ option: 'no', units: 100 }] };
      expect((await request('POST', `${externalPath}/ballots`, 'representative-one',
        externalBallot, `${aggregation}-wrong`)).status).toBe(409);
      const shares = aggregation === 'whole' ? [{ option: 'yes', units: 100 }]
        : [{ option: 'no', units: 40 }, { option: 'yes', units: 60 }];
      expect((await request('POST', `${externalPath}/ballots`, 'representative-one',
        { ...externalBallot, shares }, `${aggregation}-cast`)).status).toBe(201);
      expect(await (await request('GET', `${externalPath}/tallies`, 'administrator')).json())
        .toMatchObject({ castSeats: 1, castUnits: 100 });
    }

    const [personaOne, personaTwo] = [native(), native()];
    for (const persona of [personaOne, personaTwo]) {
      await pool.query("INSERT INTO access.authority_subject (id, kind) VALUES ($1, 'agent')", [persona]);
      await pool.query(`INSERT INTO access.representation
        (id, principal_id, subject_id, action, valid_until)
        VALUES ($1,$2,$3,'agent.control','infinity')`,
      [randomUUID(), repOne, persona]);
    }
    const personPoll = native();
    const personal = await request('POST', '/v1/polls', 'administrator', {
      ...input, poll: personPoll,
      charter: { ...input.charter, countingUnit: 'persons', admittedSeatClasses: ['person'] },
      entitlements: [
        { holder: personaOne, seatClass: 'person', units: 1 },
        { holder: personaTwo, seatClass: 'person', units: 1 },
      ],
    }, 'duplicate-person');
    expect(personal.status).toBe(409);
    expect((await personal.json() as { code: string }).code).toBe('duplicate_counting_identity');

    const corporatePoll = native(), corporateScope = pollScopeId(corporatePoll),
      corporateGrant = randomUUID(), otherMandate = randomUUID();
    await pool.query('INSERT INTO access.scope_gate (id) VALUES ($1)', [corporateScope]);
    await pool.query(`INSERT INTO access.permission_grant
      (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
      VALUES ($1,$2,$3,$4,'governance.poll.administer',now() + interval '1 hour')`,
    [corporateGrant, body, administrator, corporateScope]);
    await pool.query(`INSERT INTO access.representation
      (id, principal_id, subject_id, action, resource_subject, valid_until)
      VALUES ($1,$2,$3,'governance.ballot.operate',$4,now() + interval '1 hour')`,
    [otherMandate, repOne, another, body]);
    const corporatePath = `/v1/polls/${corporatePoll.slice(ID.length)}`;
    expect((await request('POST', '/v1/polls', 'administrator', {
      ...input, poll: corporatePoll, grantId: corporateGrant,
      entitlements: [{ holder, seatClass: 'organization', units: 1 },
        { holder: another, seatClass: 'organization', units: 1 }],
    }, 'corporate-prepare')).status).toBe(201);
    const corporateRoots = await fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
      SELECT ?seat WHERE { GRAPH <urn:rezics:graph:revisions> {
        ?seat a rv:SourceEntitlement ; rv:poll <${corporatePoll}> ; rv:holder <${holder}> } }`);
    const corporateRoot = corporateRoots.results?.bindings[0]?.seat?.value!;
    const copiedSlot = await request('POST', `${corporatePath}/allocations`, 'representative-one', {
      profile: 'poll-allocation-v1', rootEntitlement: corporateRoot, holder,
      representationId: seatManager,
      leaves: [{ holder: another, seatClass: 'organization', units: 1 }],
    }, 'corporate-copy-slot');
    expect(copiedSlot.status).toBe(409);
    expect((await request('POST', `${corporatePath}/openings`, 'administrator', {
      profile: 'poll-opening-v1', actingSubject: administrator,
      representationId, grantId: corporateGrant }, 'corporate-open')).status).toBe(201);
    const corporateSeats = await fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
      SELECT ?seat ?holder WHERE { GRAPH <urn:rezics:graph:revisions> {
        ?seat a rv:SourceEntitlement ; rv:poll <${corporatePoll}> ; rv:holder ?holder } }`);
    expect(corporateSeats.results?.bindings).toHaveLength(2);
    for (const corporate of corporateSeats.results!.bindings) {
      expect((await request('POST', `${corporatePath}/ballots`, 'representative-one', {
        ...castBody, seat: corporate.seat!.value, holder: corporate.holder!.value,
        representationId: corporate.holder!.value === holder ? mandateOne : otherMandate,
        shares: [{ option: 'yes', units: 1 }],
      }, `corporate-${corporate.holder!.value.slice(ID.length)}`)).status).toBe(201);
    }
    expect(await (await request('GET', `${corporatePath}/tallies`, 'administrator')).json())
      .toMatchObject({ seatCount: 2, castSeats: 2, castUnits: 2 });

    // Removing an operator cannot erase the frozen seat or authorize another mutation.
    const frozenHead = (await (await request('GET', `${path}/ballots/${root!.slice(ID.length)}`,
      'administrator')).json() as { revision: string }).revision;
    await pool.query('UPDATE access.representation SET active = false WHERE id = $1', [mandateOne]);
    expect((await request('POST', `${path}/ballots`, 'representative-one', {
      ...castBody, expectedHead: frozenHead }, 'departed-operator')).status).toBe(403);
    const replacement = await request('POST', `${path}/ballots`, 'representative-two', {
      ...castBody, representationId: mandateTwo, expectedHead: frozenHead },
    'replacement-operator');
    expect(replacement.status).toBe(201);
    expect(await (await request('GET', `${path}/tallies`, 'administrator')).json())
      .toMatchObject({ seatCount: 1, countedUnits: 100, castSeats: 1, castUnits: 100 });

    // The body makes a separate, digest-bound invalidation decision; the old cast remains historical.
    const invalidatorRepresentation = randomUUID(), invalidatorGrant = randomUUID();
    await pool.query(`INSERT INTO access.representation
      (id, principal_id, subject_id, action, valid_until)
      VALUES ($1,$2,$3,'governance.ballot.invalidate', now() + interval '1 hour')`,
    [invalidatorRepresentation, principalId, administrator]);
    await pool.query(`INSERT INTO access.permission_grant
      (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
      VALUES ($1,$2,$3,$4,'governance.ballot.invalidate', now() + interval '1 hour')`,
    [invalidatorGrant, body, administrator, scope]);
    const replacementHead = (await replacement.json() as { revision: string }).revision;
    const invalidation = { profile: 'ballot-invalidation-v1', seat: root, holder,
      expectedHead: replacementHead, ruleRevision: input.charter.ruleRevision,
      evidenceDigest: 'a'.repeat(64), actingSubject: administrator,
      representationId: invalidatorRepresentation, grantId: invalidatorGrant };
    expect((await request('POST', `${path}/ballot-invalidations`, 'administrator',
      { ...invalidation, expectedHead: frozenHead }, 'invalidation-stale')).status).toBe(409);
    expect((await request('POST', `${path}/ballot-invalidations`, 'representative-two', {
      ...invalidation, actingSubject: holder, representationId: mandateTwo },
    'invalidation-with-cast-mandate')).status).toBe(403);
    const invalidated = await request('POST', `${path}/ballot-invalidations`,
      'administrator', invalidation, 'invalidation-decision');
    expect(invalidated.status).toBe(201);
    const invalidationReceipt = await invalidated.json() as { revision: string; receipt: string };
    expect((await request('POST', `${path}/ballot-invalidations`, 'administrator',
      invalidation, 'invalidation-decision')).status).toBe(200);
    expect(await (await request('GET', `${path}/ballots/${root!.slice(ID.length)}`,
      'administrator')).json()).toMatchObject({ revision: invalidationReceipt.revision,
      predecessor: replacementHead, availability: 'invalidated', countedUnits: 0, shares: [] });
    expect(await (await request('GET', `${path}/tallies`, 'administrator')).json())
      .toMatchObject({ seatCount: 1, countedUnits: 100, castSeats: 0, castUnits: 0,
        uncastUnits: 100 });
    const preservedCast = await fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
      SELECT ?availability WHERE { GRAPH <urn:rezics:graph:revisions> {
        <${replacementHead}> rv:ballotAvailability ?availability } }`);
    expect(preservedCast.results?.bindings[0]?.availability?.value)
      .toBe('https://rezics.com/vocab/BallotCast');
    expect((await eventFor(invalidationReceipt.receipt)).type)
      .toBe('com.rezics.vote.ballot-invalidated.v1');

    // One frozen proxy hop shares the source seat's single ballot head with a holder override.
    const proxyPoll = native(), proxyScope = pollScopeId(proxyPoll), proxyGrant = randomUUID();
    await pool.query('INSERT INTO access.scope_gate (id) VALUES ($1)', [proxyScope]);
    await pool.query(`INSERT INTO access.permission_grant
      (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
      VALUES ($1,$2,$3,$4,'governance.poll.administer',now() + interval '1 hour')`,
    [proxyGrant, body, administrator, proxyScope]);
    const proxyPath = `/v1/polls/${proxyPoll.slice(ID.length)}`;
    expect((await request('POST', '/v1/polls', 'administrator', { ...input,
      poll: proxyPoll, grantId: proxyGrant, charter: { ...input.charter,
        proxy: 'one-hop', holderOverride: true }, entitlements: [
        { holder, seatClass: 'organization', units: 100 },
        { holder: child, seatClass: 'organization', units: 20 }],
    }, 'proxy-prepare')).status).toBe(201);
    const proxySeats = await fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
      SELECT ?seat ?holder WHERE { GRAPH <urn:rezics:graph:revisions> {
        ?seat a rv:SourceEntitlement ; rv:poll <${proxyPoll}> ; rv:holder ?holder } }`);
    const holderSeat = proxySeats.results?.bindings.find(row => row.holder?.value === holder)?.seat?.value;
    const childSeat = proxySeats.results?.bindings.find(row => row.holder?.value === child)?.seat?.value;
    expect(holderSeat).toBeTruthy();
    expect(childSeat).toBeTruthy();
    const routeIntent = { profile: 'ballot-proxy-v1', action: 'designate', seat: holderSeat,
      holder, proxy: child, expectedHead: null, representationId: seatManager };
    const designated = await request('POST', `${proxyPath}/proxies`, 'representative-one',
      routeIntent, 'proxy-designate');
    expect(designated.status).toBe(201);
    const designatedReceipt = await designated.json() as { revision: string; receipt: string };
    expect((await request('POST', `${proxyPath}/proxies`, 'representative-one',
      routeIntent, 'proxy-designate')).status).toBe(200);
    expect((await eventFor(designatedReceipt.receipt)).type).toBe('com.rezics.vote.proxy-designated.v1');
    expect((await request('POST', `${proxyPath}/allocations`, 'representative-one', {
      profile: 'poll-allocation-v1', rootEntitlement: holderSeat, holder,
      representationId: seatManager,
      leaves: [{ holder: another, seatClass: 'organization', units: 40 }],
    }, 'proxy-allocation-conflict')).status).toBe(409);
    const childManager = randomUUID();
    await pool.query(`INSERT INTO access.representation
      (id, principal_id, subject_id, action, valid_until)
      VALUES ($1,$2,$3,'governance.seat.manage',now() + interval '1 hour')`,
    [childManager, repTwo, child]);
    expect((await request('POST', `${proxyPath}/proxies`, 'representative-two', {
      ...routeIntent, seat: childSeat, holder: child, proxy: holder,
      representationId: childManager }, 'proxy-cycle')).status).toBe(409);
    expect((await request('POST', `${proxyPath}/openings`, 'administrator', {
      profile: 'poll-opening-v1', actingSubject: administrator,
      representationId, grantId: proxyGrant }, 'proxy-open')).status).toBe(201);
    expect((await request('POST', `${proxyPath}/proxies`, 'representative-two', {
      ...routeIntent, seat: childSeat, holder: child, proxy: another,
      representationId: childManager }, 'proxy-late')).status).toBe(409);
    const proxyMandate = randomUUID();
    await pool.query(`INSERT INTO access.representation
      (id, principal_id, subject_id, action, resource_subject, valid_until)
      VALUES ($1,$2,$3,'governance.ballot.operate',$4,now() + interval '1 hour')`,
    [proxyMandate, repTwo, child, body]);
    const proxyCast = await request('POST', `${proxyPath}/ballots`, 'representative-two', {
      ...castBody, seat: holderSeat, proxySubject: child, proxyRoute: designatedReceipt.revision,
      representationId: proxyMandate, expectedHead: null }, 'proxy-cast');
    expect(proxyCast.status).toBe(201);
    const proxyHead = (await proxyCast.json() as { revision: string }).revision;
    expect(await (await request('GET', `${proxyPath}/ballots/${holderSeat!.slice(ID.length)}`,
      'administrator')).json()).toMatchObject({ revision: proxyHead, castRoute: 'proxy',
      proxyRoute: designatedReceipt.revision });
    const override = await request('POST', `${proxyPath}/ballots`, 'representative-two', {
      ...castBody, seat: holderSeat, representationId: mandateTwo, expectedHead: proxyHead }, 'proxy-override');
    expect(override.status).toBe(201);
    const overrideHead = (await override.json() as { revision: string }).revision;
    expect(await (await request('GET', `${proxyPath}/ballots/${holderSeat!.slice(ID.length)}`,
      'administrator')).json()).toMatchObject({ revision: overrideHead,
      predecessor: proxyHead, castRoute: 'override' });
    expect(await (await request('GET', `${proxyPath}/tallies`, 'administrator')).json())
      .toMatchObject({ seatCount: 2, countedUnits: 120, castSeats: 1, castUnits: 100 });
    const revoked = await request('POST', `${proxyPath}/proxies`, 'representative-one', {
      ...routeIntent, action: 'revoke', expectedHead: designatedReceipt.revision }, 'proxy-revoke');
    expect(revoked.status).toBe(201);
    expect((await request('POST', `${proxyPath}/ballots`, 'representative-two', {
      ...castBody, seat: holderSeat, proxySubject: child, proxyRoute: designatedReceipt.revision,
      representationId: proxyMandate, expectedHead: overrideHead }, 'revoked-proxy-cast')).status).toBe(409);

    // A proposal's immutable effect basis is attached to the poll and its adopting resolution.
    const proposalPoll = native(), proposal = native(), proposalScope = pollScopeId(proposalPoll);
    const proposalGrant = randomUUID(), effectTarget = native(), effectDigest = 'b'.repeat(64);
    await pool.query('INSERT INTO access.scope_gate (id) VALUES ($1)', [proposalScope]);
    await pool.query(`INSERT INTO access.permission_grant
      (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
      VALUES ($1,$2,$3,$4,'governance.poll.administer',now() + interval '1 hour')`,
    [proposalGrant, body, administrator, proposalScope]);
    const proposalInput = { ...input, poll: proposalPoll, grantId: proposalGrant,
      proposal: { proposal, effectDigest, effectTarget,
        effectCapability: 'realm.policy.update', expectedTargetState: 'c'.repeat(64) } };
    expect((await request('POST', '/v1/polls', 'administrator', {
      ...proposalInput, proposal: { ...proposalInput.proposal,
        effectCapability: 'governance.poll.administer' } }, 'proposal-out-of-scope')).status).toBe(409);
    expect((await request('POST', '/v1/polls', 'administrator', proposalInput,
      'proposal-prepare')).status).toBe(201);
    const proposalPath = `/v1/polls/${proposalPoll.slice(ID.length)}`;
    const proposalView = (await (await request('GET', proposalPath, 'administrator')).json()) as {
      proposal: string; proposalRevision: string };
    expect(proposalView.proposal).toBe(proposal);
    expect(proposalView.proposalRevision).toStartWith(ID);
    const proposalSeats = await fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
      SELECT ?seat WHERE { GRAPH <urn:rezics:graph:revisions> {
        ?seat a rv:SourceEntitlement ; rv:poll <${proposalPoll}> ; rv:holder <${holder}> } }`);
    const proposalSeat = proposalSeats.results?.bindings[0]?.seat?.value;
    expect(proposalSeat).toBeTruthy();
    expect((await request('POST', `${proposalPath}/openings`, 'administrator', {
      profile: 'poll-opening-v1', actingSubject: administrator,
      representationId, grantId: proposalGrant }, 'proposal-open')).status).toBe(201);
    expect((await request('POST', `${proposalPath}/ballots`, 'representative-two', {
      ...castBody, seat: proposalSeat, representationId: mandateTwo }, 'proposal-cast')).status).toBe(201);
    expect((await request('POST', `${proposalPath}/closures`, 'administrator', {
      profile: 'poll-closure-v1', actingSubject: administrator,
      representationId, grantId: proposalGrant }, 'proposal-close')).status).toBe(201);
    expect((await request('POST', `${proposalPath}/resolutions`, 'administrator', {
      profile: 'poll-resolution-v1', actingSubject: administrator,
      representationId, grantId: proposalGrant }, 'proposal-finalize')).status).toBe(201);
    expect(await (await request('GET', `${proposalPath}/resolutions`, 'administrator')).json())
      .toMatchObject({ outcome: 'adopted', proposalRevision: proposalView.proposalRevision,
        effectDigest });
    const proposalState = await fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
      SELECT ?state WHERE { GRAPH <urn:rezics:graph:current> {
        <${proposal}> rv:proposalState ?state } }`);
    expect(proposalState.results?.bindings[0]?.state?.value)
      .toBe('https://rezics.com/vocab/ProposalAdopted');
  } finally { await pool.end(); }
}, 120_000);
