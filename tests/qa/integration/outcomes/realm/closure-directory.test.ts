import { afterAll, beforeAll, expect, setDefaultTimeout } from 'bun:test';
import { randomUUID } from 'node:crypto';
import declaration from '../../../../../scripts/qa/cases/outcomes/realm/closure-directory.ts';
import { outcomeResponse, outcomeTest } from '../../../support/outcome-test.ts';
import {
  personaSessions, type PersonaName, type PersonaSession, type PersonaSessions,
} from '../../../support/personas.ts';

setDefaultTimeout(60_000);
let closed: PersonaSessions;
let live: PersonaSessions;
let setupFailure: string | null = null;
let closureFailure: string | null = null;
type Page = { items: { id: string }[]; nextCursor: string | null };
const short = (id: string) => id.slice(-36);
const acting = (person: PersonaSession) =>
  person.actingSubject ? `actingSubject=${encodeURIComponent(person.actingSubject)}` : '';
const root = (sessions: PersonaSessions) => `/v1/realms/${short(sessions.realm)}`;
async function command<T>(
  person: PersonaSession, method: string, path: string, body?: unknown,
  status = 200, key?: string,
): Promise<T> {
  const response = await person.main(method, path, body, key);
  const raw = await response.text();
  if (response.status !== status)
    throw new Error(`${method} ${path}: expected ${status}, received ${response.status} ${raw}`);
  return JSON.parse(raw) as T;
}
async function closeRealm(sessions: PersonaSessions): Promise<string | null> {
  const operator = sessions.operator;
  try {
    const basis = await command<{ revision: string }>(
      sessions.owner, 'GET', `${root(sessions)}?${acting(sessions.owner)}`,
    );
    const ruleKey = randomUUID();
    const published = await command<{ ref: string; revision: string; digest: string }>(
      operator, 'POST', '/v1/governance/rules', {
        profile: 'governance-rule-v1', ref: `urn:rezics:rule:${randomUUID()}`,
        scopeId: 'governance:platform', actingSubject: operator.actingSubject,
        expectedRevision: null, document: { rule: 'Conceal this synthetic closure fixture' },
        idempotencyKey: ruleKey,
      }, 201, ruleKey,
    );
    const reportKey = randomUUID();
    const report = await command<{ caseId: string }>(
      sessions.stranger, 'POST', '/v1/reports', {
        profile: 'content-report-v1', actingSubject: sessions.stranger.actingSubject,
        authority: { kind: 'platform', scopeId: 'governance:platform' },
        context: 'urn:rezics:context:global',
        target: { owner: 'graph', resource: sessions.realm, component: 'record' },
        disclosure: 'parties', reasonCode: 'reviewed_removal',
        statement: 'Review this synthetic Realm record independently of its public Works.',
        evidence: [{ owner: 'graph', resource: sessions.realm, component: 'record',
          revision: null, locator: null }],
        idempotencyKey: reportKey,
      }, 201, reportKey,
    );
    const claimKey = randomUUID();
    await command(operator, 'POST', `/v1/safety-cases/${report.caseId}/claim`, {
      actingSubject: operator.actingSubject, idempotencyKey: claimKey,
    }, 200, claimKey);
    const safety = await command<{ generation: string; reports: { evidenceDigest: string }[] }>(
      operator, 'GET', `/v1/safety-cases/${report.caseId}?${acting(operator)}`,
    );
    const key = randomUUID();
    const input = {
      profile: 'moderation-decision-v1', caseId: report.caseId,
      expectedGeneration: safety.generation, actingSubject: operator.actingSubject,
      outcome: 'restrict',
      targets: [{ owner: 'graph', resource: sessions.realm, component: 'record',
        locator: null, scopeKind: 'component', revision: null,
        expectedHead: basis.revision, effect: 'disclosure' }],
      rule: { ref: published.ref, revision: published.revision, digest: published.digest },
      evidenceDigest: safety.reports[0]!.evidenceDigest,
      reversesDecisionId: null, answersStepId: null,
      rationale: 'Close only the exact Realm record', disclosure: 'parties',
      reasons: {
        facts: 'The synthetic report and exact Realm record were reviewed.',
        scope: 'Only the declared Realm record.', duration: 'Until a later staff decision.',
        automation: false, appealRoute: '/v1/public-reports/{caseId}/correspondence',
        contentLanguage: 'en',
      },
      idempotencyKey: key,
    };
    // Replay the same admitted command; a 202 is not an effective closure.
    for (let attempt = 0; attempt < 4; attempt++) {
      const response = await operator.main('POST', '/v1/moderation/decisions', input, key);
      const raw = await response.text();
      const result = JSON.parse(raw) as { operation?: { status: string } };
      if (response.status === 200 && result.operation?.status === 'completed') return null;
      if (response.status !== 202 || attempt === 3)
        throw new Error(`POST /v1/moderation/decisions: ${response.status} ${raw}`);
    }
    throw new Error('Platform closure did not complete');
  } catch (error) {
    return String(error);
  }
}
function reportFailures(failures: string[]) {
  if (failures.length) console.log(failures.join('\n'));
  expect(failures, failures.join('\n')).toEqual([]);
}

async function inventory(person: PersonaSession, sort: string, q: string | undefined, successor: boolean) {
  const ids: string[] = [];
  const cursors = new Set<string>();
  let cursor: string | null = null;
  for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
    let response: Response;
    let request: string;
    if (successor) {
      const input = {
        profile: 'resource-list-v1', context: 'global', scope: { kind: 'all' },
        sort, limit: 1, ...(q ? { q } : {}), ...(cursor ? { cursor } : {}),
        filter: { all: [{ facet: 'type', any: ['https://rezics.com/vocab/Realm'] }] },
      };
      // POST query reads repeat only the helper's exact background-work refusal.
      response = await outcomeResponse(() => person.main('POST', '/v1/query', input));
      request = `POST /v1/query ${JSON.stringify(input)}`;
    } else {
      const query = new URLSearchParams({ sort, limit: '1', ...(q ? { q } : {}), ...(cursor ? { cursor } : {}) });
      response = await person.main('GET', `/v1/realms?${query}`);
      request = `GET /v1/realms?${query}`;
    }
    const raw = await response.text();
    const body = JSON.parse(raw) as Page & { result?: Page; code?: string };
    // A cursor pins one published basis. Follow the API's explicit restart
    // instruction when a production projection publishes during traversal.
    if (response.status === 409 && body.code === 'read_basis_changed') {
      ids.length = 0;
      cursors.clear();
      cursor = null;
      continue;
    }
    if (response.status !== 200)
      throw new Error(`${request}: ${response.status} ${raw}`);
    const page = successor ? body.result! : body;
    ids.push(...page.items.map(item => item.id));
    if (!page.nextCursor) {
      expect(new Set(ids).size).toBe(ids.length);
      return ids;
    }
    expect(cursors.has(page.nextCursor), 'Directory cursor must advance').toBe(false);
    cursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
  throw new Error('Synthetic directory traversal exceeded 100 pages');
}
beforeAll(async () => {
  closed = await personaSessions('public');
  live = await personaSessions('public');
  try {
    for (const successor of [false, true]) {
      const ids = await inventory(closed.visitor, 'newest', undefined, successor);
      expect(ids).toContain(closed.realm);
      expect(ids).toContain(live.realm);
    }
  } catch (error) { setupFailure = String(error); }
  closureFailure = await closeRealm(closed);
  if (setupFailure) console.log(`Directory prerequisite: ${setupFailure}`);
  if (closureFailure) console.log(`Directory closure prerequisite: ${closureFailure}`);
}, 180_000);
afterAll(async () => { await closed?.close(); });

async function reads(name: PersonaName) {
  expect(closureFailure, closureFailure ?? '').toBeNull();
  expect(setupFailure, setupFailure ?? '').toBeNull();
  const person = closed[name];
  const failures: string[] = [];
  for (const successor of [false, true]) {
    const sorts = successor ? ['newest', 'updated', 'relevance'] : ['activity', 'members', 'newest', 'growing'];
    for (const sort of sorts)
      for (const q of sort === 'relevance' ? ['Outcome'] : [undefined, 'Outcome']) {
        try {
          const ids = await inventory(person, sort, q, successor);
          if (ids.includes(closed.realm) || !ids.includes(live.realm))
            failures.push(`${successor ? 'POST /v1/query resource-list-v1 community type Facet' : 'GET /v1/realms'} sort=${sort} q=${q ?? ''}: delivered ${JSON.stringify(ids)}`);
        } catch (error) { failures.push(String(error)); }
      }
  }
  reportFailures(failures);
}
outcomeTest(declaration, 'visitor', () => reads('visitor'));
outcomeTest(declaration, 'stranger', () => reads('stranger'));
outcomeTest(declaration, 'member', () => reads('member'));
outcomeTest(declaration, 'owner', () => reads('owner'));
outcomeTest(declaration, 'moderator', () => reads('moderator'));
outcomeTest(declaration, 'operator', () => reads('operator'));
