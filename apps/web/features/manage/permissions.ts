import type { RealmPermission, RoleImpact } from './types.ts';

// Realm permissions in the order people think about them, each with a plain
// name and what it lets someone do (`realmPermissions` in realm-admin/contract.ts).
export const permissionOrder = ['governance.moderate', 'review.decide', 'publication.adopt', 'realm.members.manage',
  'governance.rule.publish', 'realm.settings.manage', 'rating.configure', 'realm.roles.manage'] as const satisfies readonly RealmPermission[];

/** Message keys for each permission's name and description. */
export const permissionText = {
  'governance.moderate': { name: 'permModerate', help: 'permModerateHelp' },
  'review.decide': { name: 'permReview', help: 'permReviewHelp' },
  'publication.adopt': { name: 'permAdopt', help: 'permAdoptHelp' },
  'realm.members.manage': { name: 'permMembers', help: 'permMembersHelp' },
  'governance.rule.publish': { name: 'permRules', help: 'permRulesHelp' },
  'realm.settings.manage': { name: 'permSettings', help: 'permSettingsHelp' },
  'realm.roles.manage': { name: 'permRoles', help: 'permRolesHelp' },
  'rating.configure': { name: 'permRatings', help: 'permRatingsHelp' },
} as const satisfies Record<RealmPermission, { name: string; help: string }>;

export const sortPermissions = (permissions: readonly RealmPermission[]) =>
  permissionOrder.filter(permission => permissions.includes(permission));

export interface ImpactLine {
  permission: RealmPermission;
  direction: 'gain' | 'lose';
  members: string[];
}

/**
 * An impact preview grouped the way people read it: "12 members gain: Manage
 * members". One line per permission and direction, gains first, in permission
 * order; members keep Main's order.
 */
export function impactLines(impact: Pick<RoleImpact, 'changes'>): ImpactLine[] {
  const lines: ImpactLine[] = [];
  for (const direction of ['gain', 'lose'] as const) {
    for (const permission of permissionOrder) {
      const members = impact.changes.filter(change =>
        (direction === 'gain' ? change.gained : change.lost).includes(permission)).map(change => change.member);
      if (members.length) lines.push({ permission, direction, members });
    }
  }
  return lines;
}

/** Whether a change would take role management away from the person making it. */
export function removesOwnRoleManagement(impact: Pick<RoleImpact, 'changes'>, actingSubject: string): boolean {
  return impact.changes.some(change => change.member === actingSubject && change.lost.includes('realm.roles.manage'));
}

/**
 * A person's place in a Realm, in one word, from the permissions Main lists
 * for them there: an owner (`realm.owner`), someone who moderates reports,
 * someone who reviews submissions, or otherwise someone who helps run it.
 */
export function positionOf(permissions: readonly string[]): 'owner' | 'moderator' | 'reviewer' | 'manager' {
  if (permissions.includes('realm.owner')) return 'owner';
  if (permissions.includes('governance.moderate')) return 'moderator';
  if (permissions.includes('review.decide') || permissions.includes('publication.adopt')) return 'reviewer';
  return 'manager';
}
