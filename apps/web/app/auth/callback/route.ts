import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { mainApiWithToken } from '../../../features/api/main.ts';
import { serviceOrigin } from '../../../features/api/origins.ts';
import { exchangeCode, readOAuthUser } from '../../../features/auth/account.ts';
import { accountClient } from '../../../features/auth/client.ts';
import { AGENT_COOKIE, clearCookies, OAUTH_COOKIES, OAUTH_NEXT_COOKIE, OAUTH_STATE_COOKIE,
  OAUTH_VERIFIER_COOKIE } from '../../../features/auth/cookies.ts';
import { checkCallback } from '../../../features/auth/callback-check.ts';
import { appCallback, safeReturnPath, type SignInFailure } from '../../../features/auth/paths.ts';
import { ensureOnboarding, onboardingDestination } from '../../../features/onboarding/ensure.ts';
import { readMainSessionAgent } from '../../../features/auth/session.ts';
import { sessionCookies, tokenSubject, writeCookies,
  writeSessionKey } from '../../../features/auth/session-state.ts';
import { LOCALE_COOKIE, pathLocale, resolveLocale } from '../../../i18n/locale.ts';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const jar = await cookies();
  const expectedState = jar.get(OAUTH_STATE_COOKIE)?.value;
  const verifier = jar.get(OAUTH_VERIFIER_COOKIE)?.value;
  const next = safeReturnPath(jar.get(OAUTH_NEXT_COOKIE)?.value);
  const locale = pathLocale(next) ?? resolveLocale(jar.get(LOCALE_COOKIE)?.value,
    request.headers.get('accept-language'));
  // Every failure lands on a page in the person's language that says what failed and offers a retry.
  const failed = (reason: SignInFailure, providerCode?: string | null) => {
    const query = new URLSearchParams({ reason, next });
    if (providerCode) query.set('code', providerCode);
    const response = NextResponse.redirect(new URL(`/${locale}/identity/failed?${query}`, request.url), 303);
    clearCookies(response.cookies, request.url, OAUTH_COOKIES);
    return response;
  };
  const checked = checkCallback(url, `${serviceOrigin('ACCOUNT_ORIGIN')}/api/auth`, expectedState, verifier);
  if (checked.kind === 'failed') return failed(checked.reason, checked.providerCode);
  if (checked.kind === 'denied') {
    const declined = NextResponse.redirect(new URL(`/${locale}/identity/consent?next=${encodeURIComponent(next)}`,
      request.url));
    clearCookies(declined.cookies, request.url, OAUTH_COOKIES);
    return declined;
  }
  const { code, verifier: codeVerifier } = checked;
  const client = accountClient();
  if (!client) return failed('config');
  const issued = await exchangeCode(client, { code, verifier: codeVerifier, redirectUri: appCallback(request.url) });
  if (issued.status === 'rejected') return failed('code');
  if (issued.status !== 'issued') return failed('exchange');
  // Account's UserInfo endpoint reads the issued access token. The Accounts
  // session cookie is private to that origin and never travels through web.
  const subject = tokenSubject(issued.tokens.accessToken);
  const user = await readOAuthUser(client, issued.tokens.accessToken);
  if (!subject || !user || user.id !== subject) return failed('session');
  // Main owns this new session's choice. Its account-wide main-Agent preference
  // supplies the initial candidate, which is saved only if still eligible.
  const sessionKey = crypto.randomUUID();
  const agentState = await readMainSessionAgent(issued.tokens.accessToken, sessionKey);
  const candidate = agentState?.initialActingSubject;
  const selected = candidate ? await mainApiWithToken(issued.tokens.accessToken)
    .v1.me['session-agent'].put({ actingSubject: candidate, expectedRevision: null }, {
      headers: { 'x-session-key': sessionKey, 'idempotency-key': crypto.randomUUID() },
    }).then(result => !result.error).catch(() => false) : false;
  const onboarding = await ensureOnboarding(issued.tokens.accessToken, sessionKey);
  const destination = onboarding.kind === 'unavailable' && selected ? next
    : onboardingDestination(onboarding, selected, next, locale);
  const response = NextResponse.redirect(new URL(destination, url.origin));
  clearCookies(response.cookies, request.url, [...OAUTH_COOKIES, AGENT_COOKIE]);
  writeCookies(response.cookies, sessionCookies(request.url, issued.tokens, user));
  writeSessionKey(response.cookies, request.url, sessionKey);
  return response;
}
