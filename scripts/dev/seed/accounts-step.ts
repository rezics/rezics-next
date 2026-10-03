import { communityPeople } from './community-plan.ts';
import { operatorSeedSession } from './operator.ts';
import { penNames, people, seedKey } from './plan.ts';
import type { AgentReceipt, SeedState } from './state.ts';

export async function seedAccounts(state: SeedState) {
  const { api, endpoints, fixture } = state;
  for (const person of [...people, ...communityPeople]) {
    const signed = await api.signInOrUp(person);
    const token = await api.token(signed.cookie);
    const agent = await api.post<AgentReceipt>('/v1/agents', {
      profile: 'agent-provision-v1', kind: 'person', displayName: person.seedName ?? person.name },
    token, seedKey('agent', person.id));
    if (agent.state !== 'active') throw new Error(`Agent for ${person.id} is not active`);
    const path = `/v1/agents/${agent.agent.slice(-36)}`;
    const current = await api.getPublic<{ revision: string; displayName: string; handle: string | null;
      avatarSelection: string | null; bio: { text: string; language: string } | null }>(path);
    if (person.seedName) {
      if (current.displayName !== person.name) await api.put(`${path}/profile`, {
        profile: 'agent-public-profile-v1', expectedHead: current.revision,
        displayName: person.name, avatarSelection: current.avatarSelection, bio: current.bio,
      }, token, seedKey('agent-name-v2', `${person.id}:${current.revision.slice(-12)}`));
    }
    // Address history can outlive a seed receipt; an already-held handle needs no new claim.
    if (current.handle !== person.handle) await api.post('/v1/addresses/claims',
      { profile: 'alias-write-v1',scope: 'agent',holder: agent.agent,operation: 'claim',
        alias: person.handle,expectedRevision: null,actingSubject: agent.agent },
      token, seedKey('handle', person.id));
    state.sessions.push({ id: person.id, accountId: signed.id, cookie: signed.cookie,
      token, issuedAt: Date.now(), actingSubject: agent.agent });
    state.agentCount++;
  }
  const owner = state.sessions[0]!;
  const { operator, accountDatabaseUrl, accountSecret, accessDatabaseUrl } = fixture;
  state.operatorInput = operator && accountDatabaseUrl && accountSecret && accessDatabaseUrl
    ? { endpoints, credentials: operator, accountDatabaseUrl, accountSecret,
      accessDatabaseUrl, accountSubject: operator.id,
      ownerAccountSubject: owner.accountId, actingSubject: owner.actingSubject } : null;
  state.operatorSession = state.operatorInput ? await operatorSeedSession(state.operatorInput) : null;
  if (!state.operatorInput) state.findings.add('Official Realm setup: local fixture operator is unavailable');
  for (const { id, displayName, seedName, localizedName, kind } of penNames) {
    const agent = await state.optional('Pen name / organization Agent', () => api.post<AgentReceipt>('/v1/agents', {
      profile: 'agent-provision-v1', kind, displayName: seedName ?? displayName }, owner.token, seedKey('agent', id)));
    if (agent?.state === 'active') {
      if (seedName) {
        const path = `/v1/agents/${agent.agent.slice(-36)}`;
        const current = await api.getPublic<{ revision: string; displayName: string;
          originalDisplayName?: string;
          localizedNames?: { original: string; labels: Record<string, string> } | null;
          avatarSelection: string | null; bio: { text: string; language: string } | null }>(path);
        if ((current.originalDisplayName ?? current.displayName) !== displayName || localizedName &&
          current.localizedNames?.labels['zh-Hans'] !== localizedName.labels['zh-Hans']) {
          await api.put(`${path}/profile`, {
            profile: localizedName ? 'agent-public-profile-v2' : 'agent-public-profile-v1',
            expectedHead: current.revision,
            displayName, avatarSelection: current.avatarSelection, bio: current.bio,
            ...(localizedName ? { localizedName } : {}),
          }, owner.token, seedKey('agent-name-v2', `${id}:${current.revision.slice(-12)}`));
        }
      }
      state.agentCount++;
      state.penAgents.set(id, agent.agent);
    }
  }
}
