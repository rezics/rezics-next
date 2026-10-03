// Profile addresses: `/@{handle}`, `/@{handle}/works` and
// `/@{handle}/shelves/{status}`. Pure functions shared by the routes, the
// components and their tests.
//
// `@` in an App Router folder name declares a parallel route slot, so the
// profile lives in a dynamic segment, `app/[locale]/[handle]`, that receives
// the decoded `@handle` and answers 404 for anything else. Matching the URL
// directly keeps one address per profile with no rewrite to mirror in
// `proxy.ts`, and client navigation fetches the same path it shows. Static
// siblings (`/discover`, `/w`, …) still win, since routers try them first.

import type { ShelfStatus } from './types.ts';
import { resourceHref, type AddressTarget } from '../address/path.ts';
import { identityKeyUuid } from '@rezics/model/address';

// Main's handle forms (`services/main/src/modules/agent/handle.ts` and
// `vanity.ts`): a native `agent-{uuid}`, or a vanity name Main matches without
// regard to case and then redirects to its lower-case form.
// Main enforces claim policy; historical underscore forms still reach its resolver.
const vanity = /^[A-Za-z0-9_-]{3,30}$/;
const native = /^agent-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The handle a `[handle]` segment names (`@lin_mei` → `lin_mei`), or null when it names none. */
export function parseHandleSegment(segment: string): string | null {
  const decoded = segment.startsWith('%40') ? `@${segment.slice(3)}` : segment;
  if (!decoded.startsWith('@')) return null;
  const handle = decoded.slice(1);
  return identityKeyUuid(handle) || vanity.test(handle) || native.test(handle) ? handle : null;
}

/**
 * Whether a handle is the Agent's native address (`agent-{uuid}`). It still
 * resolves, but it is an identifier, so pages show and title only vanity handles.
 */
export const isNativeHandle = (handle: string) => native.test(handle);

/** Main's reading shelves in the order a profile lists them, as Goodreads does. */
export const shelfStatuses = ['reading', 'read', 'want-to-read'] as const satisfies readonly ShelfStatus[];

export function parseShelfStatus(value: string): ShelfStatus | null {
  return shelfStatuses.find(status => status === value) ?? null;
}

export type ProfileView = { kind: 'overview' } | { kind: 'works' } | { kind: 'shelf'; status: ShelfStatus };

/** A profile view's address, before the locale prefix. */
export function profileHref(profile: string | { handle: string | null; id?: string; address?: AddressTarget },
  view: ProfileView = { kind: 'overview' }, cursor?: string): string {
  const handle = typeof profile === 'string' ? profile : profile.handle;
  const address = typeof profile === 'string' ? undefined : profile.address;
  const id = typeof profile === 'string' ? profile : profile.id;
  if (!address && !handle && !id) throw new Error('Profile identity is unavailable');
  const base = address ? resourceHref('/a/', address) : !handle
    ? resourceHref('/a/', id!) : isNativeHandle(handle)
      ? resourceHref('/a/', handle.slice(6)) : identityKeyUuid(handle)
        ? resourceHref('/a/', identityKeyUuid(handle)!)
        : resourceHref('/a/', { prefix: '/@', key: handle, slugSource: '' });
  const path = `${base}${view.kind === 'works' ? '/works' : view.kind === 'shelf' ? `/shelves/${view.status}` : ''}`;
  return cursor ? `${path}?${new URLSearchParams({ cursor })}` : path;
}

/** A Main cursor from the URL, or undefined when absent or malformed. */
export function parseCursor(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 2048 ? value : undefined;
}
