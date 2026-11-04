import { expect, test as bunTest } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { bundledRelease } from '@rezics/definitions/bundled';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { deriveAccess } from '../../src/access/derived-access.ts';
import { STANDARD_QUESTION_ID } from '../../src/rating/votes.ts';
import { attachCollectionListFacts } from '../../src/library/collection-list-facts.ts';
import { fullMembers } from '../../src/library/views.ts';
import { testTokens } from '../support/test-kernel.ts';
import { capture } from '../support/growth.ts';
import detailSQL from '../../src/semantic/read-subject.sql';
import factsSQL from '../../src/semantic/list-presentation-subjects.sql';
import { createCollectionListFactsFixture } from './support/collection-list-facts-fixture.ts';

const quantity = (amount: string) => ({ amount, unit: '1' });
async function page(response: Response) {
  expect(response.status, await response.clone().text()).toBe(200);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  return (await response.json()) as { members: Record<string, any>[]; next: string | null };
}

bunTest.serial(
  'FULL Collection members carry genuine Type-selected key facts in one native batch and BASIC is unchanged',
  async () => {
    const f = await createCollectionListFactsFixture();
    try {
      const book = await f.create('schema:Book', { 'schema:wordCount': quantity('+123') });
      const film = await f.create('schema:Movie', {
        'schema:duration': { amount: '+5400', unit: 'http://www.wikidata.org/entity/Q11574' },
      });
      const recipe = await f.create('schema:Recipe', {
        'schema:cookTime': { amount: '+25', unit: 'http://www.wikidata.org/entity/Q7727' },
      });
      const plain = await f.create('schema:Person');
      const collection = await f.collection([book, film, recipe, plain, book], 'public', 'schema:Recipe');
      const measured = await capture(f.db, () => pageResult());
      async function pageResult() {
        return page(await f.get(collection.id));
      }
      const result = measured.value;
      expect(result.members.map((m) => m.subjectId)).toEqual([book, film, recipe, plain, book]);
      expect(result.members.map((m) => m.facts)).toEqual([
        { 'schema:wordCount': [{ kind: 'quantity', amount: 123, unit: '1' }] },
        { 'schema:duration': [{ kind: 'quantity', amount: 5400, unit: 'http://www.wikidata.org/entity/Q11574' }] },
        { 'schema:cookTime': [{ kind: 'quantity', amount: 25, unit: 'http://www.wikidata.org/entity/Q7727' }] },
        {},
        { 'schema:wordCount': [{ kind: 'quantity', amount: 123, unit: '1' }] },
      ]);
      for (const member of result.members) expect(member.subject.id).toBe(member.subjectId);
      expect(measured.capture.statements).not.toContain(detailSQL.sql);
      // Two native observations per home, independent of the number of rows or duplicate occurrences.
      const homes = new Set(result.members.map((m) => partitionOf(routeOf(m.subjectId)!)));
      expect(measured.capture.statements.filter((sql) => sql === factsSQL.sql).length).toBeLessThanOrEqual(
        4 * homes.size,
      );
      const basic = await page(await f.get(collection.id, 'BASIC'));
      expect(basic.next).toBe(result.next);
      expect(basic.members).toEqual(result.members.map(({ subject, facts, ...member }) => member));
      expect(f.maximumHeldBackends()).toBeLessThanOrEqual(1);
    } finally {
      await f.close();
    }
  },
  180_000,
);

bunTest.serial(
  'FULL shelf and Collection rows keep Type facts and the caller current state and zero score separate',
  async () => {
    const f = await createCollectionListFactsFixture();
    try {
      const release = structuredClone(bundledRelease);
      release.types['schema:Book']!.listPresentation = {
        imageAspect: 'portrait',
        keyFacts: ['schema:author', 'schema:wordCount'],
      };
      await f.publish(release);
      const author = await f.create('schema:Person', {}, { en: 'Author', fr: 'Auteur' });
      const book = await f.create(
        'schema:Book',
        { 'schema:author': author, 'schema:wordCount': quantity('+40') },
        { en: 'Book', fr: 'Livre' },
      );
      const collection = await f.collection([book], 'public', 'schema:Movie');

      for (const persona of ['editor', 'reader'] as const)
        for (const action of ['library_entry:update', 'library_entry:list', 'library_entry:read', 'rating:vote'])
          await f.grant(persona, action);
      await f.grant('reader', 'progress_session:list');
      await f.checked('PUT', `/v1/libraryEntries/${book}`, { state: 'completed' }, 'editor');
      await f.checked('PUT', `/v1/subjects/${book}/ratings/${STANDARD_QUESTION_ID}/vote`, { units: 12 }, 'editor');
      await f.checked('PUT', `/v1/libraryEntries/${book}`, { state: 'planned' }, 'reader');
      await f.checked('PUT', `/v1/subjects/${book}/ratings/${STANDARD_QUESTION_ID}/vote`, { units: 0 }, 'reader');
      await f.db.admin.query(
        `INSERT INTO access.exposure_opening ("group",valid,transaction_id)
       VALUES ('personal_library',tstzrange('2020-01-01T00:00:00Z',NULL,'[)'),$1),
              ('reading_progress',tstzrange('2020-01-01T00:00:00Z',NULL,'[)'),$2)`,
        [randomUUID(), randomUUID()],
      );

      const shelf = await f.call(
        'GET',
        '/v1/libraryEntries?view=FULL&orderBy=createdAt&direction=desc&limit=1',
        undefined,
        'reader',
        { 'accept-language': 'fr' },
      );
      expect(shelf.status).toBe(200);
      expect(shelf.body.libraryEntries).toHaveLength(1);
      expect(shelf.body.libraryEntries[0]).toMatchObject({
        subjectId: book,
        facts: {
          'schema:author': [{ kind: 'item', id: author, labels: { fr: 'Auteur' } }],
          'schema:wordCount': [{ kind: 'quantity', amount: 40, unit: '1' }],
        },
      });
      expect(shelf.body.viewerFacts).toMatchObject({
        state: 'current',
        rows: [
          {
            subjectId: book,
            entry: { state: 'present', entryState: 'planned' },
            vote: { state: 'present', units: 0 },
          },
        ],
      });
      const compatible = await f.call('GET', '/v1/libraryEntries?view=FULL&limit=1', undefined, 'reader', {
        'accept-language': 'fr',
      });
      expect(compatible.body.libraryEntries[0]!.facts).toEqual(shelf.body.libraryEntries[0]!.facts);

      const members = await f.call('GET', `/v1/collections/${collection.id}/members?view=FULL`, undefined, 'reader', {
        'accept-language': 'fr',
      });
      expect(members.status).toBe(200);
      expect(members.body.members[0]).toMatchObject({ subjectId: book, facts: shelf.body.libraryEntries[0].facts });
      expect(members.body.viewerFacts).toMatchObject({
        state: 'current',
        rows: [
          {
            subjectId: book,
            entry: { state: 'present', entryState: 'planned' },
            vote: { state: 'present', units: 0 },
          },
        ],
      });

      const nextRelease = structuredClone(release);
      nextRelease.types['schema:Book']!.listPresentation!.keyFacts = ['schema:wordCount'];
      await f.publish(nextRelease);
      const refreshed = await f.call(
        'GET',
        '/v1/libraryEntries?view=FULL&orderBy=createdAt&direction=desc&limit=1',
        undefined,
        'reader',
        { 'accept-language': 'fr' },
      );
      expect(refreshed.body.libraryEntries[0]!.facts).toEqual({
        'schema:wordCount': [{ kind: 'quantity', amount: 40, unit: '1' }],
      });
    } finally {
      await f.close();
    }
  },
  180_000,
);

bunTest.serial(
  'FULL uses current effective configuration, existing Fact variants and at most four properties and three values',
  async () => {
    const f = await createCollectionListFactsFixture();
    try {
      const release = structuredClone(bundledRelease);
      release.types['schema:Book']!.listPresentation = {
        imageAspect: 'portrait',
        keyFacts: ['schema:author', 'schema:datePublished', 'schema:wordCount', 'schema:inLanguage'],
      };
      await f.publish(release);
      const authors: string[] = [];
      for (let index = 0; index < 4; index++)
        authors.push(await f.create('schema:Person', {}, { en: `Author ${index}` }));
      const book = await f.create('schema:Book', {
        'schema:author': authors,
        'schema:wordCount': quantity('+42'),
        'schema:datePublished': {
          time: '+2024-01-01T00:00:00Z',
          precision: 11,
          calendarmodel: 'http://www.wikidata.org/entity/Q1985727',
        },
        'schema:inLanguage': 'en',
      });
      const collection = await f.collection([book]);
      const member = (await page(await f.get(collection.id))).members[0]!;
      expect(Object.keys(member.facts)).toEqual(release.types['schema:Book']!.listPresentation!.keyFacts);
      expect(member.facts['schema:author']).toHaveLength(3);
      expect(member.facts['schema:datePublished']).toEqual([{ kind: 'time', year: 2024 }]);
      expect(member.facts['schema:inLanguage']).toEqual([{ kind: 'code', value: 'en' }]);
      for (const type of Object.values(release.types)) delete type.listPresentation;
      await f.publish(release);
      expect((await page(await f.get(collection.id))).members[0]!.facts).toEqual({});
    } finally {
      await f.close();
    }
  },
  180_000,
);

bunTest.serial(
  'FULL conceals hidden originals, terminals and related items and rereads the current source tuple',
  async () => {
    const f = await createCollectionListFactsFixture();
    try {
      const author = await f.create('schema:Person', {}, { en: 'Withheld related name' });
      const book = await f.create('schema:Book', { 'schema:author': author, 'schema:wordCount': quantity('+5') });
      const hidden = await f.create('schema:Book', { 'schema:wordCount': quantity('+999') });
      const imported = await f.imported('schema:wordCount', quantity('+99'));
      const collection = await f.collection([book, hidden, imported.id]);
      await f.hide(author);
      await f.hide(hidden);
      await f.checked('POST', '/v1/sourceFences:takedown', {
        source: imported.source.source,
        externalId: imported.source.external_id,
        fieldGroup: 'facts',
        reason: 'Native Collection tuple withdrawal',
      });
      const result = await page(await f.get(collection.id, 'FULL', null));
      expect(result.members.map((m) => m.subjectId)).toEqual([book, imported.id]);
      expect(result.members[0]!.facts).toEqual({ 'schema:wordCount': [{ kind: 'quantity', amount: 5, unit: '1' }] });
      expect(result.members[1]!.facts).toEqual({});
      expect(JSON.stringify(result)).not.toContain(author);
      expect(JSON.stringify(result)).not.toContain('Withheld related name');
      expect(JSON.stringify(result)).not.toContain('999');
      // Actual identity mutation is pending until its native participants publish; it must never attach another row.
      const a = await f.create('schema:Book', { 'schema:wordCount': quantity('+10') });
      const b = await f.create('schema:Book', { 'schema:wordCount': quantity('+20') });
      const [terminal, original] = [a, b].sort() as [string, string];
      const redirected = await f.collection([original, terminal]);
      await f.checked('POST', '/v1/subjects:merge', { subjects: [original, terminal] });
      const pending = await f.get(redirected.id, 'FULL', null);
      expect(pending.status).toBe(503);
      expect((await pending.json()).code).toBe('semantic_not_ready');
      await f.hide(original);
      expect((await page(await f.get(redirected.id, 'FULL', null))).members.map((m) => m.subjectId)).toEqual([
        terminal,
      ]);
      await f.hide(terminal);
      expect((await page(await f.get(redirected.id, 'FULL', null))).members).toEqual([]);
    } finally {
      await f.close();
    }
  },
  180_000,
);

bunTest.serial(
  'same owner reduced scopes, other, anonymous and suspended viewers retain native disclosure and no-store outcomes',
  async () => {
    const f = await createCollectionListFactsFixture();
    try {
      const id = await f.create('schema:Book', { 'schema:wordCount': quantity('+31') });
      const privateCollection = await f.collection([id], 'private');
      const publicCollection = await f.collection([id]);
      const reduced = await f.credential(['collection:read']);
      const owner = await page(await f.get(privateCollection.id));
      expect(owner.members[0]!.facts['schema:wordCount']).toHaveLength(1);
      const limited = await page(await f.get(privateCollection.id, 'FULL', reduced));
      // Public Semantic facts remain subject to the actual subject read policy, independently of Collection scope.
      expect(limited.members).toEqual(owner.members);
      const noCollectionScope = await f.credential(['subject:read']);
      expect((await f.get(privateCollection.id, 'FULL', noCollectionScope)).status).toBe(404);
      for (const viewer of ['reader', 'anonymous'] as const) {
        expect(
          (await f.call('GET', `/v1/collections/${privateCollection.id}/members?view=FULL`, undefined, viewer)).status,
        ).toBe(404);
        const result = await f.call(
          'GET',
          `/v1/collections/${publicCollection.id}/members?view=FULL`,
          undefined,
          viewer,
        );
        expect(result.status).toBe(200);
        expect(result.body.members[0].facts).toEqual(owner.members[0]!.facts);
      }
      expect(
        (await f.call('GET', `/v1/collections/${publicCollection.id}/members?view=FULL`, undefined, 'suspended'))
          .status,
      ).toBe(401);
    } finally {
      await f.close();
    }
  },
  180_000,
);

bunTest.serial(
  'a final native Collection source change and a native fact-tuple race fail closed',
  async () => {
    const f = await createCollectionListFactsFixture();
    try {
      const imported = await f.imported('schema:wordCount', quantity('+19'));
      const collection = await f.collection([imported.id]);
      const deps = await f.deps('editor');
      let reads = 0;
      const access = deriveAccess(deps.access, {
        async prepare(actor, action, resource, context) {
          if (action === 'collection:read' && resource.id === collection.id && ++reads === 2) {
            const current = await f.checked('GET', `/v1/collections/${collection.id}`);
            await f.checked('PATCH', `/v1/collections/${collection.id}`, {
              revision: current.collection.revision,
              title: 'Changed native fence',
            });
          }
          return deps.access.prepare!(actor, action, resource, context);
        },
      });
      await expect(
        fullMembers({ ...deps, access, tokens: testTokens() }, deps.actor, collection.id, {}, deps.deadline),
      ).rejects.toMatchObject({ code: 'semantic_not_ready' });
      let subjects = 0;
      const racing = deriveAccess(deps.access, {
        async prepare(actor, action, resource, context) {
          // The first subject preparation belongs to summary projection; the later ones are the real producer.
          if (action === 'subject:read' && resource.id === imported.id && ++subjects === 4)
            await f.checked('POST', '/v1/sourceFences:takedown', {
              source: imported.source.source,
              externalId: imported.source.external_id,
              fieldGroup: 'facts',
              reason: 'Concurrent native tuple withdrawal',
            });
          return deps.access.prepare!(actor, action, resource, context);
        },
      });
      await expect(
        fullMembers({ ...deps, access: racing, tokens: testTokens() }, deps.actor, collection.id, {}, deps.deadline),
      ).rejects.toMatchObject({ code: 'semantic_not_ready' });
    } finally {
      await f.close();
    }
  },
  180_000,
);

bunTest.serial(
  'the exported preview attachment contract counts duplicate raw originals before deduplication and rejects overflow without work',
  async () => {
    const f = await createCollectionListFactsFixture();
    try {
      const id = await f.create('schema:Book', { 'schema:wordCount': quantity('+7') });
      const deps = await f.deps();
      const originals = Array.from({ length: 100 }, (_, ordinal) => ({ subjectId: id, ordinal }));
      let finalChecks = 0;
      const options = {
        async revalidate() {
          finalChecks++;
        },
      };
      const result = await attachCollectionListFacts(deps, originals, options);
      expect(result).toHaveLength(100);
      expect(result.map((m) => m.ordinal)).toEqual(originals.map((m) => m.ordinal));
      expect(result.every((m) => m.subject.id === id && m.facts['schema:wordCount']?.[0]?.kind === 'quantity')).toBe(
        true,
      );
      expect(finalChecks).toBe(1);
      let native = 0;
      const acquired = () => {
        native++;
      };
      f.pool.on('acquire', acquired);
      try {
        await expect(attachCollectionListFacts(deps, [...originals, originals[0]!], options)).rejects.toBeInstanceOf(
          RangeError,
        );
        expect(native).toBe(0);
        expect(finalChecks).toBe(1);
      } finally {
        f.pool.off('acquire', acquired);
      }
    } finally {
      await f.close();
    }
  },
  180_000,
);

bunTest.serial(
  'an identity change after the native batch cannot attach facts to a different current terminal',
  async () => {
    const f = await createCollectionListFactsFixture();
    try {
      const a = await f.create('schema:Book', { 'schema:wordCount': quantity('+10') });
      const b = await f.create('schema:Book', { 'schema:wordCount': quantity('+20') });
      const [terminal, original] = [a, b].sort() as [string, string];
      await expect(
        attachCollectionListFacts(await f.deps(), [{ subjectId: original }, { subjectId: terminal }], {
          async revalidate() {
            // A real source callback wait permits a real identity command, after native facts were observed.
            await f.checked('POST', '/v1/subjects:merge', { subjects: [original, terminal] });
          },
        }),
      ).rejects.toMatchObject({ code: 'semantic_not_ready' });
    } finally {
      await f.close();
    }
  },
  180_000,
);
