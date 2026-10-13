import closure from '../../../../../scripts/qa/cases/outcomes/realm/closure-rankings.ts';
import { afterAll, beforeAll, expect, setDefaultTimeout } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { outcomeTest } from '../../../support/outcome-test.ts';
import {
  personaSessions,
  type PersonaName,
  type PersonaSession,
  type PersonaSessions,
} from '../../../support/personas.ts';

setDefaultTimeout(60_000);
type Work = { work: string; mainVersion: string; workRevision: string };
type Publication = Work & { contribution: string; publicationDecision: string; selection: string };
let sessions: PersonaSessions;
const publications: Publication[] = [];
let closureUnavailable: string | undefined;
const phrase = `Closuregarden${randomUUID().replaceAll('-', '')}`;
const short = (id: string) => id.slice(-36);
const acting = (person: PersonaSession) =>
  person.actingSubject ? `actingSubject=${encodeURIComponent(person.actingSubject)}` : '';

async function answer<T>(request: Promise<Response>, status = 200): Promise<T> {
  const response = await request;
  const raw = await response.text();
  expect(response.status, `HTTP ${response.status}: ${raw}`).toBe(status);
  return JSON.parse(raw) as T;
}

async function missing(person: PersonaSession, path: string, absent: string) {
  const unavailable = await person.main('GET', path);
  const ordinary = await person.main('GET', absent);
  expect(ordinary.status, absent).toBe(404);
  expect(unavailable.status, path).toBe(ordinary.status);
  expect(await unavailable.json(), path).toEqual(await ordinary.json());
}

async function requireClosure(person: PersonaSession) {
  // A refused prerequisite is not an observed delivery defect. Each person
  // confirms the still-open public Realm through their own HTTP session.
  if (closureUnavailable) {
    await answer(person.main('GET', `/v1/realms/${short(sessions.realm)}`));
    throw new Error(closureUnavailable);
  }
}

async function independent(person: PersonaSession) {
  for (const publication of publications) {
    await answer(person.main('GET', `/v1/works/${short(publication.work)}`));
    const credits = await answer<{ items: { agent: string; role: string }[] }>(
      person.main('GET', `/v1/works/${short(publication.work)}/agent-credits`),
    );
    expect(credits.items).toContainEqual(
      expect.objectContaining({ agent: sessions.owner.actingSubject, role: 'author' }),
    );
  }
}

async function publishOriginals() {
  const owner = sessions.owner;
  const root = `/v1/realms/${short(sessions.realm)}`;
  const roleId = randomUUID();
  for (const change of [
    { kind: 'role', roleId, name: 'Original catalogue editors', permissions: ['publication.adopt'] },
    {
      kind: 'assignment', roleId, member: owner.actingSubject, assigned: true,
      validUntil: new Date(Date.now() + 3_600_000).toISOString(),
    },
  ]) {
    const roles = await answer<{ generation: string }>(owner.main('GET', `${root}/roles?${acting(owner)}`));
    const command = {
      actingSubject: owner.actingSubject, expectedGeneration: roles.generation,
      reason: 'Adopt original fixture publications while preserving their authors', change,
    };
    const preview = await answer<{ digest: string }>(owner.main('POST', `${root}/role-impact`, command));
    await answer(owner.main('POST', `${root}/role-changes`, { ...command, impactDigest: preview.digest }), 201);
  }
  for (let index = 0; index < 3; index++) {
    const work = await answer<Work>(owner.main('POST', '/v1/works', {
      profile: 'metadata-only-v1', title: `${phrase} ${index}`, language: 'en',
      semanticTypes: ['https://schema.org/Book'], authoring: 'own-work',
      actingSubject: owner.actingSubject,
    }), 201);
    await answer(owner.main('POST', `/v1/works/${short(work.work)}/agent-credits`, {
      profile: 'native-agent-credit-v1', credit: `https://rezics.com/id/${randomUUID()}`,
      agent: owner.actingSubject, role: 'author', expectedWorkHead: work.workRevision,
      actingSubject: owner.actingSubject,
    }), 201);
    const draft = await answer<{ contribution: string; draftRevision: string }>(
      owner.main('POST', '/v1/contributions', {
        profile: 'text-contribution-v1', work: work.work, language: 'en',
        body: `Original ${phrase} story ${index}: a gardener plants a seed.`,
        actingSubject: owner.actingSubject,
      }), 201,
    );
    const published = await answer<{ publicationDecision: string }>(
      owner.main('POST', '/v1/contribution-publications', {
        profile: 'text-publication-v1', contribution: draft.contribution,
        expectedDraftHead: draft.draftRevision, expectedPublicationHead: null,
        rightsBasis: 'original-contribution', disclosure: 'public',
        actingSubject: owner.actingSubject,
      }), 201,
    );
    const selected = {
      work: work.work, contribution: draft.contribution,
      publicationDecision: published.publicationDecision, expectedSelectionHead: null,
      actingSubject: owner.actingSubject,
    };
    await answer(owner.main('POST', '/v1/publication-selections', {
      ...selected, profile: 'main-default-selection-v1',
      context: { kind: 'main-version-default', id: work.mainVersion }, selectionBasis: 'main-maintainer',
    }), 201);
    const adoption = await answer<{ selection: string }>(
      owner.main('POST', '/v1/publication-selections', {
        ...selected, profile: 'realm-local-selection-v1',
        context: { kind: 'realm-local', id: sessions.realm }, mainVersion: work.mainVersion,
        selectionBasis: 'realm-manager-review',
      }), 201,
    );
    publications.push({ ...work, ...draft, ...published, selection: adoption.selection });
  }
}

async function closeRealm(rule: { ref: string; revision: string; digest: string }) {
  const owner = sessions.owner, operator = sessions.operator;
  const header = await answer<{ revision: string }>(
    owner.main('GET', `/v1/realms/${short(sessions.realm)}?${acting(owner)}`),
  );
  const reportKey = randomUUID();
  const report = await answer<{ caseId: string }>(owner.main('POST', '/v1/reports', {
    profile: 'content-report-v1', actingSubject: owner.actingSubject,
    authority: { kind: 'platform', scopeId: 'governance:platform' },
    context: 'urn:rezics:context:global',
    target: { owner: 'graph', resource: sessions.realm, component: 'record' },
    disclosure: 'parties', reasonCode: 'reviewed_removal',
    statement: 'Review the exact Realm record, retaining independent originals.',
    evidence: [{ owner: 'graph', resource: sessions.realm, component: 'record', revision: null, locator: null }],
    idempotencyKey: reportKey,
  }, reportKey), 201);
  const claimKey = randomUUID();
  await answer(operator.main('POST', `/v1/safety-cases/${report.caseId}/claim`, {
    actingSubject: operator.actingSubject, idempotencyKey: claimKey,
  }, claimKey));
  const basis = await answer<{ generation: string; reports: { evidenceDigest: string }[] }>(
    operator.main('GET', `/v1/safety-cases/${report.caseId}?${acting(operator)}`),
  );
  const key = randomUUID();
  const command = {
    profile: 'moderation-decision-v1', caseId: report.caseId,
    expectedGeneration: basis.generation, actingSubject: operator.actingSubject, outcome: 'restrict',
    targets: [{
      owner: 'graph', resource: sessions.realm, component: 'record', locator: null,
      scopeKind: 'component', revision: null, expectedHead: header.revision, effect: 'disclosure',
    }],
    rule, evidenceDigest: basis.reports[0]!.evidenceDigest,
    reversesDecisionId: null, answersStepId: null,
    rationale: 'Close the Realm record without restricting independent publications.',
    disclosure: 'parties',
    reasons: {
      facts: 'The exact Realm record was reviewed.', scope: 'This Realm record.',
      duration: 'Until a later platform decision.', automation: false,
      appealRoute: '/v1/public-reports/{caseId}/correspondence', contentLanguage: 'en',
    },
    idempotencyKey: key,
  };
  const response = await operator.main('POST', '/v1/moderation/decisions', command, key);
  const raw = await response.text();
  const receipt = JSON.parse(raw) as { operation?: { status: string } };
  if (response.status !== 200 || receipt.operation?.status !== 'completed') {
    closureUnavailable = `Closure prerequisite POST /v1/moderation/decisions: HTTP ${response.status} ${raw}`;
    console.log(closureUnavailable);
  }
}

// Unexpected setup exceptions stay in beforeAll. Only a recorded inability to
// establish closure through the public API becomes a pending prerequisite.
beforeAll(async () => {
  sessions = await personaSessions('public');
  const key = randomUUID();
  const command = {
    profile: 'governance-rule-v1', ref: `urn:rezics:rule:${randomUUID()}`,
    scopeId: 'governance:platform', actingSubject: sessions.operator.actingSubject,
    expectedRevision: null, document: { rule: 'Review whole-Realm closure while retaining independent publications.' },
    idempotencyKey: key,
  };
  const response = await sessions.operator.main('POST', '/v1/governance/rules', command, key);
  const raw = await response.text();
  const rule = JSON.parse(raw) as { ref: string; revision: string; digest: string; code?: string };
  if (response.status === 403 && rule.code === 'governance_denied') {
    closureUnavailable = `Closure fixture unavailable: POST /v1/governance/rules with governance:platform authority: HTTP 403 ${raw}`;
    console.log(closureUnavailable);
    return;
  }
  expect(response.status, raw).toBe(201);
  await publishOriginals();
  await prepareSurface();
  await closeRealm({ ref: rule.ref, revision: rule.revision, digest: rule.digest });
}, 180_000);

afterAll(async () => { await sessions?.close(); });

async function prepareSurface() {
  const baseline = await answer<{ items: { id: string }[] }>(
    sessions.visitor.main('GET', `/v1/realms/${short(sessions.realm)}/modules/new-adoptions`),
  );
  expect(baseline.items.map(item => item.id).sort()).toEqual(publications.map(item => item.work).sort());
  await independent(sessions.visitor);
}
async function delivered(name: PersonaName) {
  const person = sessions[name];
  await requireClosure(person);
  const root = `/v1/realms/${short(sessions.realm)}`;
  const absent = `/v1/realms/${randomUUID()}`;
  for (const suffix of ['/threads?sort=best&window=all', '/threads?sort=top&window=all',
    '/rankings', '/modules/rising']) {
    const query = person.actingSubject && suffix.startsWith('/threads') ? `&${acting(person)}` : '';
    await missing(person, `${root}${suffix}${query}`, `${absent}${suffix}${query}`);
  }
  for (const path of ['/v1/rankings/trending', '/v1/trending?scope=global']) {
    const page = await answer<unknown>(person.main('GET', path));
    const bytes = JSON.stringify(page);
    expect(bytes).not.toContain(sessions.realm);
    for (const publication of publications) expect(bytes).not.toContain(publication.selection);
  }
  const scoped = `/v1/trending?scope=${encodeURIComponent(`realm:${sessions.realm}`)}`;
  const missingScope = `/v1/trending?scope=${encodeURIComponent(`realm:https://rezics.com/id/${randomUUID()}`)}`;
  const query = person.actingSubject ? `&${acting(person)}` : '';
  await missing(person, scoped + query, missingScope + query);
  await independent(person);
}

outcomeTest(closure, 'visitor', () => delivered('visitor'));
outcomeTest(closure, 'stranger', () => delivered('stranger'));
outcomeTest(closure, 'member', () => delivered('member'));
outcomeTest(closure, 'owner', () => delivered('owner'));
outcomeTest(closure, 'moderator', () => delivered('moderator'));
outcomeTest(closure, 'operator', () => delivered('operator'));

