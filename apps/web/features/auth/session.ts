import { cookies } from 'next/headers';
import { cache } from 'react';
import { mainApiWithToken } from '../api/main.ts';
import type { AccountUser } from './account.ts';
import { type ActingContextDiscovery, type AgentOption, agentOptions, resolveSessionAgent,
  type SessionAgent } from './acting-identity.ts';
import { ACCESS_COOKIE, isSessionKey,
  SESSION_KEY_COOKIE } from './cookies.ts';
import { currentSessionRecord } from './session-state.ts';
import { readAgentProfile } from './agent-profile.ts';

export interface MainSessionAgentState {
  sessionAgent: { actingSubject: string | null; eligible: boolean; revision: string | null };
  mainAgent: { actingSubject: string | null; eligible: boolean; revision: string | null };
  initialActingSubject: string | null;
}

/** The signed-in person as the site shows them; plain data, safe to pass to client components. */
export interface Session {
  user: AccountUser;
  /** The session Agent and whether it is still eligible. */
  agent: SessionAgent;
  /** Agents the person may switch to, or empty when Main could not list them. */
  agents: AgentOption[];
  /** ISO time the session ends unless it is used (each refresh extends it). */
  expiresAt: string;
}

/** Main's discovery for the session (or an explicit token), or null when it
 * cannot answer; the session stays signed in either way. */
export async function discoverActingContexts(accessToken?: string):
  Promise<ActingContextDiscovery | null> {
  try {
    const token = accessToken ?? (await cookies()).get(ACCESS_COOKIE)?.value;
    if (!token) return null;
    const main = mainApiWithToken(token);
    const response = await main.v1.me['acting-contexts'].get({ query: { task: 'work.create' } });
    return response.error ? null : response.data;
  } catch { return null; }
}

/** The session's discovery, read once per request. */
export const sessionDiscovery = cache(() => discoverActingContexts());

/** Main owns the selected Agent for this opaque web session. */
export async function readMainSessionAgent(accessToken: string, sessionKey: string):
  Promise<MainSessionAgentState | null> {
  if (!isSessionKey(sessionKey)) return null;
  try {
    const response = await mainApiWithToken(accessToken).v1.me['session-agent'].get({
      headers: { 'x-session-key': sessionKey } });
    return response.error ? null : response.data;
  } catch { return null; }
}

export const sessionAgentState = cache(async (): Promise<MainSessionAgentState | null> => {
  const jar = await cookies();
  const token = jar.get(ACCESS_COOKIE)?.value;
  const key = jar.get(SESSION_KEY_COOKIE)?.value;
  return token && key ? readMainSessionAgent(token, key) : null;
});

/** The current session for Server Components, Server Actions and route
 * handlers, or null when signed out. Main reads are shared by callers in the render. */
export const readSession = cache(async (): Promise<Session | null> => {
  const jar = await cookies();
  const record = currentSessionRecord(jar);
  // Proxy has already tried to refresh this request. A refresh cookie alone
  // cannot make the header signed in while page readers have no access token.
  if (!record) return null;
  const [discovery, state] = await Promise.all([sessionDiscovery(), sessionAgentState()]);
  const agents = discovery ? agentOptions(discovery) : null;
  const agent = state ? resolveSessionAgent(agents, state.sessionAgent.actingSubject)
    : { status: 'unverified', previous: null } as const;
  if (agent.status === 'selected') {
    const profile = await readAgentProfile(agent.agent.iri, jar.get(ACCESS_COOKIE)?.value);
    if (profile) {
      agent.agent.label = profile.displayName;
      agent.agent.avatarUrl = profile.avatarUrl;
    }
  }
  return { user: record.user, expiresAt: record.expiresAt, agents: agents ?? [],
    agent };
});
