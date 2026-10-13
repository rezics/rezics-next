import { afterAll, beforeAll, expect, setDefaultTimeout } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { outcomeTest } from '../../../support/outcome-test.ts';
import {
  personaSessions,
  type PersonaName,
  type PersonaSession,
  type PersonaSessions,
} from '../../../support/personas.ts';

setDefaultTimeout(90_000);
let sessions: PersonaSessions;
const short = (id: string) => id.slice(-36);
const acting = (person: PersonaSession) =>
  new URLSearchParams({ actingSubject: person.actingSubject! });
async function answer<T>(request: Promise<Response>, status = 200): Promise<T> {
  const response = await request;
  const raw = await response.text();
  expect(response.status, `${response.status}: ${raw}`).toBe(status);
  return JSON.parse(raw) as T;
}
type Site = { zone: string; space: string; zoneRevision: string; navigationRevision: string };
async function site(person: PersonaSession): Promise<Site> {
  return answer(
    person.main('POST', '/v1/spaces', {
      profile: 'space-zone-v1',
      name: 'Attachment authority fixture',
      language: 'en',
      capabilities: ['zone'],
      visibility: 'public',
      listing: 'listed',
      actingSubject: person.actingSubject,
    }),
    201,
  );
}
async function head(zone: string, editor = sessions.owner) {
  return await answer<{ zone: string; revision: string; configuration: { defaultRealm?: string } }>(
    editor.main('GET', `/v1/zones/${short(zone)}/configuration?${acting(editor)}`),
  );
}
function configure(
  person: PersonaSession,
  zone: string,
  expectedHead: string,
  defaultRealm: string | null,
) {
  return person.main('PUT', `/v1/zones/${short(zone)}/configuration`, {
    actingSubject: person.actingSubject ?? sessions.owner.actingSubject,
    expectedHead,
    defaultRealm,
  });
}
async function role(person: PersonaSession, assigned: boolean, roleId = randomUUID()) {
  const owner = sessions.owner,
    root = `/v1/realms/${short(sessions.realm)}`;
  for (const change of [
    ...(assigned
      ? [
          {
            kind: 'role',
            roleId,
            name: `Delegated Realm steward ${roleId}`,
            permissions: ['realm.settings.manage'],
          },
        ]
      : []),
    {
      kind: 'assignment',
      roleId,
      member: person.actingSubject,
      assigned,
      validUntil: new Date(Date.now() + 3_600_000).toISOString(),
    },
  ]) {
    const current = await answer<{ generation: string }>(
      owner.main('GET', `${root}/roles?${acting(owner)}`),
    );
    const command = {
      actingSubject: owner.actingSubject,
      expectedGeneration: current.generation,
      reason: 'Exercise independently delegated Realm stewardship',
      change,
    };
    const impact = await answer<{ digest: string }>(
      owner.main('POST', `${root}/role-impact`, command),
    );
    await answer(
      owner.main('POST', `${root}/role-changes`, { ...command, impactDigest: impact.digest }),
      201,
    );
  }
  return roleId;
}
async function resourceMandate(action: string, scopeId: string) {
  const operator = sessions.operator;
  const page = await answer<{
    authorityEpoch: string;
    items: { recipient: { principalId?: string } }[];
  }>(
    operator.main(
      'GET',
      `/v1/access/grants?${new URLSearchParams({
        issuerSubject: operator.actingSubject!,
        profile: 'platform-grants-v1',
      })}`,
    ),
  );
  const principalId = page.items.find((item) => item.recipient.principalId)?.recipient.principalId;
  expect(principalId).toBeDefined();
  // A platform title cannot manufacture a subject or resource assignment ceiling.
  const response = await operator.main('POST', '/v1/access/grant-changes', {
    profile: 'platform-grant-change-v1',
    issuerSubject: operator.actingSubject,
    expectedAuthorityEpoch: page.authorityEpoch,
    grantId: randomUUID(),
    action: 'create',
    permission: `platform:resource:${action}`,
    scopeId,
    recipient: { principalId },
    validUntil: new Date(Date.now() + 1_800_000).toISOString(),
  });
  if (response.status === 403) {
    const refusal = await answer<{ code: string; title: string }>(Promise.resolve(response), 403);
    expect(refusal).toMatchObject({
      code: 'grant_denied',
      title: 'Resource assignment ceiling is missing or shorter',
    });
    console.info(
      JSON.stringify({
        pendingResourceMandate: {
          method: 'POST',
          path: '/v1/access/grant-changes',
          permission: `platform:resource:${action}`,
          scopeId,
          status: response.status,
          answer: refusal,
        },
      }),
    );
    throw new Error(
      'Exact resource intervention cannot be arranged through the public API without a resource assignment ceiling',
    );
  }
  return answer(Promise.resolve(response));
}
afterAll(async () => {
  await sessions?.close();
});

import inventory from '../../../../../scripts/qa/cases/outcomes/zone/list-attached-zones.ts';
type Page = {
  items: { zone: string; withdraw: { method: string; path: string } }[];
  nextCursor: string | null;
  complete: boolean;
  cost: { graphReads: number; sqlReads: number };
};
const zones: string[] = [];
let small: PersonaSessions;
let zoneOnly: Site;
beforeAll(async () => {
  sessions = await personaSessions('public');
  small = await personaSessions('public');
  zones.push(sessions.zone);
  zoneOnly = await site(sessions.member);
  // Creation consumes three Spaces per Account principal. Independent owners
  // build the inventory; temporary stewardship is issued and revoked over HTTP.
  const primary = [
    { person: sessions.owner, count: 1 },
    { person: sessions.member, count: 2 },
    { person: sessions.moderator, count: 3 },
  ];
  const contributors = [...primary];
  for (const fixture of [
    small,
    await personaSessions('public'),
    await personaSessions('public'),
    await personaSessions('public'),
  ]) {
    for (const person of [fixture.owner, fixture.member, fixture.moderator, fixture.stranger]) {
      const root = `/v1/realms/${short(sessions.realm)}`;
      const policy = await answer<{
        membershipGeneration: string;
        policyRevision: string;
        termsRevision: string;
      }>(person.main('GET', `${root}/joining?${acting(person)}`));
      await answer(
        person.main('POST', `${root}/join`, {
          actingSubject: person.actingSubject,
          expectedMembershipGeneration: policy.membershipGeneration,
          expectedPolicyRevision: policy.policyRevision,
          termsRevision: policy.termsRevision,
          listed: false,
        }),
      );
      contributors.push({ person, count: person === fixture.owner ? 1 : 3 });
    }
    if (fixture !== small) {
      const roleId = await role(fixture.owner, true);
      try {
        await answer(
          configure(
            fixture.owner,
            fixture.zone,
            (await head(fixture.zone, fixture.owner)).revision,
            sessions.realm,
          ),
        );
        zones.push(fixture.zone);
      } finally {
        await role(fixture.owner, false, roleId);
      }
    }
  }
  for (const { person, count } of contributors) {
    const roleId = person === sessions.owner ? null : await role(person, true);
    try {
      for (let index = 0; index < count; index++) {
        const created = await site(person);
        await answer(configure(person, created.zone, created.zoneRevision, sessions.realm));
        zones.push(created.zone);
      }
    } finally {
      if (roleId) await role(person, false, roleId);
    }
  }
  expect(zones).toHaveLength(50);
}, 480_000);
function list(person: PersonaSession, realm: string, limit: number, cursor?: string) {
  const query = new URLSearchParams({
    limit: String(limit),
    ...(person.actingSubject ? { actingSubject: person.actingSubject } : {}),
    ...(cursor ? { cursor } : {}),
  });
  return person.main('GET', `/v1/realms/${short(realm)}/zone-attachments?${query}`);
}
async function concealed(name: PersonaName) {
  const person = sessions[name],
    missing = `https://rezics.com/id/${randomUUID()}`;
  // The one-item fixture has its own owner: these sessions hold no stewardship in either Realm.
  const unavailable = await answer<{ code: string }>(list(person, missing, 1), 404);
  expect(unavailable.code).toBe('realm_unavailable');
  for (const realm of [small.realm, sessions.realm]) {
    for (const limit of [1, 50])
      expect(await answer(list(person, realm, limit), 404)).toEqual(unavailable);
  }
}
async function traverse(person: PersonaSession, limit: number) {
  const seen: string[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  let page: Page;
  do {
    page = await answer<Page>(list(person, sessions.realm, limit, cursor));
    expect(page.items.length).toBeLessThanOrEqual(limit);
    expect(page.complete).toBe(page.nextCursor === null);
    for (const item of page.items) {
      expect(item.withdraw).toEqual({
        method: 'POST',
        path: `/v1/zones/${short(item.zone)}/realm-attachment-withdrawals`,
      });
      seen.push(item.zone);
    }
    if (page.nextCursor) {
      expect(cursors.has(page.nextCursor)).toBe(false);
      cursors.add(page.nextCursor);
    }
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  expect(seen).toEqual([...zones].sort());
  expect(new Set(seen).size).toBe(zones.length);
}
async function traverseBeyondMaximumPage(person: PersonaSession) {
  const roleId = await role(sessions.member, true);
  try {
    await answer(
      configure(
        sessions.member,
        zoneOnly.zone,
        (await head(zoneOnly.zone, sessions.member)).revision,
        sessions.realm,
      ),
    );
  } finally {
    await role(sessions.member, false, roleId);
  }
  zones.push(zoneOnly.zone);
  try {
    const first = await answer<Page>(list(person, sessions.realm, 50));
    expect(first.items).toHaveLength(50);
    expect(first.complete).toBe(false);
    expect(first.nextCursor).not.toBeNull();
    await traverse(person, 50);
  } finally {
    await answer(
      sessions.owner.main(
        'POST',
        `/v1/zones/${short(zoneOnly.zone)}/realm-attachment-withdrawals`,
        {
          realm: sessions.realm,
          actingSubject: sessions.owner.actingSubject,
        },
      ),
    );
    zones.splice(zones.indexOf(zoneOnly.zone), 1);
  }
}
outcomeTest(inventory, 'visitor', () => concealed('visitor'));
outcomeTest(inventory, 'stranger', () => concealed('stranger'));
outcomeTest(inventory, 'member', async () => {
  expect((await head(zoneOnly.zone, sessions.member)).zone).toBe(zoneOnly.zone);
  await concealed('member');
});
outcomeTest(inventory, 'owner', async () => {
  const one = await answer<Page>(list(small.owner, small.realm, 50));
  const fifty = await answer<Page>(list(sessions.owner, sessions.realm, 50));
  expect(one.items).toHaveLength(1);
  expect(fifty.items).toHaveLength(50);
  // Public cost fields are declarations, not measurements of database queries or latency.
  expect(fifty.cost.graphReads).toBe(one.cost.graphReads);
  expect(fifty.cost.sqlReads).toBe(one.cost.sqlReads);
  await traverse(sessions.owner, 1);
  await traverse(sessions.owner, 24);
  await traverse(sessions.owner, 50);
  await traverseBeyondMaximumPage(sessions.owner);
});
outcomeTest(inventory, 'moderator', async () => {
  await concealed('moderator');
  const roleId = await role(sessions.moderator, true);
  let cursor: string | null = null;
  try {
    await traverse(sessions.moderator, 24);
    await traverseBeyondMaximumPage(sessions.moderator);
    cursor = (await answer<Page>(list(sessions.moderator, sessions.realm, 1))).nextCursor;
    expect(cursor).not.toBeNull();
  } finally {
    await role(sessions.moderator, false, roleId);
  }
  await answer(list(sessions.moderator, sessions.realm, 1, cursor!), 404);
});
outcomeTest(inventory, 'operator', async () => {
  await concealed('operator');
  await resourceMandate('realm.attach', `realm:attach:${sessions.realm}`);
  await traverse(sessions.operator, 24);
});
