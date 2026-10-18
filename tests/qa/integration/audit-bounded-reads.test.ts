import { expect, test } from 'bun:test';
import { personaNames } from '../support/personas.ts';
import { REALM_DIRECTORY_COST } from '../../../services/main/src/modules/realm-directory/contract.ts';
import { RESOURCE_LIST_COST } from '../../../services/main/src/modules/query/resource-contract.ts';
import { MAX_SEARCH_REQUEST_MS, MAX_SEARCH_FUSEKI_CALLS, MAX_SEARCH_FUSEKI_BYTES } from '../../../services/main/src/modules/work/search-readiness.ts';
import { LIST_COST } from '../../../services/main/src/api-list.ts';
import { useBoundedReadCorpus, sessions, privateRealm, corpus, measured, record, command, type Page } from '../support/bounded-read-corpus.ts';

useBoundedReadCorpus('queries');

for (const name of personaNames) {
  test(`D5-002 ${name}: legal default discovery returns a bounded page without private resources`, async () => {
    const person = sessions[name];
    const result = await measured(person, 'POST', '/v1/query', { profile: 'resource-list-v1',
      context: 'global', scope: { kind: 'all' }, sort: 'newest', limit: 20 });
    record({ case: 'D5-002', persona: name, assertionReached: true });
    expect(result.status, JSON.stringify(result)).toBe(200);
    const page = result.body.result as Page;
    expect(result.graphCalls).toBeGreaterThan(0);
    // All includes the Realm directory's own declared supplement.
    expect(result.graphCalls).toBeLessThanOrEqual(RESOURCE_LIST_COST.graphCalls + REALM_DIRECTORY_COST.graphCalls);
    expect(result.graphBytes).toBeLessThanOrEqual(RESOURCE_LIST_COST.graphBytes);
    expect(result.elapsedMs).toBeLessThan(RESOURCE_LIST_COST.deadlineMs);
    expect(page.items.length).toBeGreaterThan(0);
    expect(page.items.map(item => item.id)).not.toContain(corpus.privateWork);
    expect(page.items.map(item => item.id)).not.toContain(privateRealm.realm);
    expect(page.complete).toBe(page.nextCursor === null);
    expect(page.count.kind).toBe(page.complete ? 'exact' : 'at-least');
  }, 30_000);

  test(`AUD-001 ${name}: server cursors round-trip through a complete mixed-resource traversal`, async () => {
    const seen = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (let index = 0; index < 256; index++) {
      const result = await measured(sessions[name], 'POST', '/v1/query', { profile: 'resource-list-v1',
        context: 'global', scope: { kind: 'all' }, sort: 'newest', limit: 1, ...(cursor ? { cursor } : {}) });
      record({ case: 'AUD-001', persona: name, page: index, assertionReached: true, cursorLength: cursor?.length ?? 0 });
      expect(result.status, JSON.stringify(result)).toBe(200);
      const page = result.body.result as Page;
      for (const item of page.items) {
        expect(seen.has(item.id), 'A resource occurs once across the traversal').toBe(false);
        expect(item.id).not.toBe(corpus.privateWork);
        seen.add(item.id);
      }
      expect(page.complete).toBe(page.nextCursor === null);
      if (page.complete) {
        expect(page.count).toEqual({ kind: 'exact', value: seen.size });
        expect(seen.has(corpus.book!.work)).toBe(true);
        expect(seen.has(sessions.realm)).toBe(true);
        return;
      }
      expect(page.count.kind).toBe('at-least');
      expect(cursors.has(page.nextCursor!), 'A partial/empty page must still advance').toBe(false);
      cursors.add(page.nextCursor!);
      // Acceptance by the next API request is authoritative, even if encoding changes.
      record({ case: 'AUD-001-issued', persona: name, length: page.nextCursor!.length,
        admittedCursorCharacters: LIST_COST.cursorCharacters });
      cursor = page.nextCursor!;
    }
    throw new Error('Traversal did not complete within the known command-created corpus');
  }, 120_000);

  test(`D5-003 ${name}: healthy chapter hits and exact no-match reads avoid foreground population qualification`, async () => {
    const queries = [corpus.phrase, `${corpus.phrase}absent`, corpus.privatePhrase, corpus.phrase];
    const answers = [];
    for (const [index, phrase] of queries.entries()) {
      if (index === 3) await command(sessions.owner, 'POST', '/v1/works', { profile: 'metadata-only-v1',
        authoring: 'own-work', title: `An unrelated graph advancement ${name}`, language: 'en',
        actingSubject: sessions.owner.actingSubject });
      answers.push(await measured(sessions[name], 'POST', '/v1/queries/page', {
        profile: 'public-main-phrase-page-v1', phrase, language: null, pageSize: 10 }));
    }
    record({ case: 'D5-003', persona: name, assertionReached: true });
    for (const [index, result] of answers.entries()) {
      expect(result.status, JSON.stringify(result)).toBe(200);
      expect(result.elapsedMs).toBeLessThan(MAX_SEARCH_REQUEST_MS);
      expect(result.graphCalls).toBeGreaterThan(0);
      expect(result.graphCalls).toBeLessThanOrEqual(MAX_SEARCH_FUSEKI_CALLS);
      expect(result.graphBytes).toBeLessThanOrEqual(MAX_SEARCH_FUSEKI_BYTES);
      expect(result.populationAudits, 'A reader must not qualify the unrelated Content population').toBe(0);
      if (index === 1 || index === 2) expect(result.body).toMatchObject({ total: 0, relationComplete: true, results: [] });
      else expect(JSON.stringify(result.body)).toContain(corpus.book!.work);
    }
  }, 30_000);

}


for (const name of personaNames) {
  test('D5-003 ' + name + ': absent and unpublished chapter phrases remain exact private controls', async () => {
    for (const phrase of [corpus.phrase + 'absent', corpus.privatePhrase]) {
      const result = await measured(sessions[name], 'POST', '/v1/queries/page', {
        profile: 'public-main-phrase-page-v1', phrase, language: null, pageSize: 10 });
      record({ case: 'D5-003-disclosure', persona: name, assertionReached: true });
      expect(result.status, JSON.stringify(result)).toBe(200);
      expect(result.body).toMatchObject({ total: 0, relationComplete: true, results: [] });
      expect(JSON.stringify(result.body)).not.toContain(corpus.privateWork);
    }
  }, 30_000);
}

test('D5-004 operator: quiescent refresh exposes deferred reasons without disclosing private scope identities', async () => {
  const result = await measured(sessions.operator, 'GET', '/health/discovery-ready');
  record({ case: 'D5-004-diagnostic-control', persona: 'operator', assertionReached: true,
    persistentInvalidMediaAssertionReached: false,
    reason: 'This baseline projects identities/source evidence, not media; the old invalid-media producer is absent.' });
  expect([200, 503]).toContain(result.status);
  expect(result.body).toHaveProperty('refresh');
  const refresh = result.body.refresh as { items: { scopeKey: string; reason: string }[]; truncated: boolean } | null;
  if (refresh !== null) {
    expect(typeof refresh.truncated).toBe('boolean');
    for (const item of refresh.items) {
      expect(item.scopeKey).toMatch(/^[a-f0-9]{64}$/);
      expect(['basis-invalid', 'basis-unavailable', 'inactive', 'retry']).toContain(item.reason);
    }
    expect(JSON.stringify(refresh)).not.toContain(privateRealm.realm);
    expect(JSON.stringify(refresh)).not.toContain(privateRealm.owner.actingSubject!);
  }
}, 30_000);
