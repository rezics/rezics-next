// The Realms a person has managed on this device, newest first. Main has no
// "Realms I manage" read yet, so /manage lists these and checks each one's
// queue live; the list never grants anything, it only remembers where to look.

export const REMEMBERED_COOKIE = 'rezics_manage_realms';
export const REMEMBERED_LIMIT = 12;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function parseRemembered(value: string | undefined): string[] {
  if (!value) return [];
  let decoded: string;
  try { decoded = decodeURIComponent(value); } catch { return []; }
  return [...new Set(decoded.split('.').filter(item => uuid.test(item)))].slice(0, REMEMBERED_LIMIT);
}

export const serializeRemembered = (realms: readonly string[]) =>
  realms.filter(item => uuid.test(item)).slice(0, REMEMBERED_LIMIT).join('.');

export const remember = (realms: readonly string[], realm: string) =>
  [realm, ...realms.filter(item => item !== realm)].slice(0, REMEMBERED_LIMIT);

export const forget = (realms: readonly string[], realm: string) => realms.filter(item => item !== realm);

/** Writes the list from the browser; it holds public Realm IDs only, so scripts may read it. */
export function writeRemembered(realms: readonly string[]) {
  const secure = location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = `${REMEMBERED_COOKIE}=${serializeRemembered(realms)}; Path=/; Max-Age=31536000; SameSite=Lax${secure}`;
}

export function readRememberedCookie(): string[] {
  const entry = document.cookie.split('; ').find(item => item.startsWith(`${REMEMBERED_COOKIE}=`));
  return parseRemembered(entry?.slice(REMEMBERED_COOKIE.length + 1));
}
