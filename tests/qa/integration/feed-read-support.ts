import { createHash, randomUUID } from 'node:crypto';
import pg, { Pool, type QueryResult } from 'pg';
import { createMainApp } from '../../../services/main/src/app.ts';
import { AccountAssertionDenied } from '../../../services/main/src/modules/account/verify-assertion.ts';
import { AgentProvisioning } from '../../../services/main/src/modules/agent/provision.ts';
import { AgentVanityHandles } from '../../../services/main/src/modules/agent/vanity.ts';
import { HomePersonalStore } from '../../../services/main/src/modules/feed/personal.ts';
import { FeedRefreshWorker } from '../../../services/main/src/modules/feed/refresh.ts';
import { FeedStore } from '../../../services/main/src/modules/feed/store.ts';
import { FeedViewerStateReader } from '../../../services/main/src/modules/feed/viewer-state.ts';
import { FollowsStore } from '../../../services/main/src/modules/follows/store.ts';
import { ReaderLibraryStatusStore } from '../../../services/main/src/modules/library/status.ts';
import { initializeRelayCheckpoint, relayMainOutboxOnce } from '../../../services/main/src/modules/outbox/relay.ts';
import { RelayHandoffPositions } from '../../../services/main/src/modules/outbox/relay-position.ts';
import { ProfilesAccess } from '../../../services/main/src/modules/profiles/access.ts';
import { StructureProgressStore } from '../../../services/main/src/modules/progress/store.ts';
import { RealmReplyContentStore } from '../../../services/main/src/modules/realm-reply/content-store.ts';
import { RealmReplyStore } from '../../../services/main/src/modules/realm-reply/store.ts';
import { RealmReplyThreadStore } from '../../../services/main/src/modules/realm-reply/thread-store.ts';
import { ReaderReviews } from '../../../services/main/src/modules/review/store.ts';
import { SavedFilterStore } from '../../../services/main/src/modules/saved-filter/store.ts';
import { GRAPHS, iri } from '../../../services/main/src/modules/work/activate.ts';
import { realmSelectionDigest, selectRealmLocal } from '../../../services/main/src/modules/work/select-realm.ts';
import { startMediaStack } from './media-support.ts';
import { PersonPreferencesStore } from '../../../services/main/src/modules/preferences/store.ts';

/** The Home reads whose cost the budget and load tests hold. */
export const HOME_READS = {
  bestAll: '/v1/feed?sort=best&scope=all&limit=20',
  newAll: '/v1/feed?sort=new&scope=all&limit=20',
  topAll: '/v1/feed?sort=top&scope=all&limit=20',
  suggestions: '/v1/onboarding/suggested-follows',
} as const;
export const SIGNED_HOME_READS = {
  bestAll: '/v1/feed?sort=best&scope=all&limit=20',
  topAll: '/v1/feed?sort=top&scope=all&limit=20',
  bestFollowing: '/v1/feed?sort=best&scope=following&limit=20',
  newFollowing: '/v1/feed?sort=new&scope=following&limit=20',
  continue: '/v1/me/continue',
  suggestions: '/v1/onboarding/suggested-follows',
} as const;

/**
 * The Home read cost contract at a small, mixed page: Work, Realm pick,
 * discussion, reply, list and chapter cards, and a reader who follows a Realm
 * and a Work and is reading a book. Card parts are page batches, so the bounds
 * do not grow with the corpus; the load tier holds them at 10,000 Works.
 * Measured when set (QA 20260928t055813-6c493e): anonymous feed 72 graph
 * queries and 85 statements, signed feed 89 and 169, Continue 24 and 93,
 * suggestions 18 and 50. Before G-383 an anonymous Best page on the shared
 * seed issued 109 graph queries and 480 statements in 71 Access transactions.
 */
export const HOME_READ_BUDGET = {
  anonymous: { graphQueries: 85, statements: 100 },
  // Four summary batches can now each read current canonical names with one
  // plain SQL query. No new authority transaction belongs in that hot path.
  signed: { graphQueries: 105, statements: 204 },
  continue: { graphQueries: 30, statements: 110 },
  suggestions: { graphQueries: 25, statements: 60 },
} as const;

/**
 * One vote on one activity: its admission is a fixed read of that activity's
 * source, author, Work, Realm and (for a reply) body, run before the vote's
 * transaction takes the projection's checkpoint, so votes never queue behind
 * a slow read. Measured when set (QA 20260928t091959-349537): 18 graph
 * queries and 64 statements, most of them the admission's Access fences.
 */
export const HOME_VOTE_BUDGET = { graphQueries: 25, statements: 75 } as const;

/** The budget a read is held to. */
export const budgetFor = (name: string, signed: boolean) => name === 'continue' ? HOME_READ_BUDGET.continue
  : name === 'suggestions' ? HOME_READ_BUDGET.suggestions : signed ? HOME_READ_BUDGET.signed : HOME_READ_BUDGET.anonymous;

/**
 * Counts every SQL statement this process sends. Each transaction opened with
 * asynchronous commit is also proved, on its own backend, to change no row:
 * its table write counters do not move between BEGIN and COMMIT (the backend
 * flushes them only between transactions, so the delta is this transaction's)
 * and it sends no data-changing statement. Row locks, the only writes such a
 * read may make, move no tuple counter.
 */
export function meterStatements() {
  const prototype = pg.Client.prototype as unknown as { query: (...args: unknown[]) => unknown };
  const original = prototype.query;
  const writes = async (client: object) => (await (original.call(client, `SELECT coalesce(sum(n_tup_ins
    + n_tup_upd + n_tup_del), 0)::integer AS writes FROM pg_stat_xact_all_tables`) as Promise<QueryResult<{
    writes: number }>>)).rows[0]!.writes;
  const open = new WeakMap<object, { sent: string[]; before: number }>();
  let statements = 0, asyncCommits = 0;
  const violations: string[] = [];
  prototype.query = function (this: object, ...args: unknown[]) {
    const text = typeof args[0] === 'string' ? args[0] : (args[0] as { text?: string } | undefined)?.text ?? '';
    const promised = typeof args.at(-1) !== 'function';
    statements++;
    if (promised && /^BEGIN; SET LOCAL synchronous_commit = off$/.test(text)) {
      return (async () => {
        const result = await (original.apply(this, args) as Promise<unknown>);
        open.set(this, { sent: [], before: await writes(this) });
        return result;
      })();
    }
    const state = open.get(this);
    if (state && /^(COMMIT|ROLLBACK)$/.test(text)) {
      open.delete(this);
      if (text === 'COMMIT' && promised) {
        asyncCommits++;
        return (async () => {
          const changedRows = await writes(this) - state.before;
          const changing = state.sent.filter(statement => /^\s*(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|COPY)\b/i.test(statement));
          if (changedRows !== 0 || changing.length) {
            violations.push(`${changedRows} row writes: ${[...changing, ...state.sent].slice(0, 3).join(' | ')}`);
          }
          return original.call(this, 'COMMIT');
        })();
      }
    } else state?.sent.push(text);
    return original.apply(this, args);
  };
  return { count: () => statements, asyncCommits: () => asyncCommits, violations,
    restore: () => { prototype.query = original; } };
}

/** The feed-home composition: real Account principals, API-provisioned Agents,
 * relay delivery and the projection worker, without a web server. */
export async function startHomeStack(label: string) {
  const stack = await startMediaStack(label);
  const relay = new Pool({ connectionString: Bun.env.ACCOUNT_RELAY_DATABASE_URL, max: 2 });
  const author = await stack.member('author'), reader = await stack.member('reader');
  const principals = new Map<string, { issuer: string; subject: string; emailVerified: boolean }>(
    [author, reader].map(member => [member.token, { ...member.principal, emailVerified: true }]));
  const account = { verify: async (request: Request) => {
    const principal = principals.get(request.headers.get('authorization')?.replace('Bearer ', '') ?? '');
    if (!principal) throw new AccountAssertionDenied('Authentication required');
    return { ...principal, currentAssertion: async () => principal };
  } };
  stack.access.configureBaseline(stack.fuseki);
  const structureObjects = stack.objects('feed/structure/');
  await structureObjects.initialize();
  Object.assign(stack.env, { structureObjects });
  const consumer = `feed-${randomUUID()}`;
  const feed = new FeedStore(stack.accessPool);
  const deps = { environment: stack.env, access: stack.access, account, feed,
    follows: new FollowsStore(stack.accessPool), feedViewerState: new FeedViewerStateReader(),
    realmReplies: new RealmReplyStore(new RealmReplyContentStore(stack.contentPool), stack.content, stack.access, stack.env),
    realmReplyThreads: new RealmReplyThreadStore(stack.contentPool, stack.accessPool),
    reviews: new ReaderReviews(stack.accessPool), homePersonal: new HomePersonalStore(stack.accessPool),
    savedFilters: new SavedFilterStore(stack.accessPool),
    libraryStatus: new ReaderLibraryStatusStore(stack.contentPool), progress: new StructureProgressStore(stack.contentPool),
    content: stack.content, contentAuthoring: stack.content, media: stack.media, structureObjects,
    profiles: new ProfilesAccess(stack.accessPool), personPreferences: new PersonPreferencesStore(stack.accessPool), agentHandles: new AgentVanityHandles(stack.accessPool),
    agentProvisioning: new AgentProvisioning(stack.accessPool, stack.env),
    relayPosition: new RelayHandoffPositions(relay, consumer) };
  const app = createMainApp(stack.fuseki, deps);
  const call = (method: string, path: string, body?: unknown, token?: string, key = randomUUID()) => app.handle(
    new Request(`http://main.local${path}`, { method, headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'content-type': 'application/json', 'idempotency-key': key } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) }));
  const json = async <T>(response: Response, expected = 200): Promise<T> => {
    const text = await response.text();
    if (response.status !== expected) throw new Error(`Expected ${expected}, got ${response.status}: ${text}`);
    return JSON.parse(text) as T;
  };
  const provision = async (name: string, token: string) => (await json<{ agent: string }>(
    await call('POST', '/v1/agents', { profile: 'agent-provision-v1', kind: 'person', displayName: name }, token), 201)).agent;
  await initializeRelayCheckpoint(relay, consumer, stack.env.lineage.dataEpoch);
  const project = async () => {
    for (let i = 0; i < 400; i++) if (!await relayMainOutboxOnce(stack.fuseki, relay, consumer)) break;
    for (let i = 0; i < 400; i++) if (await new FeedRefreshWorker(deps, feed, relay).tick() === 'current') return;
    throw new Error('Home projection exceeded its fixture budget');
  };
  const stop = async () => { await relay.end(); await stack.stop(); };
  return { stack, deps, app, call, json, provision, project, author, reader, stop };
}

export type HomeStack = Awaited<ReturnType<typeof startHomeStack>>;

/** A small Home through real commands: public Works with an author credit, a
 * Realm pick, an approved discussion and reply, a public list, and a reader who
 * follows the Realm and one Work and is reading another. */
export async function seedHome(home: HomeStack, works = 6) {
  const { stack, call, json, author: a, reader: b } = home;
  const author = await home.provision('Home author', a.token), reader = await home.provision('Home reader', b.token);
  const grant = async (scope: string, action: string) => {
    await stack.accessPool.query('INSERT INTO access.scope_gate(id) VALUES ($1) ON CONFLICT DO NOTHING', [scope]);
    await stack.accessPool.query(`INSERT INTO access.representation(id,principal_id,subject_id,action,valid_until)
      VALUES ($1,$2,$3,$4,now() + interval '1 hour')`, [randomUUID(), a.principalId, author, action]);
    await stack.accessPool.query(`INSERT INTO access.permission_grant(id,issuer_subject,recipient_subject,scope_id,action,valid_until)
      VALUES ($1,$2,$2,$3,$4,now() + interval '1 hour')`, [randomUUID(), author, scope, action]);
  };
  const published = [];
  for (let index = 0; index < works; index++) published.push(await stack.publicWork(author, ['en'], `Home Work ${index}`));
  const first = published[0]!;
  const realm = await json<{ realm: string; space: string }>(await call('POST', '/v1/spaces', {
    profile: 'space-realm-v1', name: 'Home community', capabilities: ['realm'], actingSubject: author }, a.token), 201);
  const adopt = { context: { kind: 'realm-local' as const, id: realm.realm }, work: first.work,
    mainVersion: first.mainVersion, contribution: first.variants[0]!.contribution,
    publicationDecision: first.variants[0]!.decision, expectedSelectionHead: null,
    selectionBasis: 'realm-manager-review' as const, actingSubject: author };
  const adoption = await selectRealmLocal(stack.env,
    stack.admission(author, `publication:adopt:${realm.realm}`, 'publication.adopt', realmSelectionDigest(adopt)), adopt);
  if (adoption.outcome !== 'succeeded') throw new Error('Realm pick failed');
  await json(await call('POST', '/v1/collections', { collection: `https://rezics.com/id/${randomUUID()}`,
    name: 'Home reading list', disclosure: 'public', actingSubject: author }, a.token), 201);
  const rootRevision = (await stack.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/> SELECT ?draft WHERE {
    GRAPH ${iri(GRAPHS.current)} { ${iri(first.variants[0]!.contribution)} rv:publicationHead ?decision }
    GRAPH ${iri(GRAPHS.revisions)} { ?decision rv:selectedDraft ?draft } } LIMIT 1`)).results!.bindings[0]!.draft!.value;
  for (const [scope, action] of [[`review:decide:${realm.realm}`, 'review.decide'],
    [`reply:place:${realm.realm}`, 'reply.place']] as const) await grant(scope, action);
  const reply = async (body: string, parent?: { reply: string; revisionId: string }) => {
    const id = `https://rezics.com/id/${randomUUID()}`, variantId = `urn:rezics:variant:${randomUUID()}`;
    const draft = await json<{ revisionId: string; revisionDigest: string }>(await call('POST', '/v1/member-reply-drafts', {
      profile: 'member-reply-draft-v1', reply: id, variantId, rootTarget: first.work, rootRevision,
      language: 'en', direction: 'ltr', expectedHead: null, body, actingSubject: reader }, b.token), 201);
    await json(await call('POST', '/v1/realm-replies', { profile: 'realm-reply-identity-v1', reply: id, variantId,
      revisionId: draft.revisionId, author: reader, rootTarget: first.work, rootRevision,
      parentReply: parent?.reply ?? null, parentRevision: parent?.revisionId ?? null, contextRevision: null }, b.token), 201);
    const revisionDigest = draft.revisionDigest;
    const identity = { reply: id, revisionId: draft.revisionId, revisionDigest };
    const approved = await json<{ decisionId: string }>(await call('POST', '/v1/realm-reply-reviews', {
      profile: 'realm-reply-review-v1', realm: realm.realm, ...identity, expectedGeneration: '0', supersedes: null,
      outcome: 'approved', method: 'human', methodRevision: 'home-budget-v1',
      dependencyDigest: createHash('sha256').update(first.work).digest('hex'), reasonReference: null,
      actingSubject: author }, a.token), 201);
    await json(await call('POST', '/v1/realm-reply-placements', { profile: 'realm-reply-placement-v1',
      realm: realm.realm, ...identity, reviewDecisionId: approved.decisionId, expectedHead: null,
      actingSubject: author }, a.token), 201);
    return identity;
  };
  const discussion = await reply('A reviewed Home discussion');
  const response = await reply('A reviewed Home response', discussion);
  // Chapter cards, reader state and Continue's next chapter come from a real
  // book composition of public, search-eligible Content.
  const book = published[2]!;
  await stack.fuseki.update(`PREFIX schema: <https://schema.org/> INSERT DATA { GRAPH ${iri(GRAPHS.current)} {
    ${iri(book.work)} a schema:Book } }`);
  await grant(`work:edit:${book.work}`, 'work.edit');
  const composition = await json<{ structure: string; revision: string }>(await call('POST', '/v1/compositions', {
    profile: 'book-composition', work: book.work, mainVersion: book.mainVersion, actingSubject: author }, a.token), 201);
  const chapters: string[] = [];
  const chapterRevisions: { resource_id: string; id: string }[] = [];
  const chapterPhrase = `Published Home chapter ${randomUUID()}`;
  for (let ordinal = 1; ordinal <= 2; ordinal++) {
    const chapter = await stack.privateWork(author, `Home chapter ${ordinal}`);
    chapters.push(chapter.work);
    const variant = `urn:rezics:variant:${randomUUID()}`;
    for (const [scope, action] of [[`work:read:${chapter.work}`, 'work.read'], [`content:draft:${chapter.work}`, 'content.draft'],
      [`content:publish:${chapter.work}`, 'content.publish'],
      [`content:search-eligibility:${chapter.work}`, 'content.search-eligibility']] as const) await grant(scope, action);
    const saved = await json<{ revisionId: string; sourcePosition: { dataEpoch: string } }>(await call('POST', '/v1/content-drafts', {
      profile: 'content-text-v1', resourceId: chapter.work, variantId: variant,
      language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr', expectedHead: null,
      body: `${chapterPhrase} ${ordinal}`, actingSubject: author }, a.token), 201);
    chapterRevisions.push({ resource_id: chapter.work, id: saved.revisionId });
    const exact = (await stack.content.readExactBatch([saved.revisionId], async ids => new Set(ids)))[0];
    if (exact?.status !== 'available') throw new Error('Missing chapter fixture');
    const publication = await json<{ decision: string }>(await call('POST', '/v1/content-publications', {
      profile: 'content-publication-v1', preparationId: `home-chapter-${randomUUID()}`, revisionId: saved.revisionId,
      expectedDigest: exact.reference.byteDigest, expectedContentEpoch: saved.sourcePosition.dataEpoch,
      resourceId: chapter.work, variantId: variant, expectedPublicationHead: null, actingSubject: author }, a.token), 201);
    await json(await call('POST', '/v1/content-search-eligibility', { profile: 'content-search-eligibility-v1',
      resourceId: chapter.work, variantId: variant, publicationDecision: publication.decision, expectedEligibilityHead: null,
      actingSubject: author, rightsBasis: 'original-contribution', disclosure: 'public' }, a.token), 201);
  }
  await json(await call('POST', `/v1/compositions/${composition.structure.slice(-36)}/changes`, {
    profile: 'book-composition', expectedHead: composition.revision, actingSubject: author,
    operations: chapters.map((target, index) => ({ op: 'insert', parent: composition.structure, position: 'last',
      role: 'chapter', target, label: { value: `Chapter ${index + 1}`, language: 'en' } })) }, a.token));
  const follow = { profile: 'follow-command-v1', actingSubject: reader, following: true, expectedRevision: null };
  await json(await call('POST', '/v1/follows', { ...follow, target: realm.realm, kind: 'realm' }, b.token));
  await json(await call('POST', '/v1/follows', { ...follow, target: published[1]!.work, kind: 'work' }, b.token));
  await json(await call('PUT', `/v1/works/${published[2]!.work.slice(-36)}/reader-status`, {
    actingSubject: reader, expectedVersion: 0, status: 'reading', startedOn: null, finishedOn: null }, b.token));
  await home.project();
  const signed = (path: string) => `${path}${path.includes('?') ? '&' : '?'}actingSubject=${encodeURIComponent(reader)}`;
  return { author, reader, realm, works: published, signed, discussion, response, chapterRevisions, chapterPhrase };
}

/** One Home read with its graph queries, SQL statements and elapsed time. */
export async function measureRead(home: HomeStack, meter: ReturnType<typeof meterStatements>,
  path: string, token?: string) {
  const queries = home.stack.fuseki.queries, statements = meter.count(), started = performance.now();
  const response = await home.call('GET', path, undefined, token);
  const body = await response.text();
  const ms = performance.now() - started;
  if (response.status !== 200) throw new Error(`${path} returned ${response.status}: ${body}`);
  return { path, ms, graphQueries: home.stack.fuseki.queries - queries, statements: meter.count() - statements,
    items: (JSON.parse(body) as { items: unknown[] }).items.length };
}
