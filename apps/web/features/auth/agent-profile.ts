import { serviceOrigin } from '../api/origins.ts';

export interface PublicAgentProfile {
  id: string;
  displayName: string;
  revision: string;
  bio: { text: string; language: string } | null;
  avatarSelection: string | null;
  avatarUrl: string | null;
}

/** Main's public read is the CAS basis for settings and the header image. */
export async function readAgentProfile(agent: string, send: typeof fetch = fetch): Promise<PublicAgentProfile | null> {
  const id = /^https:\/\/rezics\.com\/id\/([0-9a-f-]{36})$/.exec(agent)?.[1];
  if (!id) return null;
  try {
    const response = await send(`${serviceOrigin('MAIN_ORIGIN')}/v1/agents/${id}`, {
      cache: 'no-store', signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return null;
    const profile = await response.json() as PublicAgentProfile;
    return profile.id === agent && profile.revision ? profile : null;
  } catch { return null; }
}
