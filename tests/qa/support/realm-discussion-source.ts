import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stable } from '../../../scripts/fixture/corpus.ts';
import type { RetainedOwnerState } from '../../../scripts/fixture/manifest.ts';
import { RetainedSources, type RetainedSourceAdapter, type SourceContext, type SourceInputs } from '../../../scripts/qa/retained-source.ts';
import type { PersonaName, PersonaSession, PersonaSessions, RetainedPersonaRealm } from './personas.ts';
import { prepareRealmRankingStates } from './realm-ranking-fixture.ts';
import { realmSourceBuildDeadlineMs } from './realm-discussion-budget.ts';
export { realmSourceBuildDeadlineMs } from './realm-discussion-budget.ts';

export const realmSourcePopulation = Object.freeze({ publicRanking: 261, retainedPrivate: 21,
  currentPrivate: 21, roots: 21, siblings: 193, nested: 34, privateRoots: 1 });
/** Bound fixture authority independently of active operation clocks. A retained
 * grant must survive producer work and the host's admission queue unchanged. */
export const realmSourceAuthorityLifetimeMs = 86_400_000;
export const realmSourceBuildEvidence = 'Measured retained attempt 20261014t020607-6ecee7: 189 serial identities in 290645ms; ' +
  '192 drafts in 77594ms and 184 placements in 42794ms. The complete 552-publication corpus extrapolates to about ' +
  '1200s of these phases, plus four persona bootstraps, authority/complete inventory reads and the admission transition. ' +
  'The complete 573-publication attempts 20261015t103925-3e9ad8 and 20261015t112537-961239 exhausted 1800s during verification. ' +
  'Allow 3600s only for the one-time producer; restore/readiness and the physical cut retain their separate 600s bounds. ' +
  'Record the measured complete-build duration before reusing the retained result.';

export const realmSourceRoles = ['visitor', 'stranger', 'member', 'owner', 'moderator', 'operator'] as const;
export type RealmSourceSessions = {
  rankingPublic: PersonaSessions; rankingPrivate: PersonaSessions;
  discussionPublic: PersonaSessions; discussionPrivate: PersonaSessions;
};
export type RealmSourceWork = { work: string; workRevision: string };
export type RealmSourceReply = {
  reply: string; variantId: string; revisionId: string; revisionDigest: string;
  author: string; rootTarget: string; rootRevision: string; parentReply: string | null;
  parentRevision: string | null; contextRevision: null; placement: string; body: string;
};
export type RealmSourceRequest = {
  phase: string; service: 'Main' | 'Account' | 'Mailpit'; caller: { accountId: string | null; actingSubject: string | null };
  method: string; path: string; key: string | null; body: unknown;
  startedAt: number; finishedAt: number; status: number; answer: unknown;
};
type Distribution = { count: number; medianMs: number; p95Ms: number; totalMs: number };
export type RealmSourceMeasurements = {
  requests: number; retries: number; retryGapMs: number; declaredRetryWaitMs: number;
  classes: Record<string, Distribution>; phases: Record<string, {
    wallMs: number; overlapMs: number; requests: Distribution; classes: Record<string, Distribution>;
  }>;
};

function distribution(values: number[]): Distribution {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const median = !sorted.length ? 0 : sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
  return { count: values.length, medianMs: median,
    p95Ms: sorted.length ? sorted[Math.ceil(sorted.length * .95) - 1]! : 0,
    totalMs: values.reduce((sum, value) => sum + value, 0) };
}

/** Only actual attempts enter distributions; concurrent intervals count once for
 * phase wall coverage. Gaps between same-key attempts remain distinct from work. */
export function realmSourceMeasurements(requests: readonly RealmSourceRequest[],
  intervals: Record<string, { startedAt: number; finishedAt: number }>): RealmSourceMeasurements {
  const classes: Record<string, number[]> = {}, byPhase: Record<string, RealmSourceRequest[]> = {};
  const seen = new Map<string, RealmSourceRequest>();
  let retries = 0, retryGapMs = 0, declaredRetryWaitMs = 0;
  for (const request of requests) {
    const name = `${request.service} ${request.method} ${request.path.split('?')[0]!.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, ':id')}`;
    (classes[name] ??= []).push(request.finishedAt - request.startedAt);
    (byPhase[request.phase] ??= []).push(request);
    if (request.key) {
      const key = stable([request.service, request.caller.accountId, request.method, request.path, request.key]);
      const previous = seen.get(key);
      if (previous) {
        if (stable(previous.body) !== stable(request.body)) throw new Error('Realm source retry changed command intent');
        retries++;
        retryGapMs += Math.max(0, request.startedAt - previous.finishedAt);
      }
      seen.set(key, request);
    }
    const answer = request.answer as { retry?: { afterMs?: unknown } } | null;
    if (typeof answer?.retry?.afterMs === 'number') declaredRetryWaitMs += answer.retry.afterMs;
  }
  const phases: RealmSourceMeasurements['phases'] = {};
  for (const [phase, interval] of Object.entries(intervals)) {
    const items = byPhase[phase] ?? [], spans = items.map(item => [item.startedAt, item.finishedAt] as const).sort((a, b) => a[0] - b[0]);
    let covered = 0, end = -Infinity;
    for (const [start, finish] of spans) { covered += Math.max(0, finish - Math.max(start, end)); end = Math.max(end, finish); }
    const requestDistribution = distribution(items.map(item => item.finishedAt - item.startedAt));
    const local: Record<string, number[]> = {};
    for (const item of items) {
      const name = `${item.service} ${item.method} ${item.path.split('?')[0]!.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, ':id')}`;
      (local[name] ??= []).push(item.finishedAt - item.startedAt);
    }
    phases[phase] = { wallMs: interval.finishedAt - interval.startedAt,
      overlapMs: requestDistribution.totalMs - covered, requests: requestDistribution,
      classes: Object.fromEntries(Object.entries(local).map(([name, values]) => [name, distribution(values)])) };
  }
  return { requests: requests.length, retries, retryGapMs, declaredRetryWaitMs,
    classes: Object.fromEntries(Object.entries(classes).map(([name, values]) => [name, distribution(values)])), phases };
}

export type RealmSourceMetadata = {
  contract: 'realm-discussion-source-v1'; population: typeof realmSourcePopulation;
  realms: Record<keyof RealmSourceSessions, RetainedPersonaRealm>;
  authoritySnapshots: Record<keyof RealmSourceSessions, { members: RetainedOwnerState; roles: RetainedOwnerState; settings: RetainedOwnerState }>;
  /** Restores preserve the producer's moderation deadline; expired sources refuse. */
  startingStatesValidUntil: number;
  sequenceStarts: Record<'ranking' | 'discussion', Record<PersonaName, {
    publicRealm: string; privateRealm: string; accountId: string | null; actingSubject: string | null;
    privateAccountId: string | null; privateActingSubject: string | null;
  }>>;
  ranking: { publicWork: RealmSourceWork; retainedWork: RealmSourceWork; currentWork: RealmSourceWork;
    states: { emptyRealm: string; movedRealm: string };
    public: RealmSourceReply[]; retained: RealmSourceReply[]; current: RealmSourceReply[];
    admission: { before: RetainedOwnerState; after: RetainedOwnerState; settings: RetainedOwnerState } };
  discussion: { publicWork: RealmSourceWork; privateWork: RealmSourceWork; roots: RealmSourceReply[];
    siblings: RealmSourceReply[]; nested: RealmSourceReply[]; privateOpener: RealmSourceReply };
  measurements: RealmSourceMeasurements;
};
export type RealmSourceCandidate = { sessions: RealmSourceSessions; metadata: RealmSourceMetadata;
  runId: string; preparation: { restoreMs: number; startupMs: number; readinessMs: number; totalMs: number; admissionWaitMs: number };
  close(): Promise<void> };
export type RealmSourceRuntime = {
  bootstrap(observe: (request: RealmSourceRequest) => void, phase: () => string): Promise<RealmSourceSessions>;
  retain(sessions: PersonaSessions): RetainedPersonaRealm;
  cut(context: SourceContext, metadata: RealmSourceMetadata): Promise<{ rdfDigest: string; ownerState: RetainedOwnerState }>;
  verify(context: SourceContext, ownerState: RetainedOwnerState, rdfDigest: string): Promise<string[]>;
  restore(context: SourceContext, metadata: RealmSourceMetadata): Promise<RealmSourceCandidate>;
  remove(key: string): Promise<void>;
  revision: string; qaIdentity: string;
};

export function realmDiscussionSourceSpecification(files: Record<string, string>, compatibility: RetainedOwnerState): SourceInputs {
  return { producer: 'realm-discussion-source', version: '1', files, compatibility,
    inputs: { population: realmSourcePopulation, roles: [...realmSourceRoles], language: 'en', direction: 'ltr',
      authoring: 'own-work', batch: 8, identityPublication: 'serial-no-overlapping-writes',
      authorityLifetimeMs: realmSourceAuthorityLifetimeMs,
      producerDeadlineMs: realmSourceBuildDeadlineMs, producerDeadlineEvidence: realmSourceBuildEvidence } };
}

const short = (value: string) => value.slice(-36);
const acting = (person: PersonaSession) => new URLSearchParams(person.actingSubject ? { actingSubject: person.actingSubject } : {});
function requireFact(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`Realm source integrity: ${message}`);
}
async function answer<T>(pending: Promise<Response>, status = 200): Promise<T> {
  const response = await pending, raw = await response.text();
  if (response.status !== status) throw new Error(`Realm source expected ${status}, got ${response.status}: ${raw}`);
  return JSON.parse(raw) as T;
}
async function together<T>(pending: Promise<T>[]): Promise<T[]> {
  const results = await Promise.allSettled(pending);
  return results.map(result => { if (result.status === 'rejected') throw result.reason; return result.value; });
}

export function validateRealmSourceMetadata(metadata: RealmSourceMetadata, now = Date.now()): void {
  requireFact(metadata.contract === 'realm-discussion-source-v1', 'contract differs');
  requireFact(stable(metadata.population) === stable(realmSourcePopulation), 'populations differ');
  requireFact(metadata.startingStatesValidUntil > now, 'original moderation starting states have expired');
  const { ranking, discussion } = metadata;
  requireFact(/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(ranking.states?.emptyRealm)
    && /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(ranking.states?.movedRealm)
    && ranking.states.emptyRealm !== ranking.states.movedRealm, 'ranking state Realms differ');
  const collections = [ranking.public, ranking.retained, ranking.current, discussion.roots,
    discussion.siblings, discussion.nested, [discussion.privateOpener]];
  const counts = Object.values(realmSourcePopulation);
  collections.forEach((items, index) => requireFact(items.length === counts[index], `inventory ${index} incomplete`));
  const all = collections.flat();
  requireFact(new Set(all.map(item => item.reply)).size === 552, 'reply identities overlap');
  requireFact(new Set(all.map(item => item.placement)).size === 552, 'placements overlap');
  const targets = [ranking.publicWork, ranking.retainedWork, ranking.currentWork, discussion.publicWork,
    discussion.publicWork, discussion.publicWork, discussion.privateWork];
  const owners = [metadata.realms.rankingPublic, metadata.realms.rankingPrivate, metadata.realms.rankingPrivate,
    metadata.realms.discussionPublic, metadata.realms.discussionPublic, metadata.realms.discussionPublic, metadata.realms.discussionPrivate];
  collections.forEach((items, index) => items.forEach(item => {
    requireFact(item.rootTarget === targets[index]!.work && item.rootRevision === targets[index]!.workRevision, 'root binding differs');
    requireFact(item.author === owners[index]!.identities.owner.actingSubject, 'original author differs');
    requireFact(Boolean(item.variantId && item.revisionId && /^[a-f0-9]{64}$/.test(item.revisionDigest) && item.body), 'exact authored revision missing');
    requireFact(item.contextRevision === null, 'context binding differs');
    if (index < 4 || index === 6) requireFact(item.parentReply === null && item.parentRevision === null, 'root parent differs');
  }));
  const opener = discussion.roots[0]!;
  discussion.siblings.forEach(item => requireFact(item.parentReply === opener.reply && item.parentRevision === opener.revisionId, 'sibling binding differs'));
  discussion.nested.forEach((item, index) => {
    const parent = index ? discussion.nested[index - 1]! : opener;
    requireFact(item.parentReply === parent.reply && item.parentRevision === parent.revisionId, 'nested chain differs');
  });
  requireFact(stable(ranking.admission.before) !== stable(ranking.admission.after), 'private participation transition missing');
  const settings = ranking.admission.settings.settings as RetainedOwnerState;
  requireFact(settings?.history === 'from-admission' && settings.visibility === 'private' && settings.admission === 'invitation',
    'private admission-history settings differ');
  for (const row of ['ranking', 'discussion'] as const) for (const role of realmSourceRoles) {
    const pub = metadata.realms[row === 'ranking' ? 'rankingPublic' : 'discussionPublic'];
    const priv = metadata.realms[row === 'ranking' ? 'rankingPrivate' : 'discussionPrivate'];
    const start = metadata.sequenceStarts[row][role];
    requireFact(start.publicRealm === pub.realm && start.privateRealm === priv.realm, 'sequence Realm differs');
    requireFact(start.accountId === (role === 'visitor' ? null : pub.identities[role].accountId) &&
      start.actingSubject === (role === 'visitor' ? null : pub.identities[role].actingSubject) &&
      start.privateAccountId === (role === 'visitor' ? null : priv.identities[role].accountId) &&
      start.privateActingSubject === (role === 'visitor' ? null : priv.identities[role].actingSubject), 'sequence identity differs');
  }
}

async function boundRead(person: PersonaSession, work: RealmSourceWork) {
  const selected = await answer<{ id: string; revision: string }>(person.main('GET', `/v1/works/${short(work.work)}?${acting(person)}`));
  requireFact(selected.id === work.work && selected.revision === work.workRevision, 'public Work read changed exact binding');
}
async function authority(person: PersonaSession, work: RealmSourceWork) {
  const account = await answer<{ user: { id: string }; session: { userId: string } }>(person.account('GET', '/api/auth/get-session'));
  requireFact(account.user.id === person.accountId && account.session.userId === person.accountId, 'Account authority differs');
  const session = await answer<{ sessionAgent: { actingSubject: string; eligible: boolean } }>(person.main('GET', '/v1/me/session-agent'));
  requireFact(session.sessionAgent.actingSubject === person.actingSubject && session.sessionAgent.eligible, 'session authority differs');
  const agents = await answer<{ items: { actingSubject: string; kind: string }[] }>(person.main('GET', '/v1/me/agents'));
  requireFact(agents.items.some(item => item.actingSubject === person.actingSubject && item.kind === 'person'), 'author is not the represented Person');
  await boundRead(person, work);
  await answer(person.main('GET', `/v1/revisions/${short(work.workRevision)}?${acting(person)}`));
}
async function command<T>(person: PersonaSession, work: RealmSourceWork, path: string, body: unknown): Promise<T> {
  const key = randomUUID();
  for (let attempt = 0; ; attempt++) {
    const response = await person.main('POST', path, body, key);
    if (response.status === 409 && attempt < 24) {
      const problem = await response.clone().json() as { code: string };
      if (problem.code === 'read_basis_changed') { await boundRead(person, work); continue; }
    }
    const saved = await answer<T & { replayed?: boolean }>(Promise.resolve(response), response.status === 200 ? 200 : 201);
    requireFact(saved.replayed === (response.status === 200), 'publication replay answer differs');
    return saved;
  }
}

async function grow(sessions: PersonaSessions, work: RealmSourceWork, bodies: string[], parent: RealmSourceReply | null = null) {
  const person = sessions.owner;
  const drafts = await together(bodies.map(async body => {
    const reply = `https://rezics.com/id/${randomUUID()}`, variantId = `urn:rezics:variant:${randomUUID()}`;
    const draft = await command<{ revisionId: string; revisionDigest: string }>(person, work, '/v1/member-reply-drafts', {
      profile: 'member-reply-draft-v1', reply, variantId, rootTarget: work.work, rootRevision: work.workRevision,
      originRealm: sessions.realm, language: 'en', direction: 'ltr', expectedHead: null, body, actingSubject: person.actingSubject });
    return { reply, variantId, ...draft, body, author: person.actingSubject!, rootTarget: work.work, rootRevision: work.workRevision,
      parentReply: parent?.reply ?? null, parentRevision: parent?.revisionId ?? null, contextRevision: null };
  }));
  // Content drafts can overlap. Keep identity's root reads clear of writes.
  for (const item of drafts) {
    const identity = { profile: 'realm-reply-identity-v1', reply: item.reply, variantId: item.variantId, revisionId: item.revisionId,
      author: item.author, rootTarget: item.rootTarget, rootRevision: item.rootRevision,
      parentReply: item.parentReply, parentRevision: item.parentRevision, contextRevision: null };
    const saved = await command<typeof identity>(person, work, '/v1/realm-replies', identity);
    for (const field of Object.keys(identity) as (keyof typeof identity)[])
      requireFact(saved[field] === identity[field], `identity publication changed ${field}`);
  }
  const placed: RealmSourceReply[] = [];
  // Eight queued graph commands exceeded the native 12-second command bound.
  // Pairs overlap admission/settlement without building that writer queue.
  for (let start = 0; start < drafts.length; start += 2) placed.push(...await together(drafts.slice(start, start + 2).map(async item => {
    const placement = await command<{ placement: string }>(person, work, '/v1/realm-reply-placements', {
      profile: 'realm-reply-placement-v1', realm: sessions.realm, reply: item.reply,
      revisionId: item.revisionId, revisionDigest: item.revisionDigest, reviewDecisionId: null,
      expectedHead: null, actingSubject: person.actingSubject });
    return { ...item, placement: placement.placement };
  })));
  return placed;
}

async function createWork(sessions: PersonaSessions, title: string) {
  const work = await answer<RealmSourceWork & { mainVersion: string }>(sessions.owner.main('POST', '/v1/works', {
    profile: 'metadata-only-v1', title, language: 'en', authoring: 'own-work', actingSubject: sessions.owner.actingSubject }), 201);
  // Discussion disclosure follows the root's publication as well as Realm
  // membership. Metadata alone leaves non-author members with no visible roots.
  const author = sessions.owner.actingSubject;
  const contribution = await answer<{ contribution: string; draftRevision: string }>(sessions.owner.main('POST', '/v1/contributions', {
    profile: 'text-contribution-v1', work: work.work, language: 'en',
    body: `An original essay about ${title}.`, actingSubject: author }), 201);
  const publication = await answer<{ publicationDecision: string }>(sessions.owner.main('POST', '/v1/contribution-publications', {
    profile: 'text-publication-v1', contribution: contribution.contribution,
    expectedDraftHead: contribution.draftRevision, expectedPublicationHead: null,
    rightsBasis: 'original-contribution', disclosure: 'public', actingSubject: author }), 201);
  await answer(sessions.owner.main('POST', '/v1/publication-selections', {
    profile: 'main-default-selection-v1', work: work.work, contribution: contribution.contribution,
    publicationDecision: publication.publicationDecision, expectedSelectionHead: null,
    context: { kind: 'main-version-default', id: work.mainVersion }, selectionBasis: 'main-maintainer',
    actingSubject: author }), 201);
  await authority(sessions.owner, work);
  return work;
}
async function populate(sessions: PersonaSessions, work: RealmSourceWork, size: number, body: (index: number) => string,
  parent: RealmSourceReply | null = null) {
  const replies: RealmSourceReply[] = [];
  for (let start = 0; start < size; start += 8)
    replies.push(...await grow(sessions, work, Array.from({ length: Math.min(8, size - start) }, (_, offset) => body(start + offset)), parent));
  return replies;
}

/** Public production only. The runtime performs physical custody; this builder
 * has no store handles or authority-writing escape hatch. */
export async function buildRealmDiscussionCorpus(runtime: RealmSourceRuntime, context: SourceContext) {
  let stage = 'bootstrap';
  const requests: RealmSourceRequest[] = [], intervals: Record<string, { startedAt: number; finishedAt: number }> = {};
  const startedAt = Date.now();
  if (!/^[a-z0-9][a-z0-9-]{0,160}$/.test(context.key) || !/^[a-z0-9][a-z0-9-]{0,60}$/.test(runtime.qaIdentity))
    throw new Error('Realm producer evidence requires safe source/run identities');
  const evidence = join(import.meta.dir, '../../../.temp/realm-source-evidence', runtime.qaIdentity, context.key);
  mkdirSync(evidence, { recursive: true, mode: 0o700 });
  let failed = false;
  const phase = async <T>(name: string, run: () => Promise<T>): Promise<T> => {
    context.budget.remaining(); stage = name;
    intervals[name] = { startedAt: Date.now(), finishedAt: Date.now() };
    try { return await run(); } finally { intervals[name]!.finishedAt = Date.now(); }
  };
  let sessions: RealmSourceSessions | undefined;
  try {
    sessions = await phase('bootstrap', () => runtime.bootstrap(request => {
      requests.push(request);
      mkdirSync(context.directory, { recursive: true });
      // Account attempts retain timing/identity only; passwords and OAuth bodies never enter diagnostics.
      appendFileSync(join(context.backup, 'producer-requests.jsonl'), stable(request) + '\n', { mode: 0o600 });
      appendFileSync(join(evidence, 'producer-requests.jsonl'), stable(request) + '\n', { mode: 0o600 });
      context.budget.remaining();
    }, () => stage));
    const live = sessions;
    const bounded = new WeakSet<PersonaSession>();
    for (const realm of Object.values(live)) for (const role of realmSourceRoles) {
      const person = realm[role];
      if (bounded.has(person)) continue;
      bounded.add(person);
      for (const service of ['main', 'account'] as const) {
        const call = person[service];
        person[service] = async (...args) => {
          context.budget.remaining();
          const response = await call(...args);
          context.budget.remaining();
          return response;
        };
      }
    }
    const publicWork = await phase('public-ranking-root', () => createWork(live.rankingPublic, 'Original public ranking garden'));
    const pub = await phase('public-ranking', () => populate(live.rankingPublic, publicWork, 261,
      index => `Original public thread ${index}\nA synthetic discussion authored for this ranking proof.`));
    const retainedWork = await phase('retained-private-root', () => createWork(live.rankingPrivate, 'Original retained ranking garden'));
    const retained = await phase('retained-private-participation', () => populate(live.rankingPrivate, retainedWork, 21,
      index => `Original retained thread ${index}\nA synthetic discussion authored for this ranking proof.`));
    const admission = await phase('participation-transition', async () => {
      const owner = live.rankingPrivate.owner, root = `/v1/realms/${short(live.rankingPrivate.realm)}`;
      const settingsPath = `/v1/spaces/${short(live.rankingPrivate.space)}/settings`;
      const settings = await answer<{ generation: string }>(owner.main('GET', `${settingsPath}?${acting(owner)}`));
      await answer(owner.main('PUT', settingsPath, { actingSubject: owner.actingSubject, expectedGeneration: settings.generation,
        reason: 'Retain discussion history while fencing the next admission',
        settings: { visibility: 'private', listing: 'listed', history: 'from-admission', admission: 'invitation' } }), 201);
      const before = await answer<RetainedOwnerState & { generation: string; items: { member: string; membershipGeneration: string }[] }>(owner.main('GET', `${root}/members?${acting(owner)}`));
      const member = before.items.find(item => item.member === live.rankingPrivate.member.actingSubject);
      requireFact(Boolean(member), 'previous admission is missing');
      await answer(owner.main('POST', `${root}/members`, { actingSubject: owner.actingSubject,
        member: live.rankingPrivate.member.actingSubject, expectedGeneration: before.generation,
        expectedMembershipGeneration: member!.membershipGeneration, reason: 'End the previous participation episode',
        action: 'remove', consent: null, durationSeconds: null }), 201);
      const invitation = await answer<{ invitation: { id: string } }>(owner.main('POST', `${root}/invitations`, {
        actingSubject: owner.actingSubject, member: live.rankingPrivate.member.actingSubject, expiresInSeconds: 3600 }));
      await answer(live.rankingPrivate.member.main('POST', `${root}/invitations/${invitation.invitation.id}/response`, {
        actingSubject: live.rankingPrivate.member.actingSubject, action: 'accept', listed: false }));
      return { before, after: await answer<RetainedOwnerState>(owner.main('GET', `${root}/members?${acting(owner)}`)),
        settings: await answer<RetainedOwnerState>(owner.main('GET', `${settingsPath}?${acting(owner)}`)) };
    });
    const currentWork = await phase('current-private-root', () => createWork(live.rankingPrivate, 'Original current ranking garden'));
    const current = await phase('current-private-participation', () => populate(live.rankingPrivate, currentWork, 21,
      index => `Original current thread ${index}\nA synthetic discussion authored for this ranking proof.`));
    const discussionWork = await phase('discussion-public-root', () => createWork(live.discussionPublic, 'Original discussion garden'));
    const privateWork = await phase('discussion-private-root', () => createWork(live.discussionPrivate, 'Private discussion garden'));
    const roots = await phase('discussion-roots', () => populate(live.discussionPublic, discussionWork, 21,
      index => `Garden ${index}\nAn original discussion of growing a garden.`));
    const siblings = await phase('discussion-siblings', () => populate(live.discussionPublic, discussionWork, 193,
      index => `Original sibling ${index}.`, roots[0]!));
    const nested = await phase('discussion-nested', async () => {
      const replies: RealmSourceReply[] = [];
      let parent = roots[0]!;
      for (let depth = 0; depth < 34; depth++) {
        parent = (await grow(live.discussionPublic, discussionWork, [`Original depth ${depth}.`], parent))[0]!;
        replies.push(parent);
      }
      return replies;
    });
    const privateOpener = await phase('discussion-private-opener', async () => (await grow(live.discussionPrivate, privateWork,
      ['Private garden\nAn original contribution in a private Realm.']))[0]!);
    const rankingStates = await phase('ranking-chart-and-cursor-states', () => prepareRealmRankingStates(live.rankingPublic));
    const realms = Object.fromEntries(Object.entries(live).map(([name, value]) => [name, runtime.retain(value)])) as RealmSourceMetadata['realms'];
    const authoritySnapshots = await phase('starting-authority-snapshots', async () => Object.fromEntries(await together(
      Object.entries(live).map(async ([name, realm]) => [name, await realmAuthoritySnapshot(realm)] as const))) as RealmSourceMetadata['authoritySnapshots']);
    const sequenceStarts = Object.fromEntries((['ranking', 'discussion'] as const).map(row => {
      const pub = row === 'ranking' ? live.rankingPublic : live.discussionPublic;
      const priv = row === 'ranking' ? live.rankingPrivate : live.discussionPrivate;
      return [row, Object.fromEntries(realmSourceRoles.map(role => [role, {
        publicRealm: pub.realm, privateRealm: priv.realm, accountId: pub[role].accountId, actingSubject: pub[role].actingSubject,
        privateAccountId: priv[role].accountId, privateActingSubject: priv[role].actingSubject }]))];
    })) as RealmSourceMetadata['sequenceStarts'];
    const metadata: RealmSourceMetadata = { contract: 'realm-discussion-source-v1', population: realmSourcePopulation,
      realms, authoritySnapshots, startingStatesValidUntil: startedAt + realmSourceAuthorityLifetimeMs, sequenceStarts,
      ranking: { publicWork, retainedWork, currentWork, public: pub, retained, current, admission, states: rankingStates },
      discussion: { publicWork: discussionWork, privateWork, roots, siblings, nested, privateOpener },
      measurements: realmSourceMeasurements(requests, intervals) };
    await phase('verify-complete-source', () => verifyRealmDiscussionCorpus(live, metadata));
    metadata.measurements = realmSourceMeasurements(requests, intervals);
    return { metadata, sessions: live };
  } catch (error) { failed = true; throw error; }
  finally {
    try {
      const report = stable(realmSourceMeasurements(requests, intervals)) + '\n';
      writeFileSync(join(evidence, 'producer-measurements.json'), report, { mode: 0o600 });
      writeFileSync(join(context.backup, 'producer-measurements.json'), report, { mode: 0o600 });
    } catch (error) {
      if (!failed) throw error;
      console.error('Realm producer evidence persistence also failed; preserving the producer exception');
    }
  }
}

async function realmAuthoritySnapshot(realm: PersonaSessions) {
  const owner = realm.owner, root = `/v1/realms/${short(realm.realm)}`, query = acting(owner);
  return { members: await answer<RetainedOwnerState>(owner.main('GET', `${root}/members?${query}`)),
    roles: await answer<RetainedOwnerState>(owner.main('GET', `${root}/roles?${query}`)),
    settings: await answer<RetainedOwnerState>(owner.main('GET', `/v1/spaces/${short(realm.space)}/settings?${query}`)) };
}

/** Complete API inventory, including exact authored revisions and concealed
 * historical/private resources. This is custody readiness, not the twelve row proofs. */
export async function verifyRealmDiscussionCorpus(sessions: RealmSourceSessions, metadata: RealmSourceMetadata, row?: 'ranking') {
  validateRealmSourceMetadata(metadata);
  for (const [name, realm] of Object.entries(sessions).filter(([name]) => !row || name.startsWith(row)))
    requireFact(stable(await realmAuthoritySnapshot(realm)) === stable(metadata.authoritySnapshots[name as keyof RealmSourceSessions]),
      'restored membership, role or disclosure starting state differs');
  const collect = async (realm: PersonaSessions, role: PersonaName) => {
    const person = realm[role], query = acting(person); query.set('sort', 'new'); query.set('limit', '20');
    const replies: string[] = [], cursors = new Set<string>();
    for (;;) {
      const page = await answer<{ items: { reply: string }[]; nextCursor: string | null;
        count: { value: number; kind: string; total: null } }>(person.main('GET', `/v1/realms/${short(realm.realm)}/threads?${query}`));
      requireFact(page.count.kind === 'exact-page' && page.count.value === page.items.length && page.count.total === null, 'thread count differs');
      replies.push(...page.items.map(item => item.reply));
      if (!page.nextCursor) break;
      requireFact(!cursors.has(page.nextCursor), 'thread continuation did not advance');
      cursors.add(page.nextCursor); query.set('cursor', page.nextCursor);
    }
    requireFact(new Set(replies).size === replies.length, 'thread inventory repeats');
    return replies.sort();
  };
  const same = (actual: string[], expected: RealmSourceReply[]) => requireFact(stable(actual) === stable(expected.map(item => item.reply).sort()),
    `complete API thread inventory differs: expected ${expected.length}, read ${actual.length}`);
  same(await collect(sessions.rankingPublic, 'owner'), metadata.ranking.public);
  for (const role of ['owner', 'moderator', 'member'] as const) same(await collect(sessions.rankingPrivate, role),
    role === 'member' ? metadata.ranking.current : [...metadata.ranking.retained, ...metadata.ranking.current]);
  if (!row) {
    same(await collect(sessions.discussionPublic, 'owner'), metadata.discussion.roots);
    same(await collect(sessions.discussionPrivate, 'member'), [metadata.discussion.privateOpener]);
  }
  const inventories: [PersonaSessions, RealmSourceWork, RealmSourceReply[]][] = [
    [sessions.rankingPublic, metadata.ranking.publicWork, metadata.ranking.public],
    [sessions.rankingPrivate, metadata.ranking.retainedWork, metadata.ranking.retained],
    [sessions.rankingPrivate, metadata.ranking.currentWork, metadata.ranking.current],
    [sessions.discussionPublic, metadata.discussion.publicWork, [...metadata.discussion.roots, ...metadata.discussion.siblings, ...metadata.discussion.nested]],
    [sessions.discussionPrivate, metadata.discussion.privateWork, [metadata.discussion.privateOpener]],
  ];
  for (const [realm, work, items] of inventories) {
    if (row && realm !== sessions.rankingPublic && realm !== sessions.rankingPrivate) continue;
    await authority(realm.owner, work);
    // The producer proves every exact revision, and physical custody binds
    // those immutable bytes. The ranking outcome traverses the complete restored
    // inventory for all six readers; do not hydrate it once more during readiness.
    if (row) continue;
    for (let start = 0; start < items.length; start += 8) await together(items.slice(start, start + 8).map(async expected => {
      // These views read the completed source with no producer writes left.
      const [selected, placed, branch] = await Promise.all([
        answer<RealmSourceReply>(realm.owner.main('GET', `/v1/member-replies/${short(expected.reply)}?${acting(realm.owner)}`)),
        answer<{ placement: string; realm: string; reply: string; revisionId: string; author: string; rootTarget: string }>(
        realm.owner.main('GET', `/v1/realms/${encodeURIComponent(realm.realm)}/replies/${encodeURIComponent(expected.reply)}?${acting(realm.owner)}`)),
        answer<{ rootRevision: string; items: { reply: string; parent: string | null; revisionId: string }[] }>(
        realm.owner.main('GET', `/v1/realms/${short(realm.realm)}/threads/${short(expected.reply)}?${acting(realm.owner)}`)),
      ]);
      for (const field of ['reply', 'variantId', 'revisionId', 'revisionDigest', 'author', 'rootTarget', 'rootRevision', 'body'] as const)
        requireFact(selected[field] === expected[field], `restored exact reply ${field} differs`);
      for (const field of ['placement', 'reply', 'revisionId', 'author', 'rootTarget'] as const)
        requireFact(placed[field] === expected[field], `restored placement ${field} differs`);
      requireFact(placed.realm === realm.realm, 'restored placement Realm differs');
      const focus = branch.items.find(item => item.reply === expected.reply);
      requireFact(branch.rootRevision === expected.rootRevision && focus?.revisionId === expected.revisionId &&
        focus.parent === expected.parentReply, 'restored exact thread binding differs');
    }));
  }
  const member = sessions.rankingPrivate.member;
  await answer(member.main('GET', `/v1/realms/${short(sessions.rankingPrivate.realm)}/threads/${short(metadata.ranking.retained[0]!.reply)}?${acting(member)}`), 404);
  for (const realm of row ? [sessions.rankingPrivate] : [sessions.rankingPrivate, sessions.discussionPrivate]) for (const role of ['visitor', 'stranger', 'operator'] as const) {
    const person = realm[role];
    for (const suffix of ['', '/threads']) await answer(person.main('GET', `/v1/realms/${short(realm.realm)}${suffix}?${acting(person)}`), 404);
  }
}

export function realmDiscussionSourceAdapter(specification: SourceInputs, runtime: RealmSourceRuntime, row?: 'ranking'): RetainedSourceAdapter<RealmSourceMetadata, RealmSourceCandidate> {
  let produced: Awaited<ReturnType<typeof buildRealmDiscussionCorpus>> | undefined;
  let living: RealmSourceSessions | undefined;
  return { specification,
    producerBuild: { deadlineMs: realmSourceBuildDeadlineMs, evidence: realmSourceBuildEvidence,
      async run(context) {
        produced = await buildRealmDiscussionCorpus({ ...runtime,
          async bootstrap(observe, phase) { living = await runtime.bootstrap(observe, phase); return living; } }, context);
      } },
    async build(context) {
      if (!produced) throw new Error('Realm physical cut requires the completed measured producer build');
      await produced.sessions.rankingPublic.close();
      const metadata = produced.metadata;
      validateRealmSourceMetadata(metadata);
      const physical = await runtime.cut(context, metadata);
      return { ...physical, metadata, producerRevision: runtime.revision, qaIdentity: runtime.qaIdentity,
        phases: Object.fromEntries(Object.entries(metadata.measurements.phases).map(([phase, value]) => [phase, value.wallMs])) };
    },
    async verify(context, manifest) {
      validateRealmSourceMetadata(manifest.metadata);
      requireFact(stable(manifest.integrity.ownerState.corpus) === stable(manifest.metadata), 'backup corpus descriptor differs');
      return runtime.verify(context, manifest.integrity.ownerState, manifest.integrity.rdfDigest);
    },
    async restore(context, manifest) {
      validateRealmSourceMetadata(manifest.metadata);
      const candidate = await runtime.restore(context, manifest.metadata);
      const verificationStarted = Date.now();
      try {
        await verifyRealmDiscussionCorpus(candidate.sessions, manifest.metadata, row); context.budget.remaining();
        const verificationMs = Date.now() - verificationStarted;
        candidate.preparation.readinessMs += verificationMs; candidate.preparation.totalMs += verificationMs;
        return candidate;
      }
      catch (error) { await candidate.close(); throw error; }
    },
    dispose: candidate => candidate.close(),
    async remove(key) {
      try { if (living) { await living.rankingPublic.close(); living = undefined; produced = undefined; } }
      finally { await runtime.remove(key); }
    },
  };
}

/** Default construction imports physical helpers only when explicitly preparing
 * or consuming this source. Unit regressions inject a stack-free runtime. */
export async function realmDiscussionSource(directory?: string, row?: 'ranking') {
  const runtime = await import('./realm-discussion-source-runtime.ts');
  const adapter = realmDiscussionSourceAdapter(await runtime.realmSourceInputs(), runtime.realmSourceRuntime(), row);
  return { adapter, sources: new RetainedSources(directory ?? runtime.realmSourceDirectory()) };
}
