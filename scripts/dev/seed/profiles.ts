import { createHash } from 'node:crypto';
import { type SeedApi, SeedApiError } from './api.ts';
import { profilePlan, seedKey } from './plan.ts';

interface Session { id: string; token: string; actingSubject: string }
interface AgentRead { revision: string; displayName: string; bio: { text: string; language: string } | null }

function stableId(id: string): string {
  const hex = createHash('sha256').update(`rezics-dev-seed-v1:${id}`).digest('hex').slice(0, 32);
  return `https://rezics.com/id/${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`;
}

/**
 * Profile pages (`/@handle`) through public APIs, as four independent steps:
 * native credits on the owner's Works, bios, public and follower-only shelves,
 * and follows. Each reads Main first and skips what is already true, so the
 * seed replays after other steps moved a Work head or a person changed their
 * own shelves; the caller runs each on its own, so one failing leaves the rest.
 */
export function profileSteps(api: SeedApi, owner: Session, sessions: Session[],
  agents: ReadonlyMap<string, string>, works: ReadonlyMap<string, string>) {
  // Public reads go anonymously: with a bearer token Main would also want an acting Agent.
  const read = async <T>(path: string): Promise<T> => {
    const response = await fetch(`${api.endpoints.main}${path}`);
    if (!response.ok) throw new SeedApiError(`Main ${path}`, response.status, (await response.text()).slice(0, 300));
    return await response.json() as T;
  };
  const agentOf = (id: string) => agents.get(id) ?? sessions.find(session => session.id === id)?.actingSubject;

  async function credits() {
    let count = 0;
    for (const { agent: key, work: workKey, role } of profilePlan.credits) {
      const agent = agentOf(key);
      const work = works.get(workKey);
      if (!agent || !work) continue;
      const id = work.slice(-36);
      const listed = await read<{ items: Array<{ agent: string; role: string }> }>(`/v1/works/${id}/agent-credits`);
      if (!listed.items.some(item => item.agent === agent && item.role === role)) {
        const { revision } = await read<{ revision: string }>(`/v1/works/${id}`);
        await api.post(`/v1/works/${id}/agent-credits`, { profile: 'native-agent-credit-v1',
          credit: stableId(`credit:${key}:${workKey}:${role}`), agent, role, expectedWorkHead: revision,
          actingSubject: owner.actingSubject }, owner.token,
        seedKey('credit', `${key}:${workKey}:${role}:${revision.slice(-12)}`));
      }
      count++;
    }
    return count;
  }

  async function bios() {
    for (const bio of profilePlan.bios) {
      const agent = agentOf(bio.agent);
      if (!agent) continue;
      const current = await read<AgentRead>(`/v1/agents/${agent.slice(-36)}`);
      if (current.bio?.text === bio.text) continue;
      await api.put(`/v1/agents/${agent.slice(-36)}/profile`, { profile: 'agent-public-profile-v1',
        expectedHead: current.revision, displayName: current.displayName, avatarSelection: null,
        bio: { text: bio.text, language: bio.language } }, owner.token,
      seedKey('bio', `${bio.agent}:${current.revision.slice(-12)}`));
    }
  }

  async function libraries() {
    for (const library of profilePlan.libraries) {
      const person = sessions.find(session => session.id === library.person);
      if (!person) continue;
      const path = `/v1/agents/${person.actingSubject.slice(-36)}/library-visibility`;
      const visibility = await api.get<{ visibility: string; version: number }>(path, person.token);
      if (visibility.visibility !== library.visibility) {
        await api.put(path, { visibility: library.visibility, expectedVersion: visibility.version }, person.token,
          seedKey('library-visibility', `${library.person}:${visibility.version}`));
      }
      for (const entry of library.shelf) {
        const work = works.get(entry.work);
        if (!work) continue;
        const state = await api.get<{ status: { status: string | null; version: number } }>(
          `/v1/works/${work.slice(-36)}/reader-state?actingSubject=${encodeURIComponent(person.actingSubject)}`,
          person.token);
        if (state.status.status !== null) continue;
        await api.put(`/v1/works/${work.slice(-36)}/reader-status`, { actingSubject: person.actingSubject,
          expectedVersion: state.status.version, status: entry.status, startedOn: null, finishedOn: null },
        person.token, seedKey('profile-shelf', `${library.person}:${entry.work}`));
      }
    }
  }

  async function follows() {
    let count = 0;
    for (const { agent: key, by } of profilePlan.followers) {
      const target = agentOf(key);
      if (!target) continue;
      for (const follower of sessions.filter(session => by.includes(session.id))) {
        const state = await api.get<{ following: boolean | null; revision: string | null }>(
          `/v1/follows/${target.slice(-36)}?kind=agent&actingSubject=${encodeURIComponent(follower.actingSubject)}`,
          follower.token);
        if (!state.following) {
          await api.post('/v1/follows', { profile: 'follow-command-v1', target, kind: 'agent', following: true,
            expectedRevision: state.revision, actingSubject: follower.actingSubject }, follower.token,
          seedKey('profile-follow', `${follower.id}:${key}`));
        }
        count++;
      }
    }
    return count;
  }

  return { credits, bios, libraries, follows };
}
