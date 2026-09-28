import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createMainApp } from '../../../services/main/src/app.ts';
import { CommandOutcomeUnknown, FusekiClient, type CommandEnvelope, type CommandResult }
  from '../../../services/main/src/infrastructure/fuseki.ts';
import { AgentProvisioning } from '../../../services/main/src/modules/agent/provision.ts';
import { AGENT_PROFILE_COST, AgentPublicProfiles } from '../../../services/main/src/modules/agent/profile.ts';
import { AgentVanityHandles } from '../../../services/main/src/modules/agent/vanity.ts';
import { ProfilesAccess } from '../../../services/main/src/modules/profiles/access.ts';
import { PersonPreferencesStore } from '../../../services/main/src/modules/preferences/store.ts';
import { currentNotificationAgentReader } from '../../../services/main/src/modules/notification/subjects.ts';
import { readMainOutboxEnvelope } from '../../../services/main/src/modules/outbox/relay.ts';
import { hash } from '../../../services/main/src/modules/work/activate.ts';
import { png, sha, startMediaStack } from './media-support.ts';

type Json = Record<string, unknown>;
async function json(response: Response, status: number): Promise<Json> {
  const body = await response.text();
  expect(response.status, body).toBe(status);
  return JSON.parse(body) as Json;
}

test('G-300: controlled profile CAS, receipts, public reads and event survive concurrent edits', async () => {
  const stack = await startMediaStack('agent-profile');
  try {
    const owner = await stack.member('profile-owner');
    const stranger = await stack.member('profile-stranger');
    const principals = new Map([[owner.token, owner.principal], [stranger.token, stranger.principal]]);
    const account = { verify: async (request: Request) => {
      const principal = principals.get(request.headers.get('authorization')?.replace('Bearer ', '') ?? '');
      if (!principal) throw new Error('unknown QA bearer');
      return principal;
    } };
    const app = createMainApp(stack.fuseki, { environment: stack.env, access: stack.access,
      account, media: stack.media, profiles: new ProfilesAccess(stack.accessPool),
      agentProvisioning: new AgentProvisioning(stack.accessPool, stack.env),
      agentProfiles: new AgentPublicProfiles(stack.accessPool, stack.env, stack.media.store),
      personPreferences: new PersonPreferencesStore(stack.accessPool),
      agentHandles: new AgentVanityHandles(stack.accessPool) });
    const call = (method: string, path: string, token?: string, body?: unknown, key = randomUUID(),
      language?: string) =>
      app.handle(new Request(`http://main.local${path}`, { method,
        headers: { ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(language ? { 'accept-language': language } : {}),
          ...(body ? { 'content-type': 'application/json', 'idempotency-key': key } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}) }));
    const created = await json(await call('POST', '/v1/agents', owner.token,
      { profile: 'agent-provision-v1', kind: 'person', displayName: 'Initial Name' }), 201);
    const agent = created.agent as string;
    const path = `/v1/agents/${agent.slice(-36)}`;
    const first = await json(await call('GET', path), 200);
    expect(first).toMatchObject({ displayName: 'Initial Name', bio: null,
      avatarSelection: null, avatarUrl: null });
    const org = await json(await call('POST', '/v1/agents', owner.token,
      { profile: 'agent-provision-v1', kind: 'organization', displayName: 'North Star Editions' }), 201);
    const orgPath = `/v1/agents/${(org.agent as string).slice(-36)}`;
    const orgFirst = await json(await call('GET', orgPath), 200);
    const localizedName = { original: 'en', labels: { en: 'North Star Editions',
      'zh-Hans': '北辰出版', ja: '北極星出版' } };
    const orgName = { profile: 'agent-public-profile-v2', expectedHead: orgFirst.revision,
      displayName: 'North Star Editions', avatarSelection: null, bio: null, localizedName };
    expect((await call('PUT', `${path}/profile`, owner.token,
      { ...orgName, expectedHead: first.revision })).status).toBe(400);
    const orgSaved = await json(await call('PUT', `${orgPath}/profile`, owner.token, orgName), 201);
    expect(orgSaved.profile).toBe('agent-public-profile-v2');
    const orgGraph = await stack.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
      SELECT ?model ?original ?name WHERE {
        GRAPH <urn:rezics:graph:revisions> { <${orgSaved.revision}> rv:modelRevision ?model . }
        GRAPH <urn:rezics:graph:current> { <${org.agent}> rv:originalNameLanguage ?original ;
          rv:localizedName ?name . }
      } LIMIT 21`);
    expect(orgGraph.results?.bindings).toHaveLength(3);
    expect(new Set(orgGraph.results?.bindings.map(row => row.model?.value)))
      .toEqual(new Set(['https://rezics.com/definition/agent-profile-v2']));
    expect(new Set(orgGraph.results?.bindings.map(row => row.original?.value)))
      .toEqual(new Set(['en']));
    expect(new Set(orgGraph.results?.bindings.map(row => row.name?.['xml:lang'])))
      .toEqual(new Set(['en', 'zh-Hans', 'ja']));
    expect(await json(await call('GET', orgPath, undefined, undefined, randomUUID(), 'zh-CN'), 200))
      .toMatchObject({ displayName: '北辰出版', originalDisplayName: 'North Star Editions',
        displayNameInfo: { language: 'zh-Hans', direction: 'ltr', basis: 'requested' } });
    expect(await json(await call('GET', orgPath, undefined, undefined, randomUUID(), 'de'), 200))
      .toMatchObject({ displayName: 'North Star Editions',
        displayNameInfo: { language: 'en', basis: 'fallback' } });
    const orgLegacyEdit = await json(await call('PUT', `${orgPath}/profile`, owner.token, {
      profile: 'agent-public-profile-v1', expectedHead: orgSaved.revision,
      displayName: 'North Star Books', avatarSelection: null, bio: null,
    }), 201);
    expect(orgLegacyEdit.profile).toBe('agent-public-profile-v1');
    const preservedRevision = await stack.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
      SELECT ?model WHERE { GRAPH <urn:rezics:graph:revisions> {
        <${orgLegacyEdit.revision}> rv:modelRevision ?model . } } LIMIT 2`);
    expect(preservedRevision.results?.bindings[0]?.model?.value)
      .toBe('https://rezics.com/definition/agent-profile-v2');
    expect(await json(await call('GET', orgPath, undefined, undefined, randomUUID(), 'zh-CN'), 200))
      .toMatchObject({ displayName: '北辰出版', originalDisplayName: 'North Star Books',
        localizedNames: { labels: { en: 'North Star Books' } } });
    const body = (expectedHead: string, displayName: string) => ({
      profile: 'agent-public-profile-v1', expectedHead, displayName,
      avatarSelection: null, bio: { text: ' 写作者 ', language: 'zh-Hans' },
    });
    expect((await call('PUT', `${path}/profile`, stranger.token,
      body(first.revision as string, 'Impostor'))).status).toBe(403);
    expect((await call('PUT', `${path}/profile`, owner.token,
      body(first.revision as string, 'Bad\u0001Name'))).status).toBe(400);
    expect((await call('PUT', `${path}/profile`, owner.token, {
      ...body(first.revision as string, 'Valid'), avatarSelection: randomUUID(),
    })).status).toBe(400);
    class RejectedProfileFuseki extends FusekiClient {
      outcome: 'invalid' | 'guard-unmatched' = 'invalid';
      override async commandWithReceipt(input: CommandEnvelope): Promise<CommandResult> {
        if (input.receipt.startsWith('urn:rezics:receipt:agent-profile:')) {
          return { status: this.outcome };
        }
        return super.commandWithReceipt(input);
      }
    }
    const rejected = new RejectedProfileFuseki(Bun.env.FUSEKI_URL!);
    const rejectedApp = createMainApp(stack.fuseki, { environment: stack.env, access: stack.access,
      account, media: stack.media, profiles: new ProfilesAccess(stack.accessPool),
      agentProfiles: new AgentPublicProfiles(stack.accessPool, { ...stack.env, fuseki: rejected }, stack.media.store),
      personPreferences: new PersonPreferencesStore(stack.accessPool),
      agentHandles: new AgentVanityHandles(stack.accessPool) });
    const reject = async (key: string) => json(await rejectedApp.handle(new Request(
      `http://main.local${path}/profile`, { method: 'PUT', headers: {
        authorization: `Bearer ${owner.token}`, 'content-type': 'application/json',
        'idempotency-key': key }, body: JSON.stringify(body(first.revision as string, 'Rejected')),
      })), rejected.outcome === 'invalid' ? 422 : 409);
    expect((await reject('profile-invalid')).code).toBe('agent_profile_validation_failed');
    rejected.outcome = 'guard-unmatched';
    expect((await reject('profile-guard-unmatched')).code).toBe('agent_profile_conflict');
    expect((await json(await call('GET', path), 200)).revision).toBe(first.revision);
    const [a, b] = await Promise.all([
      call('PUT', `${path}/profile`, owner.token, body(first.revision as string, '林梅'), 'profile-a'),
      call('PUT', `${path}/profile`, owner.token, body(first.revision as string, 'Mira'), 'profile-b'),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    const winner = a.status === 201 ? { response: a, key: 'profile-a', name: '林梅' }
      : { response: b, key: 'profile-b', name: 'Mira' };
    const saved = await json(winner.response, 201);
    expect((await json(await call('PUT', `${path}/profile`, owner.token,
      body(first.revision as string, winner.name), winner.key), 200)).replayed).toBe(true);
    expect((await json(await call('PUT', `${path}/profile`, owner.token,
      body(first.revision as string, 'Different'), winner.key), 409)).code)
      .toBe('agent_profile_conflict');
    const profile = await json(await call('GET', path), 200);
    expect(profile).toMatchObject({ displayName: winner.name, revision: saved.revision,
      bio: { text: '写作者', language: 'zh-Hans' } });
    const native = await json(await call('GET', `/v1/handles/agent-${agent.slice(-36)}`), 200);
    expect(native).toMatchObject({ displayName: winner.name, revision: saved.revision });
    for (const [scope, action] of [[`media:owner:${agent}`, 'media.upload'],
      [`media:owner:${agent}`, 'media.manage'], [`media:avatar:${agent}`, 'media.avatar']]) {
      await stack.accessPool.query('INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING', [scope]);
      await stack.accessPool.query(`INSERT INTO access.representation
        (id, principal_id, subject_id, action, valid_until) VALUES ($1,$2,$3,$4,'infinity')`,
      [randomUUID(), owner.principalId, agent, action]);
      await stack.accessPool.query(`INSERT INTO access.permission_grant
        (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
        VALUES ($1,$2,$2,$3,$4,'infinity')`, [randomUUID(), agent, scope, action]);
    }
    const bytes = png(128, 128);
    const upload = await json(await call('POST', '/v1/media/uploads', owner.token, {
      profile: 'media-image-upload-v1', asset: null, mediaType: 'image/png',
      byteLength: bytes.length, sha256: sha(bytes), disclosure: 'public', actingSubject: agent,
    }), 201);
    const activated = await app.handle(new Request(`http://main.local/v1/media/uploads/${upload.upload}/bytes`, {
      method: 'PUT', headers: { authorization: `Bearer ${owner.token}`,
        'content-type': 'application/octet-stream' }, body: new Blob([bytes]),
    }));
    expect(activated.status, await activated.text()).toBe(201);
    const selection = await json(await call('PUT', `/v1/resources/${agent.slice(-36)}/avatar`, owner.token, {
      profile: 'resource-avatar-selection-v1', expectedSelection: null, asset: upload.asset,
      crop: null, actingSubject: agent,
    }), 201);
    const notificationAgent = currentNotificationAgentReader(stack.fuseki, stack.env.lineage,
      stack.media.store);
    expect((await notificationAgent(agent))?.avatar).toBeNull();
    const beforeProfileQueries = stack.fuseki.queries;
    const withAvatar = await json(await call('PUT', `${path}/profile`, owner.token, {
      ...body(saved.revision as string, winner.name), avatarSelection: selection.selection,
    }), 201);
    expect(stack.fuseki.queries - beforeProfileQueries).toBeLessThanOrEqual(AGENT_PROFILE_COST.graphQueries);
    const pictured = await json(await call('GET', path), 200);
    expect(pictured).toMatchObject({ revision: withAvatar.revision,
      avatarSelection: selection.selection, avatarUrl: `/v1/media/avatars/${selection.selection}` });
    expect((await notificationAgent(agent))?.avatar).toBe(pictured.avatarUrl);
    const image = await call('GET', pictured.avatarUrl as string);
    expect(image.status).toBe(200);
    expect(sha(new Uint8Array(await image.arrayBuffer()))).toBe(sha(bytes));
    const graph = await stack.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
      SELECT ?event WHERE { GRAPH <urn:rezics:graph:outbox> {
        ?event a rv:AgentPublicProfileChangedEvent ; rv:agent <${agent}> . } } LIMIT 2`);
    expect(graph.results?.bindings).toHaveLength(2);
    const receipt = withAvatar.receipt as string;
    const position = withAvatar.sourcePosition as { dataEpoch: string; sequence: string };
    const eventId = `urn:rezics:event:${hash(receipt)}`;
    const envelope = await readMainOutboxEnvelope(stack.fuseki, {
      batchId: `urn:rezics:outbox:${hash(receipt)}`, eventIds: [eventId],
      dataEpoch: position.dataEpoch, sequence: position.sequence,
      routingEpoch: stack.env.lineage.routingEpoch,
    }, eventId);
    expect(envelope.data.receipt).toMatchObject({ action: 'agent.profile.change',
      systemProof: { kind: 'agent-profile-changed', agent, revision: withAvatar.revision } });
    class LostReplyFuseki extends FusekiClient {
      lost = false;
      override async command(input: CommandEnvelope): Promise<CommandResult> {
        const result = await super.command(input);
        if (!this.lost && input.receipt.startsWith('urn:rezics:receipt:agent-profile:')
          && result.status === 'committed') {
          this.lost = true;
          throw new CommandOutcomeUnknown('simulated lost reply');
        }
        return result;
      }
    }
    const faulted = new LostReplyFuseki(Bun.env.FUSEKI_URL!);
    const recoveryApp = createMainApp(stack.fuseki, { environment: stack.env, access: stack.access,
      account, media: stack.media, profiles: new ProfilesAccess(stack.accessPool),
      agentProfiles: new AgentPublicProfiles(stack.accessPool, { ...stack.env, fuseki: faulted }, stack.media.store),
      personPreferences: new PersonPreferencesStore(stack.accessPool),
      agentHandles: new AgentVanityHandles(stack.accessPool) });
    const recovery = await json(await recoveryApp.handle(new Request(`http://main.local${path}/profile`, {
      method: 'PUT', headers: { authorization: `Bearer ${owner.token}`, 'content-type': 'application/json',
        'idempotency-key': 'lost-reply' }, body: JSON.stringify({
        ...body(withAvatar.revision as string, 'Recovered Name'), avatarSelection: selection.selection,
      }),
    })), 201);
    expect(faulted.lost).toBe(true);
    expect((await json(await call('GET', path), 200)).revision).toBe(recovery.revision);
    const cleared = await json(await call('PUT', `${path}/profile`, owner.token, {
      ...body(recovery.revision as string, 'Recovered Name'), avatarSelection: null, bio: null,
    }), 201);
    expect((await json(await call('GET', path), 200))).toMatchObject({ revision: cleared.revision,
      bio: null, avatarSelection: null, avatarUrl: null });
    expect((await notificationAgent(agent))?.avatar).toBeNull();
    expect((await call('GET', `/v1/media/avatars/${selection.selection}`)).status).toBe(404);
    await stack.accessPool.query('UPDATE access.recovery_fence SET open = false WHERE id = true');
    expect((await call('PUT', `${path}/profile`, owner.token,
      body(cleared.revision as string, 'Held'))).status).toBe(503);
    await stack.accessPool.query('UPDATE access.recovery_fence SET open = true WHERE id = true');
  } finally { await stack.stop(); }
}, 120_000);
