import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { Access } from '../../src/request/access.ts';
import { readRealmSettingsPage } from '../../src/community/settings-page.ts';
import { routeOf } from '../../src/route/route.ts';
import {
  presentationSettingsFixture,
  type PresentationSettingsFixture,
} from './support/growth-realm-presentation-settings-fixture.ts';

let f: PresentationSettingsFixture;
beforeAll(async () => {
  f = await presentationSettingsFixture();
}, 120_000);
afterAll(async () => {
  await f?.close();
});

test.serial('protected Realms require a manager while orphaned management is explicitly read-only', async () => {
  const protectedRealm = await f.base.createRealmTarget('Protected settings Realm', 'protected');
  const protectedPath = `/v1/realms/${protectedRealm.realmId}/settings`;
  const protectedPage = await f.call('GET', protectedPath);
  expect(protectedPage.response.status, protectedPage.text).toBe(200);
  expect(protectedPage.value.snapshot.visibility).toBe('protected');
  const ungranted = await f.call('GET', protectedPath, { bearer: f.base.other.bearer });
  expect(ungranted.response.status).toBe(404);
  expect(ungranted.text).not.toContain(protectedPage.value.snapshot.head);

  const s = await f.select();
  await f.manage(s, f.base.other);
  const route = routeOf(s.realmId);
  expect(route).not.toBeNull();
  const orphaned = await f.db.admin.query<{ ownership_state: string }>(
    `WITH root AS (SELECT clock_timestamp() AS at)
     UPDATE community.realm
        SET ownership_state='orphaned', orphaned_at=root.at,
            claim_eligible_at=root.at + interval '720 hours'
       FROM root
      WHERE route=$1 AND realm_id=$2
      RETURNING ownership_state`,
    [route, s.realmId],
  );
  expect(orphaned.rows).toEqual([{ ownership_state: 'orphaned' }]);

  const page = await f.call('GET', `/v1/realms/${s.realmId}/settings`, { bearer: f.base.other.bearer });
  expect(page.response.status, page.text).toBe(200);
  expect(page.value.snapshot).toMatchObject({ ownershipState: 'orphaned', governanceReadOnly: true, canManage: false });
  for (const operation of Object.values(page.value.operations))
    expect(operation).toMatchObject({ available: false, reason: 'governance_read_only' });
});

test.serial('erased selected rules retain their pin while concealing the native body', async () => {
  const s = await f.select();
  const selected = await f.patch(s, { presentation: s.presentation });
  expect(selected.response.status, selected.text).toBe(200);

  const erased = await f.call('DELETE', `/v1/posts/${s.postId}`);
  expect(erased.response.status, erased.text).toBe(204);
  const page = await f.call('GET', `/v1/realms/${s.realmId}/settings`);
  expect(page.response.status, page.text).toBe(200);
  expect(page.value.snapshot.presentation.rules).toEqual(s.pin);
  expect(page.value.snapshot.rules).toEqual({ state: 'none', value: null });
  expect(page.text).not.toContain(s.post.sha256);
});

test.serial('a manager session suspended during composition cannot receive a settings page', async () => {
  const s = await f.select();
  const selected = await f.patch(s, { presentation: s.presentation });
  expect(selected.response.status, selected.text).toBe(200);
  await f.manage(s, f.base.other);
  const path = `/v1/realms/${s.realmId}/settings`;
  const established = await f.call('GET', path, { bearer: f.base.other.bearer });
  expect(established.response.status, established.text).toBe(200);

  const native = f.base.system.access;
  let suspendedDuringComposition = false;
  let suspensionStatus: number | undefined;
  const access: Access = {
    ...native,
    async prepareReadDecisions(input) {
      if (!suspendedDuringComposition && input.actions.has('post:read')) {
        suspendedDuringComposition = true;
        const suspension = await f.call('POST', `/v1/accounts/${f.base.other.accountId}:suspend`, {
          bearer: f.base.governance.bearer,
          body: { reason: 'Suspend the active manager during settings composition' },
        });
        suspensionStatus = suspension.response.status;
        expect(suspension.response.status, suspension.text).toBe(200);
      }
      return native.prepareReadDecisions!(input);
    },
  };

  let returned = false;
  try {
    await readRealmSettingsPage(
      { pool: f.db.pool, access, deadlineNow: () => Date.now() },
      f.base.system.actors.other.actor,
      s.realmId,
      {
        deadline: Date.now() + 30_000,
      },
    );
    returned = true;
  } catch {
    returned = false;
  }
  expect(suspendedDuringComposition).toBe(true);
  expect(suspensionStatus).toBe(200);
  expect(returned).toBe(false);
  const revoked = await f.call('GET', path, { bearer: f.base.other.bearer });
  expect(revoked.response.status).toBe(401);
  expect(revoked.text).not.toContain(s.head);
});
