import { expect, test } from 'bun:test';
import { uuidToSid } from '@rezics/model/address';
import { randomUUID } from 'node:crypto';
import { startMediaStack } from './media-support.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { AccessRealmManagement, realmAdminScope } from '../../../services/main/src/modules/access/realm-management.ts';
import { REALM_MEMBER_SEARCH_SQL } from '../../../services/main/src/modules/access/realm-management-search.ts';
import { AgentProvisioning } from '../../../services/main/src/modules/agent/provision.ts';
import { AliasRegistry } from '../../../services/main/src/modules/address/registry.ts';
import { AccountAssertionDenied } from '../../../services/main/src/modules/account/verify-assertion.ts';

const id = () => `https://rezics.com/id/${randomUUID()}`;
interface Plan { 'Relation Name'?: string; 'Actual Rows'?: number; 'Actual Loops'?: number;
  'Rows Removed by Filter'?: number; Plans?: Plan[] }
function scanned(plan: Plan, relation: string): number {
  const own = plan['Relation Name'] === relation
    ? ((plan['Actual Rows'] ?? 0) + (plan['Rows Removed by Filter'] ?? 0)) * (plan['Actual Loops'] ?? 1) : 0;
  return own + (plan.Plans ?? []).reduce((sum, child) => sum + scanned(child, relation), 0);
}

async function setup() {
  const stack = await startMediaStack('realm-member-search');
  const owner = await stack.member('owner');
  const stranger = await stack.member('stranger');
  const realm = id();
  await owner.grant(realmAdminScope(realm), 'realm.members.manage');
  await stack.accessPool.query(`INSERT INTO access.authority_subject (id,kind) VALUES ($1,'institution')`, [realm]);
  await stack.accessPool.query(`INSERT INTO access.membership_policy
    (kind,owner_subject,revision,terms_revision) VALUES ('realm',$1,1,'members-v1')`, [realm]);
  const admin = new AccessRealmManagement(stack.accessPool);
  const app = createMainApp(stack.fuseki, { environment: stack.env, access: stack.access, realmAdmin: admin,
    account: { verify: async request => {
      const token = request.headers.get('authorization')?.replace('Bearer ', '');
      const member = [owner, stranger].find(candidate => candidate.token === token);
      if (!member) throw new AccountAssertionDenied('Bearer required');
      return member.principal;
    } } });
  const provision = new AgentProvisioning(stack.accessPool, stack.env);
  const names = ['王小明', '王小明', '山田太郎', '김민수', 'Ａlice_North', 'Straße 100%'];
  const agents: string[] = [];
  for (const displayName of names) {
    const result = await provision.provision({ verify: async () => owner.principal },
      new Request('http://main.test'), { kind: 'person', displayName }, randomUUID());
    expect(result.state).toBe('active');
    agents.push(result.agent);
    await stack.accessPool.query(`INSERT INTO access.membership
      (id,kind,owner_subject,member_subject,state,generation,policy_revision,terms_revision,consent_reference)
      VALUES ($1,'realm',$2,$3,'joined',1,1,'members-v1','fixture')`, [randomUUID(), realm, result.agent]);
  }
  const read = async (search?: string, options: { after?: string; limit?: number; outsider?: boolean } = {}) => {
    const actor = options.outsider ? stranger : owner;
    const url = new URL(`http://main.test/v1/realms/${realm.slice(-36)}/members`);
    url.searchParams.set('actingSubject', actor.actor);
    if (search !== undefined) url.searchParams.set('search', search);
    if (options.after) url.searchParams.set('after', options.after);
    if (options.limit) url.searchParams.set('limit', String(options.limit));
    const response = await app.handle(new Request(url, { headers: { authorization: `Bearer ${actor.token}` } }));
    return { status: response.status, cache: response.headers.get('cache-control'),
      body: await response.json() as { items: { member: string; state: string }[]; nextCursor: string | null } };
  };
  return { stack, owner, stranger, realm, admin, agents, read, provision };
}

test('Realm member search: names, live handles and CJK match within the authorized roster', async () => {
  const s = await setup();
  try {
    const found = async (query: string) => {
      const page = await s.read(query);
      expect(page.status).toBe(200);
      expect(page.cache).toContain('no-store');
      return page.body.items.map(item => item.member);
    };
    expect(await found('小明')).toEqual(s.agents.slice(0, 2).sort());
    expect(await found('田太')).toEqual([s.agents[2]!]);
    expect(await found('민수')).toEqual([s.agents[3]!]);
    expect(await found('王')).toEqual(s.agents.slice(0, 2).sort());
    expect(await found('ALICE_')).toEqual([s.agents[4]!]);
    expect(await found('STRASSE')).toEqual([s.agents[5]!]);
    expect(await found('ssss')).toEqual([]); // Same indexed grams; different exact text.
    expect(await found('%')).toEqual([s.agents[5]!]);
    expect(await found('_')).toEqual([s.agents[4]!]);
    expect(await found('\\')).toEqual([]);
    expect(await found(s.agents[0]!)).toEqual([s.agents[0]!]);
    expect(await found(uuidToSid(s.agents[0]!.slice(-36)))).toEqual([s.agents[0]!]);
    expect(await found(s.agents[0]!.slice(-36))).toEqual([s.agents[0]!]);
    expect(await found(`@agent-${s.agents[0]!.slice(-36)}`)).toEqual([s.agents[0]!]);
    const names = new AliasRegistry(s.stack.accessPool);
    const change = async (name: string,expectedRevision: string | null) => s.stack.access.withOwnerAuthority({
      principal: s.owner.principal,actingSubject: s.agents[0]!,scope: `agent:control:${s.agents[0]}`,action: 'agent.control' },
      client => names.write(client,s.owner.principal,{ scope: 'agent',holder: s.agents[0]!,actingSubject: s.agents[0]!,
        operation: expectedRevision ? 'rename' : 'claim',alias: name,expectedRevision,idempotencyKey: randomUUID() },s.agents[0]!));
    const handle = `qa_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
    const claimed = await change(handle,null);
    expect(await found(`@${handle.toUpperCase()}`)).toEqual([s.agents[0]!]);
    await s.stack.accessPool.query(`UPDATE access.alias_registry SET changed_at = now() - interval '31 days'
      WHERE scope = 'agent' AND key = $1`, [handle]);
    const renamed = `new_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
    await change(renamed,claimed.revision);
    expect(await found(handle)).toEqual([s.agents[0]!]);
    expect(await found(renamed)).toEqual([s.agents[0]!]);
    const first = await s.read('王', { limit: 1 });
    expect(first.body.items).toHaveLength(1);
    expect(first.body.nextCursor).toBe(first.body.items[0]!.member);
    const second = await s.read('王', { after: first.body.nextCursor!, limit: 1 });
    expect(second.body.items).toHaveLength(1);
    expect(second.body.nextCursor).toBeNull();
    expect([...first.body.items, ...second.body.items].map(item => item.member)).toEqual(s.agents.slice(0, 2).sort());
    expect((await s.read()).body.items).toHaveLength(s.agents.length);
    expect((await s.read('')).body.items).toHaveLength(s.agents.length);
    expect((await s.read('王', { outsider: true })).status).toBe(403);
    expect((await s.read('x'.repeat(81))).status).toBe(400);
    expect((await s.read('王', { limit: 51 })).status).toBe(400);
    expect((await s.read('\0')).status).toBe(400);
    expect((await s.read('@')).status).toBe(400);
    // A public Agent belonging to the same Account is not automatically a member.
    const outside = await s.provision.provision({ verify: async () => s.owner.principal },
      new Request('http://main.test'), { kind: 'person', displayName: '王小明 outsider' }, randomUUID());
    const consent = randomUUID();
    await s.stack.accessPool.query(`INSERT INTO access.private_membership_consent
      (id,principal_id,principal_epoch,kind,owner_subject,policy_revision,terms_revision,next_generation,expires_at)
      VALUES ($1,$2,0,'realm',$3,1,'members-v1',1,now() + interval '5 minutes')`,
    [consent, s.owner.principalId, s.realm]);
    await s.stack.accessPool.query(`INSERT INTO access.private_membership
      (id,kind,owner_subject,principal_id,state,generation,policy_revision,terms_revision,consent_reference)
      VALUES ($1,'realm',$2,$3,'joined',1,1,'members-v1',$4)`,
    [randomUUID(), s.realm, s.owner.principalId, consent]);
    expect(await found('outsider')).toEqual([]);
    expect((await found('王')).includes(outside.agent)).toBe(false);
    // Inactive authority must not reveal the retained provisioning name or handle.
    await s.stack.accessPool.query('UPDATE access.authority_subject SET active = false WHERE id = $1', [s.agents[0]]);
    expect(await found(renamed)).toEqual([]);
    expect(await found('小明')).toEqual([s.agents[1]!]);
    await s.stack.accessPool.query('UPDATE access.recovery_fence SET open = false WHERE id');
    expect((await s.read('王')).status).toBe(503);
    await s.stack.accessPool.query('UPDATE access.recovery_fence SET open = true WHERE id');
    expect(await found('王')).toEqual([s.agents[1]!]);
  } finally { await s.stack.stop(); }
}, 120_000);

test('Realm member search complexity: GIN candidate probes and bounded identity union', async () => {
  const s = await setup();
  try {
    // An isolated, deterministic owner fixture exercises both partial indexes
    // without graph creation for thousands of unrelated profile rows.
    await s.stack.accessPool.query(`WITH subjects AS (
      INSERT INTO access.authority_subject (id,kind)
      SELECT 'https://rezics.com/id/' || gen_random_uuid(),'agent' FROM generate_series(1,4000)
      RETURNING id
    ), representations AS (
      INSERT INTO access.representation (id,principal_id,subject_id,action,valid_until)
      SELECT gen_random_uuid(),$1,id,'agent.control','infinity'::timestamptz FROM subjects
      RETURNING id,subject_id
    ) INSERT INTO access.agent_provision
      (id,principal_id,idempotency_key,request_digest,agent_id,agent_kind,display_name,
        principal_epoch,state,graph_data_epoch,graph_sequence,representation_id)
      SELECT gen_random_uuid(),$1,subject_id,repeat('a',64),subject_id,'person',
        'Unrelated ' || subject_id,0,'active','fixture',1,id FROM representations`, [s.owner.principalId]);
    await s.stack.accessPool.query(`INSERT INTO access.alias_registry (scope,key,skeleton,holder,controller,state)
      SELECT 'agent','qa_' || replace(right(agent_id,24),'-',''),agent_id,agent_id,agent_id,'current'
      FROM access.agent_provision WHERE graph_data_epoch = 'fixture'`);
    await s.stack.accessPool.query(`INSERT INTO access.membership
      (id,kind,owner_subject,member_subject,state,generation,policy_revision,terms_revision,consent_reference)
      SELECT gen_random_uuid(),'realm',$1,agent_id,'joined',1,1,'members-v1','fixture'
      FROM access.agent_provision WHERE graph_data_epoch = 'fixture'`, [s.realm]);
    await s.stack.accessPool.query('ANALYZE access.agent_provision');
    await s.stack.accessPool.query('ANALYZE access.alias_registry');
    await s.stack.accessPool.query('ANALYZE access.membership');
    const client = await s.stack.accessPool.connect();
    try {
      await client.query('BEGIN');
      // Test index capability independent of this small roster's planner choice.
      await client.query('SET LOCAL enable_seqscan = off');
      const names = await client.query(`EXPLAIN (ANALYZE, FORMAT JSON) SELECT agent_id
        FROM access.agent_provision WHERE state = 'active'
          AND access.realm_member_search_terms(access.realm_member_search_key(display_name))
            @> access.realm_member_search_terms(access.realm_member_search_key($1))`, ['小明']);
      expect(JSON.stringify(names.rows)).toContain('realm_member_name_search');
      const handles = await client.query(`EXPLAIN (ANALYZE, FORMAT JSON) SELECT holder
        FROM access.alias_registry WHERE scope = 'agent' AND state = 'current'
          AND access.realm_member_search_terms(access.realm_member_search_key(key))
            @> access.realm_member_search_terms(access.realm_member_search_key($1))`, ['missing_handle']);
      expect(JSON.stringify(handles.rows)).toContain('realm_member_alias_registry_search');
      await client.query('SET LOCAL enable_seqscan = on');
      const result = await client.query<{ member: string }>(REALM_MEMBER_SEARCH_SQL,
        [s.realm, '', '小明', 2, '小明']);
      expect(result.rows.map(row => row.member)).toEqual(s.agents.slice(0, 2).sort());
      const actual = await client.query<{ 'QUERY PLAN': { Plan: Plan }[] }>(
        `EXPLAIN (ANALYZE, FORMAT JSON) ${REALM_MEMBER_SEARCH_SQL}`, [s.realm, '', '小明', 2, '小明']);
      const plan = actual.rows[0]!['QUERY PLAN'][0]!.Plan;
      expect(scanned(plan, 'agent_provision')).toBeLessThan(64);
      expect(scanned(plan, 'name_registry')).toBeLessThan(64);
      expect(scanned(plan, 'membership')).toBeLessThan(64);
      await client.query('ROLLBACK');
    } finally { client.release(); }
  } finally { await s.stack.stop(); }
}, 120_000);
