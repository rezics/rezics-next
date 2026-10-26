import type { KernelClient } from '@rezics/client';
import { isPlatformClosedError } from '../kernel/platform-closed';
import { readLibraryResult } from '../library/reads';
import type { SessionEnv } from '../session/client';
import { prepareSession, sessionSubject, viewerCredential } from '../session/request';

export type SpoilerLevel = 0 | 1 | 2;
export type Suitability = 'blur' | 'show';
export type ReadingPreferences = { spoilerLevel: SpoilerLevel; suitability: Suitability; version: number };

export type SettingsPage =
  | { signedIn: false }
  | { signedIn: true; preferences: ReadingPreferences; securityHref: string | null };

export type PreferenceChange = {
  expectedVersion: number;
  spoilerLevel?: SpoilerLevel;
  suitability?: Suitability;
  idempotencyKey: string;
};

export type PreferenceWriteResult =
  | { ok: true; preferences: ReadingPreferences }
  | { ok: false; reason: 'closed' | 'conflict' | 'forbidden' | 'invalid' | 'unavailable' };

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The write a request asks for, or `undefined` when it names no setting or carries a value the kernel would refuse. */
export function parsePreferenceChange(input: unknown): PreferenceChange | undefined {
  if (!isRecord(input)) return undefined;
  const { expectedVersion, spoilerLevel, suitability, idempotencyKey } = input;
  if (!Number.isSafeInteger(expectedVersion) || (expectedVersion as number) < 0) return undefined;
  if (typeof idempotencyKey !== 'string' || !uuid.test(idempotencyKey)) return undefined;
  if (spoilerLevel !== undefined && spoilerLevel !== 0 && spoilerLevel !== 1 && spoilerLevel !== 2) return undefined;
  if (suitability !== undefined && suitability !== 'blur' && suitability !== 'show') return undefined;
  if (spoilerLevel === undefined && suitability === undefined) return undefined;
  return {
    expectedVersion: expectedVersion as number,
    idempotencyKey,
    ...(spoilerLevel !== undefined ? { spoilerLevel } : {}),
    ...(suitability !== undefined ? { suitability } : {}),
  };
}

function present(preferences: ReadingPreferences): ReadingPreferences {
  return {
    spoilerLevel: preferences.spoilerLevel,
    suitability: preferences.suitability,
    version: preferences.version,
  };
}

/** The Auth site owns password, passkeys and sessions; the settings page only links to them. */
function securityHref(sessionEnv: Partial<SessionEnv>): string | null {
  if (!sessionEnv.AUTH_ISSUER) return null;
  try {
    return new URL('/security', sessionEnv.AUTH_ISSUER).href;
  } catch {
    return null;
  }
}

/** One session read and one `GET /v1/accounts/<id>/preferences` for the signed-in account. */
export async function loadSettingsPage(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
): Promise<SettingsPage> {
  await prepareSession(request, sessionEnv);
  const authorization = viewerCredential(request);
  const accountId = sessionSubject(request);
  if (!authorization || !accountId) return { signedIn: false };
  const result = await client.accounts({ accountId }).preferences.get({ headers: { authorization } });
  return {
    signedIn: true,
    preferences: present(readLibraryResult(result)),
    securityHref: securityHref(sessionEnv),
  };
}

function problemCode(error: unknown): unknown {
  return isRecord(error) && isRecord(error.value) ? error.value.code : undefined;
}

/** One session read and one `PATCH` carrying the version the person read. A stale version changes nothing. */
export async function changePreferences(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  change: PreferenceChange,
): Promise<PreferenceWriteResult> {
  try {
    await prepareSession(request, sessionEnv);
    const authorization = viewerCredential(request);
    const accountId = sessionSubject(request);
    if (!authorization || !accountId) return { ok: false, reason: 'forbidden' };
    const { idempotencyKey, ...body } = change;
    const result = await client.accounts({ accountId }).preferences.patch(body, {
      headers: { authorization, 'idempotency-key': idempotencyKey } as { 'idempotency-key': string },
    });
    if (!result.error && result.data) return { ok: true, preferences: present(result.data) };
    const status = result.status;
    if (status === 409 && problemCode(result.error) === 'conflict') return { ok: false, reason: 'conflict' };
    if (status === 400 || status === 422) return { ok: false, reason: 'invalid' };
    if (status === 401 || status === 403) return { ok: false, reason: 'forbidden' };
    return { ok: false, reason: 'unavailable' };
  } catch (error) {
    if (isPlatformClosedError(error)) return { ok: false, reason: 'closed' };
    return { ok: false, reason: 'unavailable' };
  }
}
