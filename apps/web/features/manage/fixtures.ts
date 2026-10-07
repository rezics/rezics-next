import type { AgentOption } from '../auth/acting-identity.ts';
import type { AdminApi } from './admin-api.ts';
import type { Outcome } from './commands.ts';
import type { LogApi, LogNames } from './log-view.tsx';
import type { QueueApi, QueueNames } from './queue-api.ts';
import type { AgentSummary, AuditItem, ChapterSummary, DecisionBasis, InvitationPage, Loaded, Member, ModerationItem,
  ModerationPage, PersonRecord, PublicDecision, PublishedRule, RealmHeader, RealmRule, Role, RoleImpact, SettingsView,
  WorkFacts, WorkSummary } from './types.ts';

// Story data for the Manage workspace: the demo's Classic Literature Realm,
// its moderators and a busy queue. Stand-in APIs record what they were asked.

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const iri = (n: number) => `https://rezics.com/id/${id(n)}`;
export const realm = id(1);
export const now = Date.parse('2026-09-28T09:00:00.000Z');
const ago = (hours: number) => new Date(now - hours * 3_600_000).toISOString();
const position = { dataEpoch: 'fixture', sequence: '42' };

export const people = {
  mei: iri(10), daniel: iri(11), an: iri(12), sophie: iri(13), jun: iri(14), aria: iri(15),
} as const;
export const agents: Record<string, AgentSummary> = {
  [people.mei]: { iri: people.mei, label: 'Lin Mei 林梅', handle: 'lin_mei' },
  [people.daniel]: { iri: people.daniel, label: 'Daniel Chen 陈丹尼', handle: 'daniel_chen' },
  [people.an]: { iri: people.an, label: 'An Wu 吴安', handle: 'an_wu' },
  [people.sophie]: { iri: people.sophie, label: 'Sophie Li 李素菲', handle: 'sophie_li' },
  [people.jun]: { iri: people.jun, label: 'Jun Zhang 张俊', handle: 'jun_zhang' },
  [people.aria]: { iri: people.aria, label: 'Aria Wang 王雅', handle: 'aria_wang' },
};
export const acting: AgentOption = { iri: people.daniel, label: 'Daniel Chen 陈丹尼', handle: 'daniel_chen',
  kind: 'person', path: 'represented-agent' };
export const owner: AgentOption = { ...acting, iri: people.mei, label: 'Lin Mei 林梅', handle: 'lin_mei' };

const fallback = (key: string) => ({ kind: 'fallback' as const, policy: 'avatar-fallback-v1', resourceType: 'work', key });
const name = (value: string, language = 'en') => ({ value, language, direction: 'ltr' as const, basis: 'requested' as const });
const titles = ['Pride and Prejudice', 'Jane Eyre', '西游记', 'Frankenstein; or, The Modern Prometheus', '红楼梦',
  'Little Women', 'The Adventures of Sherlock Holmes', '聊斋志异 · 画皮'];
/**
 * The demo's serial and what else a Realm reviews: a Book with its chapter Posts, a
 * Minecraft mod, a prompt and a skill.
 */
export const book = iri(110);
export const chapterOne = iri(111);
export const chapterTwo = iri(112);
export const mod = iri(113);
export const prompt = iri(114);
export const skill = iri(115);
export const occurrences = { one: iri(1110), two: iri(1112) } as const;
const vocab = 'https://rezics.com/vocab/';
export const works: Record<string, WorkSummary> = {
  ...Object.fromEntries(titles.map((title, index) => {
    const work = iri(100 + index);
    const language = /\p{Script=Han}/u.test(title) ? 'zh-Hans' : 'en';
    return [work, { iri: work, title: name(title, language), cover: fallback(work), originalTitle: null,
      types: title === '聊斋志异 · 画皮' ? ['https://schema.org/DigitalDocument'] : ['https://schema.org/Book'] }];
  })),
  [book]: { iri: book, title: name('雨夜书店 · 连载小说', 'zh-Hans'), cover: fallback(book), originalTitle: null,
    types: ['https://schema.org/Book'], tagline: name('一封没有地址的信，把雨夜书店带向二十年前的秘密。', 'zh-Hans'),
    completionStatus: 'ongoing', chapterCount: 3 },
  [mod]: { iri: mod, title: name('Lantern Paths'), cover: fallback(mod), originalTitle: null,
    types: [`${vocab}ModPackage`, 'https://schema.org/SoftwareApplication'], tagline: name('Lanterns that light the way home.') },
  [prompt]: { iri: prompt, title: name('Chapter recap for serial readers'), cover: fallback(prompt), originalTitle: null,
    types: [`${vocab}PromptTemplate`] },
  [skill]: { iri: skill, title: name('Citation checker'), cover: fallback(skill), originalTitle: null,
    types: [`${vocab}SkillPackage`] },
};

/** The chapters as their Book lists them, with the opening a moderator can reveal. */
export const chapters: Record<string, ChapterSummary> = {
  [chapterOne]: { label: { value: '第一章 雨夜', language: 'zh-Hans' }, language: 'zh-Hans', direction: 'ltr',
    excerpt: '雨停在书店打烊前。林梅在门口发现一封没有地址的信。\n信封上只写着一个日期：二十年前的今天。', truncated: true },
  [chapterTwo]: { label: { value: '第二章 未寄出的信', language: 'zh-Hans' }, language: 'zh-Hans', direction: 'ltr',
    excerpt: '她把信放进收银台的抽屉，第二天早上，抽屉里多了一封回信。', truncated: false },
};

/** What Main's moderation context says of the queue's people and Works. */
export const records: Record<string, PersonRecord> = {
  [people.sophie]: { agent: people.sophie, membership: { state: 'joined', joinedAt: ago(300), banned: false, bannedUntil: null },
    submissions: { open: 2, accepted: 5, rejected: 1, changesRequested: 1, withdrawn: 0, total: 9, capped: false }, reports: null },
  [people.jun]: { agent: people.jun, membership: { state: 'joined', joinedAt: ago(120), banned: true,
    bannedUntil: new Date(now + 7 * 86_400_000).toISOString() },
  submissions: { open: 2, accepted: 0, rejected: 3, changesRequested: 0, withdrawn: 1, total: 6, capped: false }, reports: null },
  [people.mei]: { agent: people.mei, membership: { state: 'joined', joinedAt: ago(900), banned: false, bannedUntil: null },
    submissions: { open: 2, accepted: 12, rejected: 0, changesRequested: 1, withdrawn: 0, total: 15, capped: false },
    reports: { open: 3, upheld: 6, dismissed: 1, total: 10, capped: false } },
  [people.aria]: { agent: people.aria, membership: { state: 'left', joinedAt: null, banned: false, bannedUntil: null },
    submissions: null, reports: { open: 1, upheld: 0, dismissed: 0, total: 1, capped: false } },
};
export const facts: Record<string, WorkFacts> = {
  [book]: { work: book, partOf: null, authors: [{ agent: people.mei, name: 'Lin Mei 林梅' }], mod: null, hub: null },
  // A chapter's context names its place and its Book's authors.
  [chapterOne]: { work: chapterOne, partOf: { work: book, occurrence: occurrences.one },
    authors: [{ agent: people.mei, name: 'Lin Mei 林梅' }], mod: null, hub: null },
  [chapterTwo]: { work: chapterTwo, partOf: { work: book, occurrence: occurrences.two },
    authors: [{ agent: people.mei, name: 'Lin Mei 林梅' }], mod: null, hub: null },
  [mod]: { work: mod, partOf: null, authors: [{ agent: people.jun, name: 'Jun Zhang 张俊' }], hub: null,
    mod: { game: 'Minecraft', gameVersions: ['1.21.1'], loaders: ['Fabric'], latestRelease: '2.3.0' } },
  [prompt]: { work: prompt, partOf: null, authors: [{ agent: people.sophie, name: 'Sophie Li 李素菲' }], mod: null,
    hub: { kind: 'prompt', summary: 'Recap a chapter without spoiling later ones.', truncated: false,
      text: 'You are recapping chapter {{chapter}} of {{book}} for a reader who has read up to it.\n'
        + 'Summarise in three sentences. Never mention events after this chapter.', declaredModels: ['claude-sonnet-5'] } },
  [skill]: { work: skill, partOf: null, authors: [{ agent: people.aria, name: 'Aria Wang 王雅' }], mod: null,
    hub: { kind: 'skill-package', summary: 'Checks that quotations name their edition and translator.', truncated: true,
      text: '# Citation checker\n\nFor each quotation, find the edition it comes from and its translator.\n'
        + 'Flag quotations without one.', declaredModels: [] } },
};
export const names: QueueNames = { agents, works, chapters, records, facts };

export const header: RealmHeader = { profile: 'realm-read-v1', id: iri(1), space: iri(2), revision: iri(3),
  name: name('Classic Literature · 经典文学'), icon: { ...fallback(iri(1)), resourceType: 'realm' }, profileRevision: null,
  description: null, banner: null, rules: null, membership: { count: { kind: 'unknown', value: null }, publicMembers: null },
  moderators: { kind: 'known', items: [people.mei] }, visibility: 'public', reviewMode: 'mandatory',
  policyRevision: null, sourcePosition: position,
  links: { works: `/v1/realms/${realm}/works`, decisions: `/v1/realms/${realm}/decisions` } };

function report(n: number, work: number, reason: string, hours: number, overrides: Partial<ModerationItem> = {}): ModerationItem {
  return { id: id(200 + n), kind: 'content_report', state: 'open', generation: '1', decisionHead: null, openedAt: ago(hours),
    authorAgent: people.mei, reasonCode: reason, escalation: null, context: iri(1), submission: null,
    target: { owner: 'graph', resource: iri(100 + work), component: 'title' }, ...overrides };
}

function submission(n: number, work: number, hours: number, overrides: Partial<ModerationItem> = {}): ModerationItem {
  return { id: id(300 + n), kind: 'contribution_submission', state: 'open', generation: '1', decisionHead: null,
    openedAt: ago(hours), authorAgent: people.sophie, reasonCode: null, escalation: null, context: iri(1),
    target: { owner: 'graph', resource: iri(100 + work), component: iri(400 + n) },
    submission: { revision: id(500 + n), state: 'pending', contribution: iri(400 + n), publicationDecision: iri(600 + n),
      selectedDraft: iri(700 + n), correctionOf: null }, ...overrides };
}

export const escalation = { id: id(900), reason: 'The same account filed eight reports in a minute; owners should look.',
  actingSubject: people.an, escalatedAt: ago(2), target: 'owners' as const };

/** A whole Work or one exact publication offered to the Realm: no contribution draft, a Work and its variant. */
function resource(n: number, work: string, hours: number, kind: 'work' | 'content-publication',
  overrides: Partial<ModerationItem> = {}): ModerationItem {
  const variant = `urn:rezics:variant:${id(1400 + n)}`;
  return { id: id(300 + n), kind: `${kind}_submission`, state: 'open', generation: '1', decisionHead: null,
    openedAt: ago(hours), authorAgent: people.mei, reasonCode: null, escalation: null, context: iri(1),
    target: { owner: 'graph', resource: work, component: kind === 'work' ? work : variant },
    submission: { revision: id(500 + n), state: 'pending', contribution: null,
      publicationDecision: kind === 'work' ? null : `urn:rezics:content-publication:${'c'.repeat(64)}`,
      selectedDraft: null, correctionOf: null }, ...overrides };
}

export const queue: ModerationItem[] = [
  report(1, 0, 'edition_details', 50),
  submission(1, 2, 30, { authorAgent: people.jun }),
  report(2, 1, 'title_review', 26, { escalation }),
  submission(2, 3, 20),
  { ...submission(3, 4, 12), kind: 'correction_submission',
    submission: { ...submission(3, 4, 12).submission!, correctionOf: iri(800) } },
  report(3, 5, 'spoiler.in_title', 5, { authorAgent: people.aria }),
  { ...report(4, 6, 'unlicensed_copy', 3), kind: 'rights_complaint', authorAgent: people.jun },
  // A report on a chapter, naming one of the Realm's rules as its reason.
  { ...report(5, 0, 'no-spoilers', 2.5, { authorAgent: people.aria }),
    target: { owner: 'graph', resource: chapterOne, component: 'body' } },
  resource(4, book, 2, 'work'),
  resource(5, chapterTwo, 1.5, 'content-publication'),
  resource(6, mod, 1.2, 'work', { authorAgent: people.jun }),
  resource(7, prompt, 1, 'work', { authorAgent: people.sophie }),
  { ...report(6, 0, 'unsafe_instructions', 0.5, { authorAgent: people.mei }),
    target: { owner: 'graph', resource: skill, component: 'body' } },
];
export const queuePage: ModerationPage = { items: queue, nextCursor: null, sourcePosition: position,
  count: { value: queue.length, kind: 'exact-page', total: null } };
export const decidedPage: ModerationPage = { ...queuePage, items: [
  { ...submission(8, 7, 70), state: 'closed', submission: { ...submission(8, 7, 70).submission!, state: 'accepted' } },
  { ...submission(9, 1, 90), state: 'closed', submission: { ...submission(9, 1, 90).submission!, state: 'changes-requested' } },
  { ...report(9, 2, 'title_review', 100), state: 'closed' },
] };

export const drafts: Record<string, string> = {
  [iri(701)]: '第二回 悟彻菩提真妙理 断魔归本合元神\n话表美猴王得了姓名，怡然踊跃，对菩提前作礼启谢。',
  [iri(702)]: 'Chapter 2\nIt was on a dreary night of November that I beheld the accomplishment of my toils.',
  [iri(703)]: '第三回 托内兄林如海荐西宾 接外孙贾母惜孤女',
};

/** What reporters wrote, by case; the first report has a second reporter. */
const statements: Record<string, Array<{ by: string; text: string | null }>> = {
  [id(201)]: [{ by: people.mei, text: 'This is the 1813 first edition’s title page, but the text is the 1894 illustrated one.' },
    { by: people.aria, text: null }],
  [id(203)]: [{ by: people.aria, text: 'The subtitle gives away the ending.' }],
};

/** A report's decision basis as Main returns it to a moderator; `rules: false` for a Realm without published rules. */
export function basisFor(item: ModerationItem, rules = true): DecisionBasis {
  const head = `${item.target.resource}-revision-1`;
  return { caseId: item.id, generation: item.generation, decisionHead: null, state: 'open', target: item.target,
    ruleBasis: rules ? { ref: `urn:rezics:realm-rules:${realm}`, revision: '3', digest: 'a'.repeat(64), document: {} } : null,
    reports: (statements[item.id] ?? [{ by: item.authorAgent ?? people.mei, text: null }]).map((report, index) => ({
      id: id(1300 + index), actingSubject: report.by, reasonCode: item.reasonCode ?? 'other', statement: report.text,
      evidenceDigest: String(index).repeat(64), receivedAt: item.openedAt,
      evidence: [{ ordinal: 1, owner: 'graph', resource: item.target.resource, component: item.target.component,
        revision: head, locator: null, state: 'available', representation: 'work-title-en', revisionDigest: 'd'.repeat(64),
        expectedHead: head, provenance: {} }] })),
    nextCursor: null, sourcePosition: position };
}

export interface Recorded { commits: Array<{ id: string; action: string; reason: string | null; key: string }> }

/** A queue whose commits succeed unless `stale` names the item; reloads return `reload` when given. */
export function queueApi(options: { stale?: readonly string[]; reload?: ModerationItem[]; recorded?: Recorded;
  rules?: boolean } = {}): QueueApi {
  const recorded = options.recorded ?? { commits: [] };
  return {
    page: async () => ({ ok: true, data: { ...queuePage, items: options.reload ?? queue } }),
    names: async () => names,
    draft: async item => {
      const text = item.submission?.selectedDraft ? drafts[item.submission.selectedDraft] : undefined;
      return text ? { ok: true, data: { text, language: /\p{Script=Han}/u.test(text) ? 'zh-Hans' : 'en' } }
        : { ok: false, failure: 'unavailable' };
    },
    basis: async item => item.kind === 'content_report' ? { ok: true, data: basisFor(item, options.rules ?? true) }
      : { ok: false, failure: 'missing' },
    people: async () => agents,
    commit: async (item, decision, key): Promise<Outcome<unknown>> => {
      recorded.commits.push({ id: item.id, action: decision.action, reason: decision.reason, key });
      return options.stale?.includes(item.id) ? { ok: false, failure: 'stale' } : { ok: true, data: {} };
    },
  };
}

export const audit: AuditItem[] = [
  { id: id(1001), caseId: null, kind: 'realm_management', outcome: 'realm.initialize', reason: 'Initialize Realm management',
    actingSubject: people.mei, decidedAt: ago(72), caseSequence: null, detail: null, target: null },
  { id: id(1002), caseId: null, kind: 'realm_management', outcome: 'realm.roles.manage',
    reason: 'Set up the Classic Literature moderation team', actingSubject: people.mei, decidedAt: ago(71), caseSequence: null,
    detail: { kind: 'assignment', role: { id: id(2001), name: 'Community moderators' }, member: people.daniel,
      assigned: true, validUntil: new Date(now + 30 * 86_400_000).toISOString(), changes: [] }, target: null },
  { id: id(1003), caseId: id(1203), kind: 'content_moderation', outcome: 'dismiss', reason: null,
    actingSubject: people.daniel, decidedAt: ago(30), caseSequence: '2', detail: null,
    target: { owner: 'graph', resource: iri(102), component: 'title' } },
  { id: id(1006), caseId: id(1206), kind: 'content_moderation', outcome: 'restrict',
    reason: 'Breaks rule 1, “Mark spoilers”. The chapter gives away the ending and was not marked.',
    actingSubject: people.daniel, decidedAt: ago(20), caseSequence: '1', detail: null,
    target: { owner: 'graph', resource: chapterOne, component: 'title' } },
  { id: id(1004), caseId: null, kind: 'realm_management', outcome: 'realm.members.manage',
    reason: 'Repeated off-topic posts after two warnings', actingSubject: people.an, decidedAt: ago(4), caseSequence: null,
    detail: null, target: null },
  { id: id(1005), caseId: null, kind: 'realm_management', outcome: 'governance.moderate',
    reason: 'The same account filed eight reports in a minute; owners should look.', actingSubject: people.an,
    decidedAt: ago(2), caseSequence: null, detail: null, target: null },
];
export const decisions: PublicDecision[] = [
  { id: iri(1104), kind: 'adoption', dataEpoch: 'fixture', sequence: '41', work: chapterTwo, subject: iri(404), outcome: null },
  { id: iri(1101), kind: 'adoption', dataEpoch: 'fixture', sequence: '40', work: iri(100), subject: iri(401), outcome: null },
  { id: iri(1102), kind: 'classification', dataEpoch: 'fixture', sequence: '38', work: iri(102), subject: iri(402),
    outcome: 'accepted' },
  { id: iri(1103), kind: 'classification', dataEpoch: 'fixture', sequence: '31', work: iri(104), subject: iri(403),
    outcome: 'rejected' },
];
export const logApi: LogApi = {
  audit: async () => ({ ok: true, data: { items: [], nextCursor: null, sourcePosition: position,
    count: { value: 0, kind: 'exact-page', total: null } } }),
  decisions: async () => ({ ok: true, data: { profile: 'realm-decisions-v1', items: [], nextCursor: null,
    sourcePosition: position, count: { value: 0, kind: 'exact-page', total: null } } }),
  names: async () => logNames,
};
export const logNames: LogNames = { agents, works, chapters, facts };

export const roles: Role[] = [
  { id: id(2001), name: 'Community moderators', permissions: ['governance.moderate', 'realm.members.manage'] },
  { id: id(2002), name: 'Rules editors', permissions: ['governance.rule.publish', 'realm.settings.manage'] },
];
const until = new Date(now + 30 * 86_400_000).toISOString();
export const members: Member[] = [
  { member: people.daniel, joinedAt: ago(700), membershipGeneration: '1', banned: false, bannedUntil: null, state: 'joined',
    roles: [{ id: roles[0]!.id, name: roles[0]!.name, validUntil: until }] },
  { member: people.an, joinedAt: ago(650), membershipGeneration: '1', banned: false, bannedUntil: null, state: 'joined',
    roles: [{ id: roles[0]!.id, name: roles[0]!.name, validUntil: until }] },
  { member: people.sophie, joinedAt: ago(300), membershipGeneration: '1', banned: false, bannedUntil: null, state: 'joined',
    roles: [] },
  { member: people.jun, joinedAt: ago(120), membershipGeneration: '3', banned: true,
    bannedUntil: new Date(now + 7 * 86_400_000).toISOString(), state: 'joined', roles: [] },
  { member: people.aria, joinedAt: null, membershipGeneration: '2', banned: false, bannedUntil: null, state: 'left', roles: [] },
  { member: people.mei, joinedAt: null, membershipGeneration: '0', banned: false, bannedUntil: null,
    state: 'not_joined', roles: [{ id: roles[0]!.id, name: roles[0]!.name, validUntil: until }] },
];

export const outgoingInvitations: InvitationPage = { items: [{ id: id(3020), realm: iri(1), member: people.aria,
  inviter: people.daniel, state: 'pending', createdAt: ago(3), expiresAt: new Date(now + 3 * 86_400_000).toISOString(),
  policyRevision: '1', termsRevision: 'terms-1', membershipGeneration: '2' }], nextCursor: null };

export const rules: RealmRule[] = [
  { id: 'no-spoilers', governanceRule: null, title: { original: 'en', labels: { en: 'Mark spoilers', 'zh-Hans': '标注剧透' } },
    body: { original: 'en', labels: { en: 'Mark a discussion or reply that gives the story away. Write the title as you otherwise would; do not put a spoiler label in front of it.',
      'zh-Hans': '讨论或回复若会透露情节，请标记剧透。标题照常写，不要在前面加剧透字样。' } } },
  { id: 'credit-editions', governanceRule: null, title: { original: 'en', labels: { en: 'Name the edition', 'zh-Hans': '注明版本' } },
    body: { original: 'en', labels: { en: 'Say which translation or edition a text comes from, with its year when known.',
      'zh-Hans': '说明文本来自哪个译本或版本，已知时注明年份。' } } },
  { id: 'be-kind', governanceRule: null, title: { original: 'en', labels: { en: 'Criticise works, not people', 'zh-Hans': '批评作品，不针对人' } },
    body: { original: 'en', labels: { en: 'Disagree with readings and translations as sharply as you like; leave the people out of it.',
      'zh-Hans': '对解读和译文可以尖锐地表达不同意见，但不要针对人。' } } },
];
/** The rules as the Realm's public page reads them, in one language; moderators cite them by number. */
export function publishedRules(language: 'en' | 'zh-CN' = 'en'): PublishedRule[] {
  const tag = language === 'en' ? 'en' : 'zh-Hans';
  return rules.map(rule => ({ id: rule.id, governanceRule: null, title: name(rule.title.labels[tag]!, tag),
    body: name(rule.body.labels[tag]!, tag) }));
}

export const settings: SettingsView = { generation: '12',
  settings: { visibility: 'public', reviewRequired: true, whoMaySubmit: 'members', rules },
  ruleBasis: { ref: `urn:rezics:realm-rules:${realm}`, revision: '3', digest: 'a'.repeat(64) } };

/** What a role change would do: moderators gain what the change adds. */
export function impactOf(command: Parameters<AdminApi['preview']>[0]): RoleImpact {
  const change = command.change;
  const holders = change.kind === 'assignment' ? [change.member]
    : members.filter(member => member.roles.some(role => role.id === change.roleId)).map(member => member.member);
  const before = change.kind === 'role' ? roles.find(role => role.id === change.roleId)?.permissions ?? [] : [];
  const after = change.kind === 'role' ? change.permissions
    : change.assigned ? roles.find(role => role.id === change.roleId)?.permissions ?? [] : [];
  const lost = change.kind === 'assignment' && !change.assigned
    ? roles.find(role => role.id === change.roleId)?.permissions ?? [] : before.filter(item => !after.includes(item));
  const gained = after.filter(item => !before.includes(item));
  const changes = gained.length || lost.length ? holders.map(member => ({ member, gained, lost })) : [];
  return { digest: 'b'.repeat(64), exact: true, affectedCount: changes.length, generation: command.expectedGeneration, changes };
}

export interface AdminRecord { members: unknown[]; roles: unknown[]; settings: unknown[] }

/** Members, roles and settings that accept every change, except as `failures` say. */
export function adminApi(options: { record?: AdminRecord; settingsFailure?: 'stale' | 'denied'; theirs?: SettingsView;
  memberFailure?: 'stale' | 'denied' } = {}): AdminApi {
  const record = options.record ?? { members: [], roles: [], settings: [] };
  const ok = <T>(data: T): Loaded<T> => ({ ok: true, data });
  return {
    members: async search => ok({ generation: '12', nextCursor: null, items: search
      ? members.filter(member => agents[member.member]!.label!.toLowerCase().includes(search.toLowerCase())
        || `@${agents[member.member]!.handle}`.includes(search.toLowerCase()) || member.member === search)
      : members }),
    names: async () => agents,
    invitations: async () => ok(outgoingInvitations),
    revoke: async (invitation, key) => {
      record.members.push({ invitation, key, action: 'revoke' });
      return { ok: true, data: { replayed: false, invitation: { ...outgoingInvitations.items[0]!, state: 'revoked' } } };
    },
    lookup: async handle => {
      const found = Object.values(agents).find(agent => `@${agent.handle}` === handle.trim() || agent.handle === handle.trim());
      return found ? ok(found) : { ok: false, failure: 'missing' };
    },
    invite: async (command, key) => {
      record.members.push({ ...command, key });
      if (options.memberFailure) return { ok: false, failure: options.memberFailure };
      return { ok: true, data: { replayed: false, invitation: { id: id(3004), realm: iri(1), member: command.member,
        inviter: command.actingSubject, state: 'pending', createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + command.expiresInSeconds * 1000).toISOString(),
        policyRevision: '1', termsRevision: 'terms-1', membershipGeneration: '0' } } };
    },
    changeMember: async (command, key) => {
      record.members.push({ ...command, key });
      if (options.memberFailure) return { ok: false, failure: options.memberFailure };
      return { ok: true, data: { receiptId: id(3001), generation: '13', replayed: false, member: command.member,
        membershipGeneration: command.expectedMembershipGeneration, banned: command.action === 'ban',
        bannedUntil: command.durationSeconds ? new Date(now + command.durationSeconds * 1000).toISOString() : null } };
    },
    roles: async () => ok({ generation: '12', roles }),
    preview: async command => ({ ok: true, data: impactOf(command) }),
    changeRole: async (command, digest, key) => {
      record.roles.push({ ...command, digest, key });
      return { ok: true, data: { receiptId: id(3002), generation: '13', replayed: false, impact: impactOf(command) } };
    },
    settings: async () => ok(options.theirs ?? settings),
    saveSettings: async (command, key) => {
      record.settings.push({ ...command, key });
      if (options.settingsFailure) return { ok: false, failure: options.settingsFailure };
      return { ok: true, data: { generation: '13', settings: command.settings, receiptId: id(3003), replayed: false,
        ruleBasis: { ...settings.ruleBasis, revision: String(Number(command.expectedRulesRevision ?? '0') + 1) } } };
    },
  };
}
