import type { ConnectedApp, SecurityEvent, SignInMethods } from '../api/account-data.ts';

/** What happened, in the account centre's words. Account actions without one
 * (a later service addition) are left out rather than shown as raw codes. */
export type ActivityKind = 'signed-in' | 'sign-in-failed' | 'signed-out' | 'device-signed-out'
  | 'password-changed' | 'password-added' | 'password-removed' | 'passkey-added' | 'passkey-removed'
  | 'passkey-renamed' | 'two-step-on' | 'two-step-off' | 'authenticator-renamed' | 'backup-codes-changed'
  | 'email-changed' | 'app-connected' | 'app-removed' | 'data-downloaded' | 'administrator';
type SignInMethod = 'password' | 'passkey' | 'authenticator' | 'backup-code';

const kinds: Record<string, ActivityKind> = {
  sign_in: 'signed-in', sign_in_failed: 'sign-in-failed', sign_out: 'signed-out',
  session_revoked: 'device-signed-out', password_changed: 'password-changed', password_added: 'password-added',
  password_removed: 'password-removed', passkey_added: 'passkey-added', passkey_removed: 'passkey-removed',
  passkey_renamed: 'passkey-renamed', totp_added: 'two-step-on', totp_removed: 'two-step-off',
  totp_renamed: 'authenticator-renamed', backup_codes_changed: 'backup-codes-changed',
  email_changed: 'email-changed', consent_granted: 'app-connected', app_revoked: 'app-removed',
  consent_revoked: 'app-removed', data_exported: 'data-downloaded', admin_action: 'administrator',
};
// Account names the sign-in endpoint that succeeded or failed.
const methods: Record<string, SignInMethod> = { email: 'password', 'verify-authentication': 'passkey',
  'verify-totp': 'authenticator', 'verify-backup-code': 'backup-code' };

/** Changes someone else could have made: each offers "Wasn't you?". */
export const reviewable = new Set<ActivityKind>(['signed-in', 'sign-in-failed', 'password-changed',
  'password-removed', 'passkey-added', 'two-step-off', 'email-changed', 'app-connected', 'backup-codes-changed',
  'data-downloaded']);

export interface ActivityEntry {
  id: string;
  kind: ActivityKind;
  occurredAt: string;
  /** How many like events this one stands for (repeated failures, a batch of sign-outs). */
  count: number;
  method: SignInMethod | null;
  /** The App an app event concerns. */
  clientId: string | null;
  browser: string | null;
  platform: string | null;
  network: string | null;
}

// Actions that end sessions as part of their own work.
const revokers = new Set(['sign_out', 'password_changed', 'password_added', 'totp_added', 'totp_removed',
  'admin_action']);

/** The account centre shows 90 days of security activity. */
const ACTIVITY_DAYS = 90;
const echo = 10_000;

/**
 * Security events as a person reads them, newest first. Account records each
 * row it deletes, so one action can leave several events: signing out, turning
 * on 2-Step Verification or changing the password also ends sessions, and
 * removing an App withdraws its consent. Those echoes fold into the action that
 * caused them; runs of failed sign-ins or device sign-outs become one entry.
 * `complete` says whether older events inside the window may still exist.
 */
export function presentActivity(events: readonly SecurityEvent[], now: Date, more: boolean):
{ entries: ActivityEntry[]; complete: boolean } {
  const since = now.getTime() - ACTIVITY_DAYS * 86_400_000;
  const recent = events.filter(event => Date.parse(event.occurredAt) >= since);
  const causes = recent.filter(event => revokers.has(event.action) || event.action === 'app_revoked');
  const near = (event: SecurityEvent, other: SecurityEvent) =>
    Math.abs(Date.parse(event.occurredAt) - Date.parse(other.occurredAt)) <= echo;
  const entries: ActivityEntry[] = [];
  for (const event of recent) {
    const kind = kinds[event.action];
    if (!kind) continue;
    if (event.action === 'session_revoked' && causes.some(cause => revokers.has(cause.action) && near(event, cause))) continue;
    if (event.action === 'consent_revoked' && causes.some(cause => cause.action === 'app_revoked'
      && cause.clientId === event.clientId && near(event, cause))) continue;
    const previous = entries.at(-1);
    if (previous && previous.kind === kind && (kind === 'sign-in-failed' || kind === 'device-signed-out')
      && Date.parse(previous.occurredAt) - Date.parse(event.occurredAt) <= (kind === 'sign-in-failed' ? 3_600_000 : echo)) {
      previous.count++;
      continue;
    }
    entries.push({ id: event.id, kind, occurredAt: event.occurredAt, count: 1,
      method: event.method ? methods[event.method] ?? null : null, clientId: event.clientId,
      browser: event.browser, platform: event.platform, network: event.network });
  }
  return { entries, complete: !more || recent.length < events.length };
}

export type CheckupIssue = 'verify-email' | 'failed-sign-ins' | 'add-second-step' | 'unused-apps';

/** Sign-in failures in a day that deserve a look rather than a typo or two. */
export const FAILED_SIGN_IN_ALERT = 3;
/** An App unused this long probably no longer needs access, as Google's checkup suggests. */
export const UNUSED_APP_DAYS = 90;

/** Apps from outside REZICS that haven't used the account in `UNUSED_APP_DAYS`. */
export function unusedApps<T extends Pick<ConnectedApp, 'firstParty' | 'lastUsedAt' | 'grantedAt'>>(apps: readonly T[],
  now: Date): T[] {
  const since = now.getTime() - UNUSED_APP_DAYS * 86_400_000;
  return apps.filter(app => !app.firstParty && Date.parse(app.lastUsedAt ?? app.grantedAt) < since);
}

/** What the account needs now, most urgent first; empty when all is well.
 * `apps` is null when they could not be read. */
export function securityCheckup(input: { emailVerified: boolean; methods: SignInMethods | null;
  failedLast24Hours: number | null; apps?: readonly ConnectedApp[] | null; now?: Date }): CheckupIssue[] {
  const issues: CheckupIssue[] = [];
  if (!input.emailVerified) issues.push('verify-email');
  if ((input.failedLast24Hours ?? 0) >= FAILED_SIGN_IN_ALERT) issues.push('failed-sign-ins');
  // A password alone can be phished or reused; a passkey or 2-Step Verification protects it.
  if (input.methods && !input.methods.passkeys.length && !input.methods.totp?.verified) issues.push('add-second-step');
  if (input.apps && unusedApps(input.apps, input.now ?? new Date()).length) issues.push('unused-apps');
  return issues;
}

/** The checkup's four areas, in the order it reviews them. */
export type CheckupArea = 'devices' | 'activity' | 'sign-in' | 'apps';
export const checkupAreas: readonly CheckupArea[] = ['devices', 'activity', 'sign-in', 'apps'];
export const issueArea: Record<CheckupIssue, CheckupArea> = { 'verify-email': 'sign-in',
  'failed-sign-ins': 'activity', 'add-second-step': 'sign-in', 'unused-apps': 'apps' };
/** Issues someone else may be causing now, or that lock the person out. */
export const urgentIssues: ReadonlySet<CheckupIssue> = new Set(['verify-email', 'failed-sign-ins']);
export type CheckupTone = 'ok' | 'tip' | 'warn' | 'unknown';

/** An area's status: a warning for an urgent issue, a tip for a suggestion. */
export function areaTone(area: CheckupArea, issues: readonly CheckupIssue[]): CheckupTone {
  const found = issues.filter(issue => issueArea[issue] === area);
  return found.some(issue => urgentIssues.has(issue)) ? 'warn' : found.length ? 'tip' : 'ok';
}
