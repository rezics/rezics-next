import type { AgentOption } from '../auth/acting-identity.ts';
import type { StudioChapter, InventoryView, RealmOption, ReviewPage, StudioWork, WorkSubmissions } from './read.ts';
import type { ClassificationPage, ContentsPage, InventoryWork, MainClient, NativeVariants, Submission, WorkHeader }
  from './types.ts';

// Stand-in data and an in-memory Main for Studio stories: the same response
// shapes Main returns, so stories exercise the real components and adapters.

const id = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const position = { dataEpoch: 'story', sequence: '42' };
const at = (day: number) => `2026-09-${String(day).padStart(2, '0')}T10:00:00.000Z`;
/** The stories' clock: relative times read against it stay stable. */
export const now = Date.parse('2026-09-28T12:00:00.000Z');

export const agents: AgentOption[] = [
  { iri: id(1), label: 'Lin Mei 林梅', handle: null, kind: 'person', path: 'represented-agent' },
  { iri: id(2), label: '月下书生 · Moonlit Scribe', handle: null, kind: 'pen-name', path: 'represented-agent' },
  { iri: id(3), label: null, handle: null, kind: 'person', path: 'represented-agent' },
];

const cover = (key: string) => ({ kind: 'fallback' as const, policy: 'avatar-fallback-v1', key, resourceType: 'work' });
const types = { book: ['https://schema.org/Book'], document: ['https://schema.org/DigitalDocument'],
  recipe: ['https://schema.org/Recipe'], chapter: [] as string[] };

export const ids = { serial: id(101), story: id(103), recipe: id(104), chapters: [id(111), id(112), id(113)],
  realms: [id(401), id(402), id(403)], texts: { story: id(201), recipe: id(202), serial: id(203) } };

function item(n: number, work: string, title: string, language: string, kind: keyof typeof types, state: InventoryWork['state'],
  extra: Partial<InventoryWork> = {}): InventoryWork {
  return { id: work, mainVersion: id(600 + n), workRevision: id(700 + n), mainRevision: id(800 + n),
    title: { value: title, language }, relationship: 'authored', cover: cover(`key-${n}`), types: types[kind],
    disclosure: 'restricted', state,
    texts: [], submissions: [], createdAt: at(10 + n), updatedAt: at(20 + n), ...extra } as InventoryWork;
}

const text = (contribution: string, language: string, draftHead: string, published: boolean) => ({ contribution, language,
  draftHead, publicationHead: published ? id(950) : null, publicationDraft: published ? draftHead : null });

export const inventory: InventoryView = {
  page: { items: [
    item(1, ids.serial, '雨夜书店', 'zh-hans', 'book', 'published', { disclosure: 'public',
      texts: [text(ids.texts.serial, 'zh-Hans', id(303), true)],
      submissions: [{ id: id(501).slice(-36), realm: ids.realms[1]!, state: 'pending', openedAt: at(24), updatedAt: at(25) }] }),
    item(3, ids.story, 'The Cartographer of Tides', 'en', 'document', 'draft',
      { texts: [text(ids.texts.story, 'en', id(301), false)] }),
    item(4, ids.recipe, 'Ginger lemon tea', 'en', 'recipe', 'published', { disclosure: 'public',
      texts: [text(ids.texts.recipe, 'en', id(302), true)] }),
  ], nextCursor: null, sourcePosition: position, count: { value: 3, kind: 'exact-page', total: null } } as never,
  books: { [ids.serial]: { count: 3, more: false, published: 2 } },
};

/** Works the Agent imported or curates: other people wrote them, so Studio only opens them. */
export const curated: InventoryView = {
  page: { items: [
    item(5, id(105), 'Pride and Prejudice', 'en', 'book', 'published', { relationship: 'curated', disclosure: 'public',
      texts: [text(id(205), 'en', id(305), true)] }),
    item(6, id(106), '西游记', 'zh-hans', 'book', 'published', { relationship: 'curated', disclosure: 'public' }),
  ], nextCursor: null, sourcePosition: position, count: { value: 2, kind: 'exact-page', total: null } } as never,
  books: {},
};

const submission = (n: number, work: string, realm: string, state: Submission['state'], publicReason: string | null = null):
  Submission => ({ id: id(500 + n).slice(-36), realm, kind: 'contribution', work, mainVersion: id(601), target: null,
  contribution: ids.texts.serial, publicationDecision: id(950), selectedDraft: id(303), correctionOf: null,
  submittingAgent: agents[0]!.iri, state, revision: id(800 + n).slice(-36), generation: '1', reviewer: null, publicReason,
  selection: null, adoptionReceipt: null, openedAt: at(20 + n), updatedAt: at(22 + n) });

export const realmInfo = {
  [ids.realms[0]!]: { name: 'Classic Literature · 经典文学', language: 'en', reviewMode: 'mandatory' as const },
  [ids.realms[1]!]: { name: '中文网络小说 · Chinese Web Fiction', language: 'zh-Hans', reviewMode: 'trusted-members' as const },
  [ids.realms[2]!]: { name: 'Open Shelf · 开放书架', language: 'en', reviewMode: 'open' as const },
};

export const submissions: Submission[] = [
  submission(1, ids.serial, ids.realms[1]!, 'pending'),
  submission(2, ids.serial, ids.realms[0]!, 'changes-requested', 'Please add a content note for the opening chapter.'),
  submission(3, ids.recipe, ids.realms[2]!, 'accepted'),
];

export const review: ReviewPage = {
  submissions: { ok: true, data: { items: submissions, nextCursor: null } },
  realms: realmInfo,
  works: { [ids.serial]: { value: '雨夜书店', language: 'zh-Hans' }, [ids.recipe]: { value: 'Ginger lemon tea', language: 'en' } },
};

export const realmOptions: RealmOption[] = ids.realms.map(realm => ({ id: realm, space: id(410), name: {
  value: realmInfo[realm]!.name, language: realmInfo[realm]!.language }, icon: null, description: null,
membership: { count: { kind: 'unknown' } }, links: { realm: `/v1/realms/${realm.slice(-36)}` },
reviewMode: realmInfo[realm]!.reviewMode })) as unknown as RealmOption[];

export function workHeader(work: string, title: string, language: string, kind: keyof typeof types,
  extra: Partial<WorkHeader> = {}): WorkHeader {
  return { profile: 'work-read-v1', id: work, revision: id(901), mainVersion: id(601),
    title: { value: title, language, direction: 'ltr', basis: 'requested' }, cover: cover(work), types: types[kind],
    tagline: null, completionStatus: null, chapterCount: null, wordCount: null, lastUpdatedAt: null,
    disclosure: 'restricted', description: null, metadataRevision: null, originalTitle: null,
    mainVersionRevision: id(902), mainVersionLabel: null, selectedLanguage: language, sourcePosition: position,
    links: {}, ...extra } as unknown as WorkHeader;
}

export const serial: StudioWork = {
  header: workHeader(ids.serial, '雨夜书店', 'zh-hans', 'book', { disclosure: 'public', completionStatus: 'ongoing',
    tagline: { value: '一封没有地址的信，把雨夜书店带向二十年前的秘密。', language: 'zh-hans', direction: 'ltr',
      basis: 'requested' } } as never),
  metadata: { ok: true, data: { work: ids.serial, revision: id(903), originalTitle: null, completionStatus: 'ongoing',
    localized: [{ language: 'zh-Hans', title: null, description: '雨夜里，一家书店和一封没有地址的信。', mainVersionLabel: null,
      tagline: '一封没有地址的信，把雨夜书店带向二十年前的秘密。' }], sourcePosition: position } as never },
};

export const story: StudioWork = {
  header: workHeader(ids.story, 'The Cartographer of Tides', 'en', 'document'),
  metadata: { ok: true, data: { work: ids.story, revision: null, originalTitle: null, completionStatus: null,
    localized: [], sourcePosition: position } as never },
};

const chapter = (n: number, title: string | null, available: boolean): ContentsPage['items'][number] => ({
  occurrence: id(1100 + n), parent: id(1000), role: 'chapter', label: title ? { value: title, language: 'zh-Hans' } : null,
  target: title ? ids.chapters[n - 1]! : null, selectedRevision: null, progress: null,
  availability: available ? 'available' : 'unavailable' });

export const contents: ContentsPage = { profile: 'work-contents-v1', work: ids.serial, version: id(601),
  composition: id(1000), compositionRevision: id(1001), language: 'zh-hans',
  items: [chapter(1, '第一章 雨夜', true), chapter(2, '第二章 未寄出的信', true), chapter(3, '第三章 最后一班车', false),
    chapter(4, null, false)],
  nextCursor: null, sourcePosition: position, count: { value: 4, kind: 'exact-page', total: null } } as ContentsPage;

export const publishedTexts: NativeVariants['variants'] = [{ contribution: ids.texts.serial, publicationDecision: id(950),
  selectedDraft: id(303), language: 'zh-Hans', author: agents[0]!.iri }] as NativeVariants['variants'];

export const history: WorkSubmissions = { submissions: { ok: true, data: submissions.filter(item => item.work === ids.serial) },
  realms: realmInfo };

export const tags: ClassificationPage = { items: [
  { sense: id(1201), concept: id(1211), name: { value: 'Mystery · 悬疑', language: 'en' } },
  { sense: id(1202), concept: id(1212), name: { value: 'Slice of life · 日常', language: 'en' } },
], scope: { kind: 'global' }, nextCursor: null, sourcePosition: position,
count: { value: 2, kind: 'exact-page', total: null } } as unknown as ClassificationPage;

export const chapterOpened = (body = '', head: string | null = null): StudioChapter => ({
  chapter: { id: ids.chapters[2]!, title: { value: '第三章 最后一班车', language: 'zh-Hans' }, language: 'zh-Hans',
    direction: 'ltr' }, variant: `urn:rezics:variant:${id(1300).slice(-36)}`, basis: head ? 'address' : 'none', head,
  body, digest: head ? 'a'.repeat(64) : null, epoch: head ? 'story-epoch' : null, publication: null, eligibility: null });

type Answer = { data: unknown; error: { status: number; value: unknown } | null };
const ok = (data: unknown): Answer => ({ data, error: null });
const fail = (status: number, code: string, extra: Record<string, unknown> = {}): Answer =>
  ({ data: null, error: { status, value: { code, status, ...extra } } });

export interface StoryMainOptions {
  /** Saves fail as if the network were down. */
  offline?: () => boolean;
  /** Answers for publication, Main selection, Realm submission and chapter commands. */
  publish?: 'ok' | 'denied' | 'stale';
  select?: 'ok' | 'denied';
  submit?: 'ok' | 'denied' | 'accepted';
  chapters?: 'ok' | 'denied';
  delayMs?: number;
}

/**
 * An in-memory Main for one Agent: texts (create, edit on the expected head,
 * exact draft reads, head reads, publish), chapter Content drafts (409
 * `stale_head` naming the current head, exact revision reads, publication and
 * search eligibility), a Book's composition (create, insert, move) and Realm
 * submissions. `writeElsewhere` and `writeChapterElsewhere` stand in for a
 * second tab or device.
 */
export function storyMain(options: StoryMainOptions = {}) {
  let sequence = 1000;
  const next = () => id(++sequence);
  const texts = new Map<string, { head: string; body: string; language: string; work: string; publication: string | null }>();
  const drafts = new Map<string, string>();
  const variants = new Map<string, { head: string; publication: string | null; eligibility: string | null }>();
  const revisions = new Map<string, { resource: string; variant: string; body: string }>();
  const structures = new Map<string, { head: string; book: string; items: Array<{ occurrence: string; target: string;
    label: { value: string; language: string } }> }>();
  const calls: string[] = [];
  const wait = () => new Promise(resolve => setTimeout(resolve, options.delayMs ?? 30));
  const offline = async () => {
    await wait();
    if (options.offline?.()) throw new TypeError('Failed to fetch');
  };
  const recordText = (text: string, body: string, language: string, work: string) => {
    const head = next();
    texts.set(text, { head, body, language, work, publication: texts.get(text)?.publication ?? null });
    drafts.set(head, body);
    return head;
  };
  const recordDraft = (resource: string, variant: string, body: string) => {
    const revision = next().slice(-36);
    const current = variants.get(variant);
    variants.set(variant, { head: revision, publication: current?.publication ?? null, eligibility: current?.eligibility ?? null });
    revisions.set(revision, { resource, variant, body });
    return revision;
  };
  const contributions = Object.assign((params: { contribution: string }) => {
    const text = `https://rezics.com/id/${params.contribution}`;
    return {
      get: async () => {
        await wait();
        const current = texts.get(text);
        return current ? ok({ contribution: text, work: current.work, language: current.language, author: agents[0]!.iri,
          draftHead: current.head, publicationHead: current.publication }) : fail(404, 'contribution_unavailable');
      },
      drafts: (path: { revision: string }) => ({ get: async () => {
        await wait();
        const revision = `https://rezics.com/id/${path.revision}`;
        const current = texts.get(text);
        const body = drafts.get(revision);
        return body === undefined || !current ? fail(404, 'revision_unavailable') : ok({ contribution: text, revision,
          work: current.work, author: agents[0]!.iri, language: current.language, body, sourcePosition: position });
      } }),
    };
  }, { post: async (body: { work: string; language: string; body: string }) => {
    await offline();
    calls.push('create');
    const text = next();
    return ok({ contribution: text, draftRevision: recordText(text, body.body, body.language, body.work), work: body.work,
      language: body.language, author: agents[0]!.iri, sourcePosition: position, replayed: false });
  } });
  const compositions = Object.assign((params: { id: string }) => ({ changes: { post: async (body: {
    expectedHead: string; operations: Array<{ op: string; occurrence?: string; target?: string;
      label?: { value: string; language: string }; position: 'first' | 'last' | { after: string } }> }) => {
    await wait();
    const structure = structures.get(`https://rezics.com/id/${params.id}`);
    if (options.chapters === 'denied') return fail(403, 'authority_denied');
    if (!structure) return fail(404, 'composition_unavailable');
    if (structure.head !== body.expectedHead) return fail(409, 'stale_composition_head');
    const occurrences: string[] = [];
    for (const operation of body.operations) {
      if (operation.op === 'insert') {
        calls.push('insert');
        const occurrence = next();
        occurrences.push(occurrence);
        structure.items.push({ occurrence, target: operation.target!, label: operation.label! });
      } else if (operation.op === 'move') {
        calls.push('move');
        const from = structure.items.findIndex(entry => entry.occurrence === operation.occurrence);
        const [moved] = structure.items.splice(from, 1);
        const after = operation.position === 'first' ? -1 : typeof operation.position === 'object'
          ? structure.items.findIndex(entry => entry.occurrence === (operation.position as { after: string }).after)
          : structure.items.length - 1;
        structure.items.splice(after + 1, 0, moved!);
      }
    }
    structure.head = next();
    return ok({ structure: `https://rezics.com/id/${params.id}`, revision: structure.head, expectedHead: body.expectedHead,
      receipt: 'urn:rezics:receipt:story', replayed: false, occurrences, sourcePosition: position });
  } } }), { post: async (body: { work: string }) => {
    await wait();
    if (options.chapters === 'denied') return fail(403, 'authority_denied');
    calls.push('composition');
    const structure = next();
    structures.set(structure, { head: next(), book: body.work, items: [] });
    return ok({ structure, mainVersion: id(601), revision: structures.get(structure)!.head, receipt: 'urn:rezics:receipt:story',
      replayed: false, sourcePosition: position });
  } });
  const works = Object.assign((params: { id: string }) => ({ contents: { get: async () => {
    await wait();
    const found = [...structures.entries()].find(([, value]) => value.book === `https://rezics.com/id/${params.id}`);
    if (!found) return fail(404, 'work_unavailable');
    return ok({ ...contents, items: found[1].items.map(entry => ({ occurrence: entry.occurrence, parent: found[0],
      role: 'chapter', label: entry.label, target: entry.target, selectedRevision: null, progress: null,
      availability: 'unavailable' })), composition: found[0], compositionRevision: found[1].head });
  } } }), { post: async () => {
    await wait();
    calls.push('work');
    return ok({ work: next(), mainVersion: next(), workRevision: next(), mainRevision: next(), sourcePosition: position,
      replayed: false });
  } });
  const main = { v1: {
    contributions,
    compositions,
    works,
    'contribution-edits': { post: async (body: { contribution: string; expectedHead: string; body: string }) => {
      await offline();
      calls.push('edit');
      const current = texts.get(body.contribution);
      if (!current) return fail(404, 'contribution_unavailable');
      if (current.head !== body.expectedHead) return fail(409, 'stale_head', { currentHead: current.head });
      const predecessor = current.head;
      return ok({ contribution: body.contribution, draftRevision: recordText(body.contribution, body.body, current.language,
        current.work), predecessor, sourcePosition: position, replayed: false });
    } },
    'contribution-publications': { post: async (body: { contribution: string; expectedDraftHead: string }) => {
      await wait();
      calls.push('publish');
      if (options.publish === 'denied') return fail(403, 'authority_denied');
      if (options.publish === 'stale') return fail(409, 'stale_head');
      const decision = next();
      const current = texts.get(body.contribution);
      if (current) current.publication = decision;
      return ok({ contribution: body.contribution, publicationDecision: decision, selectedDraft: body.expectedDraftHead,
        predecessor: null, sourcePosition: position, replayed: false });
    } },
    'main-versions': () => ({ selection: { get: async () => { await wait(); return fail(404, 'selection_unavailable'); } } }),
    'publication-selections': { post: async () => {
      await wait();
      calls.push('select');
      return options.select === 'denied' ? fail(403, 'authority_denied')
        : ok({ selection: next(), replayed: false, sourcePosition: position });
    } },
    realms: () => ({ submissions: { post: async () => {
      await wait();
      calls.push('submit');
      if (options.submit === 'denied') return fail(403, 'authority_denied');
      return ok({ submission: { state: options.submit === 'accepted' ? 'accepted' : 'pending' }, replayed: false });
    } } }),
    'content-drafts': { post: async (body: { resourceId: string; variantId: string; expectedHead: string | null;
      body: string }) => {
      await offline();
      calls.push('draft');
      const current = variants.get(body.variantId)?.head ?? null;
      if (current !== body.expectedHead) return fail(409, 'stale_head', { currentHead: current });
      const revision = recordDraft(body.resourceId, body.variantId, body.body);
      return ok({ resourceId: body.resourceId, variantId: body.variantId, revisionId: revision, predecessor: current,
        byteDigest: 'b'.repeat(64), sourcePosition: { owner: 'content', dataEpoch: 'story-epoch', sequence: '1' },
        replayed: false });
    } },
    'content-revisions': (params: { revision: string }) => ({ get: async () => {
      await wait();
      const revision = revisions.get(params.revision);
      return revision ? ok({ reference: { owner: 'content', resourceId: revision.resource, variantId: revision.variant,
        revisionId: params.revision, byteDigest: 'b'.repeat(64) }, serializedJson: '', body: { body: revision.body } })
        : fail(404, 'revision_unavailable');
    } }),
    'content-publications': { post: async (body: { variantId: string; revisionId: string;
      expectedPublicationHead: string | null }) => {
      await wait();
      calls.push('publish-chapter');
      if (options.publish === 'denied') return fail(403, 'authority_denied');
      const variant = variants.get(body.variantId);
      if (!variant || variant.head !== body.revisionId) return fail(409, 'content_conflict');
      if ((variant.publication ?? null) !== body.expectedPublicationHead) {
        return ok({ status: 'rejected', receipt: 'urn:rezics:receipt:story', decision: null, graphDataEpoch: null,
          graphSequence: null, replayed: false });
      }
      variant.publication = `urn:rezics:content-publication:${next().slice(-12)}`;
      return ok({ status: 'active', receipt: 'urn:rezics:receipt:story', decision: variant.publication,
        graphDataEpoch: 'story', graphSequence: '1', replayed: false });
    } },
    'content-search-eligibility': { post: async (body: { variantId: string; expectedEligibilityHead: string | null }) => {
      await wait();
      calls.push('eligibility');
      const variant = variants.get(body.variantId);
      if (!variant || (variant.eligibility ?? null) !== body.expectedEligibilityHead) return fail(409, 'content_conflict');
      variant.eligibility = `urn:rezics:content-search-eligibility:${next().slice(-12)}`;
      return ok({ outcome: 'succeeded', decision: variant.eligibility, receipt: 'urn:rezics:receipt:story',
        graphDataEpoch: 'story', graphSequence: '1', replayed: false });
    } },
  } };
  return {
    main: main as unknown as MainClient,
    calls,
    /** Seeds an existing text and returns its head. */
    seed: (text: string, body: string, language: string, work: string) => recordText(text, body, language, work),
    /** Seeds a chapter's draft and returns its head (a bare revision ID, as Content names them). */
    seedChapter: (chapter: string, variant: string, body: string) => recordDraft(chapter, variant, body),
    /** Seeds a Book's composition with chapters. */
    seedBook: (book: string, chapters: Array<{ target: string; title: string }>) => {
      const structure = next();
      structures.set(structure, { head: next(), book, items: chapters.map(entry => ({ occurrence: next(),
        target: entry.target, label: { value: entry.title, language: 'zh-Hans' } })) });
      return structure;
    },
    /** Another tab or device saves a newer version. */
    writeElsewhere: (text: string, body: string) => {
      const current = texts.get(text);
      if (current) recordText(text, body, current.language, current.work);
    },
    writeChapterElsewhere: (chapter: string, variant: string, body: string) => recordDraft(chapter, variant, body),
    head: (text: string) => texts.get(text)?.head ?? null,
    chapterHead: (variant: string) => variants.get(variant)?.head ?? null,
    book: (book: string) => [...structures.values()].find(value => value.book === book),
  };
}
