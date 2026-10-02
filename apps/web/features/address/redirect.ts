import { uuidToSid } from '@rezics/model/address';
import type { UiLocale } from '../../i18n/define.ts';
import { withoutLocale } from '../../i18n/locale.ts';
import type { AddressRead, ResolvedAddress } from './client.ts';
import {
  type AddressLookup,
  addressPath,
  canonicalHref,
  canonicalRedirect,
  parseAddressSegment,
} from './path.ts';

export type AddressDecision =
  | { kind: 'pass'; data?: ResolvedAddress }
  | { kind: 'redirect'; location: string; status: 301 }
  | { kind: 'error'; status: 404 | 410 | 503 };
type Resolver = (lookup: AddressLookup) => Promise<AddressRead>;
const error = (read: Exclude<AddressRead, { kind: 'resolved' }>): AddressDecision => ({
  kind: 'error',
  status: read.kind === 'retired' ? 410 : read.kind === 'missing' ? 404 : 503,
});

/** Resolve first, then construct the final Location. No intermediate UUID/name/surface redirects. */
export async function decideAddress(
  url: URL,
  locale: UiLocale,
  resolve: Resolver,
): Promise<AddressDecision> {
  if (withoutLocale(url.pathname).replace(/\/+$/, '') === '/r') {
    const query = new URLSearchParams(url.search);
    query.set('type', 'communities');
    return { kind: 'redirect', status: 301, location: `/${locale}/discover?${query}${url.hash}` };
  }
  const path = addressPath(url.pathname);
  if (!path) return { kind: 'pass' };
  // Main's current resolver admits only anonymous summaries. Private draft
  // editors must reach their owning authenticated read until that resolver
  // supports the viewer; public address admission cannot fence an editor out.
  if (path.lookup.scope === 'work' && path.tail[0] === 'edit') return { kind: 'pass' };
  const read = await resolve(path.lookup);
  if (read.kind !== 'resolved') return error(read);
  const data = read.data;
  if (path.surface && !data.capabilities?.[path.surface === 'community' ? 'realm' : 'zone']) {
    // Legacy /r home of a site without a community still opens its site.
    if (path.surface === 'community' && !path.tail.length && data.capabilities?.zone)
      path.surface = 'site';
    else return { kind: 'error', status: 404 };
  }
  if (path.surface === 'community' && path.tail[0] === 'feed') path.tail = [];
  if (path.surface === 'community' && path.tail[0] === 'discussions' && path.tail[1]) {
    const reply = parseAddressSegment(path.tail[1]);
    if (!reply || reply.kind === 'name') return { kind: 'error', status: 404 };
    path.tail[1] = uuidToSid(reply.id);
  }
  if (path.legacySite && path.tail[0] === 'works') path.tail = ['browse', ...path.tail.slice(1)];
  let location = canonicalRedirect(url, data.canonical, locale, path);
  // A mounted detail has its own name policy. The Space and member both
  // canonicalize before returning the single Location, even after renaming.
  if (path.surface === 'site' && path.tail.length >= 2) {
    const [route, key, ...tabs] = path.tail;
    const detail = await resolve(
      route === 'w'
        ? { scope: 'work', key: key! }
        : { scope: `zone:${data.holder}`, route, key: key! },
    );
    if (detail.kind !== 'resolved') return error(detail);
    const member =
      route === 'w'
        ? { ...detail.data.canonical, key: uuidToSid(detail.data.holder.slice(-36)) }
        : detail.data.canonical;
    const base = canonicalHref(data.canonical, locale, data.canonical.slugSource, {
      surface: 'site',
    });
    const target = canonicalHref({ ...member, prefix: '/e/' }, locale, member.slugSource, {
      tail: tabs,
      search: url.search,
      hash: url.hash,
    });
    const suffix = target.slice(`/${locale}/e/`.length);
    const final = `${base}/${encodeURIComponent(route!)}/${suffix}`;
    location = final === url.pathname + url.search + url.hash ? null : final;
  }
  return location ? { kind: 'redirect', location, status: 301 } : { kind: 'pass', data };
}
