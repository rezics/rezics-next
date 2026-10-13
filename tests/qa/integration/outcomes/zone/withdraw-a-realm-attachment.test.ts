import { afterAll, beforeAll, expect, setDefaultTimeout } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { fromPlainText } from '@rezics/document';
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
  return await answer<{
    zone: string;
    revision: string;
    configuration: { defaultRealm?: string; homeDocument?: string };
  }>(editor.main('GET', `/v1/zones/${short(zone)}/configuration?${acting(editor)}`));
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

import withdrawal from '../../../../../scripts/qa/cases/outcomes/zone/withdraw-a-realm-attachment.ts';
const sites = {} as Record<PersonaName, Site>;
beforeAll(async () => {
  sessions = await personaSessions('public');
  const created = await site(sessions.owner);
  await answer(configure(sessions.owner, created.zone, created.zoneRevision, sessions.realm));
  for (const name of ['visitor', 'stranger', 'member', 'owner', 'moderator', 'operator'] as const)
    sites[name] = created;
  // The moderator ends created; the later operator refusal uses the retained fixture attachment.
  sites.operator = { ...created, zone: sessions.zone };
}, 180_000);

type Published = { revision: string; realm: string | null };
async function publishHome(created: Site, editor = sessions.owner) {
  const current = await head(created.zone, editor);
  await answer(
    editor.main('PUT', `/v1/zones/${short(created.zone)}/configuration`, {
      expectedHead: current.revision,
      prepareHomeDocument: true,
      actingSubject: editor.actingSubject,
    }),
  );
  const homeDocument = (await head(created.zone, editor)).configuration.homeDocument;
  expect(homeDocument).toBeString();
  const variantId = `urn:rezics:variant:${randomUUID()}`;
  const draft = await answer<{
    revisionId: string;
    byteDigest: string;
    sourcePosition: { dataEpoch: string };
  }>(
    editor.main('POST', '/v1/content-drafts', {
      profile: 'content-text-v1',
      resourceId: homeDocument,
      variantId,
      expectedHead: null,
      document: fromPlainText('An original attachment fixture home.', 'blocks'),
      language: { kind: 'tag', tag: 'en', originalTag: 'en' },
      direction: 'ltr',
      actingSubject: editor.actingSubject,
    }),
    201,
  );
  await answer(
    editor.main('POST', `/v1/zones/${short(created.zone)}/site-publications`, {
      expectedHead: (await head(created.zone, editor)).revision,
      actingSubject: editor.actingSubject,
      routesRevision: created.navigationRevision,
      navigationRevision: created.navigationRevision,
      pages: [
        {
          page: homeDocument,
          variantId,
          revisionId: draft.revisionId,
          byteDigest: draft.byteDigest,
          contentEpoch: draft.sourcePosition.dataEpoch,
        },
      ],
    }),
    201,
  );
}
async function publicRealm(zone: string) {
  const root = `/v1/zones/${short(zone)}`;
  const route = await answer<Published>(sessions.visitor.main('GET', `${root}/routes?path=%2F`));
  const presentation = await answer<{ realm: string | null }>(
    sessions.visitor.main('GET', `${root}/presentation`),
  );
  return { route: route.realm, presentation: presentation.realm };
}

function withdraw(person: PersonaSession, zone: string, key?: string) {
  return person.main(
    'POST',
    `/v1/zones/${short(zone)}/realm-attachment-withdrawals`,
    {
      realm: sessions.realm,
      actingSubject: person.actingSubject ?? sessions.owner.actingSubject,
    },
    key,
  );
}
async function denied(name: PersonaName, status: number) {
  const target = sites[name],
    current = await head(target.zone);
  await answer(withdraw(sessions[name], target.zone), status);
  await answer(configure(sessions[name], target.zone, current.revision, null), status);
  expect(await head(target.zone)).toEqual(current);
}
outcomeTest(withdrawal, 'visitor', () => denied('visitor', 401));
outcomeTest(withdrawal, 'stranger', () => denied('stranger', 403));
outcomeTest(withdrawal, 'member', () => denied('member', 403));
outcomeTest(withdrawal, 'owner', async () => {
  const zoneOnly = await site(sessions.member);
  const roleId = await role(sessions.member, true);
  try {
    await answer(configure(sessions.member, zoneOnly.zone, zoneOnly.zoneRevision, sessions.realm));
  } finally {
    await role(sessions.member, false, roleId);
  }
  await publishHome(zoneOnly, sessions.member);
  expect(await publicRealm(zoneOnly.zone)).toEqual({
    route: sessions.realm,
    presentation: sessions.realm,
  });
  // Realm stewardship holds no edit authority on this member's Zone.
  await answer(
    configure(
      sessions.owner,
      zoneOnly.zone,
      (await head(zoneOnly.zone, sessions.member)).revision,
      null,
    ),
    403,
  );
  const key = randomUUID();
  const receipt = await answer<{ receipt: string; replayed: boolean }>(
    withdraw(sessions.owner, zoneOnly.zone, key),
  );
  expect(receipt.replayed).toBe(false);
  expect(await answer(withdraw(sessions.owner, zoneOnly.zone, key))).toMatchObject({
    receipt: receipt.receipt,
    replayed: true,
  });
  expect(await publicRealm(zoneOnly.zone)).toEqual({ route: null, presentation: null });
  expect((await head(zoneOnly.zone, sessions.member)).configuration.defaultRealm).toBeUndefined();
  await answer(withdraw(sessions.owner, zoneOnly.zone), 404);
  // Restore an attachment through a temporary Realm mandate, then end it with only Zone authority.
  const restoredRole = await role(sessions.member, true);
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
    await role(sessions.member, false, restoredRole);
  }
  expect(await publicRealm(zoneOnly.zone)).toEqual({
    route: sessions.realm,
    presentation: sessions.realm,
  });
  await answer(withdraw(sessions.member, zoneOnly.zone), 403);
  await answer(
    configure(
      sessions.member,
      zoneOnly.zone,
      (await head(zoneOnly.zone, sessions.member)).revision,
      null,
    ),
  );
  expect(await publicRealm(zoneOnly.zone)).toEqual({ route: null, presentation: null });
  await answer(withdraw(sessions.owner, zoneOnly.zone), 404);
});
outcomeTest(withdrawal, 'moderator', async () => {
  await denied('moderator', 403);
  const target = sites.moderator;
  await publishHome(target);
  const roleId = await role(sessions.moderator, true);
  try {
    await answer(
      configure(sessions.moderator, target.zone, (await head(target.zone)).revision, null),
      403,
    );
    await answer(withdraw(sessions.moderator, target.zone));
    expect(await publicRealm(target.zone)).toEqual({ route: null, presentation: null });
  } finally {
    await role(sessions.moderator, false, roleId);
  }
});
outcomeTest(withdrawal, 'operator', async () => {
  await denied('operator', 403);
  await resourceMandate('realm.attach', `realm:attach:${sessions.realm}`);
  await answer(withdraw(sessions.operator, sites.operator.zone));
});
