import { cookies } from 'next/headers';
import { cache } from 'react';
import { mainApiWithToken } from '../api/main.ts';
import { ACCESS_COOKIE, AGENT_COOKIE } from '../auth/cookies.ts';
import { isAgentIri } from '../auth/session-state.ts';

/**
 * Who reads, once per request. Public reads go anonymously, so a list never
 * becomes a private inventory because a browser sent a token. Personal reads
 * (Mine, search mutes) need the token and the session Agent, which Main
 * requires as `actingSubject`; without an Agent they read publicly.
 */
export const browseReader = cache(async () => {
  const jar = await cookies();
  const token = jar.get(ACCESS_COOKIE)?.value;
  const subject = jar.get(AGENT_COOKIE)?.value;
  const actingSubject = token && isAgentIri(subject) ? subject : undefined;
  return { signedIn: Boolean(token), actingSubject, anonymous: mainApiWithToken(undefined),
    personal: mainApiWithToken(actingSubject ? token : undefined),
    /** Avatar bytes go through the BFF, which sends the token, so Main needs the Agent too. */
    avatarQuery: actingSubject ? `?actingSubject=${encodeURIComponent(actingSubject)}` : '' };
});
