import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { mintReadTime, type AuthoritativeTime } from '../../src/command/command.ts';
import { withReadTransaction } from '../../src/semantic/read.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import * as semantic from '../../src/semantic/index.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { createDeletionFixture } from './support/deletion-fixture.ts';

const fixture = await createDeletionFixture();
beforeAll(fixture.setup);
afterAll(fixture.close);
const { pool, admin, accounts, clock, real, call, status, cited, person, proposal, accept, adopt } = fixture;
type Persona = keyof typeof accounts;

// Read-only first slice: caller owns RR and native T; this is evidence, never an Access grant.
type LifecycleTarget = { kind: 'candidate'; subject: string; candidate: string } | { kind: 'context'; context: string };
type LifecycleEvidence = {
  target: LifecycleTarget;
  owner: { kind: 'write_basis' | 'owner_grant'; accountId: string } | null;
  state: 'active' | 'deleted' | 'purged';
  deletedAt: string | null;
  purgeAfter: string | null;
  held: boolean;
};
type LifecycleReader = (
  client: Pick<pg.PoolClient, 'query'>,
  input: { target: LifecycleTarget; accountId: string; nativeT: AuthoritativeTime },
) => Promise<LifecycleEvidence | null>;
async function lifecycle(target: LifecycleTarget, persona: Persona) {
  return withReadTransaction(pool, async (client) => {
    const nativeT = await mintReadTime(client, clock);
    const reader = Reflect.get(semantic, 'readSemanticLifecycle');
    expect(typeof reader, 'Semantic must expose its native state/owner evidence reader').toBe('function');
    return (reader as LifecycleReader)(client, { target, accountId: accounts[persona], nativeT });
  });
}
const activeEvidence = (target: LifecycleTarget, owner: LifecycleEvidence['owner']): LifecycleEvidence => ({
  target,
  owner,
  state: 'active',
  deletedAt: null,
  purgeAfter: null,
  held: false,
});

test('native lifecycle locator identifies proposal authors without provenance or editorial-role ownership', async () => {
  // The subject creator/adopter is a different account from this contribution's author.
  await real.grant({ route: 0, id: GLOBAL_CONTEXT }, 'editor', 'subject:create');
  const created = await call('POST', '/v1/subjects', 'editor', {
    type: 'schema:Person',
    labels: { en: 'Another account created this communal subject' },
  });
  status(created, 201);
  const record = await proposal(created.body.subject.id);
  await accept(record);
  await adopt(record, null);
  // Actual native attribution evidence, not installed lifecycle truth. This URL proposal
  // never mentions the derived account agent, so its source is null.
  const evidence = await admin.query(
    `SELECT r.source, b.principal_kind, b.principal_id::text
     FROM semantic.candidate c JOIN semantic.revision r
       ON r.route=c.route AND r.subject_id=c.subject_id AND r.revision=c.revision
     JOIN editorial.write_basis b ON b.partition_no=$3 AND b.transaction_id=r.recorded_transaction_id
     WHERE c.route=$1 AND c.subject_id=$2 AND c.candidate_id=$4`,
    [routeOf(record.subject), record.subject, partitionOf(routeOf(record.subject)!), record.candidate],
  );
  expect(evidence.rows).toEqual([{ source: null, principal_kind: 'account', principal_id: accounts.owner }]);
  const target: LifecycleTarget = { kind: 'candidate', subject: record.subject, candidate: record.candidate };
  expect(await lifecycle(target, 'owner')).toEqual(
    activeEvidence(target, { kind: 'write_basis', accountId: accounts.owner }),
  );
  // Acceptance/adoption authority grants no ownership of someone else's contribution.
  expect(await lifecycle(target, 'editor')).toEqual(activeEvidence(target, null));
  expect(await lifecycle(target, 'stranger')).toEqual(activeEvidence(target, null));
  expect(await lifecycle({ ...target, subject: await person() }, 'owner')).toBeNull();
});

test('native lifecycle locator identifies compact contributions independently of communal subject ownership', async () => {
  const payload = `https://example.test/compact/${randomUUID()}`;
  const created = await call('POST', '/v1/subjects', 'owner', {
    type: 'schema:Person',
    labels: { en: 'Communal subject' },
    statements: { 'schema:url': [cited('schema:url', payload)] },
  });
  status(created, 201);
  const subject = created.body.subject.id;
  const listed = await call('GET', `/v1/subjects/${subject}/candidates?property=schema%3Aurl`, 'owner');
  status(listed, 200);
  expect(listed.body.candidates).toHaveLength(1);
  const target: LifecycleTarget = { kind: 'candidate', subject, candidate: listed.body.candidates[0].id };
  expect(await lifecycle(target, 'owner')).toEqual(
    activeEvidence(target, { kind: 'write_basis', accountId: accounts.owner }),
  );
  expect(await lifecycle(target, 'stranger')).toEqual(activeEvidence(target, null));
});

test('native lifecycle state uses current Context owner grants after native revocation', async () => {
  const created = await call('POST', '/v1/contexts', 'owner', { labels: { en: 'Current owner evidence' } });
  status(created, 201);
  const context = created.body.context.id;
  const target: LifecycleTarget = { kind: 'context', context };
  expect(await lifecycle(target, 'owner')).toEqual(
    activeEvidence(target, { kind: 'owner_grant', accountId: accounts.owner }),
  );
  expect(await lifecycle(target, 'stranger')).toEqual(activeEvidence(target, null));
  const ownerGrant = await admin.query(
    `SELECT valid::text FROM access.resource_role_grant
     WHERE route=$1 AND resource_id=$2 AND subject_id=$3 AND grant_role='semantic.context.owner'`,
    [routeOf(context), context, accounts.owner],
  );
  expect(ownerGrant.rows).toHaveLength(1);
  const grant = {
    resource: { route: routeOf(context)!, id: context },
    subject: { kind: 'account', id: accounts.owner },
    role: 'semantic.context.owner',
    valid: ownerGrant.rows[0].valid,
  };
  status(await call('POST', '/v1/roleGrants:revoke', 'owner', grant), 200);
  expect(await lifecycle(target, 'owner')).toEqual(activeEvidence(target, null));
  // Global has lifecycle identity but no private owner, even for an editorial grantee.
  const global: LifecycleTarget = { kind: 'context', context: GLOBAL_CONTEXT };
  expect(await lifecycle(global, 'editor')).toEqual(activeEvidence(global, null));
});
