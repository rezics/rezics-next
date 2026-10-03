import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createMainApp } from '../../../services/main/src/app.ts';
import { AgentProvisioning } from '../../../services/main/src/modules/agent/provision.ts';
import { AgentPublicProfiles } from '../../../services/main/src/modules/agent/profile.ts';
import { aliasSkeleton } from '@rezics/model/address/aliases';
import { AliasRegistry } from '../../../services/main/src/modules/address/registry.ts';
import { AgentVanityHandles } from '../../../services/main/src/modules/agent/vanity.ts';
import { ProfilesAccess } from '../../../services/main/src/modules/profiles/access.ts';
import { startMediaStack } from './media-support.ts';

test('G525: SQL skeleton table, migration retention, competing lookalikes and unsafe names', async () => {
  const stack = await startMediaStack('g-525');
  try {
    // All allowed characters, including identity mappings: SQL is the only implementation.
    for (const character of 'abcdefghijklmnopqrstuvwxyz0123456789_') {
      const expected = ({ '0': 'o', '1': 'l', m: 'rn' } as Record<string, string>)[character] ?? character;
      expect((await stack.accessPool.query(`SELECT access.handle_skeleton($1) AS skeleton`,
        [character])).rows[0]?.skeleton).toBe(expected);
    }
    for (const [name, skeleton] of [['Lin_Mei', 'lin_rnei'], ['1in_mei', 'lin_rnei'],
      ['modern', 'rnodern'], ['rn0dern', 'rnodern'], ['mama', 'rnarna'], ['rn', 'rn']]) {
      expect((await stack.accessPool.query(`SELECT access.handle_skeleton($1) AS skeleton`,
        [name])).rows[0]?.skeleton).toBe(skeleton);
    }
    // Apply the actual migration to pre-upgrade rows without disturbing the QA owners.
    const schema = `g525_${randomUUID().replaceAll('-', '')}`;
    const migration = readFileSync(new URL('../../../services/main/migrations/access/874_permanent_agent_handles.sql',
      import.meta.url), 'utf8').replaceAll('access.', `${schema}.`);
    const client = await stack.accessPool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`CREATE SCHEMA ${schema}; CREATE TABLE ${schema}.agent_handle (
        handle text PRIMARY KEY, agent_id text, state text, retired_until timestamptz);
        INSERT INTO ${schema}.agent_handle VALUES
          ('old_name','owner-a','retired',now() - interval '1 year'),
          ('lookalike','owner-a','current',NULL), ('l00kalike','owner-b','current',NULL)`);
      await client.query(migration);
      expect((await client.query(`SELECT retired_until::text AS until FROM ${schema}.agent_handle
        WHERE handle = 'old_name'`)).rows[0]?.until).toBe('infinity');
      expect((await client.query(`SELECT count(*)::int AS count FROM ${schema}.agent_handle`))
        .rows[0]?.count).toBe(3);
      await expect(client.query(`UPDATE ${schema}.agent_handle SET retired_until = now()
        WHERE handle = 'old_name'`)).rejects.toMatchObject({ code: '23514' });
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
    const a = await stack.member('a');
    const b = await stack.member('b');
    const principals = new Map([[a.token, a.principal], [b.token, b.principal]]);
    const handles = new AgentVanityHandles(stack.accessPool);
    const app = createMainApp(stack.fuseki, { environment: stack.env, access: stack.access,
      account: { verify: async request => {
        const principal = principals.get(request.headers.get('authorization')?.replace('Bearer ', '') ?? '');
        if (!principal) throw new Error('unknown QA bearer');
        return principal;
      } }, profiles: new ProfilesAccess(stack.accessPool), media: stack.media,
      agentProvisioning: new AgentProvisioning(stack.accessPool, stack.env),
      agentProfiles: new AgentPublicProfiles(stack.accessPool, stack.env, stack.media.store), agentHandles: handles });
    const call = (method: string, path: string, token: string, body?: unknown) =>
      app.handle(new Request(`http://main.local${path}`, { method,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json',
          'idempotency-key': randomUUID() }, ...(body ? { body: JSON.stringify(body) } : {}) }));
    const create = async (token: string) => {
      const response = await call('POST', '/v1/agents', token,
        { profile: 'agent-provision-v1', kind: 'person', displayName: 'Safe Reader' });
      expect(response.status, await response.clone().text()).toBe(201);
      return (await response.json() as { agent: string }).agent;
    };
    const agentA = await create(a.token);
    const agentB = await create(b.token);
    const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
    const first = `m_${suffix}`;
    const second = `rn_${suffix}`;
    const names = new AliasRegistry(stack.accessPool);
    const claim = async (token: string,agent: string,handle: string,expectedHandle: string | null) => {
      const head = expectedHandle ? await names.lookup('agent',expectedHandle) : null;
      return call('POST',expectedHandle ? '/v1/addresses/renames' : '/v1/addresses/claims',token,
        { profile: 'alias-write-v1',scope: 'agent',holder: agent,actingSubject: agent,
          operation: expectedHandle ? 'rename' : 'claim',alias: handle,expectedRevision: head?.revision ?? null });
    };
    const raced = await Promise.all([claim(a.token, agentA, first, null), claim(b.token, agentB, second, null)]);
    expect(raced.map(response => response.status).sort()).toEqual([201, 409]);
    const winner = raced[0]!.status === 201 ? { token: a.token, agent: agentA, name: first, alias: second }
      : { token: b.token, agent: agentB, name: second, alias: first };
    const loser = raced[0]!.status === 201 ? { token: b.token, agent: agentB } : { token: a.token, agent: agentA };
    expect(await names.availability('agent',winner.alias)).toMatchObject({ available: false, reason: 'confusable' });
    expect(await handles.current(loser.agent)).toBeNull();
    expect((await stack.accessPool.query(`SELECT count(*)::int AS count FROM access.alias_registry
      WHERE scope = 'agent' AND skeleton = $1`, [aliasSkeleton(first)])).rows[0]?.count).toBe(1);
    const probe = await stack.accessPool.connect();
    try {
      await probe.query('BEGIN');
      await probe.query('SET LOCAL enable_seqscan = off');
      // Both inequalities seek the compound index, skipping every same-Agent
      // alias even when that Agent's retained inventory grows without a limit.
      for (const comparison of ['<', '>']) {
        const plan = await probe.query(`EXPLAIN (FORMAT JSON) SELECT 1 FROM access.alias_registry
          WHERE scope = 'agent' AND skeleton = $1 AND controller = $2 AND holder ${comparison} $2 LIMIT 1`,
        [aliasSkeleton(first), winner.agent]);
        expect(JSON.stringify(plan.rows)).toMatch(/alias_registry_(?:handle_)?skeleton/);
        expect(JSON.stringify(plan.rows)).toMatch(/Index Cond[^\n]*holder/);
      }
    } finally {
      await probe.query('ROLLBACK');
      probe.release();
    }
    await stack.accessPool.query(`UPDATE access.alias_registry SET changed_at = now() - interval '31 days'
      WHERE scope = 'agent' AND key = $1`, [winner.name]);
    // The same Agent may hold multiple spellings; its retired alias continues to resolve.
    expect((await claim(winner.token, winner.agent, winner.alias, winner.name)).status).toBe(201);
    expect(await handles.resolve(winner.name)).toMatchObject({ agent: winner.agent, state: 'retired',
      redirect: true, currentHandle: winner.alias });
    expect((await claim(loser.token, loser.agent, winner.name, null)).status).toBe(409);
    expect((await call('POST', '/v1/agents', a.token, { profile: 'agent-provision-v1',
      kind: 'person', displayName: 'Unsafe\u202eReader' })).status).toBe(400);
    const profile = await call('GET', `/v1/agents/${agentA.slice(-36)}`, a.token);
    const { revision } = await profile.json() as { revision: string };
    const edit = { profile: 'agent-public-profile-v1', expectedHead: revision,
      displayName: 'Unsafe\u202eReader', avatarSelection: null, bio: null };
    expect((await call('PUT', `/v1/agents/${agentA.slice(-36)}/profile`, a.token, edit)).status).toBe(400);
    expect((await call('PUT', `/v1/agents/${agentA.slice(-36)}/profile`, a.token,
      { ...edit, profile: 'agent-public-profile-v2', displayName: 'Safe Reader',
        localizedName: { original: 'en', labels: { en: 'Safe Reader', ar: 'Unsafe\u2066Reader' } } })).status).toBe(400);
  } finally { await stack.stop(); }
});
