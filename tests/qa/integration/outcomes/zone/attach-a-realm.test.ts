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

import attachment from '../../../../../scripts/qa/cases/outcomes/zone/attach-a-realm.ts';
let target: Site;
beforeAll(async () => {
  sessions = await personaSessions('public');
  target = await site(sessions.owner);
}, 180_000);

async function denied(name: PersonaName, status: number) {
  const current = await head(target.zone);
  const refusal = await answer<{ code: string }>(
    configure(sessions[name], target.zone, current.revision, sessions.realm),
    status,
  );
  expect(refusal.code).toBeString();
  expect(await head(target.zone)).toEqual(current);
}
outcomeTest(attachment, 'visitor', () => denied('visitor', 401));
outcomeTest(attachment, 'stranger', () => denied('stranger', 403));
outcomeTest(attachment, 'member', () => denied('member', 403));
outcomeTest(attachment, 'owner', async () => {
  // This member owns a different Space's Zone, but holds no Realm stewardship.
  const zoneOnly = await site(sessions.member);
  const missing = `https://rezics.com/id/${randomUUID()}`;
  const inaccessible = await answer<{ title: string }>(
    configure(sessions.member, zoneOnly.zone, zoneOnly.zoneRevision, sessions.realm),
    400,
  );
  expect(
    await answer(configure(sessions.member, zoneOnly.zone, zoneOnly.zoneRevision, missing), 400),
  ).toEqual(inaccessible);
  expect(inaccessible.title).toBe('default Realm is unavailable');
  await answer(
    configure(sessions.owner, zoneOnly.zone, zoneOnly.zoneRevision, sessions.realm),
    403,
  );
  expect((await head(zoneOnly.zone, sessions.member)).configuration.defaultRealm).toBeUndefined();
  expect(target.space).not.toBe(sessions.space);
  const current = await head(target.zone);
  await answer(configure(sessions.owner, target.zone, current.revision, sessions.realm));
  expect((await head(target.zone)).configuration.defaultRealm).toBe(sessions.realm);
  // The operator variant must request a new attachment, rather than retain this owner's link.
  await answer(configure(sessions.owner, target.zone, (await head(target.zone)).revision, null));
});
outcomeTest(attachment, 'moderator', async () => {
  await denied('moderator', 403);
  const ownZone = await site(sessions.moderator);
  await answer(
    configure(sessions.moderator, ownZone.zone, ownZone.zoneRevision, sessions.realm),
    400,
  );
  const roleId = await role(sessions.moderator, true);
  try {
    await answer(configure(sessions.moderator, ownZone.zone, ownZone.zoneRevision, sessions.realm));
    expect((await head(ownZone.zone, sessions.moderator)).configuration.defaultRealm).toBe(
      sessions.realm,
    );
  } finally {
    await role(sessions.moderator, false, roleId);
  }
});
outcomeTest(attachment, 'operator', async () => {
  await denied('operator', 403);
  await resourceMandate('zone.edit', `zone:edit:${target.zone}`);
  const zoneOnly = await head(target.zone);
  const attempted = await configure(
    sessions.operator,
    target.zone,
    zoneOnly.revision,
    sessions.realm,
  );
  console.info(
    JSON.stringify({
      operatorZoneAuthority: {
        operation: 'attach-realm-without-stewardship',
        status: attempted.status,
        answer: await attempted.clone().json(),
      },
    }),
  );
  expect([400, 403]).toContain(attempted.status);
  const refusal = await answer<{ code: string; title: string }>(
    Promise.resolve(attempted),
    attempted.status,
  );
  if (attempted.status === 400)
    expect(refusal).toMatchObject({
      code: 'invalid_zone_configuration',
      title: 'default Realm is unavailable',
    });
  else expect(refusal.code).toBe('authority_denied');
  expect(await head(target.zone)).toEqual(zoneOnly);
  await resourceMandate('realm.attach', `realm:attach:${sessions.realm}`);
  const current = await head(target.zone);
  await answer(configure(sessions.operator, target.zone, current.revision, sessions.realm));
});
