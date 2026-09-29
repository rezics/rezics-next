import { isUiLocale, defaultLocale, type UiLocale } from '../src/i18n/locales.ts';
import type { AboutEnv } from './env.ts';

/** Why a submission was refused; the page maps each code to localized text. */
export type NotifyError = 'invalid_email' | 'invalid_request' | 'cross_origin' | 'unavailable';

const emailPattern = /^[^\s@]+@[^\s@.][^\s@]*\.[^\s@]+$/;

interface Submission {
  email: string;
  locale: UiLocale;
  /** Hidden field only scripts fill in. */
  trap: boolean;
}

function parseSubmission(fields: {
  email?: unknown;
  locale?: unknown;
  company?: unknown;
}): Submission | NotifyError {
  const email = typeof fields.email === 'string' ? fields.email.trim().toLowerCase() : '';
  if (!email || email.length > 254 || !emailPattern.test(email)) return 'invalid_email';
  const locale =
    typeof fields.locale === 'string' && isUiLocale(fields.locale) ? fields.locale : defaultLocale;
  return {
    email,
    locale,
    trap: typeof fields.company === 'string' && fields.company.trim() !== '',
  };
}

async function readFields(
  request: Request,
): Promise<{ email?: unknown; locale?: unknown; company?: unknown } | undefined> {
  const type = request.headers.get('content-type') ?? '';
  try {
    if (type.includes('application/json')) return (await request.json()) as Record<string, unknown>;
    if (
      type.includes('application/x-www-form-urlencoded') ||
      type.includes('multipart/form-data')
    ) {
      return Object.fromEntries(await request.formData());
    }
  } catch {
    /* fall through to a refusal */
  }
  return undefined;
}

function problem(code: NotifyError, status: number): Response {
  return Response.json(
    { type: 'about:blank', title: code, status, code },
    {
      status,
      headers: { 'content-type': 'application/problem+json', 'cache-control': 'no-store' },
    },
  );
}

/**
 * Store an address and its locale, once. Repeating a submission, or hitting the
 * hidden field, answers exactly like a first success so the form never reveals
 * whether an address is already on the list. Script callers (`Accept: application/json`)
 * get JSON; a plain form post is redirected to the localized confirmation page.
 */
export async function handleNotify(request: Request, env: AboutEnv): Promise<Response> {
  if (request.method !== 'POST')
    return new Response(null, { status: 405, headers: { allow: 'POST' } });
  const origin = request.headers.get('origin');
  if (origin && new URL(origin).host !== new URL(request.url).host)
    return problem('cross_origin', 403);
  const fields = await readFields(request);
  const wantsJson = (request.headers.get('accept') ?? '').includes('application/json');
  const submission = fields ? parseSubmission(fields) : 'invalid_request';
  if (typeof submission === 'string') {
    if (wantsJson) return problem(submission, 422);
    const locale =
      fields && typeof fields.locale === 'string' && isUiLocale(fields.locale)
        ? fields.locale
        : defaultLocale;
    return Response.redirect(new URL(`/${locale}/#notify`, request.url), 303);
  }
  if (!submission.trap) {
    try {
      await env.DB.prepare(
        'INSERT INTO notify_signup (email, locale, created_at) VALUES (?1, ?2, ?3) ON CONFLICT (email) DO NOTHING',
      )
        .bind(submission.email, submission.locale, new Date().toISOString())
        .run();
    } catch {
      return wantsJson
        ? problem('unavailable', 503)
        : Response.redirect(new URL(`/${submission.locale}/#notify`, request.url), 303);
    }
  }
  if (wantsJson)
    return Response.json({ status: 'subscribed' }, { headers: { 'cache-control': 'no-store' } });
  return Response.redirect(new URL(`/${submission.locale}/notified/`, request.url), 303);
}
