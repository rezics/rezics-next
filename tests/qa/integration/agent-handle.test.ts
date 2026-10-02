import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { startMediaStack } from './media-support.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { AgentProvisioning } from '../../../services/main/src/modules/agent/provision.ts';
import { AgentVanityHandles } from '../../../services/main/src/modules/agent/vanity.ts';
import { ProfilesAccess } from '../../../services/main/src/modules/profiles/access.ts';
import { AccessActingContexts } from '../../../services/main/src/modules/access/contexts.ts';
import { AccessSessionAgents } from '../../../services/main/src/modules/access/session-agent.ts';
import { AccountAssertionDenied } from '../../../services/main/src/modules/account/verify-assertion.ts';
import { PersonPreferencesStore } from '../../../services/main/src/modules/preferences/store.ts';
import { OnboardingPersons } from '../../../services/main/src/modules/onboarding/persons.ts';

const short = (agent: string) => agent.slice(-36);
async function json(response: Response, status: number) {
  const body = await response.text();
  expect(response.status, body).toBe(status);
  return JSON.parse(body) as Record<string, unknown>;
}

test('G284: first sign-in and vanity handles preserve authority, claims and retired redirects', async () => {
  const stack = await startMediaStack('agent-handle');
  try {
    const a = await stack.member('first-person');
    const b = await stack.member('other-person');
    const c = await stack.member('recovered-person');
    const principals = new Map([
      [a.token, { ...a.principal, emailVerified: true }],
      [b.token, { ...b.principal, emailVerified: true }],
      [c.token, { ...c.principal, emailVerified: true }],
    ]);
    const account = { verify: async (request: Request) => {
      const principal = principals.get(request.headers.get('authorization')?.replace('Bearer ', '') ?? '');
      if (!principal) throw new AccountAssertionDenied('unknown QA bearer');
      return principal;
    } };
    const contexts = new AccessActingContexts(stack.accessPool, stack.env);
    const app = createMainApp(stack.fuseki, { environment: stack.env, access: stack.access, account,
      profiles: new ProfilesAccess(stack.accessPool), personPreferences: new PersonPreferencesStore(stack.accessPool),
      agentProvisioning: new AgentProvisioning(stack.accessPool, stack.env),
      onboardingPersons: new OnboardingPersons(stack.accessPool),
      agentHandles: new AgentVanityHandles(stack.accessPool),
      sessionAgents: new AccessSessionAgents(stack.accessPool, contexts) });
    const call = (method: string, path: string, token?: string, body?: unknown,
      key: string = randomUUID(), sessionKey?: string) => app.handle(new Request(`http://main.local${path}`, {
      method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'content-type': 'application/json', 'idempotency-key': key } : {}),
        ...(sessionKey ? { 'x-session-key': sessionKey } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) }));
    const sessionKey = randomUUID();
    const onboarding = { profile: 'person-onboarding-v1', displayName: 'Lin Mei 林梅' };
    const first = await json(await call('POST', '/v1/me/onboarding', a.token, onboarding,
      'first-attempt', sessionKey), 201);
    const agent = first.agent as string;
    expect(first).toMatchObject({ state: 'active', sessionAgent: agent, suggestedHandle: 'lin_mei' });
    const second = await json(await call('POST', '/v1/me/onboarding', a.token, onboarding,
      'different-attempt', sessionKey), 200);
    expect(second).toMatchObject({ agent, sessionAgent: agent, replayed: true });
    expect((await stack.accessPool.query(`SELECT count(*)::int AS count FROM access.agent_provision
      WHERE principal_id = $1 AND agent_kind = 'person'`, [a.principalId])).rows[0]?.count).toBe(1);
    const other = await json(await call('POST', '/v1/me/onboarding', b.token,
      { ...onboarding, displayName: 'Other Reader' },
      'other-attempt', randomUUID()), 201);
    const otherAgent = other.agent as string;
    // A compensated first attempt does not strand the next signed-in session.
    await stack.accessPool.query(`INSERT INTO access.agent_provision
      (id, principal_id, idempotency_key, request_digest, agent_id, agent_kind,
       display_name, principal_epoch, state) VALUES
      ($1,$2,$3,$4,$5,'person','Recovered Reader',0,'compensated')`,
    [randomUUID(), c.principalId, `system:person-onboarding:${randomUUID()}`,
      'a'.repeat(64), `https://rezics.com/id/${randomUUID()}`]);
    const recovered = await json(await call('POST', '/v1/me/onboarding', c.token,
      { ...onboarding, displayName: 'Recovered Reader' }, 'recovered-attempt', randomUUID()), 201);
    expect(recovered.state).toBe('active');

    const heads = new Map<string,string>();
    const change = async (token: string,target: string,handle: string,expectedHandle: string | null,key = randomUUID()) => {
      const expectedRevision = expectedHandle === null ? null : heads.get(expectedHandle)!;
      const response = await call('POST',expectedHandle === null ? '/v1/addresses/claims' : '/v1/addresses/renames',token,
        { profile: 'name-write-v1',scope: 'agent',holder: target,actingSubject: target,
          operation: expectedHandle === null ? 'claim' : 'rename',name: handle,expectedRevision },key);
      if (response.ok) heads.set(handle,(await response.clone().json() as { revision: string }).revision);
      return response;
    };
    expect((await change(b.token, agent, 'lin_mei', null)).status).toBe(403);
    expect((await call('GET', '/v1/addresses/availability?scope=agent&name=admin').then(r => r.json()) as {
      reason: string }).reason).toBe('reserved');
    const [claimed, raced] = await Promise.all([
      change(a.token, agent, 'lin_mei', null, 'first-handle'),
      change(b.token, otherAgent, 'lin_mei', null, 'raced-handle'),
    ]);
    expect([claimed.status, raced.status].sort()).toEqual([201, 409]);
    const holder = claimed.status === 201 ? agent : otherAgent;
    const holderToken = claimed.status === 201 ? a.token : b.token;
    const claimKey = claimed.status === 201 ? 'first-handle' : 'raced-handle';
    expect((await json(await change(holderToken, holder, 'lin_mei', null, claimKey), 200)).replayed).toBe(true);
    expect((await change(holderToken, holder, 'other_name', null)).status).toBe(409);
    expect((await json(await change(holderToken, holder, 'other_name', 'lin_mei'), 409)).code)
      .toBe('name_cooldown');
    expect((await json(await change(holderToken, holder, 'other_name', null, claimKey), 409)).code)
      .toBe('name_conflict');
    const labelled = await contexts.discover(principals.get(holderToken)!);
    expect(labelled.contexts.find(item => item.actingSubject === holder)?.handle).toBe('lin_mei');
    const profile = await json(await call('GET', `/v1/agents/${short(holder)}`), 200);
    expect(profile).toMatchObject({ id: holder, handle: 'lin_mei',
      links: { profile: '/@lin_mei' } });
    const current = await json(await call('GET', '/v1/handles/LIN_MEI'), 200);
    expect(current.resolution).toMatchObject({ state: 'current', redirect: true,
      canonical: '/@lin_mei' });
    expect((await json(await call('GET', `/v1/handles/agent-${short(holder)}`), 200)).resolution)
      .toMatchObject({ state: 'native', redirect: true });
    await stack.accessPool.query(`UPDATE access.name_registry SET changed_at = now() - interval '31 days'
      WHERE scope = 'agent' AND key = 'lin_mei'`);
    expect((await json(await change(holderToken, holder, 'new_name', 'lin_mei'), 201)).previousKey)
      .toBe('lin_mei');
    expect((await json(await call('GET', '/v1/addresses/availability?scope=agent&name=lin_mei'), 200)).reason)
      .toBe('retained');
    const retired = await json(await call('GET', '/v1/handles/lin_mei'), 200);
    expect(retired.resolution).toMatchObject({ state: 'retired', redirect: true,
      canonical: '/@new_name' });
    expect((await change(holder === agent ? b.token : a.token,
      holder === agent ? otherAgent : agent, 'lin_mei', null)).status).toBe(409);
    expect((await stack.accessPool.query("SELECT state FROM access.name_registry WHERE scope = 'agent' AND key = 'lin_mei'")).rows[0]?.state).toBe('redirect');
    // A century-old alias remains an address and cannot become another Agent's brand.
    await stack.accessPool.query(`UPDATE access.name_registry SET changed_at = now() - interval '100 years'
      WHERE scope = 'agent' AND key = 'lin_mei'`);
    expect((await json(await call('GET', '/v1/handles/lin_mei'), 200)).id).toBe(holder);
    expect((await json(await call('GET', '/v1/addresses/availability?scope=agent&name=lin_mei'), 200)).available).toBe(false);
    const otherTarget = holder === agent ? otherAgent : agent;
    const otherToken = holder === agent ? b.token : a.token;
    expect((await json(await change(otherToken, otherTarget, 'lin_mei', null), 409)).code)
      .toBe('name_conflict');
    expect((await json(await change(otherToken, otherTarget, '1in_mei', null), 409)).code)
      .toBe('name_conflict');
    expect((await json(await call('GET', '/v1/addresses/availability?scope=agent&name=1in_mei'), 200)).reason)
      .toBe('confusable');
    await stack.accessPool.query(`UPDATE access.name_registry SET changed_at = now() - interval '31 days'
      WHERE scope = 'agent' AND key = 'new_name'`);
    expect((await json(await change(holderToken, holder, 'lin_mei', 'new_name', 'reclaim-old'), 201)).previousKey)
      .toBe('new_name');
    expect((await json(await call('GET', '/v1/handles/new_name'), 200)).resolution)
      .toMatchObject({ state: 'retired', canonical: '/@lin_mei' });
    expect((await json(await change(holderToken, holder, 'lin_mei', 'new_name', 'reclaim-old'), 200)).replayed)
      .toBe(true);
    await stack.accessPool.query('UPDATE access.recovery_fence SET open = false WHERE id = true');
    expect((await change(holderToken, holder, 'held_name', 'lin_mei')).status).toBe(503);
    await stack.accessPool.query('UPDATE access.recovery_fence SET open = true WHERE id = true');
  } finally { await stack.stop(); }
});
