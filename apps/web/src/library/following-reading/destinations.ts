import * as v from 'valibot';
import { subjectHref } from '../../subject/subject-href';
import type { MineFollow } from '../mine-following';

export type FollowingDestination = { href: string; kind: 'subject' | 'collection' | 'space' | 'realm' };
const uuid = v.pipe(v.string(), v.uuid());
// The address reader accepts one nonempty path parameter, at most 128 characters.
const address = v.pipe(v.string(), v.minLength(1), v.maxLength(128));

/** Summary identity is not a Space address or Realm identity. */
export function suppliedDestination(follow: MineFollow, title: string, locale: string): FollowingDestination | null {
  if (!follow.target) return null;
  if (follow.targetType === 'subject')
    return { kind: 'subject', href: subjectHref({ id: follow.target.id, label: title }, locale).href };
  if (follow.targetType === 'collection')
    return {
      kind: 'collection',
      href: `/${encodeURIComponent(locale)}/collections/${encodeURIComponent(follow.target.id)}`,
    };
  return null;
}

/** Same encoded address and Realm routes as the installed community readers. */
export function spaceDestination(
  space: { address: string | null; realmId: string | null },
  locale: string,
): FollowingDestination | null {
  if (v.is(address, space.address))
    return { kind: 'space', href: `/${encodeURIComponent(locale)}/spaces/${encodeURIComponent(space.address)}` };
  if (v.is(uuid, space.realmId))
    return { kind: 'realm', href: `/${encodeURIComponent(locale)}/realms/${encodeURIComponent(space.realmId)}` };
  return null;
}
