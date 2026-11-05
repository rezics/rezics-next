import { candidateContext } from '../../subject/candidates';

export const albumCurrentVisitLimit = 2048;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const tokenAlphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export type AlbumCurrentVisitOrigin = {
  version: 1;
  subject: { id: string; type: 'schema:MusicAlbum'; label: string };
  address: string;
  locale: string;
  context: {
    id: string;
    population: 'global' | 'realm';
    realm?: string;
    label?: string;
  };
  release?: string;
  reader?: string;
};

export type AlbumCurrentVisit =
  | { state: 'none' }
  | { state: 'unsupported' }
  | { state: 'origin'; token: string; origin: AlbumCurrentVisitOrigin };

export type AlbumCurrentReading = {
  subjectId: string;
  locale: string;
  context: { id: string; population: 'global' | 'realm'; realm?: string };
  release?: string | undefined;
  reader?: string | undefined;
  address: string;
};

const encoder = new TextEncoder();

function bytes(value: string) {
  return encoder.encode(value).byteLength;
}

function boundedText(value: unknown, limit: number): value is string {
  return typeof value === 'string' && value.length > 0 && bytes(value) <= limit && !/[\u0000-\u001f\u007f]/u.test(value);
}

function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []) {
  const keys = Object.keys(value);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    keys.length >= required.length &&
    keys.every((key) => required.includes(key) || optional.includes(key))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function base64UrlEncode(input: Uint8Array) {
  let output = '';
  for (let index = 0; index < input.length; index += 3) {
    const first = input[index]!;
    const second = input[index + 1];
    const third = input[index + 2];
    output += tokenAlphabet[first >> 2]!;
    output += tokenAlphabet[((first & 3) << 4) | ((second ?? 0) >> 4)]!;
    if (second !== undefined) output += tokenAlphabet[((second & 15) << 2) | ((third ?? 0) >> 6)]!;
    if (third !== undefined) output += tokenAlphabet[third & 63]!;
  }
  return output;
}

function base64UrlDecode(value: string): Uint8Array | undefined {
  if (!value || value.length > albumCurrentVisitLimit || !/^[A-Za-z0-9_-]+$/u.test(value) || value.length % 4 === 1)
    return;
  const output: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const character of value) {
    const digit = tokenAlphabet.indexOf(character);
    if (digit < 0) return;
    buffer = (buffer << 6) | digit;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      output.push((buffer >> bits) & 255);
    }
  }
  if (bits && (buffer & ((1 << bits) - 1)) !== 0) return;
  const decoded = Uint8Array.from(output);
  return base64UrlEncode(decoded) === value ? decoded : undefined;
}

function normalizeOrigin(
  value: unknown,
  locale: string,
  validateAddress: (value: unknown, locale: string) => string | undefined,
): AlbumCurrentVisitOrigin | undefined {
  if (!isRecord(value) || !exactKeys(value, ['version', 'subject', 'address', 'locale', 'context'], ['release', 'reader']))
    return;
  if (value.version !== 1 || value.locale !== locale) return;
  if (!isRecord(value.subject) || !exactKeys(value.subject, ['id', 'type', 'label'])) return;
  if (
    typeof value.subject.id !== 'string' ||
    !uuid.test(value.subject.id) ||
    value.subject.type !== 'schema:MusicAlbum' ||
    !boundedText(value.subject.label, 512)
  )
    return;
  if (!isRecord(value.context) || !exactKeys(value.context, ['id', 'population'], ['realm', 'label'])) return;
  if (
    typeof value.context.id !== 'string' ||
    !uuid.test(value.context.id) ||
    (value.context.population !== 'global' && value.context.population !== 'realm')
  )
    return;
  const realm = value.context.realm;
  if (realm !== undefined && (typeof realm !== 'string' || !uuid.test(realm))) return;
  if (value.context.population === 'realm' && !realm) return;
  if (value.context.population === 'global' && value.context.id !== candidateContext) return;
  if (value.context.label !== undefined && !boundedText(value.context.label, 256)) return;
  if (value.release !== undefined && !boundedText(value.release, 128)) return;
  if (value.reader !== undefined && !boundedText(value.reader, 128)) return;
  if (typeof value.address !== 'string' || !boundedText(value.address, albumCurrentVisitLimit)) return;
  const address = validateAddress(value.address, locale);
  if (!address) return;
  let parsed: URL;
  try {
    parsed = new URL(address, 'https://rezics.invalid');
  } catch {
    return;
  }
  if (
    parsed.origin !== 'https://rezics.invalid' ||
    parsed.username ||
    parsed.password ||
    parsed.pathname.split('/')[1] !== locale ||
    parsed.pathname.split('/')[2] !== 'subjects' ||
    parsed.pathname.split('/')[3] !== value.subject.id
  )
    return;
  const realms = parsed.searchParams.getAll('realm');
  const contexts = parsed.searchParams.getAll('context');
  if (
    realms.length > 1 ||
    contexts.length > 1 ||
    (realm && realms[0] !== realm) ||
    (!realm && realms.length > 0) ||
    (contexts.length === 1 && contexts[0] !== value.context.id)
  )
    return;
  return {
    version: 1,
    subject: { id: value.subject.id, type: 'schema:MusicAlbum', label: value.subject.label },
    address,
    locale,
    context: {
      id: value.context.id,
      population: value.context.population,
      ...(realm ? { realm } : {}),
      ...(value.context.label ? { label: value.context.label } : {}),
    },
    ...(typeof value.release === 'string' ? { release: value.release } : {}),
    ...(typeof value.reader === 'string' ? { reader: value.reader } : {}),
  };
}

function encodeOrigin(origin: AlbumCurrentVisitOrigin): string | undefined {
  const encoded = base64UrlEncode(encoder.encode(JSON.stringify(origin)));
  return encoded.length <= albumCurrentVisitLimit && bytes(encoded) <= albumCurrentVisitLimit ? encoded : undefined;
}

function decodeOrigin(
  token: string,
  locale: string,
  validateAddress: (value: unknown, locale: string) => string | undefined,
): AlbumCurrentVisitOrigin | undefined {
  const encoded = base64UrlDecode(token);
  if (!encoded || encoded.byteLength > albumCurrentVisitLimit) return;
  let json: string;
  try {
    json = new TextDecoder('utf-8', { fatal: true }).decode(encoded);
  } catch {
    return;
  }
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return;
  }
  const origin = normalizeOrigin(value, locale, validateAddress);
  return origin && JSON.stringify(origin) === json ? origin : undefined;
}

function addressWithinLimit(value: string) {
  return value.length <= albumCurrentVisitLimit && bytes(value) <= albumCurrentVisitLimit;
}

export function albumCurrentVisitReturnHref(origin: AlbumCurrentVisitOrigin, token: string): string | undefined {
  if (token.length > albumCurrentVisitLimit || !/^[A-Za-z0-9_-]+$/u.test(token)) return;
  const url = new URL(origin.address, 'https://rezics.invalid');
  url.hash = `album-current-return=${token}`;
  const href = `${url.pathname}${url.search}${url.hash}`;
  return addressWithinLimit(href) ? href : undefined;
}

export function createAlbumCurrentVisitLink(
  albumHref: string,
  input: unknown,
  locale: string,
  validateAddress: (value: unknown, locale: string) => string | undefined,
): { href: string; token: string } {
  const unsupported = new URL(albumHref, 'https://rezics.invalid');
  unsupported.searchParams.set('visit', 'unsupported');
  const fallback = `${unsupported.pathname}${unsupported.search}`;
  if (!addressWithinLimit(fallback)) return { href: albumHref, token: 'unsupported' };
  const origin = normalizeOrigin(input, locale, validateAddress);
  if (!origin) return { href: fallback, token: 'unsupported' };
  const token = encodeOrigin(origin);
  if (!token || !albumCurrentVisitReturnHref(origin, token)) return { href: fallback, token: 'unsupported' };
  const url = new URL(albumHref, 'https://rezics.invalid');
  if (
    url.origin !== 'https://rezics.invalid' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !url.pathname.startsWith(`/${locale}/subjects/${origin.subject.id}/`) ||
    !url.pathname.endsWith('/album')
  )
    return { href: fallback, token: 'unsupported' };
  url.searchParams.set('visit', token);
  const href = `${url.pathname}${url.search}`;
  return addressWithinLimit(url.search.slice(1)) ? { href, token } : { href: fallback, token: 'unsupported' };
}

export function parseAlbumCurrentVisitSearch(
  search: string,
  locale: string,
  validateAddress: (value: unknown, locale: string) => string | undefined,
): AlbumCurrentVisit {
  if (search.length > albumCurrentVisitLimit || bytes(search) > albumCurrentVisitLimit) return { state: 'unsupported' };
  const parameters = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const keys = [...parameters.keys()];
  if (!keys.includes('visit')) return { state: 'none' };
  if (keys.length !== 1 || keys.some((key) => key !== 'visit') || parameters.getAll('visit').length !== 1)
    return { state: 'unsupported' };
  const token = parameters.get('visit');
  if (!token || token === 'unsupported') return { state: 'unsupported' };
  const origin = decodeOrigin(token, locale, validateAddress);
  return origin && albumCurrentVisitReturnHref(origin, token)
    ? { state: 'origin', token, origin }
    : { state: 'unsupported' };
}

export function albumCurrentVisitFromReturnHash(
  hash: string,
  locale: string,
  validateAddress: (value: unknown, locale: string) => string | undefined,
): { token: string; origin?: AlbumCurrentVisitOrigin } | undefined {
  const prefix = '#album-current-return=';
  if (!hash.startsWith(prefix)) return;
  const token = hash.slice(prefix.length);
  if (!token || token.includes('&') || token.includes('=')) return { token };
  return { token, origin: decodeOrigin(token, locale, validateAddress) };
}

export function albumCurrentVisitSourceAddress(value: string): string {
  const url = new URL(value, 'https://rezics.invalid');
  if (url.hash.startsWith('#album-current-return=')) url.hash = '';
  return `${url.pathname}${url.search}${url.hash}`;
}

export function albumCurrentVisitMatches(origin: AlbumCurrentVisitOrigin, current: AlbumCurrentReading): boolean {
  if (
    origin.subject.id !== current.subjectId ||
    origin.locale !== current.locale ||
    origin.context.id !== current.context.id ||
    origin.context.population !== current.context.population ||
    (origin.context.realm ?? '') !== (current.context.realm ?? '') ||
    !origin.reader ||
    !current.reader ||
    origin.reader !== current.reader ||
    !origin.release ||
    !current.release ||
    origin.release !== current.release
  )
    return false;
  try {
    const original = new URL(origin.address, 'https://rezics.invalid');
    const returned = new URL(current.address, 'https://rezics.invalid');
    return (
      original.origin === returned.origin &&
      original.pathname === returned.pathname &&
      original.search === returned.search
    );
  } catch {
    return false;
  }
}
