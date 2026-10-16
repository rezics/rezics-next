import { afterAll, beforeAll, expect, setDefaultTimeout } from 'bun:test';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { fromPlainText } from '@rezics/document';
import { OutcomeRecorder, outcomeTest } from '../../../support/outcome-test.ts';
import {
  personaSessions,
  type PersonaName,
  type PersonaSession,
  type PersonaSessions,
} from '../../../support/personas.ts';

import { discoverActingContexts, discoverAgents, readMainSessionAgent } from '../../../../../apps/web/features/auth/session.ts';
import { readAgentProfile } from '../../../../../apps/web/features/auth/agent-profile.ts';
import { commandLane } from '../../../../../apps/web/features/api/command.ts';
import { browserMainApi } from '../../../../../apps/web/features/api/browser.ts';
import { readRealmHeader, readZoneAttachments, settle } from '../../../../../apps/web/features/manage/read.ts';
import { readManagementAccess } from '../../../../../apps/web/features/manage/settings-api.ts';
import { realmEditSite } from '../../../../../apps/web/features/manage/realm-site.ts';
import { withdrawRealmAttachment } from '../../../../../apps/web/features/manage/zone-attachments-api.ts';
import { readShowcaseEditor } from '../../../../../apps/web/features/zone-editor/edit-site-link.tsx';
import { browserZoneRealmAttachment, commitCommand } from '../../../../../apps/web/features/zone-editor/api.ts';
import { readManagementAddress, suppliedManagementSite, zoneAuthoringFromAddress, zoneLifecycleFromAddress } from '../../../../../apps/web/features/zone-editor/authoring-reads.ts';

setDefaultTimeout(210_000);
const fileWall = setTimeout(() => { throw new Error('Realm attachment withdrawal file exceeded 480 s'); }, 480_000);
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
  clearTimeout(fileWall);
  try { await recording.publish(); } finally { await sessions?.close(); }
});

import withdrawal from '../../../../../scripts/qa/cases/outcomes/zone/withdraw-a-realm-attachment.ts';
const recording = new OutcomeRecorder(withdrawal);
const visits = {} as Record<PersonaName, Site>;
const sites = {} as Record<PersonaName, Site>;
beforeAll(async () => {
  await recording.prepare();
  sessions = await personaSessions('public');
  const created = await site(sessions.owner);
  await answer(configure(sessions.owner, created.zone, created.zoneRevision, sessions.realm));
  for (const name of ['visitor', 'stranger', 'member', 'owner', 'moderator', 'operator'] as const)
    sites[name] = created;
  for (const name of ['stranger', 'owner', 'moderator', 'operator'] as const) visits[name] = created;
  visits.member = await site(sessions.member);
  const delegated = await role(sessions.member, true);
  try { await answer(configure(sessions.member, visits.member.zone, visits.member.zoneRevision, sessions.realm)); }
  finally { await role(sessions.member, false, delegated); }
  // The moderator ends created; the later operator refusal uses the retained fixture attachment.
  sites.operator = { ...created, zone: sessions.zone };
  visits.operator = { ...sites.operator, space: sessions.space };
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
outcomeTest(withdrawal, 'visitor', () => qualify('visitor', () => denied('visitor', 401)), recording);
outcomeTest(withdrawal, 'stranger', () => qualify('stranger', () => denied('stranger', 403)), recording);
outcomeTest(withdrawal, 'member', () => qualify('member', () => denied('member', 403)), recording);
outcomeTest(withdrawal, 'owner', () => qualify('owner', async () => {
  const zoneOnly = await site(sessions.member);
  visits.owner = zoneOnly;
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
}), recording);
outcomeTest(withdrawal, 'moderator', () => qualify('moderator', async () => {
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
}), recording);
outcomeTest(withdrawal, 'operator', () => qualify('operator', async () => {
  await denied('operator', 403);
  const target = sites.operator;
  const navigation = await answer<{ revision: string }>(
    sessions.owner.main('GET', `/v1/zones/${short(target.zone)}?${acting(sessions.owner)}`),
  );
  await publishHome({ ...target, navigationRevision: navigation.revision });
  await resourceMandate('zone.edit', `zone:edit:${target.zone}`);
  const removed = await configure(
    sessions.operator,
    target.zone,
    (await head(target.zone)).revision,
    null,
  );
  console.info(
    JSON.stringify({
      operatorZoneAuthority: {
        operation: 'withdraw-through-zone-mandate',
        status: removed.status,
        answer: await removed.clone().json(),
      },
    }),
  );
  await answer(Promise.resolve(removed));
  expect(await publicRealm(target.zone)).toEqual({ route: null, presentation: null });
  // Realm intervention uses its own attachment and mandate; Zone editing granted no stewardship.
  await answer(
    configure(sessions.owner, target.zone, (await head(target.zone)).revision, sessions.realm),
  );
  await resourceMandate('realm.attach', `realm:attach:${sessions.realm}`);
  await answer(withdraw(sessions.operator, sites.operator.zone));
}), recording);

async function within<T>(milliseconds: number, part: string, run: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([run(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${part} exceeded ${milliseconds} ms`)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}
async function qualify(name: PersonaName, proof: () => Promise<void>) {
  const started = Date.now();
  let proofMs = 0, visitStarted = 0;
  try {
    // The API proof keeps its original 90 s; the production visit owns another 120 s.
    await within(90_000, 'API proof', proof);
    proofMs = Date.now() - started;
    visitStarted = Date.now();
    await within(120_000, 'production visit', () => productionVisit(name));
  } finally {
    console.info(`[persona-timing] ${name} proofMs=${proofMs || Date.now() - started} visitMs=${visitStarted ? Date.now() - visitStarted : 0}`);
  }
}

const labels = new AsyncLocalStorage<string | ((path: string) => string)>();
const named = <T,>(label: string | ((path: string) => string), run: () => Promise<T>) => labels.run(label, run);
function productionTransport(name: PersonaName, anonymous = false) {
  const sample = recording.session(name, anonymous ? sessions.visitor : sessions[name]);
  const fetcher = (async (input, init) => {
    const request = new Request(input, init), url = new URL(request.url);
    const path = url.pathname.replace(/^\/api\/main/, '') + url.search;
    const naming = labels.getStore();
    const label = typeof naming === 'function' ? naming(path) : naming;
    if (!label) throw new Error(`Production request has no label: ${request.method} ${path}`);
    const raw = await request.text();
    return sample(label, request.method, path, raw ? JSON.parse(raw) as unknown : undefined,
      request.headers.get('idempotency-key') ?? undefined,
      { headers: Object.fromEntries([...request.headers].filter(([key]) =>
        !['authorization', 'cookie', 'x-session-key'].includes(key))), settle: false });
  }) as typeof fetch;
  return { fetcher, main: browserMainApi('https://recorded.invalid', { anonymous, fetcher }) };
}

async function productionVisit(name: PersonaName) {
  // Both management routes send the signed-out visitor to sign-in before any Main read.
  if (name === 'visitor') return;
  const { main, fetcher } = productionTransport(name), actor = sessions[name].actingSubject!;
  const realm = short(sessions.realm), target = visits[name];
  // Restore the proof's final detached fixture without adding requests to the visit.
  if (name === 'owner') {
    const delegated = await role(sessions.member, true);
    try { await answer(configure(sessions.member, target.zone, (await head(target.zone, sessions.member)).revision, sessions.realm)); }
    finally { await role(sessions.member, false, delegated); }
  } else if (name === 'moderator' || name === 'operator') {
    await answer(configure(sessions.owner, target.zone, (await head(target.zone)).revision, sessions.realm));
  }
  // readSession's server-only cookie/cache wrapper is unavailable here. Its typed Main
  // client sends these discovery reads together, then reads the selected Agent profile.
  await named('session-language-selection', () => readMainSessionAgent('recorded', '00000000-0000-4000-8000-000000000001', fetcher));
  await named('session-preferences', () => main.v1.me['person-preferences'].get({ query: { actingSubject: actor } }));
  await Promise.all([
    named('session-contexts', () => discoverActingContexts('recorded', fetcher)),
    named('session-agents', () => discoverAgents('recorded', 'en', fetcher)),
    named('session-selection', () => readMainSessionAgent('recorded', '00000000-0000-4000-8000-000000000001', fetcher)),
  ]);
  await named('session-profile', () => readAgentProfile(actor, 'recorded', fetcher));

  async function realmPage(prefix: string) {
    // /manage/r/[realm]/zones: layout and body render together; tabs read after hydration.
    const [, , inventory] = await Promise.all([
      named(`${prefix}-header`, () => readRealmHeader(main, realm, 'en', actor)),
      realmEditSite({
        zone: () => named(`${prefix}-zone`, () => settle(() => main.v1.realms({ realm }).zone.get({ query: { actingSubject: actor } }))),
        editor: async zoneId => (await named(`${prefix}-editor`, () => readShowcaseEditor(main, zoneId, actor))).loaded,
      }),
      named(`${prefix}-attachments`, () => readZoneAttachments(main, realm, actor)),
    ]);
    await named(`${prefix}-access`, () => readManagementAccess(main, realm, actor));
    if (!inventory.ok || !inventory.data.items.some(item => item.zone === target.zone)) return;
    const input = { zone: target.zone, realm: sessions.realm, actingSubject: actor, key: randomUUID() };
    let result = await named(`${prefix}-withdraw`, () => withdrawRealmAttachment(main, input));
    if (!result.ok && result.failure === 'unavailable')
      result = await named(`${prefix}-withdraw-retry`, () => withdrawRealmAttachment(main, input));
    if (!result.ok && ['denied', 'missing', 'sign-in'].includes(result.failure))
      await named(`${prefix}-refused-attachments`, () => readZoneAttachments(main, realm, actor));
    // On success production removes the row locally; it sends no follow-up read.
  }
  await realmPage('realm');
  if (name === 'moderator') {
    const roleId = await role(sessions.moderator, true);
    try { await realmPage('delegated-realm'); }
    finally { await role(sessions.moderator, false, roleId); }
  }

  // /manage/z/[space]/realm shares address admission and authoring between its
  // layout and body. Give each concurrent branch its own fixed request names.
  const space = short(target.space);
  const address = await named(path => path.includes('/addresses/resolve') ? 'zone-address' : 'zone-configuration',
    () => readManagementAddress(main, space, 'en', actor, suppliedManagementSite(main, actor)));
  const authoringRead = named(path => path.includes('/showcase-editor') ? 'zone-editor' : 'zone-navigation',
      () => zoneAuthoringFromAddress(main, space, actor, address));
  await Promise.all([
    named('zone-lifecycle-configuration', () => zoneLifecycleFromAddress(main, space, actor, address)),
    (async () => {
      const authoring = await authoringRead;
      if (authoring.kind !== 'ready') return;
      const zoneId = authoring.model.zoneId;
      const configuration = await named('attachment-configuration', () => settle(
        () => main.v1.zones({ id: zoneId }).configuration.get({ query: { actingSubject: actor } }), { management: true }));
      if (!configuration.ok) return;
      const attached = configuration.data.configuration.defaultRealm;
      if (typeof attached !== 'string') return;
      const { main: anonymous } = productionTransport(name, true);
      await named('attachment-name', () => settle(() => anonymous.v1.realms({ realm: short(attached) }).get({ query: {} })));
      const client = browserZoneRealmAttachment(main);
      const body = { expectedHead: configuration.data.revision, actingSubject: actor, defaultRealm: null };
      // The Remove action retains this revision and retry key through commitCommand.
      const lane = commandLane<typeof body, Awaited<ReturnType<typeof client.saveConfiguration>>>({ ok: false, failure: 'unavailable' });
      await lane.submit(body, (captured, round) => named('attachment-remove', () => commitCommand(round,
        key => client.saveConfiguration(zoneId, captured, key))));
    })(),
  ]);
}
