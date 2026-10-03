import { serviceOrigin } from '../api/origins.ts';
import { mainReadHeaders } from '../api/main-read.ts';

export interface PublicAgentProfile {
  id: string;
  displayName: string;
  revision: string;
  bio: { text: string; language: string } | null;
  avatarSelection: string | null;
  avatarUrl: string | null;
}

/** Main's public read is the CAS basis for settings and the header image. */
export async function readAgentProfile(agent: string, accessToken?: string,
  send: typeof fetch = fetch): Promise<PublicAgentProfile | null> {
  const id = /^https:\/\/rezics\.com\/id\/([0-9a-f-]{36})$/.exec(agent)?.[1];
  if (!id) return null;
  try {
    const response = await send(`${serviceOrigin('MAIN_ORIGIN')}/v1/agents/${id}`
      + (accessToken ? `?actingSubject=${encodeURIComponent(agent)}` : ''), {
      cache: 'no-store', signal: AbortSignal.timeout(10_000),
      headers: await mainReadHeaders(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
    });
    if (!response.ok) return null;
    const profile = await response.json() as PublicAgentProfile;
    return profile.id === agent && profile.revision ? profile : null;
  } catch { return null; }
}
