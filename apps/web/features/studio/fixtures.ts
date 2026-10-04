import type { AgentOption } from '../auth/acting-identity.ts';
import type { StudioChapter, InventoryView, RealmOption, ReviewPage, StudioWork, WorkSubmissions } from './read.ts';
import type { ClassificationPage, ContentsPage, InventoryWork, MainClient, NativeVariants, Submission, WorkHeader }
  from './types.ts';
import { documentText, parseDocument, type DocumentSnapshot } from '@rezics/document';

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
  division: null, number: n, childCount: null,
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
interface FixtureBody { body: string; document?: DocumentSnapshot }
interface FixtureBodyInput { body?: string; document?: DocumentSnapshot }
const bodyOf = (input: FixtureBodyInput): FixtureBody => {
  if ((input.body === undefined) === (input.document === undefined)) throw new TypeError('one body or document is required');
  if (!input.document) return { body: input.body! };
  const document = parseDocument(structuredClone(input.document));
  return { body: documentText(document), document };
};
const seedBody = (body: string | DocumentSnapshot) => bodyOf(typeof body === 'string' ? { body } : { document: body });

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
  const texts = new Map<string, FixtureBody & { head: string; language: string; work: string; publication: string | null }>();
  const drafts = new Map<string, FixtureBody>();
  const publications = new Map<string, { text: string; revision: string }>();
  const selections = new Map<string, { selection: string; work: string; text: string; revision: string }>();
  const variants = new Map<string, { head: string; publication: string | null; eligibility: string | null;
    resource: string }>();
  const revisions = new Map<string, FixtureBody & { resource: string; variant: string }>();
  const structures = new Map<string, Outline>();
  const calls: string[] = [];
  const backup = () => structuredClone({ sequence, texts, drafts, publications, selections, variants, revisions, structures });
  let baseline: ReturnType<typeof backup> | undefined;
  function restoreMap<K, V>(target: Map<K, V>, saved: Map<K, V>) {
    target.clear();
    for (const [key, value] of saved) target.set(key, value);
  }
  const wait = () => new Promise(resolve => setTimeout(resolve, options.delayMs ?? 30));
  const offline = async () => {
    await wait();
    if (options.offline?.()) throw new TypeError('Failed to fetch');
  };
  const recordText = (text: string, body: FixtureBody, language: string, work: string) => {
    const head = next();
    texts.set(text, { head, ...body, language, work, publication: texts.get(text)?.publication ?? null });
    drafts.set(head, body);
    return head;
  };
  const recordDraft = (resource: string, variant: string, body: FixtureBody) => {
    const revision = next().slice(-36);
    const current = variants.get(variant);
    variants.set(variant, { head: revision, publication: current?.publication ?? null, eligibility: current?.eligibility ?? null,
      resource });
    revisions.set(revision, { resource, variant, ...body });
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
          work: current.work, author: agents[0]!.iri, language: current.language, ...body, sourcePosition: position });
      } }),
    };
  }, { post: async (body: { work: string; language: string } & FixtureBodyInput) => {
    await offline();
    calls.push('create');
    const text = next();
    return ok({ contribution: text, draftRevision: recordText(text, bodyOf(body), body.language, body.work), work: body.work,
      language: body.language, author: agents[0]!.iri, sourcePosition: position, replayed: false });
  } });
  const compositions = Object.assign((params: { id: string }) => ({ changes: { post: async (body: {
    expectedHead: string; operations: Array<{ op: string; occurrence?: string; target?: string; parent?: string;
      role?: string; division?: Division; label?: { value: string; language: string };
      position?: 'first' | 'last' | { after: string } }> }) => {
    await wait();
    const structure = structures.get(`https://rezics.com/id/${params.id}`);
    if (options.chapters === 'denied') return fail(403, 'authority_denied');
    if (!structure) return fail(404, 'composition_unavailable');
    if (structure.head !== body.expectedHead) return fail(409, 'stale_composition_head');
    const occurrences: string[] = [];
    // One change applies whole or not at all, as Main's does.
    const before = structure.nodes.map(node => ({ ...node }));
    for (const operation of body.operations) {
      const node = structure.nodes.find(entry => entry.occurrence === operation.occurrence);
      calls.push(operation.op);
      if (operation.op === 'insert') {
        const occurrence = next();
        occurrences.push(occurrence);
        place(structure, { occurrence, parent: operation.parent!, role: operation.role === 'group' ? 'group' : 'chapter',
          ...(operation.target ? { target: operation.target } : {}), ...(operation.label ? { label: operation.label } : {}),
          ...(operation.division ? { division: operation.division } : {}) }, operation.position ?? 'last');
      } else if (!node || !conflictFree(structure, operation, node)) {
        structure.nodes = before;
        return fail(409, 'composition_conflict');
      } else if (operation.op === 'move') place(structure, node, operation.position ?? 'last', operation.parent);
      else if (operation.op === 'update') Object.assign(node, operation.label ? { label: operation.label } : {},
        operation.division ? { division: operation.division } : {});
      else if (operation.op === 'remove') structure.nodes = structure.nodes.filter(entry => entry !== node);
    }
    structure.head = next();
    return ok({ structure: `https://rezics.com/id/${params.id}`, revision: structure.head, expectedHead: body.expectedHead,
      receipt: 'urn:rezics:receipt:story', replayed: false, occurrences, sourcePosition: position });
  } } }), { post: async (body: { work: string }) => {
    await wait();
    if (options.chapters === 'denied') return fail(403, 'authority_denied');
    calls.push('composition');
    const structure = next();
    structures.set(structure, { structure, head: next(), book: body.work, nodes: [] });
    return ok({ structure, mainVersion: id(601), revision: structures.get(structure)!.head, receipt: 'urn:rezics:receipt:story',
      replayed: false, sourcePosition: position });
  } });
  const outlineOf = (work: string) => [...structures.values()].find(value => value.book === `https://rezics.com/id/${work}`);
  const works = Object.assign((params: { id: string }) => ({
    chapters: { post: async (body: { title: string; language: string; parent: string; expectedCompositionHead: string }) => {
      await wait();
      if (options.chapters === 'denied') return fail(403, 'authority_denied');
      const structure = outlineOf(params.id);
      if (!structure) return fail(404, 'composition_unavailable');
      if (structure.head !== body.expectedCompositionHead) return fail(409, 'stale_composition_head');
      calls.push('post');
      const post = next(), revision = next(), occurrence = next();
      place(structure, { occurrence, parent: body.parent, role: 'chapter', target: post,
        label: { value: body.title, language: body.language } }, 'last');
      structure.head = next();
      return ok({ post, revision, occurrence, structure: structure.structure,
        compositionRevision: structure.head, variantId: `urn:rezics:variant:${next().slice(-36)}`,
        language: body.language, direction: 'ltr', receipt: 'urn:rezics:receipt:story',
        replayed: false, sourcePosition: position });
    } },
    contents: { get: async (request?: { query?: { parent?: string } }) => {
      await wait();
      const found = outlineOf(params.id);
      if (!found) return fail(404, 'work_unavailable');
      return ok(levelPage(found, request?.query?.parent));
    } },
    'content-variants': { get: async () => {
      await wait();
      const resource = `https://rezics.com/id/${params.id}`;
      return ok({ work: resource, items: [...variants.entries()].filter(([, value]) => value.resource === resource)
        .map(([variantId, value]) => ({ variantId, language: { kind: 'tag', tag: 'zh-Hans', originalTag: 'zh-Hans' },
          direction: 'ltr', draftHead: value.head, publicationHead: value.publication,
          eligibilityHead: value.eligibility })), nextCursor: null,
      sourcePosition: { owner: 'content', dataEpoch: 'story-epoch', sequence: '1' } });
    } },
  }), { post: async () => {
    await wait();
    calls.push('work');
    return ok({ work: next(), mainVersion: next(), workRevision: next(), mainRevision: next(), sourcePosition: position,
      replayed: false });
  } });
  /** Main's Studio chapter read: one level with where each chapter stands for its writer, the Studio Agent. */
  const me = { agents: (agent: { agent: string }) => ({ works: (work: { id: string }) => ({ chapters: { get: async (
    request?: { query?: { parent?: string } }) => {
    await wait();
    const found = outlineOf(work.id);
    if (!found) return fail(404, 'work_unavailable');
    const page = levelPage(found, request?.query?.parent);
    const writer = `https://rezics.com/id/${agent.agent}`;
    return ok({ profile: 'studio-chapters-v1', page, facts: page.items.filter(item => item.role === 'chapter')
      .map(item => {
        const node = found.nodes.find(entry => entry.occurrence === item.occurrence)!;
        return { occurrence: item.occurrence, writer, otherIdentity: false, state: node.state ?? 'empty',
          target: item.target, label: item.label, language: item.label?.language ?? null,
          length: node.length ?? null };
      }) });
  } } }) }) };
  const main = { v1: {
    contributions,
    compositions,
    works,
    me,
    'contribution-edits': { post: async (body: { contribution: string; expectedHead: string } & FixtureBodyInput) => {
      await offline();
      calls.push('edit');
      const current = texts.get(body.contribution);
      if (!current) return fail(404, 'contribution_unavailable');
      if (current.head !== body.expectedHead) return fail(409, 'stale_head', { currentHead: current.head });
      const predecessor = current.head;
      return ok({ contribution: body.contribution, draftRevision: recordText(body.contribution, bodyOf(body), current.language,
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
      publications.set(decision, { text: body.contribution, revision: body.expectedDraftHead });
      return ok({ contribution: body.contribution, publicationDecision: decision, selectedDraft: body.expectedDraftHead,
        predecessor: null, sourcePosition: position, replayed: false });
    } },
    'main-versions': (params: { mainVersion: string }) => ({ selection: { get: async () => {
      await wait();
      const main = `https://rezics.com/id/${params.mainVersion}`;
      const selection = selections.get(main);
      const draft = selection && drafts.get(selection.revision);
      const text = selection && texts.get(selection.text);
      return !selection || !draft || !text ? fail(404, 'selection_unavailable') : ok({
        work: selection.work, mainVersion: main, selection: selection.selection, contribution: selection.text,
        selectedDraft: selection.revision, language: text.language, ...draft,
      });
    } } }),
    'publication-selections': { post: async (body: { context: { id: string }; work: string;
      contribution: string; publicationDecision: string }) => {
      await wait();
      calls.push('select');
      if (options.select === 'denied') return fail(403, 'authority_denied');
      const publication = publications.get(body.publicationDecision);
      if (!publication || publication.text !== body.contribution) return fail(404, 'publication_unavailable');
      const selection = next();
      selections.set(body.context.id, { selection, work: body.work, text: body.contribution, revision: publication.revision });
      return ok({ selection, replayed: false, sourcePosition: position });
    } },
    realms: () => ({ submissions: { post: async () => {
      await wait();
      calls.push('submit');
      if (options.submit === 'denied') return fail(403, 'authority_denied');
      return ok({ submission: { state: options.submit === 'accepted' ? 'accepted' : 'pending' }, replayed: false });
    } } }),
    'content-drafts': { post: async (body: { resourceId: string; variantId: string; expectedHead: string | null } & FixtureBodyInput) => {
      await offline();
      calls.push('draft');
      const current = variants.get(body.variantId)?.head ?? null;
      if (current !== body.expectedHead) return fail(409, 'stale_head', { currentHead: current });
      const revision = recordDraft(body.resourceId, body.variantId, bodyOf(body));
      return ok({ resourceId: body.resourceId, variantId: body.variantId, revisionId: revision, predecessor: current,
        byteDigest: 'b'.repeat(64), sourcePosition: { owner: 'content', dataEpoch: 'story-epoch', sequence: '1' },
        replayed: false });
    } },
    'content-revisions': (params: { revision: string }) => ({ get: async () => {
      await wait();
      const revision = revisions.get(params.revision);
      return revision ? ok({ reference: { owner: 'content', resourceId: revision.resource, variantId: revision.variant,
        revisionId: params.revision, byteDigest: 'b'.repeat(64) },
        serializedJson: JSON.stringify({ body: revision.body, ...(revision.document ? { document: revision.document } : {}) }),
        body: { body: revision.body, ...(revision.document ? { document: revision.document } : {}) } })
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
    /** Capture seeded data on the first run; restore an isolated copy on every rerun. */
    reset() {
      baseline ??= backup();
      const saved = structuredClone(baseline);
      sequence = saved.sequence;
      restoreMap(texts, saved.texts); restoreMap(drafts, saved.drafts);
      restoreMap(publications, saved.publications); restoreMap(selections, saved.selections);
      restoreMap(variants, saved.variants); restoreMap(revisions, saved.revisions);
      restoreMap(structures, saved.structures);
      calls.length = 0;
    },
    /** Seeds an existing text and returns its head. */
    seed: (text: string, body: string | DocumentSnapshot, language: string, work: string) => recordText(text, seedBody(body), language, work),
    /** Seeds a chapter's draft and returns its head (a bare revision ID, as Content names them). */
    seedChapter: (chapter: string, variant: string, body: string | DocumentSnapshot) => recordDraft(chapter, variant, seedBody(body)),
    /** Seeds a Book's composition with chapters at its top level. */
    seedBook: (book: string, chapters: Array<{ target: string; title: string }>) => {
      const structure = next();
      structures.set(structure, { structure, head: next(), book, nodes: chapters.map(entry => ({ occurrence: next(),
        parent: structure, role: 'chapter' as const, target: entry.target,
        label: { value: entry.title, language: 'zh-Hans' } })) });
      return structure;
    },
    /**
     * Seeds a Book's composition in volumes: each entry is a top-level chapter or a group with its chapters,
     * a chapter saying where it stands for its writer and how long it is.
     */
    seedOutline: (book: string, entries: readonly OutlineSeed[]) => {
      const structure = next();
      const outline: Outline = { structure, head: next(), book, nodes: [] };
      const chapterNode = (parent: string, entry: OutlineChapterSeed): OutlineNode => ({ occurrence: next(), parent,
        role: 'chapter', target: entry.target, label: { value: entry.title, language: 'zh-Hans' },
        ...(entry.state ? { state: entry.state } : {}), ...(entry.length ? { length: entry.length } : {}) });
      for (const entry of entries) {
        if (!('chapters' in entry)) { outline.nodes.push(chapterNode(structure, entry)); continue; }
        const group: OutlineNode = { occurrence: next(), parent: structure, role: 'group', division: entry.division,
          ...(entry.title ? { label: { value: entry.title, language: 'zh-Hans' } } : {}) };
        outline.nodes.push(group, ...entry.chapters.map(chapter => chapterNode(group.occurrence, chapter)));
      }
      structures.set(structure, outline);
      return structure;
    },
    /** One level of a seeded Book as Main's contents read returns it. */
    level: (book: string, parent?: string) => levelPage(outlineOf(book.slice(-36))!, parent),
    /** Another tab or device saves a newer version. */
    writeElsewhere: (text: string, body: string | DocumentSnapshot) => {
      const current = texts.get(text);
      if (current) recordText(text, seedBody(body), current.language, current.work);
    },
    writeChapterElsewhere: (chapter: string, variant: string, body: string | DocumentSnapshot) => recordDraft(chapter, variant, seedBody(body)),
    head: (text: string) => texts.get(text)?.head ?? null,
    chapterHead: (variant: string) => variants.get(variant)?.head ?? null,
    /** A Book's outline: its head, its top level (`items`) and every node. */
    book: (book: string) => {
      const found = [...structures.values()].find(value => value.book === book);
      return found ? { head: found.head, nodes: found.nodes,
        items: found.nodes.filter(node => node.parent === found.structure) as Array<OutlineNode & {
          label: { value: string; language: string } }> } : undefined;
    },
  };
}

type Division = 'volume' | 'part' | 'extras';
type ChapterState = 'empty' | 'draft' | 'published' | 'changed';
interface OutlineNode { occurrence: string; parent: string; role: 'chapter' | 'group'; target?: string;
  label?: { value: string; language: string }; division?: Division; state?: ChapterState;
  length?: { unit: 'characters' | 'words'; value: number } }
/** A stand-in Book composition: siblings keep their order in `nodes`. */
interface Outline { structure: string; head: string; book: string; nodes: OutlineNode[] }
interface OutlineChapterSeed { target: string; title: string; state?: ChapterState;
  length?: { unit: 'characters' | 'words'; value: number } }
export type OutlineSeed = OutlineChapterSeed | { title: string | null; division: Division; chapters: OutlineChapterSeed[] };

/** Puts `node` first, last or after a sibling of `parent` (its own parent by default), keeping sibling order. */
function place(outline: Outline, node: OutlineNode, where: 'first' | 'last' | { after: string }, parent = node.parent) {
  outline.nodes = outline.nodes.filter(entry => entry !== node);
  node.parent = parent;
  const siblings = outline.nodes.filter(entry => entry.parent === parent);
  const index = where === 'first' ? siblings.length ? outline.nodes.indexOf(siblings[0]!) : outline.nodes.length
    : where === 'last' ? siblings.length ? outline.nodes.indexOf(siblings.at(-1)!) + 1 : outline.nodes.length
      : outline.nodes.findIndex(entry => entry.occurrence === where.after) + 1;
  outline.nodes.splice(index, 0, node);
}

/** Main's rules the stand-in keeps: groups sit at the top level, and only an empty group is removed. */
function conflictFree(outline: Outline, operation: { op: string; parent?: string }, node: OutlineNode): boolean {
  if (operation.op === 'remove') return node.role === 'chapter' || !outline.nodes.some(entry => entry.parent === node.occurrence);
  if (operation.op === 'move' && operation.parent) {
    const into = outline.nodes.find(entry => entry.occurrence === operation.parent);
    return operation.parent === outline.structure ? true : node.role === 'chapter' && into?.role === 'group';
  }
  return true;
}

/** One level as Main's contents read numbers it: volumes among volumes, story chapters through the Book. */
function levelPage(outline: Outline, parent = outline.structure): ContentsPage {
  const children = (of: string) => outline.nodes.filter(node => node.parent === of);
  const top = children(outline.structure);
  const numbers = new Map<string, number | null>();
  let chapter = 0;
  for (const node of top) {
    if (node.role === 'chapter') numbers.set(node.occurrence, ++chapter);
    else for (const child of children(node.occurrence)) {
      numbers.set(child.occurrence, node.division === 'extras' ? null : ++chapter);
    }
  }
  const volumes = top.filter(node => node.role === 'group' && (node.division ?? 'part') === 'volume');
  return { ...contents, composition: outline.structure, compositionRevision: outline.head, nextCursor: null,
    items: children(parent).map(node => ({ occurrence: node.occurrence, parent, role: node.role,
      label: node.label ?? null, division: node.role === 'group' ? node.division ?? 'part' : null,
      number: node.role === 'group' ? volumes.includes(node) ? volumes.indexOf(node) + 1 : null
        : numbers.get(node.occurrence) ?? null,
      childCount: node.role === 'group' ? children(node.occurrence).length : null, target: node.target ?? null,
      selectedRevision: null, progress: null,
      availability: node.state === 'published' || node.state === 'changed' ? 'available' : 'unavailable' })),
    count: { value: children(parent).length, kind: 'exact-page', total: null } } as ContentsPage;
}
