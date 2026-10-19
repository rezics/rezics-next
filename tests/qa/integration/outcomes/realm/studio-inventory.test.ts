import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import declaration from '../../../../../scripts/qa/cases/outcomes/realm/studio-inventory.ts';
import { outcomeTest } from '../../../support/outcome-test.ts';
import { type PersonaName } from '../../../support/personas.ts';
import { authorManagementManifest, bookType, buildAuthorManagementCorpus,
  restoreAuthorManagementCorpus, short } from '../../../support/author-management-fixture.ts';

type Item = { id: string; title: { value: string; language: string }; types: string[];
  relationship: string; state: string; createdAt: string; updatedAt: string;
  chapterCount: { value: number; complete: boolean } | null };
type Page = { items: Item[]; nextCursor: string | null;
  count: { value: number; kind: string; total: null } };
type Chapters = { page: { items: { occurrence: string; role: string; target: string | null;
  childCount: number | null }[]; nextCursor: string | null;
  count: { value: number; kind: string; total: null } } };
let fixture: Awaited<ReturnType<typeof restoreAuthorManagementCorpus>>;
setDefaultTimeout(120_000);
const preparing = Bun.env.AUTHOR_MANAGEMENT_PREPARE === '1';
if (preparing) {
  test('AMGT00: retains one command-created author-management corpus', buildAuthorManagementCorpus, 600_000);
}
describe('AMGT01:', () => {
  beforeAll(async () => { fixture = await restoreAuthorManagementCorpus(); }, 600_000);
  afterAll(async () => { await fixture?.close(); });
  const path = (agent: string) => `/v1/me/agents/${short(agent)}/works`;
  const query = (fields: Record<string, string> = {}) => new URLSearchParams({
    q: 'Studio needle', sort: 'title', state: 'empty', type: bookType, view: 'authored', limit: '5', ...fields,
  });
  async function read(name: PersonaName, agent: string, fields: Record<string, string> = {}) {
    const response = await fixture.sessions[name].main('GET', `${path(agent)}?${query(fields)}`);
    return { status: response.status, raw: await response.text() };
  }
  function compare(sort: string, left: Item, right: Item): number {
    const a = left.title.value.normalize('NFKC').toLowerCase(), b = right.title.value.normalize('NFKC').toLowerCase();
    const key = sort === 'title'
      ? Buffer.compare(Buffer.from(a), Buffer.from(b))
      : Date.parse(sort === 'recent' ? right.updatedAt : right.createdAt)
        - Date.parse(sort === 'recent' ? left.updatedAt : left.createdAt);
    return key || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  }
  async function traverse(sort: string) {
    const items: Item[] = [], failures: string[] = [];
    let cursor: string | null = null, pages = 0;
    do {
      const response = await read('owner', fixture.sessions.owner.actingSubject!, {
        sort, ...(cursor ? { cursor } : {}),
      });
      if (response.status !== 200) { failures.push(`page ${pages}: HTTP ${response.status} ${response.raw}`); break; }
      const page = JSON.parse(response.raw) as Page;
      if (page.count.value !== page.items.length || page.count.kind !== 'exact-page' || page.count.total !== null)
        failures.push(`dishonest page count: ${JSON.stringify(page.count)}`);
      items.push(...page.items);
      cursor = page.nextCursor;
      if (++pages > 12) { failures.push('continuation did not terminate within corpus bound'); break; }
    } while (cursor);
    return { items, pages, failures };
  }

  async function inventoryPersona(name: PersonaName) {
    const { sessions, metadata } = fixture, person = sessions[name], owner = sessions.owner;
    if (name === 'visitor') {
      const response = await person.main('GET', path(owner.actingSubject!));
      const raw = await response.text();
      expect(response.status, raw).toBe(401);
      expect(raw).not.toContain(metadata.inventory.foreign.work);
      expect(raw).not.toContain(metadata.inventory.matching[0]!.title);
      const chapters = await person.main('GET', `${path(owner.actingSubject!)}/${short(metadata.book.work)}/chapters`);
      expect(chapters.status, await chapters.text()).toBe(401);
      return;
    }
    if (name !== 'owner') {
      const denied = await person.main('GET', path(owner.actingSubject!));
      const raw = await denied.text();
      expect(denied.status, raw).toBe(403);
      expect(raw).not.toContain(metadata.inventory.matching[0]!.work);
      expect(raw).not.toContain(metadata.inventory.matching[0]!.title);
    }
    const response = await read(name, person.actingSubject!);
    // This is an outcome assertion in the persona body, not a setup failure.
    expect(response.status, response.raw).toBe(200);
    const page = JSON.parse(response.raw) as Page;
    for (const item of page.items) {
      expect(item.types).toContain(bookType);
      expect(item.state).toBe('empty');
      expect(item.chapterCount).toEqual({ value: 0, complete: true });
      expect(item.relationship).toBe('authored');
      expect(item.title.value.toLowerCase()).toContain('studio needle');
      expect(item.id).not.toBe(metadata.inventory.alternate.work);
    }
    if (name === 'owner') {
      const all = await traverse('title');
      expect(all.failures).toEqual([]);
      expect(all.pages).toBeGreaterThan(1);
      expect(all.items).toHaveLength(23);
      expect(new Set(all.items.map(item => item.id)).size).toBe(23);
      expect(all.items.map(item => item.id).sort()).toEqual(metadata.inventory.matching.map(item => item.work).sort());
      expect(all.items).toEqual([...all.items].sort((a, b) => compare('title', a, b)));
      const exactTitle = metadata.inventory.matching[0]!.title;
      const exact = await read(name, owner.actingSubject!, { q: exactTitle });
      expect(exact.status, exact.raw).toBe(200);
      expect((JSON.parse(exact.raw) as Page).items.map(item => item.id).sort())
        .toEqual(metadata.inventory.matching.slice(0, 2).map(item => item.work).sort());
      const normalized = await read(name, owner.actingSubject!, { q: '  ＳＴＵＤＩＯ ＮＥＥＤＬＥ  ' });
      expect(normalized.status, normalized.raw).toBe(200);
      expect((JSON.parse(normalized.raw) as Page).items).toEqual(page.items);
      const cjk = await read(name, owner.actingSubject!, { q: '再会' });
      expect(cjk.status, cjk.raw).toBe(200);
      expect((JSON.parse(cjk.raw) as Page).items.map(item => item.id).sort())
        .toEqual(metadata.inventory.matching.slice(0, 2).map(item => item.work).sort());
      const empty = await read(name, owner.actingSubject!, { q: 'no matching original title' });
      expect(empty.status, empty.raw).toBe(200);
      expect(JSON.parse(empty.raw)).toMatchObject({ items: [], nextCursor: null,
        count: { value: 0, kind: 'exact-page', total: null } });
    } else {
      expect(page.items.map(item => item.id)).toEqual(name === 'member' ? [metadata.inventory.foreign.work] : []);
    }
  }
  outcomeTest(declaration, 'visitor', () => inventoryPersona('visitor'));
  outcomeTest(declaration, 'stranger', () => inventoryPersona('stranger'));
  outcomeTest(declaration, 'member', () => inventoryPersona('member'));
  outcomeTest(declaration, 'owner', () => inventoryPersona('owner'));
  outcomeTest(declaration, 'moderator', () => inventoryPersona('moderator'));
  outcomeTest(declaration, 'operator', () => inventoryPersona('operator'));

  test.failing('AMGT01 Studio recent created and title sorts are stable across every page', async () => {
    const sorted = new Map<string, Item[]>();
    for (const sort of ['recent', 'created', 'title']) {
      const first = await traverse(sort);
      expect(first.failures).toEqual([]);
      expect(first.pages).toBeGreaterThan(1);
      expect(first.items.map(item => item.id).sort()).toEqual(fixture.metadata.inventory.matching.map(item => item.work).sort());
      expect(first.items).toEqual([...first.items].sort((a, b) => compare(sort, a, b)));
      const replay = await traverse(sort);
      expect(replay.failures).toEqual([]);
      expect(replay.items).toEqual(first.items);
      sorted.set(sort, first.items);
    }
    expect(sorted.get('recent')!.map(item => item.id)).not.toEqual(sorted.get('created')!.map(item => item.id));
    expect(sorted.get('title')!.map(item => item.id)).not.toEqual(sorted.get('created')!.map(item => item.id));
  });

  test.failing('AMGT01 Studio continuations bind query sort filters page size and controlled acting Agent', async () => {
    const { metadata, sessions } = fixture, agent = sessions.owner.actingSubject!;
    const first = await read('owner', agent);
    expect(first.status, first.raw).toBe(200);
    const cursor = (JSON.parse(first.raw) as Page).nextCursor;
    expect(cursor).toBeString();
    const same = await read('owner', agent, { cursor: cursor! });
    expect(same.status, same.raw).toBe(200);
    expect((JSON.parse(same.raw) as Page).items.map(item => item.id))
      .not.toEqual((JSON.parse(first.raw) as Page).items.map(item => item.id));
    for (const fields of [{ q: 'different' }, { sort: 'created' }, { state: 'draft' },
      { type: 'https://schema.org/Recipe' }, { view: 'curated' }, { limit: '6' }]) {
      const response = await read('owner', agent, { ...fields, cursor: cursor! });
      expect(response.status, `${JSON.stringify(fields)}: ${response.raw}`).toBe(400);
      expect(JSON.parse(response.raw)).toMatchObject({ code: 'invalid_read' });
    }
    const alternate = await read('owner', metadata.inventory.alternateAgent, { cursor: cursor! });
    expect(alternate.status, alternate.raw).toBe(400);
    const alternateFirst = await read('owner', metadata.inventory.alternateAgent);
    expect(alternateFirst.status, alternateFirst.raw).toBe(200);
    expect((JSON.parse(alternateFirst.raw) as Page).items.map(item => item.id)).toEqual([metadata.inventory.alternate.work]);
    const borrowed = await read('member', agent, { cursor: cursor! });
    expect(borrowed.status, borrowed.raw).toBe(403);
    expect(borrowed.raw).not.toContain(metadata.inventory.matching[0]!.title);
    const curated = await read('owner', agent, { view: 'curated' });
    expect(curated.status, curated.raw).toBe(200);
    expect((JSON.parse(curated.raw) as Page).items).toEqual([]);
  });

  test.failing('AMGT01 Studio counts nested and paginated chapter occurrences without counting groups', async () => {
    const { metadata, sessions } = fixture, agent = sessions.owner.actingSubject!;
    const detailResponse = await sessions.owner.main('GET', `${path(agent)}/${short(metadata.book.work)}`);
    const raw = await detailResponse.text();
    expect(detailResponse.status, raw).toBe(200);
    const detail = JSON.parse(raw) as { item: Item };
    expect(detail.item.chapterCount).toEqual({ value: 23, complete: true });
    const listed = await read('owner', agent, { q: metadata.book.title, state: 'published' });
    expect(listed.status, listed.raw).toBe(200);
    expect((JSON.parse(listed.raw) as Page).items).toEqual([expect.objectContaining({
      id: metadata.book.work, chapterCount: { value: metadata.chapterCount, complete: true },
    })]);
    const chapters: string[] = [], visited = new Set<string>();
    let pageCount = 0;
    const parents = [metadata.composition.structure];
    for (const parent of parents) {
      expect(visited.has(parent)).toBe(false);
      visited.add(parent);
      let cursor: string | null = null;
      do {
        const fields = new URLSearchParams({ parent, language: 'en', ...(cursor ? { cursor } : {}) });
        const response = await sessions.owner.main('GET', `${path(agent)}/${short(metadata.book.work)}/chapters?${fields}`);
        const text = await response.text();
        expect(response.status, text).toBe(200);
        const { page } = JSON.parse(text) as Chapters;
        expect(++pageCount).toBeLessThan(10);
        expect(page.count).toEqual({ value: page.items.length, kind: 'exact-page', total: null });
        for (const item of page.items) {
          if (item.role === 'group') parents.push(item.occurrence);
          else if (item.role === 'chapter') chapters.push(item.occurrence);
        }
        cursor = page.nextCursor;
      } while (cursor);
    }
    expect(visited.has(metadata.chapterGroup)).toBe(true);
    expect(pageCount).toBeGreaterThan(3);
    expect(new Set(chapters).size).toBe(23);
    expect(chapters).toHaveLength(23);
    const recipeDetail = await sessions.owner.main('GET', `${path(agent)}/${short(metadata.inventory.otherType.work)}`);
    expect(recipeDetail.status, await recipeDetail.clone().text()).toBe(200);
    expect((await recipeDetail.json() as { item: Item }).item.chapterCount).toBeNull();
    console.info('Author-management count corpus', authorManagementManifest);
  });

  test.failing('AMGT01 Studio rejects a continuation whose valid inventory source basis moved', async () => {
    const { metadata, sessions } = fixture, owner = sessions.owner;
    const first = await read('owner', owner.actingSubject!);
    expect(first.status, first.raw).toBe(200);
    const cursor = (JSON.parse(first.raw) as Page).nextCursor;
    expect(cursor).toBeString();
    const work = metadata.inventory.matching[0]!;
    const edited = await owner.main('POST', '/v1/content-edits', { profile: 'metadata-only-v1',
      work: work.work, expectedHead: work.workRevision, title: `${work.title} corrected`,
      actingSubject: owner.actingSubject });
    const raw = await edited.text();
    expect(edited.status, raw).toBe(200);
    expect(JSON.parse(raw)).toMatchObject({ work: work.work, predecessor: work.workRevision });
    const continued = await read('owner', owner.actingSubject!, { cursor: cursor! });
    expect(continued.status, continued.raw).toBe(409);
    expect(JSON.parse(continued.raw)).toMatchObject({ code: 'read_basis_changed' });
    const refreshed = await read('owner', owner.actingSubject!, { q: `${work.title} corrected` });
    expect(refreshed.status, refreshed.raw).toBe(200);
    expect((JSON.parse(refreshed.raw) as Page).items).toContainEqual(expect.objectContaining({
      id: work.work, title: expect.objectContaining({ value: `${work.title} corrected` }),
    }));
  });
});
