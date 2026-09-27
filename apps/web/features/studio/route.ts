import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { cache } from 'react';
import { requestLocale } from '../../i18n/server.ts';
import { localizedPath, withoutLocale } from '../../i18n/locale.ts';
import type { AgentOption } from '../auth/acting-identity.ts';
import { signInPath } from '../auth/paths.ts';
import { readSession } from '../auth/session.ts';
import { resolveStudioAgent, type StudioAgent } from './agent.ts';

/** The page's own path without its locale, as the proxy saw it; `/studio` when it is not known. */
export async function studioPath(): Promise<string> {
  const url = (await headers()).get('x-rezics-page-url');
  return url ? withoutLocale(new URL(url).pathname) : '/studio';
}

/**
 * The Studio Agent a `/studio/@{agent}` page acts as, shared by its layout and
 * page. Signed-out visitors sign in and return here; an address for an Agent
 * this person does not act for is reported by the layout, never replaced.
 */
export const studioContext = cache(async (segment: string): Promise<{
  studio: StudioAgent; agents: AgentOption[]; session: AgentOption | null;
}> => {
  const locale = await requestLocale();
  const session = await readSession();
  if (!session) redirect(signInPath(localizedPath(await studioPath(), locale)));
  return { studio: resolveStudioAgent(segment, session.agents), agents: session.agents,
    session: session.agent.status === 'selected' ? session.agent.agent : null };
});

/** The Studio Agent for a page, or null when the layout is already explaining why there is none. */
export async function studioAgent(segment: string): Promise<AgentOption | null> {
  const { studio } = await studioContext(segment);
  return studio.kind === 'agent' ? studio.agent : null;
}
