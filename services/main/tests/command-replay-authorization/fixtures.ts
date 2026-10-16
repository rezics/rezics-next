import type { PrivateMembershipChange } from '../../src/modules/access/private-memberships.ts';
import type { SetStatementDecisionInput } from '../../src/modules/statement/graph.ts';
import type { Loss } from './authority-classes.ts';
import { afterAll, beforeAll, beforeEach, expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { schemaFiles } from '../../../../scripts/qa/schema-files.ts';
import { startPostgresCluster, type PostgresCluster } from '../../../../tests/qa/support/postgres-cluster.ts';
import { readEnv } from '../../../../scripts/dev/config.ts';
import { stageQaBootstrap } from '../../../../scripts/qa/bootstrap.ts';
import { admitIntegrationWorkScope, qaStartupTestTimeout, runQaAdmissionChildAsync, runQaStartupChildAsync } from '../../../../scripts/qa/stack-startup.ts';
import { exclusiveWorkScopeAssembler, qaStackEnvironment } from '../../../../scripts/qa/stack-environment.ts';
import { startMediaStack, type MediaStack } from '../../../../tests/qa/integration/media-support.ts';
import { expireFixtureAuthority, grantFixtureAuthority, registerFixtureIdentity, reduceFixtureGrant } from '../../src/modules/access/fixture-authority.ts';
import { initializeRelayCheckpoint, relayMainOutboxOnce } from '../../src/modules/outbox/relay.ts';

export const root = resolve(import.meta.dir, '../../../..');
export const evidenceDirectory = join(root, '.temp/goal/replay-authorization');
export let stack: MediaStack;
let legacyCluster: PostgresCluster;
export let legacyPool: Pool;
export let legacyController: Member;
let selfHostedRun: string | undefined;
const savedEnvironment = { ...process.env };
export type Member = Awaited<ReturnType<MediaStack['member']>>;
export type { Loss, Scenario, ReplayEntry, PrincipalLoss, PrincipalReplayEntry,
  RealmMembershipLoss, RealmMembershipReplayEntry, StatementAcceptanceLoss, StatementAcceptanceReplayEntry } from './authority-classes.ts';

export function initializeReplayFixtures() {
  beforeAll(async () => {
    mkdirSync(evidenceDirectory, { recursive: true });
    if (!process.env.FUSEKI_URL || !process.env.REZICS_QA_RUN_ID) {
      selfHostedRun = `replay-${randomUUID().slice(0, 18)}`;
      const environment = { ...qaStackEnvironment(process.env),
        REZICS_FUSEKI_ASSEMBLER: exclusiveWorkScopeAssembler };
      const startup = await runQaStartupChildAsync(root,
        ['stack:up', '--profile', 'qa', '--run-id', selfHostedRun], 180_000, environment, console.log);
      if (!startup.ok) throw new Error(`Replay owner stack startup failed: ${startup.output.slice(-4000)}`);
      const directory = join(root, '.temp/stack', `rezics-qa-${selfHostedRun}`);
      const staged = stageQaBootstrap(directory);
      const bootstrap = await runQaAdmissionChildAsync(root, 'bun', staged.args, 180_000, environment);
      if (!bootstrap.ok) throw new Error(`Replay owner bootstrap failed: ${bootstrap.output.slice(-4000)}`);
      const apps = readEnv(join(directory, 'apps.env'));
      await admitIntegrationWorkScope({ root, projectRunId: selfHostedRun, fusekiUrl: apps.FUSEKI_URL!,
        maintenanceToken: apps.FUSEKI_MAINTENANCE_TOKEN, environment });
      Object.assign(process.env, apps, { REZICS_QA_RUN_ID: selfHostedRun });
      expect(startup.activeElapsedMs + bootstrap.elapsedMs).toBeLessThan(600_000);
    }
    stack = await startMediaStack('command-replay-authorization', { profileCredits: true });
    await initializeRelayCheckpoint(stack.composition.relayPool!, stack.composition.relayConsumer!, stack.env.lineage.dataEpoch);
    legacyCluster = await startPostgresCluster();
    legacyPool = new Pool({ ...legacyCluster.connection, max: 4 });
    legacyController = await stack.member('legacy-controller');
    // Reproduce the supported upgrade from finite legacy mandates. Current
    // controller episodes cannot be shortened, so expiry cannot be injected
    // into a freshly installed open-ended controller.
    const files = schemaFiles(root, 'access');
    for (const file of files.filter(file => Number(file.split('_')[0]) < 54)) {
      await legacyPool.query(readFileSync(join(root, 'services/main/migrations/access', file), 'utf8'));
    }
    const client = await legacyPool.connect();
    try {
      await client.query('BEGIN');
      await registerFixtureIdentity(client, { principalId: legacyController.principalId,
        actor: legacyController.actor, ...legacyController.principal });
      await grantFixtureAuthority(client, { scope: 'work:create:root', requireDispatch: true,
        representations: [{ principalId: legacyController.principalId, actor: legacyController.actor,
          action: 'agent.control', lifetime: '8 hours' }],
        grant: { actor: legacyController.actor, action: 'agent.control', lifetime: '8 hours' } });
      await client.query('COMMIT');
    } finally { client.release(); }
    for (const file of files.filter(file => Number(file.split('_')[0]) >= 54 && Number(file.split('_')[0]) < 873)) {
      await legacyPool.query(readFileSync(join(root, 'services/main/migrations/access', file), 'utf8'));
    }
  }, qaStartupTestTimeout(600_000));
  beforeEach(async () => {
    // composeMain does not start process workers. Consume the real outbox
    // between scenarios so a long sequential run respects the broker budget.
    for (let batch = 0; batch < 128; batch++) {
      if (!await relayMainOutboxOnce(stack.fuseki, stack.composition.relayPool!, stack.composition.relayConsumer!,
        { ownerOutbox: stack.env.receiptCustody })) return;
    }
    throw new Error('Replay fixture relay exceeded 128 batches between cases');
  }, 60_000);
  afterAll(async () => {
    await legacyPool?.end(); legacyCluster?.remove(); await stack?.stop();
    if (selfHostedRun) {
      const stopped = await runQaAdmissionChildAsync(root, 'task',
        ['stack:reset', '--', '--profile', 'qa', '--run-id', selfHostedRun], 60_000);
      for (const name of Object.keys(process.env)) if (!(name in savedEnvironment)) delete process.env[name];
      Object.assign(process.env, savedEnvironment);
      if (!stopped.ok) throw new Error(`Replay owner stack cleanup failed: ${stopped.output.slice(-4000)}`);
    }
  // Stack reset has its own 60-second bound, in addition to owner teardown.
  }, 120_000);

}

export const request = (member: Member) => new Request('http://main.local/', {
  headers: { authorization: `Bearer ${member.token}` },
});
export const principal = (member: Member) => stack.composition.dependencies.account.verify(request(member), []);
export const head = async (agent: string) => (await stack.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
  SELECT ?head WHERE { GRAPH <urn:rezics:graph:current> { <${agent}> rv:head ?head } } LIMIT 2`))
  .results!.bindings![0]!.head!.value;
export async function graphSnapshot(resource: string, receipt: string) {
  return (await stack.fuseki.query(`SELECT ?g ?s ?p ?o WHERE {
    VALUES ?g { <urn:rezics:graph:current> <urn:rezics:graph:receipts> }
    VALUES ?s { <${resource}> <${receipt}> } GRAPH ?g { ?s ?p ?o }
  } ORDER BY ?g ?s ?p ?o LIMIT 256`)).results?.bindings;
}
export async function loseGrant(member: Member, grant: string, loss: Loss) {
  if (loss === 'expired') await expireFixtureAuthority(stack.accessPool, member.actor);
  else await reduceFixtureGrant(stack.accessPool, grant, { active: false });
}
export type RealmMembershipLossInput = Pick<PrivateMembershipChange,
  'ownerSubject' | 'expectedGeneration' | 'expectedPolicyRevision'> & { membershipId: string };

// Judgment eligibility uses the Account's private membership, independently of
// Agent membership. Its owner applies the episode and dependent-authority fences.
export async function loseRealmMembership(member: Member, input: RealmMembershipLossInput) {
  const response = await member.send('POST', '/v1/access/private-membership-changes', {
    profile: 'access-private-membership-change-v1', ...input, kind: 'realm', action: 'leave',
  });
  expect(response.status, await response.clone().text()).toBe(200);
  const result = await response.json() as { state: string; generation: string };
  expect(result.state).toBe('left');
  expect(result.generation).not.toBe(input.expectedGeneration);
}

export type StatementAcceptanceLossInput = Pick<SetStatementDecisionInput, 'target' | 'acceptance'> & {
  expectedDecisionHead: string;
};

// An explicit rejection supersedes the accepted head. Withdrawal can inherit
// global acceptance, so it cannot establish this loss for every Realm scope.
export async function loseStatementAcceptance(reviewer: Member, input: StatementAcceptanceLossInput) {
  const response = await reviewer.send('POST', '/v1/statement-decisions', {
    profile: 'statement-decision-v1', ...input, actingSubject: reviewer.actor, outcome: 'rejected',
  });
  expect([200, 201], await response.clone().text()).toContain(response.status);
  const result = await response.json() as { outcome: string; decision: string };
  expect(result.outcome).toBe('rejected');
  expect(result.decision).not.toBe(input.expectedDecisionHead);
}

export async function proposal(member: Member, externalId: string, title: string, revision: number) {
  const deps = stack.composition.dependencies;
  const raw = Buffer.from(JSON.stringify({ key: `/works/${externalId}`, type: { key: '/type/work' },
    title, revision }));
  const observed = await deps.sourceIntake!.submit(member.principalId, randomUUID(), {
    provider: 'open-library', namespace: 'work', externalId, sourceRevision: String(revision),
    mediaType: 'application/json', retention: 'retained', rawBytesBase64: raw.toString('base64'),
    coverage: { scope: 'open-library-work-response-v1', complete: true, omittedFields: [] },
    rightsEvidence: { basis: 'unknown', note: '' },
  }, { profile: 'open-library-work-acquisition-v1', url: `https://openlibrary.org/works/${externalId}.json`,
    status: 200, etag: null, lastModified: null, fetchedAt: new Date().toISOString() });
  const conversion = await deps.sourceConversions!.convert(member.principalId,
    observed.observation.observation.split('/').at(-1)!);
  const conversionId = conversion!.conversion.conversion.split('/').at(-1)!;
  await deps.sourceGraph!.project(member.principalId, conversionId);
  return (await deps.sourceProposals!.propose(member.principalId, conversionId))!.proposal;
}
export const sourceSnapshot = async (work: string, receipt: string, actor: string) => ({
  graph: await graphSnapshot(work, receipt),
  bindings: (await stack.contentPool.query(`SELECT to_jsonb(b) AS row FROM source.native_work_binding b
    JOIN source.native_work_adoption_intent i ON i.id = b.intent_id WHERE i.acting_subject = $1 ORDER BY b.id`,
  [actor])).rows,
  applications: (await stack.contentPool.query(`SELECT to_jsonb(a) AS row
    FROM source.native_work_title_application a WHERE work = $1 ORDER BY id`, [work])).rows,
  admissions: (await stack.accessPool.query(`SELECT to_jsonb(a) AS row
    FROM access.admission a WHERE acting_subject = $1 ORDER BY id`, [actor])).rows,
});

