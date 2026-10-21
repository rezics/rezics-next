import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { readEnv } from '../../../scripts/dev/config.ts';
import { signupPolicyFixture } from '../../../scripts/dev/signup-policy-fixture.ts';
import { signIn, type LocalOAuthClient } from '../../../scripts/lib/oauth-client.ts';
import { createCorpusBackupDriver } from '../../../scripts/load/corpus-backup-driver.ts';
import { compatibleLoadStorage, loadCompatibility, type LoadCompatibility } from '../../../scripts/load/compatibility.ts';
import { accountEmailQueue, smtpSender } from '../../../services/account/src/email.ts';
import { personaNames, personaSession, personaSessions, retainPersonaRealm, restorePersonaRealms,
  type PersonaName, type PersonaSession, type PersonaSessions, type RetainedPersonaRealm } from './personas.ts';

const directory = resolve('.temp/identity-reader');
const manifestPath = join(directory, 'corpus.json');
const recipe = createHash('sha256').update(readFileSync(import.meta.path)).digest('hex');
export const short = (id: string) => id.slice(-36);
export type IdentityChoice = { actingSubject: string | null; eligible: boolean; revision: string | null };
export type SessionChoice = { profile: string; sessionAgent: IdentityChoice; mainAgent: IdentityChoice;
  initialActingSubject: string | null };
export type ChapterFixture = { post: string; variantId: string; occurrence: string; compositionRevision: string;
  revisionId: string; byteDigest: string; text: string };
export type BookFixture = { work: string; mainVersion: string; title: string; structure: string;
  compositionRevision: string; chapters: ChapterFixture[]; contribution?: string; publicationDecision?: string };
type EmptyIdentity = { email: string; password: string; accountId: string };
type Corpus = { format: 'identity-reader-corpus-v1'; recipe: string; productRevision: string;
  compatibility: LoadCompatibility; backup: string; realm: RetainedPersonaRealm; emptyIdentity: EmptyIdentity;
  alternatives: Record<Exclude<PersonaName, 'visitor'>, string>;
  publicBook: BookFixture; emptyBook: BookFixture; privateBook: BookFixture;
  unpublishedBook: BookFixture; unpublishedRevision: string; phrase: string; buildMs: number };

type SignedPersona = Exclude<PersonaName, 'visitor'>;
type ReaderCorpus = Pick<Corpus, 'realm' | 'emptyIdentity' | 'alternatives' | 'publicBook'
  | 'emptyBook' | 'privateBook' | 'unpublishedBook' | 'unpublishedRevision' | 'phrase'>;
export type IdentityReaderPin = { path: string; sha256: string };
export type PreparedIdentityReaderInput = {
  format: 'identity-reader-prepared-v1';
  sourceRoot: string; productRevision: string; productTree: string;
  qualification: IdentityReaderPin; sourceEquivalence: IdentityReaderPin;
  /** Private retained controls, not a request to prepare or restore them. */
  corpus: IdentityReaderPin; custodyModule: IdentityReaderPin; custodyInput: IdentityReaderPin;
  leaseId: string; mainOrigin: string; accountService: string; accountOrigin: string; accountResource: string;
  outputDirectory: string;
};
export type IdentityReaderLease = {
  borrower: 'G-2775'; custodian: 'G-2823'; id: string; recordedJobId: string;
  activatedAt: string; expiresAt: string; activation: IdentityReaderPin;
  productRevision: string; productTree: string; mainOrigin: string; accountService: string; accountOrigin: string;
  assertActive(): void;
  /** Existing owner-authorized failure only; never a successful response provider. */
  fault: { fail(unavailable: boolean): void; readonly failures: number };
};
export type IdentityReaderCustody = {
  /** Both original files attach to the enclosing job's same finite lease. */
  attachIdentityReader(input: PreparedIdentityReaderInput): Promise<IdentityReaderLease>;
  /** Parent finally restores owner availability and idempotently releases only this lease. */
  releaseIdentityReader(input: PreparedIdentityReaderInput, outcome: 'completed' | 'failed'): Promise<IdentityReaderPin>;
};

function preparedRequired(value: unknown, field: string): asserts value {
  if (!value) throw new Error(`TEST PREMISE: prepared identity reader ${field}; no outcome assertion reached`);
}
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
function pin(value: unknown, field: string): asserts value is IdentityReaderPin {
  preparedRequired(record(value) && nonempty(value.path) && typeof value.sha256 === 'string'
    && /^[a-f0-9]{64}$/.test(value.sha256), `${field} file/digest missing`);
}
function origin(value: unknown, field: string) {
  preparedRequired(nonempty(value), `${field} missing`);
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`TEST PREMISE: prepared identity reader invalid ${field}`); }
  preparedRequired(['http:', 'https:'].includes(url.protocol) && url.origin === value
    && !url.username && !url.password, `${field} must be an exact HTTP origin`);
}
/** Shape/identity checks do not qualify live eligibility, rights or source success. */
export function validatePreparedIdentityReaderInput(value: unknown): asserts value is PreparedIdentityReaderInput {
  preparedRequired(record(value) && value.format === 'identity-reader-prepared-v1', 'input format differs');
  for (const field of ['sourceRoot', 'leaseId', 'accountResource', 'outputDirectory'] as const)
    preparedRequired(nonempty(value[field]), `${field} missing`);
  for (const field of ['productRevision', 'productTree'] as const)
    preparedRequired(typeof value[field] === 'string' && /^[a-f0-9]{40}$/.test(value[field]), `${field} pin missing`);
  for (const field of ['corpus', 'qualification', 'sourceEquivalence', 'custodyModule', 'custodyInput'] as const)
    pin(value[field], field);
  for (const field of ['mainOrigin', 'accountService', 'accountOrigin'] as const) origin(value[field], field);
}
export function validatePreparedIdentityReaderCorpus(value: unknown): asserts value is ReaderCorpus {
  preparedRequired(record(value) && record(value.realm), 'retained realm missing');
  const realm = value.realm;
  preparedRequired(record(realm.identities) && record(value.alternatives), 'retained persona identities/alternatives missing');
  for (const field of ['realm', 'space', 'zone'] as const) preparedRequired(nonempty(realm[field]), `realm.${field} missing`);
  preparedRequired(realm.visibility === 'public', 'public realm required');
  const accounts = new Set<string>(), agents = new Set<string>();
  for (const name of personaNames) if (name !== 'visitor') {
    const identity = realm.identities[name], alternative = value.alternatives[name];
    preparedRequired(record(identity), `${name} retained identity missing`);
    for (const field of ['email', 'password', 'accountId', 'actingSubject'] as const)
      preparedRequired(nonempty(identity[field]), `${name}.${field} missing`);
    preparedRequired(!accounts.has(identity.accountId as string), `${name} Account duplicated`);
    preparedRequired(nonempty(alternative) && alternative !== identity.actingSubject,
      `${name} second distinct eligible Agent missing`);
    for (const agent of [identity.actingSubject as string, alternative]) {
      preparedRequired(!agents.has(agent), `${name} Agent duplicated`); agents.add(agent);
    }
    accounts.add(identity.accountId as string);
  }
  preparedRequired(record(value.emptyIdentity), 'genuine no-Agent Account missing');
  for (const field of ['email', 'password', 'accountId'] as const)
    preparedRequired(nonempty(value.emptyIdentity[field]), `emptyIdentity.${field} missing`);
  preparedRequired(!accounts.has(value.emptyIdentity.accountId as string), 'empty Account substitutes a persona');
  preparedRequired(record(realm.auth), 'retained OAuth registration missing');
  origin(realm.auth.accountOrigin, 'realm.auth.accountOrigin');
  preparedRequired(nonempty(realm.auth.clientId) && nonempty(realm.auth.scope)
    && Array.isArray(realm.auth.redirectUris) && realm.auth.redirectUris.length > 0
    && realm.auth.redirectUris.every(nonempty), 'retained OAuth client/scope/callback missing');
  const works = new Set<string>(), posts = new Set<string>(), occurrences = new Set<string>(), revisions = new Set<string>();
  for (const [field, count] of [['publicBook', 2], ['emptyBook', 0], ['privateBook', 1], ['unpublishedBook', 1]] as const) {
    const book = value[field];
    preparedRequired(record(book), `${field} missing`);
    for (const key of ['work', 'mainVersion', 'title', 'structure', 'compositionRevision'] as const)
      preparedRequired(nonempty(book[key]), `${field}.${key} missing`);
    preparedRequired(!works.has(book.work as string), `${field} substitutes another Book control`); works.add(book.work as string);
    preparedRequired(Array.isArray(book.chapters) && book.chapters.length === count, `${field} requires ${count} exact chapters`);
    if (field === 'publicBook' || field === 'emptyBook')
      preparedRequired(nonempty(book.contribution) && nonempty(book.publicationDecision), `${field} published default controls missing`);
    for (const chapter of book.chapters) {
      preparedRequired(record(chapter), `${field} chapter missing`);
      for (const key of ['post', 'variantId', 'occurrence', 'compositionRevision', 'revisionId', 'byteDigest', 'text'] as const)
        preparedRequired(nonempty(chapter[key]), `${field} chapter.${key} missing`);
      preparedRequired(/^[a-f0-9]{64}$/.test(chapter.byteDigest as string), `${field} chapter digest invalid`);
      for (const [key, seen] of [['post', posts], ['occurrence', occurrences], ['revisionId', revisions]] as const) {
        preparedRequired(!seen.has(chapter[key] as string), `${field} duplicate chapter ${key}`); seen.add(chapter[key] as string);
      }
    }
  }
  preparedRequired(nonempty(value.unpublishedRevision) && !revisions.has(value.unpublishedRevision), 'distinct unpublished successor missing');
  preparedRequired(nonempty(value.phrase), 'phrase control missing');
  for (const chapter of (value.publicBook as BookFixture).chapters)
    preparedRequired(chapter.text.includes(value.phrase), 'public chapter lacks exact phrase control');
}

export function checkIdentityReaderPin(value: IdentityReaderPin): string {
  pin(value, 'retained');
  const path = resolve(value.path);
  preparedRequired(createHash('sha256').update(readFileSync(path)).digest('hex') === value.sha256, 'retained file digest differs');
  return path;
}
export function identityReaderOutputDirectory(path: string, root = resolve(import.meta.dir, '../../..')) {
  const target = resolve(path), suffix: string[] = [];
  let ancestor = target;
  while (!existsSync(ancestor)) { suffix.unshift(basename(ancestor)); ancestor = dirname(ancestor); }
  const canonical = resolve(realpathSync(ancestor), ...suffix);
  preparedRequired(relative(realpathSync(root), canonical).startsWith('.temp/'),
    'output must remain in this checkout .temp without symlink escape');
  return canonical;
}
function preparedInput() {
  const path = Bun.env.REZICS_IDENTITY_READER_PREPARED_INPUT;
  preparedRequired(path, 'REZICS_IDENTITY_READER_PREPARED_INPUT missing');
  const input: unknown = JSON.parse(readFileSync(path, 'utf8'));
  validatePreparedIdentityReaderInput(input);
  for (const field of ['qualification', 'sourceEquivalence', 'corpus', 'custodyModule', 'custodyInput'] as const)
    checkIdentityReaderPin(input[field]);
  const git = (revision: string) => execFileSync('git', ['rev-parse', revision], { cwd: input.sourceRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  preparedRequired(git('HEAD') === input.productRevision && git('HEAD^{tree}') === input.productTree, 'live product checkout pin differs');
  identityReaderOutputDirectory(input.outputDirectory);
  return input;
}
export function validateIdentityReaderLease(lease: IdentityReaderLease, input: PreparedIdentityReaderInput, now = Date.now()) {
  preparedRequired(lease.borrower === 'G-2775' && lease.custodian === 'G-2823' && lease.id === input.leaseId
    && nonempty(lease.recordedJobId), 'named recorded custody differs');
  const start = Date.parse(lease.activatedAt), end = Date.parse(lease.expiresAt);
  preparedRequired(start <= now && end > now && end - start <= 600_000, 'fresh finite ten-minute lease required');
  for (const field of ['productRevision', 'productTree', 'mainOrigin', 'accountService', 'accountOrigin'] as const)
    preparedRequired(lease[field] === input[field], `${field} lease binding differs`);
  preparedRequired(typeof lease.assertActive === 'function' && typeof lease.fault?.fail === 'function'
    && Number.isSafeInteger(lease.fault.failures) && lease.fault.failures >= 0, 'existing synchronous owner fault/recovery/count capability missing');
  pin(lease.activation, 'activation');
}
async function preparedFixture() {
  const input = preparedInput();
  for (const original of identityReaderOriginals) checkIdentityReaderPin(original);
  const corpus: unknown = JSON.parse(readFileSync(checkIdentityReaderPin(input.corpus), 'utf8'));
  validatePreparedIdentityReaderCorpus(corpus);
  preparedRequired(corpus.realm.auth.accountOrigin === input.accountOrigin, 'OAuth Account origin differs from custody');
  const owner = await import(pathToFileURL(checkIdentityReaderPin(input.custodyModule)).href) as IdentityReaderCustody;
  const lease = await owner.attachIdentityReader(input);
  validateIdentityReaderLease(lease, input); checkIdentityReaderPin(lease.activation); lease.assertActive();
  mkdirSync(input.outputDirectory, { recursive: true, mode: 0o700 });
  appendFileSync(join(input.outputDirectory, 'attachments.ndjson'), JSON.stringify({
    at: new Date().toISOString(), recordedJobId: lease.recordedJobId, leaseId: lease.id,
    activatedAt: lease.activatedAt, expiresAt: lease.expiresAt, activation: lease.activation,
    productRevision: lease.productRevision, productTree: lease.productTree,
    mainOrigin: lease.mainOrigin, accountService: lease.accountService, accountOrigin: lease.accountOrigin,
    corpus: input.corpus, qualification: input.qualification, sourceEquivalence: input.sourceEquivalence,
    assertionsReached: false,
  }) + '\n', { mode: 0o600 });
  const active = () => { validateIdentityReaderLease(lease, input); lease.assertActive(); };
  const visitor = personaSession(input.mainOrigin, input.accountService, null, undefined, undefined,
    undefined, 'visitor', undefined, undefined, input.accountOrigin);
  const guarded = (call: PersonaSession['main']): PersonaSession['main'] => (...args) => { active(); return call(...args); };
  visitor.main = guarded(visitor.main); visitor.account = guarded(visitor.account);
  return { sessions: { visitor }, corpus, fault: lease.fault, mainOrigin: input.mainOrigin,
    login: identityLogin(corpus, visitor, input.mainOrigin, input.accountService, input.accountResource, active),
    async close() { lease.fault.fail(false); },
  };
}

// This proxy forwards genuine owner answers. Its only synthetic response is an
// explicit failure; it never fabricates successful discovery, content or rights.
function ownerProxy(upstream: string) {
  const target = new URL(upstream);
  let unavailable = false, failures = 0;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    if (unavailable) { failures++; return new Response('Isolated owner failure', { status: 503 }); }
    const url = new URL(request.url);
    const headers = new Headers(request.headers);
    headers.delete('host');
    return fetch(new URL(url.pathname + url.search, target.origin), {
      method: request.method, headers, redirect: 'manual', signal: AbortSignal.timeout(30_000),
      ...(['GET', 'HEAD'].includes(request.method) ? {} : { body: await request.arrayBuffer() }),
    });
  } });
  return { url: `${server.url.origin}${target.pathname.replace(/\/$/, '')}`,
    fail(value: boolean) { unavailable = value; }, get failures() { return failures; },
    close() { return server.stop(true); } };
}

export async function fixtureCommand<T>(pending: Promise<Response>, status = 200): Promise<T> {
  const response = await pending, raw = await response.text();
  if (response.status !== status) throw new Error(`SETUP: expected ${status}, received ${response.status}: ${raw}`);
  return JSON.parse(raw) as T;
}

async function createBook(owner: PersonaSession, title: string, count: number, published: boolean,
  phrase: string, publishWithoutEligibility = false): Promise<BookFixture> {
  const actingSubject = owner.actingSubject;
  const work = await fixtureCommand<{ work: string; mainVersion: string }>(owner.main('POST', '/v1/works', {
    profile: 'metadata-only-v1', title, language: 'en', semanticTypes: ['https://schema.org/Book'],
    authoring: 'own-work', actingSubject,
  }), 201);
  const composition = await fixtureCommand<{ structure: string; revision: string }>(owner.main('POST', '/v1/compositions', {
    profile: 'book-composition', work: work.work, mainVersion: work.mainVersion, actingSubject,
  }), 201);
  const result: BookFixture = { ...work, title, structure: composition.structure,
    compositionRevision: composition.revision, chapters: [] };
  if (published) {
    const draft = await fixtureCommand<{ contribution: string; draftRevision: string }>(owner.main('POST', '/v1/contributions', {
      profile: 'text-contribution-v1', work: work.work, language: 'en',
      body: 'An original catalogue introduction about a garden beside a river.', actingSubject,
    }), 201);
    const publication = await fixtureCommand<{ publicationDecision: string }>(owner.main('POST', '/v1/contribution-publications', {
      profile: 'text-publication-v1', contribution: draft.contribution, expectedDraftHead: draft.draftRevision,
      expectedPublicationHead: null, rightsBasis: 'original-contribution', disclosure: 'public', actingSubject,
    }), 201);
    await fixtureCommand(owner.main('POST', '/v1/publication-selections', {
      profile: 'main-default-selection-v1', context: { kind: 'main-version-default', id: work.mainVersion },
      work: work.work, contribution: draft.contribution, publicationDecision: publication.publicationDecision,
      expectedSelectionHead: null, selectionBasis: 'main-maintainer', actingSubject,
    }), 201);
    result.contribution = draft.contribution;
    result.publicationDecision = publication.publicationDecision;
  }
  for (let index = 0; index < count; index++) {
    const chapter = await fixtureCommand<Omit<ChapterFixture, 'revisionId' | 'byteDigest' | 'text'>>(owner.main('POST',
      `/v1/works/${short(work.work)}/chapters`, { profile: 'book-chapter-create-v1',
        title: `${title} chapter ${index + 1}`, language: 'en', direction: 'ltr', parent: result.structure,
        position: 'last', expectedCompositionHead: result.compositionRevision, actingSubject }));
    result.compositionRevision = chapter.compositionRevision;
    const text = `${phrase}. Original chapter ${index + 1}: the gardener walks beside the river.`;
    const draft = await fixtureCommand<{ revisionId: string; byteDigest: string; sourcePosition: { dataEpoch: string } }>(
      owner.main('POST', '/v1/content-drafts', { profile: 'content-text-v1', resourceId: chapter.post,
        variantId: chapter.variantId, expectedHead: null, language: { kind: 'tag', tag: 'en', originalTag: 'en' },
        direction: 'ltr', body: text, actingSubject }), 201);
    result.chapters.push({ ...chapter, revisionId: draft.revisionId, byteDigest: draft.byteDigest, text });
    if (published || publishWithoutEligibility) {
      const publication = await fixtureCommand<{ decision: string }>(owner.main('POST', '/v1/content-publications', {
        profile: 'content-publication-v1', resourceId: chapter.post, variantId: chapter.variantId,
        revisionId: draft.revisionId, preparationId: randomUUID(), expectedDigest: draft.byteDigest,
        expectedContentEpoch: draft.sourcePosition.dataEpoch, expectedPublicationHead: null, actingSubject,
      }), 201);
      if (published) await fixtureCommand(owner.main('POST', '/v1/content-search-eligibility', {
        profile: 'content-search-eligibility-v1', resourceId: chapter.post, variantId: chapter.variantId,
        publicationDecision: publication.decision, expectedEligibilityHead: null,
        rightsBasis: 'original-contribution', disclosure: 'public', actingSubject,
      }), 201);
    }
  }
  if (published) {
    const current = await fixtureCommand<{ revision: string }>(owner.main('GET',
      `/v1/works/${short(work.work)}?actingSubject=${encodeURIComponent(actingSubject!)}`));
    await fixtureCommand(owner.main('POST', '/v1/work-publications', {
      profile: 'work-structure-publication-v1', operation: 'publish', work: work.work,
      expectedWorkHead: current.revision, expectedMainVersion: work.mainVersion, structure: result.structure,
      expectedStructureHead: result.compositionRevision, expectedPublicationHead: null,
      rightsBasis: 'original-contribution', disclosure: 'public', actingSubject,
    }), 201);
  }
  return result;
}

async function emptyAccount(sessions: PersonaSessions): Promise<EmptyIdentity> {
  const email = `identity-empty-${randomUUID()}@example.test`, password = `Fixture-${randomUUID()}-aA7!`;
  await fixtureCommand(sessions.visitor.account('POST', '/api/auth/sign-up/email', {
    ...signupPolicyFixture, name: 'Original empty identity', email, password,
  }));
  // Account's real queue worker delivers to this isolated stack's Mailpit.
  const compose = readEnv(resolve('.temp/stack', `rezics-qa-${Bun.env.REZICS_QA_RUN_ID}`, 'compose.env'));
  const pool = new Pool({ connectionString: Bun.env.ACCOUNT_DATABASE_URL });
  try {
    const queue = accountEmailQueue(pool, Bun.env.ACCOUNT_SECRET!, smtpSender({
      host: '127.0.0.1', port: Number(compose.MAILPIT_SMTP_PORT), secure: false, requireTLS: false,
      user: '', password: '', from: 'REZICS QA <qa@example.test>',
    }), Bun.env.ACCOUNT_BASE_URL!);
    await queue.drain();
  } finally { await pool.end(); }
  const inbox = `http://127.0.0.1:${compose.MAILPIT_HTTP_PORT}`;
  const deadline = Date.now() + 30_000;
  let messageId: string | undefined;
  do {
    const found = await fixtureCommand<{ messages: { ID: string }[] }>(fetch(
      `${inbox}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`));
    messageId = found.messages[0]?.ID;
    if (messageId) break;
    await Bun.sleep(100);
  } while (Date.now() < deadline);
  if (!messageId) throw new Error('SETUP: empty Account verification email was not delivered');
  const message = await fixtureCommand<{ Text: string }>(fetch(`${inbox}/api/v1/message/${messageId}`));
  const link = message.Text.match(/https?:\/\/[^\s]+/)?.[0];
  if (!link) throw new Error('SETUP: empty Account has no verification link');
  const verified = await sessions.visitor.account('GET', link);
  if (![200, 302].includes(verified.status)) throw new Error(`SETUP: Account verification ${verified.status}`);
  const login = await fixtureCommand<{ user: { id: string } }>(sessions.visitor.account('POST', '/api/auth/sign-in/email', { email, password }));
  return { email, password, accountId: login.user.id };
}

// A shared producer may reuse the Account-only stage without invoking this
// helper's separate catalogue preparation or creating another backup.
export { emptyAccount as prepareEmptyIdentity };

async function withEnvironment<T>(values: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, Bun.env[key]]));
  try { Object.assign(Bun.env, values); return await fn(); }
  finally { for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete Bun.env[key]; else Bun.env[key] = value;
  } }
}

function identityLogin(corpus: ReaderCorpus, visitor: PersonaSession, mainOrigin: string,
  accountService: string, resource = Bun.env.ACCOUNT_MAIN_RESOURCE, active: () => void = () => {}) {
  return async (name: SignedPersona | 'empty', next: string, scope?: string) => {
    const identity = name === 'empty' ? corpus.emptyIdentity : corpus.realm.identities[name];
    active();
    const login = await visitor.account('POST', '/api/auth/sign-in/email', {
      email: identity.email, password: identity.password,
    });
    const account = await fixtureCommand<{ user: { id: string } }>(Promise.resolve(login));
    if (account.user.id !== identity.accountId) throw new Error('SETUP: sign-in changed Account identity');
    const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    if (!cookie) throw new Error('SETUP: Account sign-in returned no cookie');
    const state = JSON.stringify({ next, nonce: randomUUID() }), callbacks: string[] = [];
    const auth = corpus.realm.auth;
    const client: LocalOAuthClient = { account: auth.accountOrigin, service: accountService,
      clientId: auth.clientId, redirectUri: auth.redirectUris[0]!, scope: scope ?? auth.scope,
      resource,
      async fetch(input, init) {
        active();
        const response = await fetch(input, init);
        const location = response.headers.get('location');
        if (location) { const url = new URL(location, auth.accountOrigin);
          if (url.searchParams.has('code')) callbacks.push(url.href); }
        if (new URL(input).pathname === '/api/account/consent' && response.ok && !location) {
          const body = await response.clone().json() as { url?: string; redirect_uri?: string };
          const callback = body.url ?? body.redirect_uri;
          if (callback) callbacks.push(new URL(callback, auth.accountOrigin).href);
        }
        return response;
      } };
    const oauth = await signIn(client, cookie, { state, attempts: 1 });
    const person = personaSession(mainOrigin, accountService, identity.accountId, cookie, oauth,
      undefined, name, undefined, undefined, auth.accountOrigin);
    person.actingSubject = name === 'empty' ? null : corpus.realm.identities[name].actingSubject;
    const sessionKey = randomUUID();
    // A fixed captured bearer and one session key observe the first answer:
    // no identity substitution, bearer renewal or automatic read retries.
    const bearer = oauth.accessToken;
    const request = (method: string, path: string, body?: unknown, key?: string) => { active(); return fetch(new URL(path, mainOrigin), {
      method, redirect: 'manual', signal: AbortSignal.timeout(30_000),
      headers: { authorization: `Bearer ${bearer}`, 'x-session-key': sessionKey,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(key === undefined ? {} : { 'idempotency-key': key }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }); };
    const accountCall = person.account;
    person.account = (...args) => { active(); return accountCall(...args); };
    return { person, request, state, callbacks, next, redirectUri: client.redirectUri };
  };
}

let preparations = 0;
export async function identityReaderFixture() {
  if (Bun.env.REZICS_IDENTITY_READER_PREPARED_INPUT !== undefined) return preparedFixture();
  const sourceRunId = Bun.env.REZICS_QA_RUN_ID;
  if (!sourceRunId || Bun.env.REZICS_QA_BROWSER_OUTCOMES === '1')
    throw new Error('SETUP: identity reader requires an admitted isolated integration stack');
  const started = preparations++ === 0 ? Number(Bun.env.REZICS_QA_PREPARATION_STARTED_AT ?? Date.now()) : Date.now();
  const remaining = () => {
    const ms = 600_000 - (Date.now() - started);
    if (ms <= 0) throw new Error('SETUP: identity reader preparation exceeded 600 seconds');
    return ms;
  };
  const signal = AbortSignal.timeout(remaining());
  mkdirSync(directory, { recursive: true });
  let proxy: ReturnType<typeof ownerProxy> | undefined;
  let source: PersonaSessions | undefined, sessions: PersonaSessions | undefined;
  let mainOrigin = '', accountService = '';
  let phase = 'load-corpus';
  let corpus: Corpus;
  const target = `identity-reader-${randomUUID()}`;
  const backups = createCorpusBackupDriver({ sourceRunId, directory: join(directory, 'backups'),
    restoreResourceClass: 'ordinary',
    async quiesce() { await source?.close(); source = undefined; await proxy?.close(); proxy = undefined; },
    async smokeRead(copy) {
      proxy = ownerProxy(copy.apps.FUSEKI_URL!);
      mainOrigin = `http://127.0.0.1:${copy.apps.MAIN_PORT}`;
      accountService = copy.apps.ACCOUNT_SERVICE_ORIGIN ?? corpus.realm.auth.accountOrigin;
      [sessions] = await withEnvironment({ ...copy.apps, FUSEKI_URL: proxy.url, REZICS_QA_RUN_ID: copy.runId },
        () => restorePersonaRealms([corpus.realm]));
      if (!sessions) throw new Error('SETUP: restored persona Realm is missing');
      return async () => { await sessions?.close(); await proxy?.close(); };
    },
  });
  try {
    if (existsSync(manifestPath)) {
      corpus = JSON.parse(readFileSync(manifestPath, 'utf8')) as Corpus;
      if (corpus.format !== 'identity-reader-corpus-v1' || corpus.recipe !== recipe
        || !compatibleLoadStorage(corpus.compatibility, loadCompatibility(process.cwd())) || !existsSync(corpus.backup))
        throw new Error('SETUP: retained identity reader corpus is incompatible; preserve it and explicitly select a new corpus directory');
    } else {
      phase = 'create-personas';
      proxy = ownerProxy(Bun.env.FUSEKI_URL!);
      source = await personaSessions('public', { graphEndpoint: proxy.url, moderatorLifetimeMs: 7 * 86_400_000 });
      phase = 'create-alternative-agents';
      const alternatives = {} as Corpus['alternatives'];
      for (const name of personaNames.filter((name): name is Exclude<PersonaName, 'visitor'> => name !== 'visitor')) {
        const person = source[name], key = randomUUID();
        for (let attempt = 0; ; attempt++) {
          const response = await person.main('POST', '/v1/agents', {
            profile: 'agent-provision-v1', kind: 'organization', displayName: `Original ${name} garden group`,
          }, key);
          if (response.status === 202 && attempt < 30) { await response.body?.cancel(); await Bun.sleep(100); continue; }
          const expected = response.status === 200 ? 200 : 201;
          alternatives[name] = (await fixtureCommand<{ agent: string }>(Promise.resolve(response), expected)).agent;
          break;
        }
      }
      const phrase = `Rivergarden${randomUUID().replaceAll('-', '')}`;
      phase = 'create-public-book';
      const publicBook = await createBook(source.owner, `${phrase} public Book`, 2, true, phrase);
      phase = 'create-empty-book';
      const emptyBook = await createBook(source.owner, `${phrase} empty Book`, 0, true, phrase);
      phase = 'create-private-book';
      const privateBook = await createBook(source.owner, `${phrase} private notebook`, 1, false, phrase);
      phase = 'create-unpublished-book';
      const unpublishedBook = await createBook(source.owner, `${phrase} unpublished Book`, 1, false, phrase, true);
      phase = 'create-unpublished-successor';
      const first = publicBook.chapters[0]!;
      const successor = await fixtureCommand<{ revisionId: string }>(source.owner.main('POST', '/v1/content-drafts', {
        profile: 'content-text-v1', resourceId: first.post, variantId: first.variantId,
        expectedHead: first.revisionId, language: { kind: 'tag', tag: 'en', originalTag: 'en' },
        direction: 'ltr', body: 'PRIVATE unpublished correction beside the river.', actingSubject: source.owner.actingSubject,
      }), 201);
      phase = 'create-empty-account';
      corpus = { format: 'identity-reader-corpus-v1', recipe,
        productRevision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
        compatibility: loadCompatibility(process.cwd()), backup: '', realm: retainPersonaRealm(source),
        emptyIdentity: await emptyAccount(source), alternatives, publicBook, emptyBook, privateBook, unpublishedBook,
        unpublishedRevision: successor.revisionId, phrase, buildMs: 0 };
      phase = 'backup-corpus';
      corpus.backup = await backups.backup(`identity-reader-${recipe.slice(0, 20)}`, signal);
      corpus.buildMs = Date.now() - started;
      remaining();
      // Private credentials and original identities travel with this one stopped cut.
      writeFileSync(manifestPath, JSON.stringify(corpus, null, 2) + '\n', { mode: 0o600 });
    }
    // Historical restore admission belongs to the original overlay; prepared execution never loads it.
    const auditExecutionPath = './audit-execution.ts';
    const { assertAuditExecution } = await import(auditExecutionPath) as { assertAuditExecution(value: unknown): unknown };
    const execution = assertAuditExecution(corpus);
    phase = 'restore-corpus';
    await backups.restore(corpus.backup, target, signal);
    remaining();
    const live = sessions!;
    const fault = proxy!;
    const preparation = { status: 'ready', sourceRevision: corpus.productRevision, execution, backup: corpus.backup,
      buildMs: corpus.buildMs, restore: backups.preparation(target), totalMs: Date.now() - started, budgetMs: 600_000 };
    console.info('IDENTITY_READER_PREPARATION', JSON.stringify(preparation));
    writeFileSync(join(directory, `preparation-${sourceRunId}-${target}.json`), JSON.stringify(preparation, null, 2) + '\n');
    return { sessions: live, corpus, fault, mainOrigin,
      login: identityLogin(corpus, live.visitor, mainOrigin, accountService),
      async close() { fault.fail(false); await backups.stop(target); },
    };
  } catch (error) {
    const preparation = { status: 'setup-failed', phase,
      sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      totalMs: Date.now() - started, budgetMs: 600_000, assertionsReached: false };
    console.info('IDENTITY_READER_PREPARATION', JSON.stringify(preparation));
    writeFileSync(join(directory, `preparation-${sourceRunId}-${target}.json`), JSON.stringify(preparation, null, 2) + '\n');
    await source?.close(); await sessions?.close(); await proxy?.close();
    await backups.stop(target);
    throw error;
  }
}
export type IdentityReaderFixture = Awaited<ReturnType<typeof identityReaderFixture>>;

export const identityReaderOriginals = [
  { path: '.temp/identity-reader-prepared/originals/tests/qa/integration/outcomes/realm/identity-discovery.test.ts',
    sha256: '9968c98b679ef125abdd75fff9545a5e1f0ae1bf120c1da1e6d25a66498fd77b' },
  { path: '.temp/identity-reader-prepared/originals/tests/qa/integration/audit-public-reading.test.ts',
    sha256: 'd76938aaf9776926c9520c374467ec0a41c6290c6c0d8d8c17c124ef50dcfc41' },
] as const;

/** Run only the frozen originals through admitted loose-file QA, with no hosted stack. */
export async function runPreparedIdentityReader() {
  const input = preparedInput();
  const corpus: unknown = JSON.parse(readFileSync(checkIdentityReaderPin(input.corpus), 'utf8'));
  validatePreparedIdentityReaderCorpus(corpus);
  for (const original of identityReaderOriginals) checkIdentityReaderPin(original);
  const owner = await import(pathToFileURL(checkIdentityReaderPin(input.custodyModule)).href) as IdentityReaderCustody;
  preparedRequired(typeof owner.attachIdentityReader === 'function' && typeof owner.releaseIdentityReader === 'function',
    'existing owner attachment/release exports missing');
  mkdirSync(input.outputDirectory, { recursive: true, mode: 0o700 });
  const runId = `identity-reader-prepared-${randomUUID()}`;
  // The runner classifies .temp files as loose Bun tests. Each wrapper imports
  // its frozen original; neither tests nor expected results are transformed.
  const wrappers = identityReaderOriginals.map((original, index) => {
    const wrapper = join(input.outputDirectory, `original-${index}.test.ts`);
    writeFileSync(wrapper, `import ${JSON.stringify(pathToFileURL(resolve(original.path)).href)};\n`, { mode: 0o600, flag: 'wx' });
    return wrapper;
  });
  let code = 1, childExit: number | null = null, exceeded = false;
  let release: IdentityReaderPin | undefined, releaseFailed = false;
  try {
    const child = spawn('bun', ['scripts/goal/goalctl.ts', 'test', ...wrappers,
      '--reporter=junit', `--reporter-outfile=${join(input.outputDirectory, 'original.junit.xml')}`],
    { stdio: 'inherit', env: { ...process.env, REZICS_QA_RUN_ID: runId } });
    const term = () => child.kill('SIGTERM'), interrupt = () => child.kill('SIGINT');
    process.on('SIGTERM', term); process.on('SIGINT', interrupt);
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const deadline = setTimeout(() => { exceeded = true; child.kill('SIGTERM');
      escalation = setTimeout(() => child.kill('SIGKILL'), 3_000);
    }, 600_000);
    try {
      childExit = await new Promise<number | null>((accept, reject) => {
        child.once('error', reject); child.once('close', accept);
      });
      code = childExit === 0 && !exceeded ? 0 : 1;
    } finally {
      clearTimeout(deadline); if (escalation) clearTimeout(escalation);
      process.off('SIGTERM', term); process.off('SIGINT', interrupt);
    }
  } finally {
    try { release = await owner.releaseIdentityReader(input, code === 0 ? 'completed' : 'failed'); checkIdentityReaderPin(release); }
    catch { releaseFailed = true; code = 1; }
    writeFileSync(join(input.outputDirectory, 'execution.json'), JSON.stringify({
      code, childExit, exceeded, release, releaseFailed, runId, originals: identityReaderOriginals,
      originalSpecificationRevision: '8014f1fd4874f452a813554c5e5f2814c13f4b97',
      historicalSupportSha256: '7074631465842ef948a9d44c8b297be38186e5a2bdccadb71d9c2a308fbc0407',
      testRevision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      testTree: execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim(),
      supportSha256: createHash('sha256').update(readFileSync(import.meta.path)).digest('hex'),
      productRevision: input.productRevision, productTree: input.productTree,
      corpus: input.corpus, qualification: input.qualification, sourceEquivalence: input.sourceEquivalence,
      custodyModule: input.custodyModule, custodyInput: input.custodyInput,
      assertionEvidence: `.temp/identity-reader/assertions-${runId}.jsonl and original.junit.xml; beforeAll is preparation only`,
      runtimeStopped: false, corpusPreparedOrRestored: false,
    }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  }
  return code;
}

if (import.meta.main) process.exitCode = await runPreparedIdentityReader();

export function reached(caseId: string, assertion: string) {
  mkdirSync(directory, { recursive: true });
  const record = { case: caseId, assertion, phase: 'outcome-assertion-reached', at: new Date().toISOString() };
  appendFileSync(join(directory, `assertions-${Bun.env.REZICS_QA_RUN_ID}.jsonl`), JSON.stringify(record) + '\n');
  console.info('IDENTITY_READER_ASSERTION', JSON.stringify(record));
}
