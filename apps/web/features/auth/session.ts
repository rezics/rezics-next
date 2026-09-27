import { cookies } from 'next/headers';
import { cache } from 'react';
import { mainApi, mainApiWithToken } from '../api/main.ts';
import type { AccountUser } from './account.ts';
import { type ActingContextDiscovery, type AgentOption, agentOptions, resolveSessionAgent,
  type SessionAgent } from './acting-identity.ts';
import { ACCESS_COOKIE, AGENT_COOKIE, REFRESH_COOKIE, SESSION_COOKIE } from './cookies.ts';
import { decodeSessionRecord, isAgentIri } from './session-state.ts';

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
    const main = accessToken ? mainApiWithToken(accessToken) : await mainApi();
    const response = await main.v1.me['acting-contexts'].get({ query: { task: 'work.create' } });
    return response.error ? null : response.data;
  } catch { return null; }
}

/** The session's discovery, read once per request. */
export const sessionDiscovery = cache(() => discoverActingContexts());

/** The current session for Server Components, Server Actions and route
 * handlers, or null when signed out. One Main read per request, shared by
 * every caller in the render. */
export const readSession = cache(async (): Promise<Session | null> => {
  const jar = await cookies();
  const record = decodeSessionRecord(jar.get(SESSION_COOKIE)?.value);
  const signedIn = Boolean(jar.get(ACCESS_COOKIE)?.value || jar.get(REFRESH_COOKIE)?.value);
  if (!record || !signedIn) return null;
  const chosen = jar.get(AGENT_COOKIE)?.value;
  const discovery = jar.get(ACCESS_COOKIE)?.value ? await sessionDiscovery() : null;
  const agents = discovery ? agentOptions(discovery) : null;
  return { user: record.user, expiresAt: record.expiresAt, agents: agents ?? [],
    agent: resolveSessionAgent(agents, isAgentIri(chosen) ? chosen : null) };
});
