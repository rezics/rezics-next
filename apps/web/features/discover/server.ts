import { cookies } from 'next/headers';
import { cache } from 'react';
import { mainApiWithToken } from '../api/main.ts';
import { ACCESS_COOKIE, AGENT_COOKIE } from '../auth/cookies.ts';
import { isAgentIri } from '../auth/session-state.ts';

/**
 * Who reads, once per request. publicWorkRead keeps a public inventory and still
 * applies the account's age and opt-ins from the bearer, so a signed-in reader
 * sends the token on every page of one list. Mine and other member reads also
 * name the session Agent as `actingSubject`.
 */
export const browseReader = cache(async () => {
  const jar = await cookies();
  const token = jar.get(ACCESS_COOKIE)?.value;
  const subject = jar.get(AGENT_COOKIE)?.value;
  const actingSubject = token && isAgentIri(subject) ? subject : undefined;
  return { signedIn: Boolean(token), actingSubject, anonymous: mainApiWithToken(undefined),
    personal: mainApiWithToken(token),
    /** Avatar bytes go through the BFF, which sends the token, so Main needs the Agent too. */
    avatarQuery: actingSubject ? `?actingSubject=${encodeURIComponent(actingSubject)}` : '' };
});
