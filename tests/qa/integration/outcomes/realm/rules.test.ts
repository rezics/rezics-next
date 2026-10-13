import { afterAll, beforeAll, expect, setDefaultTimeout } from 'bun:test';
import { randomUUID } from 'node:crypto';
import rules from '../../../../../scripts/qa/cases/outcomes/realm/rules.ts';
import { outcomeTest } from '../../../support/outcome-test.ts';
import {
  personaSessions,
  type PersonaName,
  type PersonaSession,
  type PersonaSessions,
} from '../../../support/personas.ts';

setDefaultTimeout(90_000);
let publicRealm: PersonaSessions, privateRealm: PersonaSessions;
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
  await publicRealm?.close();
});

async function readRules(name: PersonaName) {
  for (const fixture of [publicRealm, privateRealm]) {
    const person = fixture[name],
      allowed = fixture === publicRealm || ['member', 'owner', 'moderator'].includes(name);
    const path = `${rootOf(fixture)}?language=zh-CN${name === 'visitor' ? '' : `&${acting(person)}`}`;
    const response = await answer(person.main('GET', path), allowed ? 200 : 404);
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
        publicRealm[name].main(
          'GET',
          `${rootOf(publicRealm)}?language=${language}${name === 'visitor' ? '' : `&${acting(publicRealm[name])}`}`,
        ),
      ),
    ).toMatchObject({ rules: [{ title: { value: 'Read with care', language: 'en' } }] });
  }
  const joined = ['member', 'owner', 'moderator'].includes(name);
  // Joined readers use the full member route; the separate landing is for outsiders.
  const landing = await answer(
    privateRealm[name].main(
      'GET',
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
  await answer(person.main('GET', `${rootOf(publicRealm)}/settings?${acting(person)}`), status);
  await answer(
    person.main('PUT', `${rootOf(publicRealm)}/settings`, command(await basis(), person)),
    status,
  );
}
outcomeTest(rules, 'visitor', async () => {
  await readRules('visitor');
  await cannotManage('visitor');
});
async function participate(name: 'stranger' | 'member' | 'moderator' | 'operator') {
  await readRules(name);
  await cannotManage(name);
  const person = publicRealm[name],
    input = await candidate(person);
  const allowed = ['member', 'moderator'].includes(name);
  const response = await answer(
    person.main('POST', `${rootOf(publicRealm)}/submissions`, input),
    allowed ? 201 : 403,
  );
  if (allowed)
    expect(response).toMatchObject({
      submission: { state: 'pending', submittingAgent: person.actingSubject, work: input.work },
    });
}
outcomeTest(rules, 'stranger', () => participate('stranger'));
outcomeTest(rules, 'member', () => participate('member'));

outcomeTest(rules, 'owner', async () => {
  await readRules('owner');
  const owner = publicRealm.owner,
    path = `${rootOf(publicRealm)}/settings`,
    roleId = randomUUID(),
    moderator = publicRealm.moderator;
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
      owner.main('PUT', path, input, key),
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
      owner.main('PUT', path, { ...input, reason: 'Different publishing intent' }, key),
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
});
outcomeTest(rules, 'moderator', async () => {
  await participate('moderator');
  await answer(
    publicRealm.moderator.main(
      'GET',
      `${rootOf(publicRealm)}/moderation?${acting(publicRealm.moderator)}`,
    ),
  );
});
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
});
