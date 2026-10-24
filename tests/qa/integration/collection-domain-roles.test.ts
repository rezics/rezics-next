import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { collectionCases, type CollectionKey } from '../fixtures/catalogue-information-matrix.ts';
import type { PersonaSessions } from '../support/personas.ts';
import {
  allPersonas, assertCollectionPurpose, assertNativeSupportCommands, body, command, loadInformationCorpus, noHidden,
  openInformationCorpus, publicRead, resourcePath, type InformationCorpus, type PartsPage,
} from './support/catalogue-information.ts';

setDefaultTimeout(120_000);
let corpus: InformationCorpus;
let sessions: PersonaSessions;

describe('C29: explicit Collection purpose through shared membership and Structure', () => {
  beforeAll(async () => {
    corpus = loadInformationCorpus();
    sessions = await openInformationCorpus(corpus);
  }, 600_000);
  afterAll(async () => { await sessions?.close(); });

  // Supplemental contracts are pending just like the registered row. No successful
  // build run changes declaration state or establishes source/persona proof.
  for (const persona of allPersonas) {
    test(`${persona}: ordinary membership, a book list, recipe selection, series and franchise stay distinct`, async () => {
      const read = publicRead(sessions[persona]);
      for (const key of Object.keys(collectionCases) as CollectionKey[])
        await assertCollectionPurpose(read, corpus, key);
      const ordinary = await body<{ summary: { name: { value: string } } }>(read,
        resourcePath(corpus.collections.ordinary.resource, 'page'));
      // A misleading name is a deliberate counterexample to title/type heuristics.
      expect(ordinary.summary.name.value).toBe(corpus.collections.ordinary.name);
      for (const hidden of corpus.controls.hidden.resources) {
        const response = await read(resourcePath(hidden, 'page'));
        expect(response.status).toBe(404);
        noHidden(await response.json(), corpus);
      }
    });
  }

  test('six personas: native admission binds exact retained evidence; refused support and withdrawal preserve human content', async () => {
    await assertNativeSupportCommands(sessions, corpus);
  });

  test('six personas: cursors bind subject, parent and order; private changes preserve them, public changes restart explicitly', async () => {
    const order = corpus.orders.tracks;
    const base = resourcePath(order.resource, 'parts');
    const selection = new URLSearchParams({ limit: '1', parent: order.parent! });
    const cursors = new Map<string, { cursor: string; expected: PartsPage }>();
    for (const persona of allPersonas) {
      const read = publicRead(sessions[persona]);
      const first = await body<PartsPage>(read, `${base}?${selection}`);
      expect(first.next).not.toBeNull();
      const nextQuery = new URLSearchParams(selection);
      nextQuery.set('after', first.next!);
      const next = await body<PartsPage>(read, `${base}?${nextQuery}`);
      expect(next.parts[0]?.occurrence).toBe(order.items[1]?.occurrence);
      cursors.set(persona, { cursor: first.next!, expected: next });

      const otherSubject = `${resourcePath(corpus.orders.episodes.resource, 'parts')}?${nextQuery}`;
      const wrongSubject = await read(otherSubject);
      expect(wrongSubject.status).toBe(400);
      const otherParent = new URLSearchParams(nextQuery);
      otherParent.set('parent', corpus.orders.media.items.find(item => item.occurrence !== order.parent)!.occurrence);
      expect((await read(`${base}?${otherParent}`)).status).toBe(400);
      const largerPage = new URLSearchParams(nextQuery);
      largerPage.set('limit', '2');
      const larger = await body<PartsPage>(read, `${base}?${largerPage}`);
      expect(larger.parts.map(part => part.occurrence)).toEqual(order.items.slice(1, 3).map(part => part.occurrence));
    }
    await command(sessions.owner, corpus.controls.privateMutation);
    for (const persona of allPersonas) {
      const { cursor, expected } = cursors.get(persona)!;
      const query = new URLSearchParams({ ...Object.fromEntries(selection), after: cursor });
      const continued = await body<PartsPage>(publicRead(sessions[persona]), `${base}?${query}`);
      expect(continued.parts).toEqual(expected.parts);
      expect(continued.next).toBe(expected.next);
      noHidden(continued, corpus);
    }
    // This is an isolated writable restore. The reusable backup is never mutated;
    // the public selection mutation is last and the QA harness discards the copy.
    await command(sessions.owner, corpus.controls.publicMutation);
    for (const persona of allPersonas) {
      const { cursor } = cursors.get(persona)!;
      const query = new URLSearchParams({ ...Object.fromEntries(selection), after: cursor });
      const response = await publicRead(sessions[persona])(`${base}?${query}`);
      expect(response.status).toBe(409);
      const refusal = await response.json() as { code: string; restart: { href: string } };
      expect(refusal.code).toBe('read_basis_changed');
      expect(refusal.restart.href).toBe(`${base}?${selection}`);
      noHidden(refusal, corpus);
      const restarted = await body<PartsPage>(publicRead(sessions[persona]), refusal.restart.href);
      expect(restarted.resource).toBe(order.resource);
      expect(restarted.revision).not.toBe(order.revision);
    }
  });
});
