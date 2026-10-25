import { cookie, LOGIN_COOKIE, SESSION_COOKIE, validId } from '../session/cookies.ts';
import { problem, problemResponse } from '../media/kernel.ts';

export type ReadRateLimitEnv = {
  READS_10S: Pick<RateLimit, 'limit'>;
  READS_60S: Pick<RateLimit, 'limit'>;
};

export function readLimitKey(request: Request, subject?: string): string {
  if (subject) return `account:${subject}`;

  const sessionId = cookie(request, SESSION_COOKIE);
  if (validId(sessionId)) return `session:${sessionId}`;

  const loginId = cookie(request, LOGIN_COOKIE);
  if (validId(loginId)) return `session:${loginId}`;

  return `ip:${request.headers.get('CF-Connecting-IP') ?? ''}`;
}

export async function limitRead(request: Request, env: ReadRateLimitEnv, key: string): Promise<Response | undefined> {
  const [short, long] = await Promise.all([env.READS_10S.limit({ key }), env.READS_60S.limit({ key })]);
  const retryAfter = !short.success ? 10 : !long.success ? 60 : undefined;
  if (retryAfter === undefined) return undefined;

  const response = problemResponse(problem(429, 'rate_limited', 'Too Many Requests'), {
    'Retry-After': String(retryAfter),
  });
  return request.method === 'HEAD' ? new Response(null, response) : response;
}
