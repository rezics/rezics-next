import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { uuidToSid } from '@rezics/model/address';
import { createMainApp } from '../../../services/main/src/app.ts';
import { AgentProvisioning } from '../../../services/main/src/modules/agent/provision.ts';
import { AgentPublicProfiles } from '../../../services/main/src/modules/agent/profile.ts';
import { AgentVanityHandles } from '../../../services/main/src/modules/agent/vanity.ts';
import { ProfilesAccess } from '../../../services/main/src/modules/profiles/access.ts';
import { PersonPreferencesStore } from '../../../services/main/src/modules/preferences/store.ts';
import { currentNotificationAgentReader } from '../../../services/main/src/modules/notification/subjects.ts';
import { readAgentCards } from '../../../services/main/src/modules/profiles/read.ts';
import { WorkReadSession } from '../../../services/main/src/modules/work/read-session.ts';
import { namedDiscoveryCredits } from '../../../services/main/src/modules/discovery/credits.ts';
import { startMediaStack } from './media-support.ts';

test('G-1019: unnamed and named people keep their identity across profile, credit, notification and legacy reads', async () => {
  const s = await startMediaStack('g-1019');
  try {
    const owner = await s.member('profile-owner');
    const handles = new AgentVanityHandles(s.accessPool);
    const deps = {
      environment: s.env,
      access: s.access,
      media: s.media,
      profiles: new ProfilesAccess(s.accessPool),
      personPreferences: new PersonPreferencesStore(s.accessPool),
      agentHandles: handles,
      agentProvisioning: new AgentProvisioning(s.accessPool, s.env),
      agentProfiles: new AgentPublicProfiles(s.accessPool, s.env, s.media.store),
      account: { verify: async () => owner.principal },
    };
    const app = createMainApp(s.fuseki, deps);
    const call = async (method: string, path: string, body?: object) => {
      const response = await app.handle(
        new Request(`http://main.test${path}`, {
          method,
          headers: {
            ...(method !== 'GET' ? { authorization: `Bearer ${owner.token}` } : {}),
            'content-type': 'application/json',
            'idempotency-key': randomUUID(),
          },
          body: body ? JSON.stringify(body) : undefined,
        }),
      );
      const text = await response.text();
      expect(response.status, text).toBe(method !== 'GET' ? 201 : 200);
      return JSON.parse(text) as Record<string, unknown>;
    };
    const created = await call('POST', '/v1/agents', {
      profile: 'agent-provision-v1',
      kind: 'person',
      displayName: '林梅',
    });
    const agent = created.agent as string,
      id = agent.slice(-36),
      sid = uuidToSid(id);
    const path = `/v1/agents/${id}`;
    const savedHandle = async () =>
      (
        await s.fuseki.query(`ASK { GRAPH <urn:rezics:graph:current> {
      <${agent}> <https://rezics.com/vocab/profileHandle> ?handle } }`)
      ).boolean;
    expect(await savedHandle()).toBe(false);
    const unnamed = await call('GET', path);
    expect(unnamed).toMatchObject({
      handle: null,
      displayName: '林梅',
      address: { prefix: '/a/', key: sid },
      links: { profile: `/a/${sid}` },
    });
    expect(JSON.stringify(unnamed)).not.toContain(`agent-${id}`);
    const legacy = await call('GET', `/v1/handles/agent-${id}`);
    expect(legacy).toMatchObject({
      handle: null,
      resolution: { redirect: true, canonical: `/a/${sid}` },
    });
    const session = () =>
      new WorkReadSession(
        deps,
        new Request('http://main.test'),
        {},
        unnamed.sourcePosition as { dataEpoch: string; sequence: string },
      );
    expect((await readAgentCards(session(), [agent])).get(agent)).toMatchObject({
      displayName: '林梅',
      handle: null,
      links: { profile: `/a/${sid}` },
    });
    const credits = [
      {
        id: agent,
        role: 'author' as const,
        participantKind: 'agent' as const,
        agent,
        provider: null,
        key: null,
        ordinal: null,
        displayName: null,
        handle: null,
      },
    ];
    for (const preview of [false, true]) {
      expect(
        (await namedDiscoveryCredits(session(), credits, 20, preview)).get(agent),
      ).toMatchObject({ displayName: '林梅', handle: null, address: { prefix: '/a/', key: sid } });
    }
    const notification = currentNotificationAgentReader(
      s.fuseki,
      s.env.lineage,
      s.media.store,
      handles,
    );
    expect(await notification(agent)).toMatchObject({
      name: '林梅',
      handle: null,
      address: { prefix: '/a/', key: sid },
    });
    const handle = `mei_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await call('POST', '/v1/addresses/claims', {
      profile: 'name-write-v1',
      scope: 'agent',
      holder: agent,
      actingSubject: agent,
      operation: 'claim',
      name: handle,
      expectedRevision: null,
    });
    expect(await call('GET', path)).toMatchObject({ handle, links: { profile: `/@${handle}` } });
    expect((await readAgentCards(session(), [agent])).get(agent)).toMatchObject({ handle });
    expect(await notification(agent)).toMatchObject({ name: '林梅', handle });
    expect(await call('GET', `/v1/handles/agent-${id}`)).toMatchObject({
      handle,
      resolution: { redirect: true, canonical: `/@${handle}` },
    });
    const edit = (expectedHead: string) => ({
      profile: 'agent-public-profile-v1',
      expectedHead,
      displayName: '林梅',
      avatarSelection: null,
      bio: null,
    });
    const edited = await call('PUT', `${path}/profile`, edit(unnamed.revision as string));
    expect(await savedHandle()).toBe(false);
    // A restored legacy current graph is readable and upgrades on its next
    // authorized edit. The predecessor revision remains immutable.
    await s.fuseki.update(`PREFIX rv: <https://rezics.com/vocab/>
      DELETE { GRAPH <urn:rezics:graph:current> { <${agent}> rv:profileNameFormat ?format ; rv:profileStateFormat ?state } }
      INSERT { GRAPH <urn:rezics:graph:current> { <${agent}> rv:profileHandle "agent-${id}" } }
      WHERE { GRAPH <urn:rezics:graph:current> { <${agent}> rv:profileNameFormat ?format ; rv:profileStateFormat ?state } }`);
    expect(await call('GET', path)).toMatchObject({ handle, displayName: '林梅' });
    await call('PUT', `${path}/profile`, edit(edited.revision as string));
    expect(await savedHandle()).toBe(false);
  } finally {
    await s.stop();
  }
}, 180_000);
