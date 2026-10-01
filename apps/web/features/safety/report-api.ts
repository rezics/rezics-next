import { BFF_PREFIX } from '../api/browser.ts';
import { retryAfterSeconds } from './retry-after.ts';
import type { CaseStatus, CorrespondenceInput, ReportInput, ReportList, ReportReceipt } from './report.ts';

// Report calls are Main's `/v1/public-reports` routes. Intake and the signed-in
// list go through the BFF like any other call. A case's credential never goes
// in a URL: status and correspondence travel through the report page's relay,
// which puts it in a header (see `app/[locale]/report/relay`).

export type Failure =
  | { ok: false; reason: 'invalid' | 'unavailable' | 'denied' | 'failed' }
  | { ok: false; reason: 'limited'; retryAfter: number };
export type Result<T> = { ok: true; data: T } | Failure;

async function settle<T>(response: Response): Promise<Result<T>> {
  if (response.ok) {
    try { return { ok: true, data: await response.json() as T }; } catch { return { ok: false, reason: 'failed' }; }
  }
  await response.body?.cancel();
  if (response.status === 429) return { ok: false, reason: 'limited', retryAfter: retryAfterSeconds(response) };
  if (response.status === 400 || response.status === 409 || response.status === 413 || response.status === 422) {
    return { ok: false, reason: 'invalid' };
  }
  // Main answers a wrong, expired and unknown case the same way, so none of them can be told apart.
  if (response.status === 401 || response.status === 403 || response.status === 404) return { ok: false, reason: 'denied' };
  return { ok: false, reason: response.status >= 500 ? 'unavailable' : 'failed' };
}

async function call<T>(send: () => Promise<Response>): Promise<Result<T>> {
  try { return await settle<T>(await send()); } catch { return { ok: false, reason: 'unavailable' }; }
}

const json = (key: string, body: unknown, headers: Record<string, string> = {}): RequestInit => ({ method: 'POST',
  cache: 'no-store', credentials: 'same-origin',
  headers: { 'content-type': 'application/json', 'idempotency-key': key, ...headers }, body: JSON.stringify(body) });

/** Sends a report. The same `key` replays the same case, so a lost response never files it twice. */
export const submitReport = (input: Omit<ReportInput, 'profile'>, key: string, send: typeof fetch = fetch) =>
  call<ReportReceipt>(() => send(`${BFF_PREFIX}/v1/public-reports`,
    json(key, { profile: 'public-report-v1', ...input })));

/** The reports the signed-in reporter sent, newest page first. */
export const listReports = (cursor: string | null, send: typeof fetch = fetch) =>
  call<ReportList>(() => send(`${BFF_PREFIX}/v1/public-reports/mine${cursor ? `?cursor=${cursor}` : ''}`,
    { cache: 'no-store', credentials: 'same-origin' }));

/** Where a locale's report page relays credentialed calls. */
export const relayBase = (locale: string) => `/${locale}/report/relay`;
const credentialed = (credential: string) => ({ 'x-rezics-case-credential': credential });

export const readCase = (input: { locale: string; caseId: string; credential: string; cursor?: string | null },
  send: typeof fetch = fetch) => call<CaseStatus>(() => send(
  `${relayBase(input.locale)}/v1/public-reports/${input.caseId}${input.cursor ? `?cursor=${input.cursor}` : ''}`,
  { cache: 'no-store', credentials: 'same-origin', headers: credentialed(input.credential) }));

/** Follow-up, an appeal or a counter-notice. */
export const writeCase = (input: { locale: string; caseId: string; credential: string; key: string;
  body: CorrespondenceInput }, send: typeof fetch = fetch) => call<{ stepId: string }>(() => send(
  `${relayBase(input.locale)}/v1/public-reports/${input.caseId}/correspondence`,
  json(input.key, input.body, credentialed(input.credential))));
