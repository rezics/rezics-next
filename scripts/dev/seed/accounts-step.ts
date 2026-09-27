import { operatorSeedSession } from './operator.ts';
import { penNames, people, seedKey } from './plan.ts';
import type { AgentReceipt, SeedState } from './state.ts';

export async function seedAccounts(state: SeedState) {
  const { api, endpoints, fixture } = state;
  for (const person of people) {
    const signed = await api.signInOrUp(person);
    const token = await api.token(signed.cookie);
    const agent = await api.post<AgentReceipt>('/v1/agents', {
      profile: 'agent-provision-v1', kind: 'person', displayName: person.name },
    token, seedKey('agent', person.id));
    if (agent.state !== 'active') throw new Error(`Agent for ${person.id} is not active`);
    await api.put(`/v1/agents/${agent.agent.slice(-36)}/handle`,
      { profile: 'agent-handle-v1', handle: person.handle, expectedHandle: null },
      token, seedKey('handle', person.id));
    state.sessions.push({ id: person.id, accountId: signed.id, token, actingSubject: agent.agent });
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
  for (const { id, displayName, kind } of penNames) {
    const agent = await state.optional('Pen name / organization Agent', () => api.post<AgentReceipt>('/v1/agents', {
      profile: 'agent-provision-v1', kind, displayName }, owner.token, seedKey('agent', id)));
    if (agent?.state === 'active') {
      state.agentCount++;
      state.penAgents.set(id, agent.agent);
    }
  }
}
