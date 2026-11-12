import * as v from 'valibot';
import { subjectHref } from '../../subject/subject-href';
import type { MineFollow } from '../mine-following';
import type { SelectedSpace } from './space-reader';

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
  if (follow.target.id !== follow.targetId) return null;
  const supplied = follow.destination;
  if (!supplied || supplied.kind === 'unavailable') return null;
  if (supplied.kind === 'space') {
    if (supplied.spaceId !== follow.targetId || !v.is(address, supplied.address)) return null;
    return { kind: 'space', href: `/${encodeURIComponent(locale)}/spaces/${encodeURIComponent(supplied.address)}` };
  }
  if (supplied.kind !== 'realm' || !v.is(uuid, supplied.realmId)) return null;
  return { kind: 'realm', href: `/${encodeURIComponent(locale)}/realms/${encodeURIComponent(supplied.realmId)}` };
}

/** A selected native read confirms the FULL page's supplied destination before inspection uses it. */
export function currentSpaceDestination(
  follow: MineFollow,
  current: SelectedSpace,
  locale: string,
): FollowingDestination | null {
  const destination = suppliedDestination(follow, '', locale);
  if (!destination || current.spaceId !== follow.targetId) return null;
  if (
    follow.destination?.kind === 'space' &&
    current.address === follow.destination.address &&
    current.spaceId === follow.destination.spaceId
  )
    return destination;
  if (follow.destination?.kind === 'realm' && current.realmId === follow.destination.realmId) return destination;
  return null;
}

/** Realm membership actions stay with their existing Realm page owner and use only its native Realm operand. */
export function suppliedRealmMembershipHref(follow: MineFollow, current: SelectedSpace, locale: string): string | null {
  const actions = follow.actions;
  if (
    !follow.target ||
    follow.targetType !== 'space' ||
    !currentSpaceDestination(follow, current, locale) ||
    !actions ||
    actions.status !== 'available' ||
    actions.resourceType !== 'community.realm' ||
    !v.is(uuid, actions.resourceId) ||
    actions.resourceId !== current.realmId
  )
    return null;
  const admitted = actions.viewerActions.some(
    ({ action, operations }) =>
      action === 'realm:join' && (operations.includes('realm.join') || operations.includes('realm.leave')),
  );
  return admitted ? `/${encodeURIComponent(locale)}/realms/${encodeURIComponent(actions.resourceId)}` : null;
}
