import { closeRealm, closureCell } from './closure-fixture.ts';
import { afterAll, beforeAll, expect, setDefaultTimeout } from 'bun:test';
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
outcomeTest(declaration, 'visitor', () => closureCell(declaration, 'visitor', () => closed, () => reads('visitor')));
outcomeTest(declaration, 'stranger', () => closureCell(declaration, 'stranger', () => closed, () => reads('stranger')));
outcomeTest(declaration, 'member', () => closureCell(declaration, 'member', () => closed, () => reads('member')));
outcomeTest(declaration, 'owner', () => closureCell(declaration, 'owner', () => closed, () => reads('owner')));
outcomeTest(declaration, 'moderator', () => closureCell(declaration, 'moderator', () => closed, () => reads('moderator')));
outcomeTest(declaration, 'operator', () => closureCell(declaration, 'operator', () => closed, () => reads('operator')));
