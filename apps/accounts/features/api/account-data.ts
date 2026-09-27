// Account service responses cross a trust boundary; each is narrowed to the
// fields the pages show. Fields added to the service later are optional here,
// so a page keeps working against an Account service one release behind.

export type AccountLocale = 'en' | 'zh-CN';
interface AccountUser { id: string; name: string; email: string; emailVerified: boolean;
  image: string | null; createdAt: string; locale: AccountLocale | null; twoFactorEnabled: boolean }
export interface AccountSession { user: AccountUser; sessionId: string }
export interface Passkey { id: string; name: string | null; provider: string | null; createdAt: string;
  lastUsedAt: string | null; backedUp: boolean }
export interface SignInMethods { password: boolean; passwordChangedAt: string | null; passkeys: Passkey[];
  /** The authenticator app; `verified` is false while setup is unfinished. */
  totp: { name: string; verified: boolean } | null }
export interface DeviceSession { id: string; createdAt: string; lastActiveAt: string;
  browser: string | null; platform: string | null; network: string | null; thisDevice: boolean }
export interface SecurityEvent { id: string; action: string; occurredAt: string; method: string | null;
  browser: string | null; platform: string | null; network: string | null; clientId: string | null }
export interface SecurityActivity { items: SecurityEvent[]; nextCursor: string | null;
  failedLast24Hours: { count: number; capped: boolean } }
export interface ScopeDescription { scope: string; description: Record<AccountLocale, string> }
export interface ConnectedApp { clientId: string; name: string; uri: string | null; icon: string | null;
  trusted: boolean; scopes: ScopeDescription[]; grantedAt: string; lastUsedAt: string | null;
  /** The App was withdrawn from REZICS; its access can still be removed. */
  withdrawn: boolean }
export interface PublicClient { clientId: string; name: string | null; uri: string | null;
  logo: string | null; policy: string | null; terms: string | null }

type Json = Record<string, unknown>;
export const record = (value: unknown): Json | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Json : null;
const text = (value: unknown): string | null => typeof value === 'string' ? value : null;
const date = (value: unknown): string | null =>
  typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : null;
const locale = (value: unknown): AccountLocale | null => value === 'en' || value === 'zh-CN' ? value : null;
export function list<T>(value: unknown, item: (entry: unknown) => T | null): T[] | null {
  if (!Array.isArray(value)) return null;
  const items = value.map(item);
  return items.every(entry => entry !== null) ? items as T[] : null;
}
function webLink(value: unknown): string | null {
  const candidate = text(value);
  if (!candidate) return null;
  try { return ['https:', 'http:'].includes(new URL(candidate).protocol) ? candidate : null; }
  catch { return null; }
}
/** `{ items, nextCursor }` pages of the Account API. */
function page<T>(value: unknown, item: (entry: unknown) => T | null): { items: T[]; nextCursor: string | null } | null {
  const body = record(value);
  const items = list(body?.items, item);
  return items ? { items, nextCursor: text(body?.nextCursor) } : null;
}

export function parseSession(value: unknown): AccountSession | null {
  const body = record(value);
  const user = record(body?.user);
  const session = record(body?.session);
  const id = text(user?.id);
  const email = text(user?.email);
  const sessionId = text(session?.id);
  const createdAt = date(user?.createdAt);
  if (!id || !email || !sessionId || !createdAt) return null;
  return { sessionId, user: { id, email, createdAt, name: text(user?.name) ?? '',
    emailVerified: user?.emailVerified === true, image: webLink(user?.image), locale: locale(user?.locale),
    twoFactorEnabled: user?.twoFactorEnabled === true } };
}

function parsePasskey(value: unknown): Passkey | null {
  const item = record(value);
  const id = text(item?.id);
  const createdAt = date(item?.createdAt);
  return id && createdAt ? { id, createdAt, name: text(item?.name)?.trim() || null, provider: text(item?.provider),
    lastUsedAt: date(item?.lastUsedAt), backedUp: item?.backedUp === true } : null;
}

export function parseMethods(value: unknown): SignInMethods | null {
  const body = record(value);
  const passkeys = list(body?.passkeys, parsePasskey);
  const totp = record(body?.totp);
  if (typeof body?.password !== 'boolean' || !passkeys) return null;
  return { password: body.password, passwordChangedAt: date(body.passwordChangedAt), passkeys,
    totp: totp ? { name: text(totp.name) ?? '', verified: totp.verified === true } : null };
}

function parseDevice(value: unknown): DeviceSession | null {
  const item = record(value);
  const device = record(item?.device);
  const id = text(item?.id);
  const createdAt = date(item?.createdAt);
  const lastActiveAt = date(item?.lastActiveAt) ?? createdAt;
  if (!id || !createdAt || !lastActiveAt) return null;
  // The service names a browser it can't recognise "Unknown browser".
  const browser = text(device?.browser);
  return { id, createdAt, lastActiveAt, browser: browser === 'Unknown browser' ? null : browser,
    platform: text(device?.platform), network: text(item?.network), thisDevice: item?.thisDevice === true };
}

export const parseSessions = (value: unknown) => page(value, parseDevice);

function parseEvent(value: unknown): SecurityEvent | null {
  const item = record(value);
  const detail = record(item?.detail) ?? {};
  const device = record(detail.device);
  const id = text(item?.id);
  const action = text(item?.action);
  const occurredAt = date(item?.occurredAt);
  if (!id || !action || !occurredAt) return null;
  const browser = text(device?.browser);
  return { id, action, occurredAt, method: text(detail.method),
    browser: browser === 'Unknown browser' ? null : browser, platform: text(device?.platform),
    network: text(detail.network), clientId: text(detail.clientId) };
}

export function parseActivity(value: unknown): SecurityActivity | null {
  const events = page(value, parseEvent);
  const failed = record(record(value)?.failedAttemptsLast24Hours);
  if (!events) return null;
  return { ...events, failedLast24Hours: { count: typeof failed?.count === 'number' ? failed.count : 0,
    capped: failed?.capped === true } };
}

function parseScope(value: unknown): ScopeDescription | null {
  const item = record(value);
  const description = record(item?.description);
  const scope = text(item?.scope);
  const en = text(description?.en);
  return scope && en ? { scope, description: { en, 'zh-CN': text(description?.['zh-CN']) ?? en } } : null;
}

function parseConnectedApp(value: unknown): ConnectedApp | null {
  const item = record(value);
  const clientId = text(item?.clientId);
  const grantedAt = date(item?.grantedAt);
  const scopes = list(item?.scopes, parseScope);
  if (!clientId || !grantedAt || !scopes) return null;
  return { clientId, grantedAt, scopes, name: text(item?.name)?.trim() || clientId, uri: webLink(item?.uri),
    icon: webLink(item?.icon), trusted: item?.trusted === true, lastUsedAt: date(item?.lastUsedAt),
    withdrawn: item?.installationState === 'revoked' };
}

export const parseConnectedApps = (value: unknown) => page(value, parseConnectedApp);

export function parsePublicClient(value: unknown): PublicClient | null {
  const item = record(value);
  const clientId = text(item?.client_id);
  if (!clientId) return null;
  return { clientId, name: text(item?.client_name), uri: webLink(item?.client_uri),
    logo: webLink(item?.logo_uri), policy: webLink(item?.policy_uri), terms: webLink(item?.tos_uri) };
}
