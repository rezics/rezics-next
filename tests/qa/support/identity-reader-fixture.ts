import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { readEnv } from '../../../scripts/dev/config.ts';
import { signupPolicyFixture } from '../../../scripts/dev/signup-policy-fixture.ts';
import { signIn, type LocalOAuthClient } from '../../../scripts/lib/oauth-client.ts';
import { createCorpusBackupDriver } from '../../../scripts/load/corpus-backup-driver.ts';
import { compatibleLoadStorage, loadCompatibility, type LoadCompatibility } from '../../../scripts/load/compatibility.ts';
import { accountEmailQueue, smtpSender } from '../../../services/account/src/email.ts';
import { assertAuditExecution } from './audit-execution.ts';
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
    close() { server.stop(true); } };
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

let preparations = 0;
export async function identityReaderFixture() {
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
    async quiesce() { await source?.close(); source = undefined; proxy?.close(); proxy = undefined; },
    async smokeRead(copy) {
      proxy = ownerProxy(copy.apps.FUSEKI_URL!);
      mainOrigin = `http://127.0.0.1:${copy.apps.MAIN_PORT}`;
      accountService = copy.apps.ACCOUNT_SERVICE_ORIGIN ?? corpus.realm.auth.accountOrigin;
      [sessions] = await withEnvironment({ ...copy.apps, FUSEKI_URL: proxy.url, REZICS_QA_RUN_ID: copy.runId },
        () => restorePersonaRealms([corpus.realm]));
      if (!sessions) throw new Error('SETUP: restored persona Realm is missing');
      return async () => { await sessions?.close(); proxy?.close(); };
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
      async login(name: Exclude<PersonaName, 'visitor'> | 'empty', next: string, scope?: string) {
        const identity = name === 'empty' ? corpus.emptyIdentity : corpus.realm.identities[name];
        const login = await live.visitor.account('POST', '/api/auth/sign-in/email', {
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
          resource: Bun.env.ACCOUNT_MAIN_RESOURCE,
          async fetch(input, init) {
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
        const request = (method: string, path: string, body?: unknown, key?: string) => fetch(new URL(path, mainOrigin), {
          method, redirect: 'manual', signal: AbortSignal.timeout(30_000),
          headers: { authorization: `Bearer ${bearer}`, 'x-session-key': sessionKey,
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
            ...(key === undefined ? {} : { 'idempotency-key': key }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        return { person, request, state, callbacks, next, redirectUri: client.redirectUri };
      },
      async close() { fault.fail(false); await backups.stop(target); },
    };
  } catch (error) {
    const preparation = { status: 'setup-failed', phase,
      sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      totalMs: Date.now() - started, budgetMs: 600_000, assertionsReached: false };
    console.info('IDENTITY_READER_PREPARATION', JSON.stringify(preparation));
    writeFileSync(join(directory, `preparation-${sourceRunId}-${target}.json`), JSON.stringify(preparation, null, 2) + '\n');
    await source?.close(); await sessions?.close(); proxy?.close();
    await backups.stop(target);
    throw error;
  }
}
export type IdentityReaderFixture = Awaited<ReturnType<typeof identityReaderFixture>>;

export function reached(caseId: string, assertion: string) {
  mkdirSync(directory, { recursive: true });
  const record = { case: caseId, assertion, phase: 'outcome-assertion-reached', at: new Date().toISOString() };
  appendFileSync(join(directory, `assertions-${Bun.env.REZICS_QA_RUN_ID}.jsonl`), JSON.stringify(record) + '\n');
  console.info('IDENTITY_READER_ASSERTION', JSON.stringify(record));
}
