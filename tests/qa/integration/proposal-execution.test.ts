import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { expect, test } from 'bun:test';
import { Pool } from 'pg';
import { createMainApp } from '../../../services/main/src/app.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { AccessManagedOrganizations, type ManagedGrantChangeResult, type OrgManagementState }
  from '../../../services/main/src/modules/access/managed-organizations.ts';
import { AccessProposalExecutions } from '../../../services/main/src/modules/proposal/access.ts';
import { readMainOutboxEnvelope } from '../../../services/main/src/modules/outbox/relay.ts';
import { proposalDigest } from '../../../services/main/src/modules/proposal/execute.ts';
import { GRAPHS, ID, RV, iri, lit } from '../../../services/main/src/modules/work/activate.ts';
import { cloneQaOwnerDatabases } from '../support/databases.ts';
import { seedOrgRealm } from '../support/org-realm.ts';
import { seedManagedOrganization } from '../support/managed-organization.ts';
import { ratingAccount } from '../support/rating-account.ts';
import { assertCommandRace } from '../support/command-race.ts';

const root = resolve(import.meta.dir, '../../..');
const native = () => ID + randomUUID();

test('GOV23: adopted proposal executes one scoped roster effect and recovers the same operation ID', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.FUSEKI_URL) throw new Error('Use the QA integration tier');
  const databases = await cloneQaOwnerDatabases(Bun.env.REZICS_QA_RUN_ID, ['account', 'access'], 'owner');
  const pool = new Pool({ connectionString: databases.urls.access });
  const account = await ratingAccount({ ...Bun.env, ACCOUNT_DATABASE_URL: databases.urls.account } as
    Record<string, string>, 'openid vote:manage access:manage');
  const fuseki = new FusekiClient(Bun.env.FUSEKI_URL);
  let loseGraphResponse = true;
  class InterruptedFuseki extends FusekiClient {
    override async commandWithReceipt(...args: Parameters<FusekiClient['commandWithReceipt']>) {
      const result = await super.commandWithReceipt(...args);
      if (loseGraphResponse) { loseGraphResponse = false; throw new Error('lost Jena response'); }
      return result;
    }
  }
  const commandFuseki = new InterruptedFuseki(Bun.env.FUSEKI_URL);
  const env = { fuseki, lineage: { dataEpoch: Bun.env.MAIN_DATA_EPOCH!, routingEpoch: Bun.env.MAIN_ROUTING_EPOCH! },
    objectDirectory: join(root, '.temp', `proposal-execution-${randomUUID()}`) };
  try {
    const fixture = await seedOrgRealm(pool, account.issuer, { org: account.a.id, realm: account.b.id });
    const managed = await seedManagedOrganization(pool, fixture);
    const owner = new AccessManagedOrganizations(pool);
    const readApp = createMainApp(fuseki, { environment: env, account: account.verifier, managedOrganizations: owner });
    const readState = async () => {
      const response = await readApp.handle(new Request('http://main.local/v1/access/organization-management?'
        + new URLSearchParams({ organizationSubject: fixture.org }),
      { headers: { authorization: `Bearer ${account.tokenA}` } }));
      expect(response.status).toBe(200);
      return await response.json() as OrgManagementState;
    };
    const current = await readState();
    const issuedResponse = await readApp.handle(new Request('http://main.local/v1/access/managed-organization-grants', {
      method: 'POST', headers: { authorization: `Bearer ${account.tokenA}`, 'content-type': 'application/json',
        'idempotency-key': `proposal-grant-${randomUUID()}` }, body: JSON.stringify({
      profile: 'access-managed-organization-grant-v1', operation: 'issue',
      organizationSubject: fixture.org, expectedAuthorityEpoch: current.authorityEpoch,
      recipient: { kind: 'realm', id: fixture.realm }, actions: ['access.org.roster.policy'],
      delegationCeiling: 0, validFrom: new Date(Date.now() - 1000).toISOString(),
      validUntil: new Date(Date.now() + 1_200_000).toISOString(),
    }) }));
    expect(issuedResponse.status).toBe(200);
    const issued = await issuedResponse.json() as ManagedGrantChangeResult;
    const recipientResponse = await readApp.handle(new Request(
      `http://main.local/v1/access/managed-organization-grants/${issued.grantId}?side=recipient`,
      { headers: { authorization: `Bearer ${account.tokenB}` } }));
    expect(recipientResponse.status).toBe(200);
    const recipient = await recipientResponse.json() as { representation: { id: string; generation: string } };
    const effect = { profile: 'access-organization-roster-policy-v1' as const,
      organizationSubject: fixture.org, recipient: { kind: 'realm' as const, id: fixture.realm },
      grantId: issued.grantId, expectedGrantGeneration: issued.generation,
      representationId: recipient.representation.id, expectedRepresentationGeneration: recipient.representation.generation,
      expectedPolicyRevision: current.policyRevision, admissionsOpen: false };
    const effectDigest = proposalDigest(effect);
    const expectedTargetState = proposalDigest({ profile: 'access-organization-roster-policy-state-v1',
      organizationSubject: fixture.org, policyRevision: current.policyRevision,
      admissionsOpen: current.admissionsOpen });
    const body = fixture.realmManager;
    const executionRepresentation = randomUUID(), capabilityGrant = randomUUID();
    const capabilityScope = `access:org-roster:${fixture.org.slice(-36)}`;
    await pool.query('INSERT INTO access.scope_gate (id) VALUES ($1)', [capabilityScope]);
    await pool.query(`INSERT INTO access.representation
      (id, principal_id, subject_id, action, valid_until)
      VALUES ($1,$2,$3,'governance.proposal.execute',now() + interval '1 hour')`,
    [executionRepresentation, fixture.realmPrincipalId, body]);
    await pool.query(`INSERT INTO access.permission_grant
      (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
      VALUES ($1,$2,$2,$3,'access.org.roster.policy',now() + interval '1 hour')`,
    [capabilityGrant, body, capabilityScope]);

    const seedProposal = async (capability = 'access.org.roster.policy',
      approvedDigest = effectDigest, approvedState = expectedTargetState) => {
      const proposal = native(), proposalRevision = native(), poll = native(), resolution = native();
      await fuseki.update(`PREFIX rv: <${RV}> INSERT DATA {
        GRAPH ${iri(GRAPHS.current)} {
          ${iri(proposal)} a rv:Proposal ; rv:governingBody ${iri(body)} ;
            rv:proposalHead ${iri(proposalRevision)} ; rv:proposalState rv:ProposalAdopted .
          ${iri(poll)} a rv:Poll ; rv:governingBody ${iri(body)} ;
            rv:pollState rv:PollFinalized ; rv:pollResolution ${iri(resolution)} .
        }
        GRAPH ${iri(GRAPHS.revisions)} {
          ${iri(proposalRevision)} a rv:ProposalRevision ; rv:proposal ${iri(proposal)} ;
            rv:ruleRevision <urn:rezics:governance-rule:proposal-v1> ;
            rv:operation <urn:rezics:operation:${proposalDigest(proposalRevision)}> ;
            rv:revisedAt ${lit(new Date().toISOString())}^^<http://www.w3.org/2001/XMLSchema#dateTime> ;
            rv:effectDigest ${lit(approvedDigest)} ; rv:effectTarget ${iri(fixture.org)} ;
            rv:effectCapability ${lit(capability)} ; rv:expectedTargetState ${lit(approvedState)} .
          ${iri(resolution)} a rv:PollResolution ; rv:poll ${iri(poll)} ;
            rv:resolutionOutcome rv:ResolutionAdopted ;
            rv:proposalRevision ${iri(proposalRevision)} ; rv:effectDigest ${lit(approvedDigest)} .
        }
      }`);
      return { proposal, proposalRevision, poll, resolution };
    };
    let loseTargetResponse = true;
    class InterruptedTarget extends AccessManagedOrganizations {
      override async setRosterPolicy(...args: Parameters<AccessManagedOrganizations['setRosterPolicy']>) {
        const receipt = await super.setRosterPolicy(...args);
        if (loseTargetResponse) { loseTargetResponse = false; throw new Error('lost target response'); }
        return receipt;
      }
    }
    let loseSealResponse = true;
    class InterruptedExecutions extends AccessProposalExecutions {
      override async seal(...args: Parameters<AccessProposalExecutions['seal']>) {
        if (loseSealResponse) { loseSealResponse = false; throw new Error('lost seal response'); }
        await super.seal(...args);
      }
    }
    const app = createMainApp(commandFuseki, { environment: { ...env, fuseki: commandFuseki },
      account: account.verifier,
      managedOrganizations: new InterruptedTarget(pool), proposalExecutions: new InterruptedExecutions(pool) });
    const post = async (token: string, payload: object, key: string) => {
      const response = await app.handle(new Request('http://main.local/v1/proposals/executions', {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json',
          'idempotency-key': key }, body: JSON.stringify(payload) }));
      return { status: response.status, body: await response.json() as Record<string, unknown> };
    };
    const proposal = await seedProposal();
    const input = { profile: 'proposal-execution-v1', ...proposal, body,
      representationId: executionRepresentation, capabilityGrantId: capabilityGrant,
      effectDigest, expectedTargetState, effect };
    const initialRevision = current.policyRevision;
    const policyRevision = async () => (await readState()).policyRevision;
    expect((await post(account.noScope, input, 'no-scope')).status).toBe(401);
    expect((await post(account.tokenB, { ...input, effect: { ...effect, admissionsOpen: true } }, 'changed-effect')).status)
      .toBe(403);
    expect((await post(account.tokenB, { ...input, capabilityGrantId: randomUUID() }, 'wrong-grant')).status).toBe(403);
    const unrelatedScope = `access:org-roster:${fixture.otherRealm.slice(-36)}`;
    const unrelatedGrant = randomUUID();
    await pool.query('INSERT INTO access.scope_gate (id) VALUES ($1)', [unrelatedScope]);
    await pool.query(`INSERT INTO access.permission_grant
      (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
      VALUES ($1,$2,$2,$3,'access.org.roster.policy',now() + interval '1 hour')`,
    [unrelatedGrant, body, unrelatedScope]);
    expect((await post(account.tokenB, { ...input, capabilityGrantId: unrelatedGrant },
      'wrong-scope')).status).toBe(403);
    expect(await policyRevision()).toBe(initialRevision);
    const unsupported = await seedProposal('realm.policy.update');
    expect((await post(account.tokenB, { ...input, ...unsupported }, 'wrong-capability')).status).toBe(403);
    expect(await policyRevision()).toBe(initialRevision);

    const first = await post(account.tokenB, input, 'execute-once');
    expect(first.status, JSON.stringify(first.body)).toBe(202);
    expect(loseTargetResponse).toBe(false);
    expect(loseGraphResponse).toBe(false);
    expect(await policyRevision()).toBe('2');
    const retry = await post(account.tokenB, input, 'execute-once');
    expect(retry.status, JSON.stringify(retry.body)).toBe(200);
    expect(retry.body).toMatchObject({ policyRevision: '2', replayed: true,
      proposal: proposal.proposal, effectDigest });
    expect(await policyRevision()).toBe('2');
    expect((await pool.query(`SELECT count(*)::int AS n FROM access.org_roster_policy_history
      WHERE organization_subject = $1`, [fixture.org])).rows[0].n).toBe(1);
    const admission = (await pool.query<{ id: string; state: string }>(`SELECT id, state FROM access.admission
      WHERE action = 'governance.proposal.execute' AND idempotency_key = 'execute-once'`)).rows[0]!;
    expect(admission.state).toBe('sealed');
    expect((await pool.query(`SELECT count(*)::int AS n FROM access.proposal_execution_admission
      WHERE proposal_revision = $1`, [proposal.proposalRevision])).rows[0].n).toBe(1);
    const events = await fuseki.query(`PREFIX rv: <${RV}> SELECT ?batch ?event ?sequence WHERE {
      GRAPH ${iri(GRAPHS.outbox)} { ?batch rv:event ?event .
        ?event a rv:ProposalExecutedEvent ; rv:receipt ${iri(String(retry.body.receipt))} . }
      GRAPH ${iri(GRAPHS.receipts)} { ${iri(String(retry.body.receipt))} rv:sequence ?sequence . }
    }`);
    const event = events.results?.bindings[0];
    expect(events.results?.bindings).toHaveLength(1);
    const envelope = await readMainOutboxEnvelope(fuseki, {
      batchId: event!.batch!.value, eventIds: [event!.event!.value],
      dataEpoch: Bun.env.MAIN_DATA_EPOCH!, routingEpoch: Bun.env.MAIN_ROUTING_EPOCH!,
      sequence: event!.sequence!.value }, event!.event!.value);
    expect(envelope.type).toBe('com.rezics.governance.proposal-executed.v1');
    expect((await post(account.tokenB, { ...input, effect: { ...effect, grantId: randomUUID() } },
      'execute-once')).status).toBe(403);
    const changedIntent = { ...effect, admissionsOpen: true };
    expect((await post(account.tokenB, { ...input, effect: changedIntent,
      effectDigest: proposalDigest(changedIntent) }, 'execute-once')).status).toBe(409);
    const stale = await seedProposal();
    const staleCall = await post(account.tokenB, { ...input, ...stale }, 'stale-policy');
    expect(staleCall.status, JSON.stringify(staleCall.body)).toBe(409);
    expect(await policyRevision()).toBe('2');
    const nextEffect = { ...effect, expectedPolicyRevision: '2', admissionsOpen: true };
    const nextDigest = proposalDigest(nextEffect);
    const nextState = proposalDigest({ profile: 'access-organization-roster-policy-state-v1',
      organizationSubject: fixture.org, policyRevision: '2', admissionsOpen: false });
    const competing = await seedProposal('access.org.roster.policy', nextDigest, nextState);
    const nextInput = { ...input, ...competing, effect: nextEffect,
      effectDigest: nextDigest, expectedTargetState: nextState };
    const parallelCommands = [
      post.bind(null, account.tokenB, nextInput, 'competing-a'),
      post.bind(null, account.tokenB, nextInput, 'competing-b'),
    ];
    await assertCommandRace(
      await Promise.all(parallelCommands.map((send) => send())),
      201,
      (index) => parallelCommands[index]!(),
    );
    expect(await policyRevision()).toBe('3');
    expect((await pool.query(`SELECT count(*)::int AS n FROM access.org_roster_policy_history
      WHERE organization_subject = $1`, [fixture.org])).rows[0].n).toBe(2);
    const thirdEffect = { ...effect, expectedPolicyRevision: '3', admissionsOpen: false };
    const thirdDigest = proposalDigest(thirdEffect);
    const thirdState = proposalDigest({ profile: 'access-organization-roster-policy-state-v1',
      organizationSubject: fixture.org, policyRevision: '3', admissionsOpen: true });
    const staleRepresentation = await seedProposal('access.org.roster.policy', thirdDigest, thirdState);
    await pool.query('UPDATE access.representation SET generation = generation + 1 WHERE id = $1',
      [managed.recipientRepresentation]);
    const changedRepresentation = await post(account.tokenB, { ...input, ...staleRepresentation,
      effect: thirdEffect, effectDigest: thirdDigest, expectedTargetState: thirdState }, 'stale-representation');
    expect(changedRepresentation.status, JSON.stringify(changedRepresentation.body)).toBe(409);
    expect(await policyRevision()).toBe('3');
    const staleGrant = await seedProposal('access.org.roster.policy', thirdDigest, thirdState);
    await owner.change(fixture.orgPrincipal, { operation: 'revoke', organizationSubject: fixture.org,
      expectedAuthorityEpoch: (await owner.readOrganization(fixture.orgPrincipal, fixture.org)).authorityEpoch,
      grantId: issued.grantId, expectedGeneration: issued.generation }, `revoke-${randomUUID()}`);
    const changedGrant = await post(account.tokenB, { ...input, ...staleGrant,
      effect: thirdEffect, effectDigest: thirdDigest, expectedTargetState: thirdState }, 'stale-grant');
    expect(changedGrant.status, JSON.stringify(changedGrant.body)).toBe(409);
    expect(await policyRevision()).toBe('3');
    const revokedBodyGrant = await seedProposal('access.org.roster.policy', thirdDigest, thirdState);
    await pool.query('UPDATE access.permission_grant SET active = false WHERE id = $1', [capabilityGrant]);
    expect((await post(account.tokenB, { ...input, ...revokedBodyGrant,
      effect: thirdEffect, effectDigest: thirdDigest, expectedTargetState: thirdState },
    'revoked-body-grant')).status).toBe(403);
    // A saved target/graph receipt does not bypass the execution authority fence.
    expect((await post(account.tokenB, input, 'execute-once')).status).toBe(403);
    expect(await policyRevision()).toBe('3');
    // Native exact-scope gate lookup does not grow with unrelated scopes.
    for (const total of [100, 1_000, 10_000]) {
      await pool.query(`INSERT INTO access.scope_gate (id)
        SELECT 'governance:cost:' || g::text FROM generate_series(1, $1::int) AS g
        ON CONFLICT DO NOTHING`, [total]);
      await pool.query('ANALYZE access.scope_gate');
      const plan = (await pool.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON, TIMING OFF)
        SELECT authority_epoch FROM access.scope_gate WHERE id = $1`,
      [capabilityScope])).rows[0]['QUERY PLAN'][0].Plan;
      expect(plan['Actual Rows']).toBe(1);
      expect(plan['Shared Hit Blocks'] + plan['Shared Read Blocks']).toBeLessThan(16);
      expect(plan['Temp Read Blocks']).toBe(0);
    }
    const state = await fuseki.query(`PREFIX rv: <${RV}> SELECT ?state WHERE {
      GRAPH ${iri(GRAPHS.current)} { ${iri(proposal.proposal)} rv:proposalState ?state }
    }`);
    expect(state.results?.bindings[0]?.state?.value).toBe(`${RV}ProposalExecuted`);
  } finally { await account.close(); await pool.end(); await databases.close(); }
}, 180_000);
