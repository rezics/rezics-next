import { expect, test } from 'bun:test';
import { platformAdministratorAction } from '../../../services/main/src/modules/access/platform-administrator.ts';
import { findPlatformPermission, type PlatformPermission } from '../../../services/main/src/modules/access/platform-permissions.ts';

const work = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';
const scope = `work:publish:${work}`;
const permission = (action: string, scope_id: string): PlatformPermission => ({
  id: '00000000-0000-4000-8000-000000000002', action, scope_id,
  generation: '1', valid_until: null, witness: 'direct',
});

test('publication authority accepts only the native exact Work publication scope', () => {
  expect(platformAdministratorAction('work.publish', scope)).toBe(true);
  for (const invalid of ['work:publish:*', 'platform:access', `work:edit:${work}`,
    'work:publish:https://example.test/work', `${scope}/*`, `${scope}\n`,
    'work:publish:https://rezics.com/id/------------------------------------'])
    expect(platformAdministratorAction('work.publish', invalid)).toBe(false);
});

test('status, import and assignment permissions do not substitute for a Work publication mandate', () => {
  const grants = [permission('platform:use:platform-admin', 'platform:access'),
    permission('platform:resource:work.create', 'work:create:root'),
    permission('access.grant.assign.work.publish', 'work:publish:*')];
  expect(findPlatformPermission(grants, 'platform:resource:work.publish', scope)).toBeNull();
  grants.push(permission('platform:resource:work.publish', scope));
  expect(findPlatformPermission(grants, 'platform:resource:work.publish', scope)).toEqual(grants[3]!);
  expect(findPlatformPermission(grants, 'platform:resource:work.publish',
    'work:publish:https://rezics.com/id/00000000-0000-4000-8000-000000000003')).toBeNull();
});
