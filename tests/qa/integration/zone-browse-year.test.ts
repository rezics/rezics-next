import { expect, test } from 'bun:test';
import { Pool } from 'pg';
import { createMainApp } from '../../../services/main/src/app.ts';
import { createRealmSpace, spaceCreationDigest } from '../../../services/main/src/modules/space/create.ts';
import { mainSelectionDigest, selectMainDefault } from '../../../services/main/src/modules/work/select-main.ts';
import { realmSelectionDigest, selectRealmLocal } from '../../../services/main/src/modules/work/select-realm.ts';
import { ZoneBrowseProjection } from '../../../services/main/src/modules/zone-browse/store.ts';
import { ensureGlobalClassificationContext } from '../../../services/main/src/modules/classification/global.ts';
import { seedFirstPublicationDate } from '../../../scripts/dev/seed/relation-lexicon.ts';
import { startMediaStack } from './media-support.ts';

const XSD = 'http://www.w3.org/2001/XMLSchema#';
/** The ordinary QA Fuseki class holds a few hundred command writes. A first match past the
 * 256-row request budget needs about 1,800 and is covered by the owner test. */
const MATCHES = 12;
const PAGE = 5;

type Page = {
  items: { id: string }[];
  nextCursor: string | null;
  query: { publicationYear?: string };
  matches: { value: number; kind: string };
  window: { complete: boolean };
};
type Written = { statement: string; revision: string; meaningKey: string };
type Row = { work: string; contribution: string; decision: string; mainVersion: string };

test('Zone year browse pages the accepted Statements of a Realm through the API, with real acceptance', async () => {
  const stack = await startMediaStack('zone-browse-year');
  const relay = new Pool({ connectionString: Bun.env.ACCOUNT_RELAY_DATABASE_URL! });
  try {
    const author = await stack.member('zone-year-editor');
    for (const [scope, action] of [
      ['semantic:create:root', 'semantic.change'],
      [`statement:speak:${author.actor}`, 'statement.record'],
      [`statement:speak:${author.actor}`, 'statement.withdraw'],
      ['classification:decide:global', 'statement.decide'],
    ] as const) await author.grant(scope, action);
    const send = async <T>(method: string, path: string, body: object, key?: string): Promise<T> => {
      const response = await author.send(method, path, body, key);
      const text = await response.text();
      if (!response.ok) throw new Error(`${method} ${path} ${response.status}: ${text.slice(0, 400)}`);
      return JSON.parse(text) as T;
    };
    await ensureGlobalClassificationContext(stack.env);
    const published = await seedFirstPublicationDate({
      post: <T>(path: string, body: object, key: string) => send<T>('POST', path, body, key),
      authorizeDefinition: async receipt => {
        await author.grant(`semantic:read:${receipt.component}`, 'semantic.read');
      },
    }, author.actor);
    const record = (work: string, lexical: string, datatype = `${XSD}date`) =>
      send<Written>('POST', '/v1/statements', {
        profile: 'statement-v1', speaker: { kind: 'personal' }, subject: work,
        predicate: published.component, relationDefinition: published.revision,
        value: { kind: 'literal', lexical, datatype, language: null },
        applicability: [], interpretation: { kind: 'selected' }, evidence: [], actingSubject: author.actor,
      });
    const decide = (target: object, outcome: 'accepted' | 'rejected') =>
      send('POST', '/v1/statement-decisions', {
        profile: 'statement-decision-v1', target, acceptance: { kind: 'global' },
        expectedDecisionHead: null, outcome, actingSubject: author.actor,
      });
    const accept = async (work: string, lexical: string, datatype?: string) => {
      const written = await record(work, lexical, datatype);
      await decide({ kind: 'statement', statement: written.statement }, 'accepted');
      return written;
    };

    const input = { name: `Year browse ${Date.now()}`, actingSubject: author.actor };
    const space = await createRealmSpace(stack.env,
      stack.admission(author.actor, 'space:create:root', 'space.create', spaceCreationDigest(input)), input);
    if (space.outcome !== 'succeeded' || !space.realm) throw new Error('Realm creation failed');
    const realm = space.realm;

    const prepare = async (title: string): Promise<Row> => {
      const created = await stack.catalogueWork(author.actor, title);
      const text = await stack.contribution(created.work, author.actor, 'en', title);
      const selection = { context: { kind: 'main-version-default' as const, id: created.mainVersion },
        work: created.work, contribution: text.contribution, publicationDecision: text.decision,
        expectedSelectionHead: null, selectionBasis: 'main-maintainer' as const, actingSubject: author.actor };
      const selected = await selectMainDefault(stack.env, stack.admission(author.actor,
        `publication:select:${created.mainVersion}`, 'publication.select', mainSelectionDigest(selection)), selection);
      if (selected.outcome !== 'succeeded') throw new Error(`Main selection failed for ${title}`);
      return { work: created.work, contribution: text.contribution, decision: text.decision,
        mainVersion: created.mainVersion };
    };
    const prepared = (titles: string[]) => Promise.all(titles.map(prepare));
    const matching = await prepared(Array.from({ length: MATCHES }, (_, index) => `Year match ${index}`));
    const [qualified, duplicate, unaccepted, rejected, withdrawn, otherYear, undated, textual] =
      await prepared(['qualified', 'duplicate', 'unaccepted', 'rejected', 'withdrawn', 'other year', 'undated',
        'textual date'].map(name => `Year ${name}`)) as [Row, Row, Row, Row, Row, Row, Row, Row];

    for (const [index, row] of matching.entries()) {
      await accept(row.work, index % 2 ? '1995-01-01' : '1995-07-12');
    }
    // The Statement is not accepted itself: its exact meaning is, with the Statement as support.
    const support = await record(qualified.work, '1995-05-05');
    await decide({ kind: 'qualified-fact', meaningKey: support.meaningKey, support: [support.statement] }, 'accepted');
    // Two accepted dates in one year are one browse row.
    await accept(duplicate.work, '1995-03-01');
    await accept(duplicate.work, '1995-06-01');
    await record(unaccepted.work, '1995-02-02');
    const refused = await record(rejected.work, '1995-02-03');
    await decide({ kind: 'statement', statement: refused.statement }, 'rejected');
    const retired = await accept(withdrawn.work, '1995-02-04');
    await send('POST', `/v1/statements/${retired.statement.slice(-36)}/withdrawals`, {
      profile: 'statement-v1', speaker: { kind: 'personal' }, expectedHead: retired.revision,
      actingSubject: author.actor,
    });
    await accept(otherYear.work, '2001-01-01');
    await accept(textual.work, '1995', `${XSD}string`).catch(() => undefined);

    const adopt = async (row: Row) => {
      const adoption = { context: { kind: 'realm-local' as const, id: realm }, work: row.work,
        mainVersion: row.mainVersion, contribution: row.contribution, publicationDecision: row.decision,
        expectedSelectionHead: null, selectionBasis: 'realm-manager-review' as const, actingSubject: author.actor };
      const adopted = await selectRealmLocal(stack.env, stack.admission(author.actor, `publication:adopt:${realm}`,
        'publication.adopt', realmSelectionDigest(adoption)), adoption);
      if (adopted.outcome !== 'succeeded') throw new Error(`Adoption failed for ${row.work}`);
    };
    const groups = [...matching, qualified, duplicate, unaccepted, rejected, withdrawn, otherYear, undated, textual];
    for (const row of groups) await adopt(row);
    // Newest adoption first: the matches in reverse adoption order.
    const expected = [...matching, qualified, duplicate].reverse().map(row => row.work);

    const projection = new ZoneBrowseProjection(stack.accessPool, relay, stack.env);
    await projection.backfill();
    const app = createMainApp(stack.fuseki, {
      ...stack.composition.dependencies,
      zoneBrowse: projection,
      discovery: { active: async () => ({ stale: false }), workTerms: async () => [] } as never,
    });
    const path = `http://main.local/v1/realms/${realm.slice(-36)}/modules/browse`;
    const call = (parameters: Record<string, string>) =>
      app.handle(new Request(`${path}?${new URLSearchParams(parameters)}`));
    const read = async (publicationYear: string, cursor?: string) => {
      const response = await call({ publicationYear, limit: String(PAGE), ...(cursor ? { cursor } : {}) });
      if (response.status !== 200) throw new Error(`${response.status}: ${await response.text()}`);
      return response.json() as Promise<Page>;
    };

    const pages: Page[] = [];
    for (let cursor: string | undefined; pages.length < 10;) {
      const page: Page = await read('1995', cursor);
      pages.push(page);
      expect(page.query.publicationYear).toBe('1995');
      // The count comes from the response that carries the items, not from another read.
      expect(page.matches.value).toBe(pages.reduce((sum, item) => sum + item.items.length, 0));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(pages.map(page => page.items.length)).toEqual([PAGE, PAGE, expected.length - 2 * PAGE]);
    const seen = pages.flatMap(page => page.items.map(item => item.id));
    expect(seen).toEqual(expected);
    expect(pages[0]!.matches).toEqual({ value: PAGE, kind: 'lower-bound' });
    const last = pages.at(-1)!;
    expect(last.matches).toEqual({ value: expected.length, kind: 'exact' });
    expect(last.nextCursor).toBeNull();
    expect(last.window.complete).toBe(true);
    for (const row of [unaccepted, rejected, withdrawn, otherYear, undated, textual]) {
      expect(seen).not.toContain(row.work);
    }
    expect(seen.filter(work => work === duplicate.work)).toHaveLength(1);

    expect((await read('1990-2000')).items.map(item => item.id)).toEqual(pages[0]!.items.map(item => item.id));
    // A year change does not reuse another year's continuation.
    expect((await call({ publicationYear: '2001', cursor: pages[0]!.nextCursor! })).status).toBe(400);
    // The shared Query read admits the same year Facet.
    const post = await app.handle(new Request('http://main.local/v1/query', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ profile: 'filter-document-v2', context: { realm }, scope: { kind: 'realm', realm },
        sort: 'newest', page: { size: PAGE },
        filter: { all: [{ facet: 'publicationYear', range: { min: '01995', max: '1995' } }] } }),
    }));
    if (post.status !== 200) throw new Error(`${post.status}: ${await post.text()}`);
    expect(((await post.json()) as { result: Page }).result.items.map(item => item.id))
      .toEqual(pages[0]!.items.map(item => item.id));
    for (const invalid of ['2000-1990', '10000', '1995) UNION {}']) {
      expect((await call({ publicationYear: invalid })).status).toBe(400);
    }
  } finally {
    await relay.end();
    await stack.stop();
  }
}, 900_000);
