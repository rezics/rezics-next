import type { AgentOption } from '../auth/acting-identity.ts';
import type { StudioHome } from './read.ts';
import type { MainClient, MyText, RealmChoice, Submission, WorkHeader } from './types.ts';

// Stand-in data and an in-memory Main for Studio stories: the same response
// shapes Main returns, so stories exercise the real components and adapters.

const id = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const position = { dataEpoch: 'story', sequence: '42' };

export const agents: AgentOption[] = [
  { iri: id(1), label: 'Lin Mei 林梅', handle: null, kind: 'person', path: 'represented-agent' },
  { iri: id(2), label: '月下书生 · Moonlit Scribe', handle: null, kind: 'pen-name', path: 'represented-agent' },
  { iri: id(3), label: null, handle: null, kind: 'person', path: 'represented-agent' },
];

const cover = (key: string) => ({ kind: 'fallback' as const, policy: 'resource-type-v1', key, resourceType: 'work' });
const title = (value: string, language: string) => ({ value, language, direction: 'ltr', basis: 'selected' });

export const works = {
  serial: { id: id(101), title: title('雨夜书店 · 连载小说', 'zh-Hans'), cover: cover('serial') },
  chapter: { id: id(102), title: title('雨夜书店 · 第三章 最后一班车', 'zh-Hans'), cover: cover('chapter') },
  tides: { id: id(103), title: title('The Cartographer of Tides', 'en'), cover: cover('tides') },
};

export const texts: MyText[] = [
  { id: id(201), work: works.chapter, revision: id(301), language: 'zh-Hans', publication: 'draft' },
  { id: id(202), work: works.tides, revision: id(302), language: 'en', publication: 'draft' },
  { id: id(203), work: works.serial, revision: id(303), language: 'zh-Hans', publication: 'public' },
  { id: id(204), work: works.tides, revision: id(304), language: 'fr', publication: 'private' },
] as MyText[];

export const realms: RealmChoice[] = [
  { id: id(401), space: id(411), name: { value: 'Classic Literature · 经典文学', language: 'en' }, icon: null,
    description: null, membership: { count: { kind: 'unknown' } }, links: { realm: '/v1/realms/401' } },
  { id: id(402), space: id(412), name: { value: '中文网络小说 · Chinese Web Fiction', language: 'zh-Hans' }, icon: null,
    description: null, membership: { count: { kind: 'unknown' } }, links: { realm: '/v1/realms/402' } },
] as unknown as RealmChoice[];

const submission = (n: number, work: string, realm: string, state: Submission['state'], publicReason: string | null = null):
  Submission => ({ id: id(500 + n).slice(-36), realm, kind: 'contribution', work, mainVersion: id(600), contribution: id(203),
  publicationDecision: id(700), selectedDraft: id(303), correctionOf: null, submittingAgent: id(1), state,
  revision: id(800 + n).slice(-36), generation: '1', reviewer: null, publicReason, selection: null, adoptionReceipt: null,
  openedAt: '2026-09-20T10:00:00.000Z', updatedAt: `2026-09-2${n}T10:00:00.000Z` });

export const submissions: Submission[] = [
  submission(1, works.serial.id, id(402), 'pending'),
  submission(2, works.serial.id, id(401), 'changes-requested', 'Please add a content note for the opening chapter.'),
  submission(3, works.tides.id, id(401), 'accepted'),
];

export const home: StudioHome = {
  texts: { ok: true, data: { items: texts, nextCursor: null } },
  submissions: { ok: true, data: submissions },
  realms: { [id(401)]: 'Classic Literature · 经典文学', [id(402)]: '中文网络小说 · Chinese Web Fiction' },
};

export const header = {
  profile: 'work-read-v1', id: works.chapter.id, revision: id(901), mainVersion: id(600), title: works.chapter.title,
  cover: works.chapter.cover, types: ['https://schema.org/DigitalDocument'], disclosure: 'restricted', originalTitle: null,
  metadataRevision: null, description: null, mainVersionRevision: id(902), mainVersionLabel: null, selectedLanguage: 'zh-Hans',
  sourcePosition: position, links: {},
} as unknown as WorkHeader;

type Answer = { data: unknown; error: { status: number; value: unknown } | null };
const ok = (data: unknown): Answer => ({ data, error: null });
const fail = (status: number, code: string): Answer => ({ data: null, error: { status, value: { code, status } } });

export interface StoryMainOptions {
  /** Saves fail as if the network were down. */
  offline?: () => boolean;
  /** Answer for publication, Main selection and each Realm submission. */
  publish?: 'ok' | 'denied' | 'stale';
  select?: 'ok' | 'denied';
  submit?: 'ok' | 'denied';
  /** Whether Main lets this Agent list its texts (the conflict view needs it to compare). */
  listTexts?: boolean;
  delayMs?: number;
}

/**
 * An in-memory Main for one Agent's texts: creates, edits on the expected
 * head (409 `stale_head` otherwise), exact draft reads and the publish
 * commands. `writeElsewhere` stands in for a second tab or device.
 */
export function storyMain(options: StoryMainOptions = {}) {
  let sequence = 1000;
  const next = () => id(++sequence);
  const heads = new Map<string, { head: string; body: string; language: string; work: string }>();
  const bodies = new Map<string, string>();
  const calls: string[] = [];
  const wait = () => new Promise(resolve => setTimeout(resolve, options.delayMs ?? 30));
  const offline = async () => {
    await wait();
    if (options.offline?.()) throw new TypeError('Failed to fetch');
  };
  const record = (text: string, body: string, language: string, work: string) => {
    const head = next();
    heads.set(text, { head, body, language, work });
    bodies.set(head, body);
    return head;
  };
  const contributions = Object.assign((params: { contribution: string }) => ({
    drafts: (path: { revision: string }) => ({ get: async () => {
      await wait();
      const text = `https://rezics.com/id/${params.contribution}`;
      const revision = `https://rezics.com/id/${path.revision}`;
      const current = heads.get(text);
      const body = bodies.get(revision);
      return body === undefined || !current ? fail(404, 'revision_unavailable') : ok({ contribution: text, revision,
        work: current.work, author: agents[0]!.iri, language: current.language, body, sourcePosition: position });
    } }),
  }), { post: async (body: { work: string; language: string; body: string }) => {
    await offline();
    calls.push('create');
    const text = next();
    return ok({ contribution: text, draftRevision: record(text, body.body, body.language, body.work), work: body.work,
      language: body.language, author: agents[0]!.iri, sourcePosition: position, replayed: false });
  } });
  const main = { v1: {
    contributions,
    'contribution-edits': { post: async (body: { contribution: string; expectedHead: string; body: string }) => {
      await offline();
      calls.push('edit');
      const current = heads.get(body.contribution);
      if (!current) return fail(404, 'contribution_unavailable');
      if (current.head !== body.expectedHead) return fail(409, 'stale_head');
      const predecessor = current.head;
      return ok({ contribution: body.contribution, draftRevision: record(body.contribution, body.body, current.language,
        current.work), predecessor, sourcePosition: position, replayed: false });
    } },
    me: { contributions: { get: async () => {
      await wait();
      if (options.listTexts === false) return fail(403, 'library_denied');
      return ok({ items: [...heads].map(([text, value]) => ({ id: text, revision: value.head, language: value.language,
        publication: 'draft', work: null })), nextCursor: null, sourcePosition: position,
      count: { value: heads.size, kind: 'exact-page', total: null } });
    } } },
    'contribution-publications': { post: async (body: { contribution: string; expectedDraftHead: string }) => {
      await wait();
      calls.push('publish');
      if (options.publish === 'denied') return fail(403, 'authority_denied');
      if (options.publish === 'stale') return fail(409, 'stale_head');
      return ok({ contribution: body.contribution, publicationDecision: next(), selectedDraft: body.expectedDraftHead,
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
      return options.submit === 'denied' ? fail(503, 'dependency_unavailable') : ok({ submission: {}, replayed: false });
    } } }),
  } };
  return {
    main: main as unknown as MainClient,
    calls,
    /** Seeds an existing text and returns its head. */
    seed: (text: string, body: string, language: string, work: string) => record(text, body, language, work),
    /** Another tab or device saves a newer version. */
    writeElsewhere: (text: string, body: string) => {
      const current = heads.get(text);
      if (current) record(text, body, current.language, current.work);
    },
    head: (text: string) => heads.get(text)?.head ?? null,
  };
}
