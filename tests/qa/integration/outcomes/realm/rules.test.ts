import { afterAll, beforeAll, expect, setDefaultTimeout } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mainApiWithToken } from '../../../../../apps/web/features/api/main.ts';
import rules from '../../../../../scripts/qa/cases/outcomes/realm/rules.ts';
import { OutcomeRecorder, outcomeTest } from '../../../support/outcome-test.ts';
import { recordFrameReads } from '../../../support/frame-reads.ts';
import {
  personaSessions,
  type PersonaName,
  type PersonaSession,
  type PersonaSessions,
} from '../../../support/personas.ts';

setDefaultTimeout(90_000);
let publicRealm: PersonaSessions, privateRealm: PersonaSessions;
let emptyRealm: PersonaSessions;
const recording = new OutcomeRecorder(rules);
const rootOf = (fixture: PersonaSessions) => `/v1/realms/${fixture.realm.slice(-36)}`;
const acting = (person: PersonaSession) =>
  `actingSubject=${encodeURIComponent(person.actingSubject ?? publicRealm.owner.actingSubject!)}`;
const originalRules = [
  {
    id: 'read-with-care',
    title: { original: 'en', labels: { en: 'Read with care', 'zh-Hans': '认真阅读' } },
    body: {
      original: 'en',
      labels: {
        en: 'Read the story before discussing its characters.',
        'zh-Hans': '讨论角色之前，请先阅读故事。',
      },
    },
    governanceRule: null,
  },
];
type Settings = {
  visibility: string;
  reviewRequired: boolean;
  reviewMode: string;
  whoMaySubmit: string;
  selfJoin: boolean;
  rules: typeof originalRules;
};
type Basis = {
  generation: string;
  settings: Settings;
  ruleBasis: { revision: string | null; digest: string | null };
};
async function answer<T>(request: Promise<Response>, status = 200): Promise<T> {
  const response = await request,
    raw = await response.text();
  expect(response.status, `${response.status}: ${raw}`).toBe(status);
  return JSON.parse(raw) as T;
}
async function basis(fixture = publicRealm, person = fixture.owner) {
  return answer<Basis>(person.main('GET', `${rootOf(fixture)}/settings?${acting(person)}`));
}
function command(current: Basis, person: PersonaSession, settings = current.settings) {
  return {
    actingSubject: person.actingSubject ?? publicRealm.owner.actingSubject,
    expectedGeneration: current.generation,
    expectedRulesRevision: current.ruleBasis.revision,
    reason: 'Publish the original fixture community rules',
    settings,
  };
}
async function candidate(person: PersonaSession) {
  const work = await answer<{ work: string; mainVersion: string }>(
    person.main('POST', '/v1/works', {
      profile: 'metadata-only-v1',
      title: `Original seed story ${randomUUID().slice(0, 8)}`,
      language: 'en',
      semanticTypes: ['https://schema.org/Book'],
      authoring: 'own-work',
      actingSubject: person.actingSubject,
    }),
    201,
  );
  const draft = await answer<{ contribution: string; draftRevision: string }>(
    person.main('POST', '/v1/contributions', {
      profile: 'text-contribution-v1',
      work: work.work,
      language: 'en',
      body: 'A reader planted a seed, returned in spring, and found a small tree.',
      actingSubject: person.actingSubject,
    }),
    201,
  );
  const published = await answer<{ publicationDecision: string }>(
    person.main('POST', '/v1/contribution-publications', {
      profile: 'text-publication-v1',
      contribution: draft.contribution,
      expectedDraftHead: draft.draftRevision,
      expectedPublicationHead: null,
      rightsBasis: 'original-contribution',
      disclosure: 'public',
      actingSubject: person.actingSubject,
    }),
    201,
  );
  return {
    actingSubject: person.actingSubject,
    kind: 'contribution',
    work: work.work,
    mainVersion: work.mainVersion,
    contribution: draft.contribution,
    publicationDecision: published.publicationDecision,
    selectedDraft: draft.draftRevision,
    correctionOf: null,
  };
}
beforeAll(async () => {
  publicRealm = await personaSessions('public');
  privateRealm = await personaSessions('private');
  emptyRealm = await personaSessions('public');
  await recording.prepare();
  for (const fixture of [publicRealm, privateRealm]) {
    const current = await basis(fixture);
    await answer(
      fixture.owner.main(
        'PUT',
        `${rootOf(fixture)}/settings`,
        command(current, fixture.owner, {
          ...current.settings,
          reviewRequired: true,
          reviewMode: 'mandatory',
          rules: originalRules,
        }),
      ),
      201,
    );
  }
  const path = `/v1/spaces/${privateRealm.space.slice(-36)}/settings`;
  const current = await answer<{ generation: string }>(
    privateRealm.owner.main('GET', `${path}?${acting(privateRealm.owner)}`),
  );
  await answer(
    privateRealm.owner.main('PUT', path, {
      actingSubject: privateRealm.owner.actingSubject,
      expectedGeneration: current.generation,
      reason: 'Publish only a bounded request landing',
      settings: {
        visibility: 'private',
        listing: 'listed',
        history: 'from-admission',
        admission: 'request',
      },
    }),
    201,
  );
}, 180_000);
afterAll(async () => {
  try { await recording.publish(); }
  finally { await publicRealm?.close(); }
});

async function pageReads(name: PersonaName, fixture: PersonaSessions, prefix: string) {
  const person = fixture[name];
  const personal = recording.session(name, person);
  const anonymous = recording.session(name, fixture.visitor);
  const discard = async (pending: Promise<Response>) => { await (await pending).body?.cancel(); };
  const clientRead = async (label: string, session: PersonaSession,
    build: (client: ReturnType<typeof mainApiWithToken>) => PromiseLike<unknown>): Promise<Response> => {
    let response: Response | undefined;
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const answer = await recording.session(name, session)(`${prefix}-${label}`,
        init?.method ?? 'GET', url.pathname + url.search);
      response = answer.clone();
      return answer;
    }) as typeof fetch;
    await build(mainApiWithToken(undefined, { fetcher }));
    if (!response) throw new Error(`Page read ${label} sent no request`);
    return response;
  };
  // Prefix each visit's frame labels; its requests and identities stay with the shared helper.
  const frameRecording = new Proxy(recording, {
    get(target, property, receiver) {
      if (property !== 'session') return Reflect.get(target, property, receiver);
      return (...args: Parameters<OutcomeRecorder['session']>) => {
        const sample = target.session(...args);
        return (label: string, ...request: Parameters<PersonaSession['main']>) =>
          sample(`${prefix}-${label}`, ...request);
      };
    },
  });
  const frame = recordFrameReads(frameRecording, name, person, fixture.visitor, fixture.realm,
    fixture.zone, 'space', fixture.realm.slice(-36), 'rules');
  const identity = person.actingSubject ? Promise.all([
    ['agent-choices', '/v1/me/agents?languages=en'],
    ['acting-contexts', '/v1/me/acting-contexts?task=work.create'],
    ['acting-agent-profile', `/v1/agents/${person.actingSubject.slice(-36)}?${acting(person)}`],
  ].map(([label, path]) => discard(personal(`${prefix}-${label}`, 'GET', path!)))) : Promise.resolve();
  const rulesPage = async () => {
    if (fixture.visibility === 'private') {
      await discard((person.actingSubject ? personal : anonymous)(`${prefix}-rules-header`, 'GET',
        `${rootOf(fixture)}${person.actingSubject ? `?${acting(person)}` : ''}`));
      if (!['member', 'owner', 'moderator'].includes(name))
        await discard(anonymous(`${prefix}-join-page`, 'GET', `${rootOf(fixture)}/join-page`));
    }
    if (fixture.visibility === 'private' && !['member', 'owner', 'moderator'].includes(name)) return;
    const attached = await clientRead('rules-site-link', person, client =>
      client.v1.realms({ realm: fixture.realm.slice(-36) }).zone.get({
        query: { actingSubject: person.actingSubject ?? undefined },
      }));
    if (attached.ok) {
      const data = await attached.json() as { zone: string };
      await discard(clientRead('rules-site-address', person, client =>
        client.v1.zones({ id: data.zone.slice(-36) }).presentation.get({
          query: { actingSubject: person.actingSubject ?? undefined },
        })));
    } else await attached.body?.cancel();
  };
  const managementFrame = async () => {
    const header = discard(clientRead('management-header', person, client =>
      client.v1.realms({ realm: fixture.realm.slice(-36) }).get({ query: {
        language: 'en', actingSubject: person.actingSubject ?? undefined,
      } })));
    if (!person.actingSubject) { await header; return; }
    const zone = await clientRead('management-zone', person, client =>
      client.v1.realms({ realm: fixture.realm.slice(-36) }).zone.get({ query: { actingSubject: person.actingSubject! } }));
    if (zone.ok) {
      const data = await zone.json() as { zone: string };
      await discard(personal(`${prefix}-management-editor`, 'GET',
        `/v1/zones/${data.zone.slice(-36)}/showcase-editor?${acting(person)}`));
    } else await zone.body?.cancel();
    await header;
  };
  const managementAccess = async () => {
    if (!person.actingSubject) return;
    const access = await personal(`${prefix}-management-space-direct`, 'GET',
      `/v1/spaces/${fixture.realm.slice(-36)}/settings?${acting(person)}`);
    let settingsAllowed = access.ok;
    const fallback = [403, 404].includes(access.status);
    await access.body?.cancel();
    if (fallback) {
      const header = await personal(`${prefix}-management-access-header`, 'GET', `${rootOf(fixture)}?${acting(person)}`);
      if (header.ok) {
        const data = await header.json() as { space: string };
        const settings = await personal(`${prefix}-management-space-settings`, 'GET',
          `/v1/spaces/${data.space.slice(-36)}/settings?${acting(person)}`);
        settingsAllowed = settings.ok;
        await settings.body?.cancel();
      } else await header.body?.cancel();
    }
    if (settingsAllowed)
      await discard(personal(`${prefix}-management-rule-settings`, 'GET', `${rootOf(fixture)}/settings?${acting(person)}`));
  };
  await Promise.all([frame, identity, rulesPage(), managementFrame(), managementAccess()]);
}

async function readRules(name: PersonaName) {
  await Promise.all([
    pageReads(name, publicRealm, 'public-page'),
    pageReads(name, privateRealm, 'private-page'),
  ]);
  for (const fixture of [publicRealm, privateRealm]) {
    const person = fixture[name],
      allowed = fixture === publicRealm || ['member', 'owner', 'moderator'].includes(name);
    const sample = recording.session(name, person);
    const path = `${rootOf(fixture)}?language=zh-CN${name === 'visitor' ? '' : `&${acting(person)}`}`;
    const response = await answer(sample(`${fixture === publicRealm ? 'public' : 'private'}-rules-zh`, 'GET', path), allowed ? 200 : 404);
    if (allowed)
      expect(response).toMatchObject({
        id: fixture.realm,
        rules: [
          {
            id: 'read-with-care',
            title: { value: '认真阅读', language: 'zh-Hans' },
            body: { value: '讨论角色之前，请先阅读故事。', language: 'zh-Hans' },
          },
        ],
      });
    else expect(JSON.stringify(response)).not.toContain(fixture.realm);
  }
  for (const language of ['en', 'fr']) {
    expect(
      await answer(
        recording.session(name, publicRealm[name])(
          `public-rules-${language}`, 'GET',
          `${rootOf(publicRealm)}?language=${language}${name === 'visitor' ? '' : `&${acting(publicRealm[name])}`}`,
        ),
      ),
    ).toMatchObject({ rules: [{ title: { value: 'Read with care', language: 'en' } }] });
  }
  const joined = ['member', 'owner', 'moderator'].includes(name);
  // Joined readers use the full member route; the separate landing is for outsiders.
  const landing = await answer(
    recording.session(name, privateRealm[name])(
      'private-request-landing', 'GET',
      `${rootOf(privateRealm)}/join-page?language=zh-CN${name === 'visitor' ? '' : `&${acting(privateRealm[name])}`}`,
    ),
    joined ? 404 : 200,
  );
  if (!joined) {
    expect(landing).toMatchObject({
      profile: 'realm-join-page-v1',
      rules: [{ title: { value: '认真阅读' }, body: { value: '讨论角色之前，请先阅读故事。' } }],
    });
    expect(landing).not.toHaveProperty('ruleBasis');
    expect(landing).not.toHaveProperty('generation');
  }
}
async function cannotManage(name: Exclude<PersonaName, 'owner'>) {
  const person = publicRealm[name],
    status = name === 'visitor' ? 401 : 403;
  await answer(recording.session(name, person)('rule-settings-denied', 'GET', `${rootOf(publicRealm)}/settings?${acting(person)}`), status);
  await answer(
    person.main('PUT', `${rootOf(publicRealm)}/settings`, command(await basis(), person)),
    status,
  );
}
outcomeTest(rules, 'visitor', async () => {
  await readRules('visitor');
  await cannotManage('visitor');
}, recording);
async function participate(name: 'stranger' | 'member' | 'moderator' | 'operator') {
  await readRules(name);
  await cannotManage(name);
  const person = publicRealm[name],
    input = await candidate(person);
  const allowed = ['member', 'moderator'].includes(name);
  const response = await answer(
    recording.session(name, person)('submission-after-reading-rules', 'POST', `${rootOf(publicRealm)}/submissions`, input),
    allowed ? 201 : 403,
  );
  if (allowed)
    expect(response).toMatchObject({
      submission: { state: 'pending', submittingAgent: person.actingSubject, work: input.work },
    });
}
outcomeTest(rules, 'stranger', () => participate('stranger'), recording);
outcomeTest(rules, 'member', () => participate('member'), recording);

outcomeTest(rules, 'owner', async () => {
  await readRules('owner');
  await pageReads('owner', emptyRealm, 'empty-page');
  const owner = publicRealm.owner,
    path = `${rootOf(publicRealm)}/settings`,
    roleId = randomUUID(),
    moderator = publicRealm.moderator;
  const sample = recording.session('owner', owner);
  for (const [label, path] of [
    ['session-agent', '/v1/me/session-agent'],
    ['agent-choices', '/v1/me/agents?languages=en'],
    ['acting-contexts', '/v1/me/acting-contexts?task=work.create'],
    ['acting-agent-profile', `/v1/agents/${owner.actingSubject!.slice(-36)}?${acting(owner)}`],
  ] as const) await (await sample(label, 'GET', path)).body?.cancel();
  await answer(sample('rule-settings', 'GET', `${path}?${acting(owner)}`));
  await answer(sample('space-settings', 'GET', `/v1/spaces/${publicRealm.space.slice(-36)}/settings?${acting(owner)}`));
  await (await sample('legacy-space-settings-denied', 'GET', `/v1/spaces/${publicRealm.realm.slice(-36)}/settings?${acting(owner)}`)).body?.cancel();
  await answer(sample('reading-preferences', 'GET', `/v1/me/person-preferences?${acting(owner)}`));
  await answer(recording.session('owner', publicRealm.visitor)('realm-address', 'GET', `/v1/addresses/resolve?scope=space&key=${publicRealm.realm.slice(-36)}`));
  await answer(sample('joining-policy', 'GET', `${rootOf(publicRealm)}/joining?${acting(owner)}`));
  await answer(sample('realm-follow', 'GET', `/v1/follows/${publicRealm.realm.slice(-36)}?kind=realm&${acting(owner)}`));
  await answer(sample('appeal-access', 'GET', '/v1/me/platform-access'));
  await answer(sample('own-ban-absent', 'GET', `${rootOf(publicRealm)}/member-ban?${acting(owner)}`), 404);
  // The frame can render without a site link; retain the API's refusal too.
  await (await sample('management-site', 'GET', `${rootOf(publicRealm)}/zone?${acting(owner)}`)).body?.cancel();
  await (await sample('site-editor-access', 'GET', `/v1/zones/${publicRealm.zone.slice(-36)}/showcase-editor?${acting(owner)}`)).body?.cancel();
  const emptySample = recording.session('owner', emptyRealm.owner);
  await answer(emptySample('rules-empty', 'GET', `${rootOf(emptyRealm)}?${acting(emptyRealm.owner)}`));
  await answer(emptySample('rule-settings-empty', 'GET', `${rootOf(emptyRealm)}/settings?${acting(emptyRealm.owner)}`));
  async function role(change: object) {
    const roles = await answer<{ generation: string }>(
      owner.main('GET', `${rootOf(publicRealm)}/roles?${acting(owner)}`),
    );
    const intent = {
      actingSubject: owner.actingSubject,
      expectedGeneration: roles.generation,
      reason: 'Delegate each settings and publishing capability explicitly',
      change,
    };
    const impact = await answer<{ digest: string }>(
      owner.main('POST', `${rootOf(publicRealm)}/role-impact`, intent),
    );
    await answer(
      owner.main('POST', `${rootOf(publicRealm)}/role-changes`, {
        ...intent,
        impactDigest: impact.digest,
      }),
      201,
    );
  }
  try {
    const current = await basis(),
      key = randomUUID();
    const input = command(current, owner, {
      ...current.settings,
      rules: [
        {
          ...originalRules[0]!,
          body: {
            original: 'en',
            labels: { en: 'Discuss the story with care.', 'zh-Hans': '认真讨论故事。' },
          },
        },
      ],
    });
    const receipt = await answer<Basis & { receiptId: string }>(
      sample('rules-published', 'PUT', path, input, key),
      201,
    );
    expect(receipt.settings).toEqual(input.settings);
    expect(receipt.ruleBasis.revision).not.toBe(current.ruleBasis.revision);
    expect(receipt.ruleBasis.digest).not.toBe(current.ruleBasis.digest);
    expect(await answer(owner.main('PUT', path, input, key))).toMatchObject({
      receiptId: receipt.receiptId,
      replayed: true,
    });
    await answer(
      sample('rule-intent-conflict', 'PUT', path, { ...input, reason: 'Different publishing intent' }, key),
      409,
    );
    await answer(owner.main('PUT', path, input), 409);
    const fresh = await basis();
    await answer(
      owner.main('PUT', path, {
        ...command(fresh, owner),
        expectedRulesRevision: current.ruleBasis.revision,
      }),
      409,
    );
    expect((await basis()).ruleBasis).toEqual(fresh.ruleBasis);
    expect(
      await answer(publicRealm.visitor.main('GET', `${rootOf(publicRealm)}?language=zh-CN`)),
    ).toMatchObject({ rules: [{ body: { value: '认真讨论故事。' } }] });
    const raceInput = command(await basis(), owner);
    const replies = await Promise.all([
      owner.main('PUT', path, raceInput),
      owner.main('PUT', path, raceInput),
    ]);
    expect(replies.map((reply) => reply.status).sort()).toEqual([201, 409]);

    await role({
      kind: 'role',
      roleId,
      name: 'Settings delegate',
      permissions: ['realm.settings.manage'],
    });
    await role({
      kind: 'assignment',
      roleId,
      member: moderator.actingSubject,
      assigned: true,
      validUntil: new Date(Date.now() + 3_600_000).toISOString(),
    });
    await basis(publicRealm, moderator);
    await answer(moderator.main('PUT', path, command(await basis(), moderator)), 403);
    await role({
      kind: 'role',
      roleId,
      name: 'Rule publisher',
      permissions: ['governance.rule.publish'],
    });
    await answer(moderator.main('GET', `${path}?${acting(moderator)}`), 403);
    await answer(moderator.main('PUT', path, command(await basis(), moderator)), 403);
    await role({
      kind: 'role',
      roleId,
      name: 'Settings and rule publisher',
      permissions: ['realm.settings.manage', 'governance.rule.publish'],
    });
    await answer(
      moderator.main('PUT', path, command(await basis(publicRealm, moderator), moderator)),
      201,
    );
    await role({
      kind: 'assignment',
      roleId,
      member: moderator.actingSubject,
      assigned: false,
      validUntil: new Date(Date.now() + 3_600_000).toISOString(),
    });
    await answer(moderator.main('GET', `${path}?${acting(moderator)}`), 403);
    const closed = await basis();
    await answer(
      owner.main(
        'PUT',
        path,
        command(closed, owner, { ...closed.settings, whoMaySubmit: 'closed' }),
      ),
      201,
    );
    await answer(
      publicRealm.member.main(
        'POST',
        `${rootOf(publicRealm)}/submissions`,
        await candidate(publicRealm.member),
      ),
      403,
    );
    const restore = await basis();
    await answer(
      owner.main(
        'PUT',
        path,
        command(restore, owner, {
          ...restore.settings,
          whoMaySubmit: 'members',
          rules: originalRules,
        }),
      ),
      201,
    );
  } finally {
    // A failing publisher proof must not change later personas' rule or policy basis.
    const roles = await answer<{ roles: { id: string; holders: { member: string }[] | null }[] }>(
      owner.main('GET', `${rootOf(publicRealm)}/roles?${acting(owner)}`),
    );
    if (
      roles.roles
        .find((entry) => entry.id === roleId)
        ?.holders?.some((holder) => holder.member === moderator.actingSubject)
    ) {
      await role({
        kind: 'assignment',
        roleId,
        member: moderator.actingSubject,
        assigned: false,
        validUntil: new Date(Date.now() + 3_600_000).toISOString(),
      });
    }
    const restore = await basis();
    await answer(
      publicRealm.owner.main(
        'PUT',
        `${rootOf(publicRealm)}/settings`,
        command(restore, publicRealm.owner, {
          ...restore.settings,
          whoMaySubmit: 'members',
          rules: originalRules,
        }),
      ),
      201,
    );
  }
}, recording);
outcomeTest(rules, 'moderator', async () => {
  await participate('moderator');
  await answer(
    publicRealm.moderator.main(
      'GET',
      `${rootOf(publicRealm)}/moderation?${acting(publicRealm.moderator)}`,
    ),
  );
}, recording);
outcomeTest(rules, 'operator', async () => {
  expect(await answer(publicRealm.operator.main('GET', '/v1/me/platform-access'))).toMatchObject({
    groups: ['platform-admin'],
  });
  await participate('operator');
  await answer(
    publicRealm.operator.main(
      'PUT',
      `${rootOf(publicRealm)}/settings`,
      command(await basis(), publicRealm.owner),
    ),
    403,
  );
}, recording);
