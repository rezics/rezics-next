import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { authorCreditFixture } from '../fixtures/author-credit.ts';

interface Page {
  context: { kind: string; id: string };
  results: Array<{
    work: string;
    mainVersion: string;
    contribution: string;
    revision: string;
    selection: string;
    language: string;
  }>;
  count: { value: number; precision: string };
  next: string | null;
}

test('Realm ranked name/body HTTP pages retain independent selected-language adoptions after a source edit', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through goalctl integration QA');
  const fixture = await authorCreditFixture(
    Bun.env as Record<string, string>,
    resolve('.temp', `catalogue-realm-seek-${randomUUID()}`),
    'openid work:create work:edit work:read space:create realm:adopt semantic:read',
  );
  const alias = `realmname${randomUUID().replaceAll('-', '')}`;
  const phrase = `realmbody${randomUUID().replaceAll('-', '')}`;
  const edited = `realmprivate${randomUUID().replaceAll('-', '')}`;
  try {
    await fixture.grant('space:create:root', 'space.create');
    const space = await fixture.json<{ space: string; realm: string }>(
      await fixture.call('POST', '/v1/spaces', {
        profile: 'space-realm-v1',
        name: 'Ranked Realm seek',
        capabilities: ['realm'],
        actingSubject: fixture.actor,
      }),
      201,
    );
    const expected = new Map<
      string,
      { main: string; contribution: string; revision: string; selection: string }
    >();
    const publish = async (work: string, language: string, body: string) => {
      await fixture.grant(`contribution:create:${work}`, 'contribution.create');
      const draft = await fixture.json<{ contribution: string; draftRevision: string }>(
        await fixture.call('POST', '/v1/contributions', {
          profile: 'text-contribution-v1',
          work,
          language,
          body,
          actingSubject: fixture.actor,
        }),
        201,
      );
      await fixture.grant(`contribution:read:${draft.contribution}`, 'contribution.read');
      await fixture.grant(`contribution:publish:${draft.contribution}`, 'contribution.publish');
      const decision = await fixture.json<{ publicationDecision: string }>(
        await fixture.call('POST', '/v1/contribution-publications', {
          profile: 'text-publication-v1',
          contribution: draft.contribution,
          expectedDraftHead: draft.draftRevision,
          expectedPublicationHead: null,
          rightsBasis: 'original-contribution',
          disclosure: 'public',
          actingSubject: fixture.actor,
        }),
        201,
      );
      return { ...draft, ...decision };
    };
    for (let n = 0; n < 4; n++) {
      const work = await fixture.json<{ work: string; mainVersion: string }>(
        await fixture.call(
          'POST',
          '/v1/works',
          await fixture.authoredBody({
            profile: 'metadata-only-v1',
            title: `${alias} ${n}`,
            language: 'en',
            actingSubject: fixture.actor,
          }),
        ),
        201,
      );
      const main = await publish(work.work, 'en', 'An unrelated globally selected English body');
      await fixture.grant(`publication:select:${work.mainVersion}`, 'publication.select');
      await fixture.json(
        await fixture.call('POST', '/v1/publication-selections', {
          profile: 'main-default-selection-v1',
          context: { kind: 'main-version-default', id: work.mainVersion },
          work: work.work,
          contribution: main.contribution,
          publicationDecision: main.publicationDecision,
          expectedSelectionHead: null,
          selectionBasis: 'main-maintainer',
          actingSubject: fixture.actor,
        }),
        201,
      );
      const adopted = await publish(work.work, 'zh-Hant', `${phrase} 獨立採用版本 ${n}`);
      await fixture.grant(`publication:adopt:${space.realm}`, 'publication.adopt');
      const selection = await fixture.json<{ selection: string }>(
        await fixture.call('POST', '/v1/publication-selections', {
          profile: 'realm-local-selection-v1',
          context: { kind: 'realm-local', id: space.realm },
          work: work.work,
          mainVersion: work.mainVersion,
          contribution: adopted.contribution,
          publicationDecision: adopted.publicationDecision,
          expectedSelectionHead: null,
          selectionBasis: 'realm-manager-review',
          actingSubject: fixture.actor,
        }),
        201,
      );
      expected.set(work.work, {
        main: work.mainVersion,
        contribution: adopted.contribution,
        revision: adopted.draftRevision,
        selection: selection.selection,
      });
    }
    const traverse = async (q: string, language = 'zh-Hant') => {
      const rows: Page['results'] = [];
      let cursor: string | undefined;
      for (let n = 0; n < 40; n++) {
        const query = new URLSearchParams({
          q,
          realm: space.realm,
          language,
          limit: '2',
          ...(cursor ? { cursor } : {}),
        });
        const page = await fixture.json<Page>(
          await fixture.call('GET', `/v1/search/catalogue?${query}`),
          200,
        );
        expect(page.context).toEqual({ kind: 'realm-local', id: space.realm });
        rows.push(...page.results);
        if (!page.next) {
          expect(page.count).toEqual({ value: rows.length, precision: 'exact' });
          return rows;
        }
        expect(page.count.precision).toBe('lower-bound');
        expect(page.next).not.toBe(cursor);
        cursor = page.next;
      }
      throw new Error('Realm ranked continuation did not finish');
    };
    for (const q of [alias, phrase]) {
      const rows = await traverse(q);
      expect(rows).toHaveLength(expected.size);
      expect(new Set(rows.map((row) => row.work)).size).toBe(expected.size);
      for (const row of rows) {
        const owner = expected.get(row.work)!;
        expect(row).toMatchObject({
          mainVersion: owner.main,
          contribution: owner.contribution,
          revision: owner.revision,
          selection: owner.selection,
          language: 'zh-Hant',
        });
      }
    }
    expect(await traverse(alias, 'en')).toEqual([]);
    const first = expected.values().next().value!;
    await fixture.grant(`contribution:edit:${first.contribution}`, 'contribution.edit');
    await fixture.json(
      await fixture.call('POST', '/v1/contribution-edits', {
        profile: 'text-contribution-v1',
        contribution: first.contribution,
        expectedHead: first.revision,
        body: `${edited} 私人新草稿`,
        actingSubject: fixture.actor,
      }),
      200,
    );
    const retained = await traverse(phrase);
    expect(retained).toHaveLength(expected.size);
    expect(retained.find((row) => row.contribution === first.contribution)?.revision).toBe(
      first.revision,
    );
    expect(await traverse(edited)).toEqual([]);
  } finally {
    await fixture.close();
  }
}, 240_000);
