import {
  type CanonicalAddress,
  deriveAddressSlug,
  identityKeyUuid,
  isSid,
  uuidToSid,
} from '@rezics/model/address';
import type { UiLocale } from '../../i18n/define.ts';
import { localizedPath, withoutLocale } from '../../i18n/locale.ts';

export type AddressSegment =
  | { kind: 'sid' | 'sid-slug' | 'uuid'; id: string; key: string }
  | { kind: 'name'; key: string };

/** Router params are already decoded. Slugs never participate in identity resolution. */
export function parseAddressSegment(segment: string): AddressSegment | null {
  if (!segment || segment.length > 512 || /[/\\?#\u0000-\u001f\u007f]/u.test(segment)) return null;
  const id = identityKeyUuid(segment);
  if (id)
    return {
      kind: /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(segment)
        ? 'uuid'
        : isSid(segment)
          ? 'sid'
          : 'sid-slug',
      id,
      key: segment,
    };
  return { kind: 'name', key: segment.normalize('NFC') };
}

export type AddressScope = 'agent' | 'space' | 'work' | 'resource' | 'concept' | `zone:${string}`;
export type Surface = 'community' | 'site';
export interface AddressLookup {
  scope: AddressScope;
  key: string;
  route?: string;
}
export interface AddressPath {
  lookup: AddressLookup;
  tail: string[];
  surface?: Surface;
  legacySite?: boolean;
}

const communityRoutes = new Set([
  'feed',
  'about',
  'rules',
  'members',
  'discussions',
  'submit',
  'decisions',
]);
export const isCommunityPath = (tail: readonly string[]) =>
  tail.length === 0 ||
  (communityRoutes.has(tail[0]!) &&
    (tail.length === 1 || (tail[0] === 'discussions' && tail.length === 2)));

/** A path lookup, including old capability UUIDs and the former native Agent handle. */
export function addressPath(pathname: string): AddressPath | null {
  let segments: string[];
  try {
    segments = withoutLocale(pathname).split('/').filter(Boolean).map(decodeURIComponent);
  } catch {
    return null;
  }
  const [prefix, key, ...tail] = segments;
  if (prefix?.startsWith('@')) {
    const handle = prefix.slice(1);
    const native = /^agent-([0-9a-f-]{36})$/i.exec(handle);
    const value = native && identityKeyUuid(native[1]!) ? native[1]! : handle;
    return parseAddressSegment(value)
      ? { lookup: { scope: 'agent', key: value }, tail: segments.slice(1) }
      : null;
  }
  if (!key || !parseAddressSegment(key)) return null;
  switch (prefix) {
    case 'a':
      return { lookup: { scope: 'agent', key }, tail };
    case 'w':
      return { lookup: { scope: 'work', key }, tail };
    case 'e':
      return { lookup: { scope: 'resource', key }, tail };
    case 'concepts':
      return { lookup: { scope: 'concept', key }, tail };
    case 'z':
      return { lookup: { scope: 'space', key }, surface: 'site', tail };
    case 'r': {
      // /r/new remains the community creation flow, never a Space lookup.
      if (key === 'new') return null;
      const legacySite = !isCommunityPath(tail);
      return {
        lookup: { scope: 'space', key },
        surface: legacySite ? 'site' : 'community',
        tail,
        ...(legacySite ? { legacySite: true } : {}),
      };
    }
    default:
      return null;
  }
}

export function addressKey(address: CanonicalAddress, displayedName = address.slugSource): string {
  if (!isSid(address.key)) return address.key;
  const slug = deriveAddressSlug(displayedName);
  return `${address.key}${slug ? `-${slug}` : ''}`;
}

/** Main selects the identity/name policy; the web only decorates an identity in the page's language. */
export function canonicalHref(
  address: CanonicalAddress,
  locale: UiLocale,
  displayedName = address.slugSource,
  options: { surface?: Surface; tail?: readonly string[]; search?: string; hash?: string } = {},
): string {
  const prefix =
    options.surface === 'community' ? '/r/' : options.surface === 'site' ? '/z/' : address.prefix;
  const tail = options.tail?.length ? `/${options.tail.map(encodeURIComponent).join('/')}` : '';
  return `${localizedPath(`${prefix}${encodeURIComponent(addressKey(address, displayedName))}${tail}`, locale)}${
    options.search ?? ''
  }${options.hash ?? ''}`;
}

/** All normalization happens in the same hop. Browser fragments survive a Location without a fragment too. */
export function canonicalRedirect(
  from: URL,
  address: CanonicalAddress,
  locale: UiLocale,
  options: { surface?: Surface; tail?: readonly string[]; displayedName?: string } = {},
): string | null {
  const target = canonicalHref(address, locale, options.displayedName ?? address.slugSource, {
    ...options,
    search: from.search,
    hash: from.hash,
  });
  return from.pathname + from.search + from.hash === target ? null : target;
}

/** Stable short forms for callers that have only a native identity, never a display name. */
export const identityHref = (prefix: '/a/' | '/w/' | '/e/' | '/concepts/', id: string) =>
  `${prefix}${uuidToSid(id.startsWith('https://rezics.com/id/') ? id.slice(-36) : id)}`;

export type AddressTarget = string | CanonicalAddress;

/** Summaries carry Main's policy; callers with only an identity use its short form. */
export function targetKey(target: AddressTarget): string {
  if (typeof target !== 'string') return addressKey(target);
  const key = target.startsWith('https://rezics.com/id/') ? target.slice(-36) : target;
  const parsed = parseAddressSegment(key);
  return parsed?.kind === 'uuid' ? uuidToSid(parsed.id) : key;
}

export function resourceHref(
  prefix: '/a/' | '/w/' | '/e/' | '/concepts/',
  target: AddressTarget,
): string {
  return `${typeof target === 'string' ? prefix : target.prefix}${encodeURIComponent(targetKey(target))}`;
}

export function spaceHref(
  target: AddressTarget,
  surface: Surface,
  tail: readonly string[] = [],
): string {
  return `${surface === 'community' ? '/r/' : '/z/'}${encodeURIComponent(targetKey(target))}${
    tail.length ? `/${tail.map(encodeURIComponent).join('/')}` : ''
  }`;
}

/** A mounted member can have a route-specific name policy supplied by Main. */
export function zoneMemberHref(
  space: AddressTarget,
  route: string,
  member: AddressTarget,
  tail: readonly string[] = [],
): string {
  return spaceHref(space, 'site', [route, targetKey(member), ...tail]);
}

export const threadHref = (communityPath: string, reply: string) =>
  `${communityPath}/discussions/${encodeURIComponent(targetKey(reply))}`;
