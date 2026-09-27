// Account service responses cross a trust boundary; each is narrowed to the
// fields the pages show.

interface AccountUser { id: string; name: string; email: string; emailVerified: boolean;
  image: string | null; createdAt: string }
export interface AccountSession { user: AccountUser; sessionId: string }
export interface DeviceSession { id: string; token: string; createdAt: string; updatedAt: string;
  ipAddress: string | null; userAgent: string | null }
export interface LinkedAccount { id: string; providerId: string; createdAt: string }
export interface AppConsent { id: string; clientId: string; scopes: string[]; createdAt: string }
export interface PublicClient { clientId: string; name: string | null; uri: string | null;
  logo: string | null; policy: string | null; terms: string | null }

type Json = Record<string, unknown>;
export const record = (value: unknown): Json | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Json : null;
const text = (value: unknown): string | null => typeof value === 'string' ? value : null;
const date = (value: unknown): string | null =>
  typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : null;
export function list<T>(value: unknown, item: (entry: unknown) => T | null): T[] | null {
  if (!Array.isArray(value)) return null;
  const items = value.map(item);
  return items.every(entry => entry !== null) ? items as T[] : null;
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
    emailVerified: user?.emailVerified === true, image: text(user?.image) } };
}

export function parseDeviceSession(value: unknown): DeviceSession | null {
  const item = record(value);
  const id = text(item?.id);
  const token = text(item?.token);
  const createdAt = date(item?.createdAt);
  const updatedAt = date(item?.updatedAt) ?? createdAt;
  if (!id || !token || !createdAt || !updatedAt) return null;
  return { id, token, createdAt, updatedAt, ipAddress: text(item?.ipAddress) || null,
    userAgent: text(item?.userAgent) || null };
}

export function parseLinkedAccount(value: unknown): LinkedAccount | null {
  const item = record(value);
  const id = text(item?.id);
  const providerId = text(item?.providerId);
  const createdAt = date(item?.createdAt);
  return id && providerId && createdAt ? { id, providerId, createdAt } : null;
}

export function parseConsent(value: unknown): AppConsent | null {
  const item = record(value);
  const id = text(item?.id);
  const clientId = text(item?.clientId);
  const createdAt = date(item?.createdAt);
  const scopes = typeof item?.scopes === 'string' ? item.scopes.split(' ').filter(Boolean)
    : list(item?.scopes, text);
  return id && clientId && createdAt && scopes ? { id, clientId, createdAt, scopes } : null;
}

export function parsePublicClient(value: unknown): PublicClient | null {
  const item = record(value);
  const clientId = text(item?.client_id);
  if (!clientId) return null;
  const link = (entry: unknown) => {
    const candidate = text(entry);
    if (!candidate) return null;
    try { return ['https:', 'http:'].includes(new URL(candidate).protocol) ? candidate : null; }
    catch { return null; }
  };
  return { clientId, name: text(item?.client_name), uri: link(item?.client_uri),
    logo: link(item?.logo_uri), policy: link(item?.policy_uri), terms: link(item?.tos_uri) };
}

