import { expect } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { createCorpusBackupDriver } from '../../../scripts/load/corpus-backup-driver.ts';
import { signIn, type LocalOAuthSession } from '../../../scripts/lib/oauth-client.ts';
import type { AuditFilePin } from '../fixtures/audit-corpus-contract.ts';
import { publicDomainBaseline, publicDomainOriginalArraySha256, privateRecipeText, assertPublicDomainOriginalWorks, assertPublicDomainNativeCreation, type PublicDomainCorpus,
  type PublicDomainSelectedCorpus, type PublicDomainSelection, type PublicRecipe, type RecipePage, type SourceQuote } from '../fixtures/catalogue-public-domain.ts';
import { grantPersonaFixtureAuthority } from './persona-fixture-authority.ts';
import { assertAuditExecution } from './audit-execution.ts';
import { personaNames, personaSession, restorePersonaRealms, type PersonaSession, type PersonaSessions } from './personas.ts';

export const short = (id: string) => id.slice(-36);
export const viewer = (person: PersonaSession, path: string) => person.actingSubject
  ? `${path}${path.includes('?') ? '&' : '?'}${new URLSearchParams({ actingSubject: person.actingSubject })}` : path;
export type Call = PersonaSession['main'];
export async function answer<T>(request: Promise<Response>, status = 200): Promise<T> {
  const response = await request, raw = await response.text();
  expect(response.status, `HTTP ${response.status}: ${raw}`).toBe(status);
  return JSON.parse(raw) as T;
}

function localFile(path: string): string {
  const file = resolve(path), part = relative(realpathSync('.'), realpathSync(file));
  if (isAbsolute(path) || part.startsWith('..') || !/^(?:\.temp|tests\/fixtures)\//.test(part))
    throw new Error('Public corpus files must stay in this worktree .temp or tests/fixtures');
  return file;
}
function sourceQuote(quote: SourceQuote): void {
  const bytes = readFileSync(localFile(quote.file));
  if (!/^[a-f0-9]{64}$/.test(quote.sha256)
    || createHash('sha256').update(bytes).digest('hex') !== quote.sha256 || !quote.exact.trim())
    throw new Error(`Frozen public corpus source digest/quote is invalid: ${quote.file}`);
  // Gutenberg JSON pins retain the text as a JSON string; other pins may be raw text.
  let text = bytes.toString('utf8');
  try { text = JSON.stringify(JSON.parse(text)); } catch { /* Raw retained source text. */ }
  if (!text.includes(JSON.stringify(quote.exact).slice(1, -1)) && !bytes.toString('utf8').includes(quote.exact))
    throw new Error(`Public corpus quote is absent from frozen source: ${quote.file}`);
}

function admissionJson(pin: AuditFilePin, label: string): unknown {
  if (!pin || typeof pin.file !== 'string' || typeof pin.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(pin.sha256))
    throw new Error(`TEST PREMISE: ${label} needs an existing producer file/digest pin`);
  try {
    const bytes = readFileSync(localFile(pin.file));
    if (createHash('sha256').update(bytes).digest('hex') !== pin.sha256) throw new Error('digest differs');
    return JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new Error(`TEST PREMISE: ${label} pinned evidence is invalid: ${pin.file}`, { cause: error });
  }
}

/** Fixture admission only; genuine source, rights, structure and publication checks still follow. */
export function assertPublicDomainWorkAdmission(corpus: Pick<PublicDomainCorpus, 'originals' | 'importedWorks'>,
  targets: ReadonlyArray<Pick<PublicRecipe, 'work' | 'creationReceipt'> & { mainVersion?: string }>): void {
  const originals = admissionJson(corpus.originals, 'original 113 association ledger');
  if (Array.isArray(originals) && corpus.originals.sha256 !== publicDomainOriginalArraySha256)
    throw new Error('TEST PREMISE: original array ledger must retain its pinned original digest');
  assertPublicDomainOriginalWorks(corpus.importedWorks, originals);
  for (const target of targets) {
    if (corpus.importedWorks.includes(target.work) && target.creationReceipt === undefined) continue;
    const pin = target.creationReceipt;
    if (!pin) throw new Error(`TEST PREMISE: additional native Work ${target.work} is missing its creation receipt`);
    assertPublicDomainNativeCreation(target, admissionJson({ file: pin.path, sha256: pin.sha256 }, 'native creation receipt'));
  }
}

export function loadPublicDomainCorpus(selection: PublicDomainSelection): PublicDomainCorpus {
  const path = '.temp/goal/public-domain-corpus.json';
  if (!existsSync(path)) throw new Error(`TEST PREMISE: missing ${path}; prepare one isolated command-created corpus `
    + 'with explicit product/test revision pins, retain a consistent owner backup and reviewed source quotes within 600 seconds. '
    + 'No product assertion has been reached. Do not use the shared dev stack or the retained private recipe.');
  const corpus = JSON.parse(readFileSync(localFile(path), 'utf8')) as PublicDomainCorpus;
  // This legacy field records the historical baseline, not the repaired product under test.
  assertAuditExecution(corpus, { productBaseline: corpus.productRevision });
  if (corpus.profile !== 'catalogue-public-domain-corpus-v1' || corpus.productRevision !== publicDomainBaseline
    || !corpus.preparationQaRun || !Number.isFinite(corpus.preparationMs)
    || corpus.preparationMs <= 0 || corpus.preparationMs > 600_000)
    throw new Error('TEST PREMISE: public corpus baseline/preparation evidence is missing or outside 600 seconds');
  localFile(corpus.backup);
  if (corpus.importedWorks.length !== 113 || new Set(corpus.importedWorks).size !== 113)
    throw new Error('TEST PREMISE: retain all 113 original imported Work identities');
  assertPublicDomainSelectedPremises(corpus, selection);
  // Existing outcome witnesses retain their complete type; absent unselected branches are never synthesized.
  return corpus;
}

/** Keep custody/identity/citations global, and require only the existing selected outcome's body premises. */
export function assertPublicDomainSelectedPremises(corpus: PublicDomainSelectedCorpus, selection: PublicDomainSelection): void {
  if (!['book', 'recipe', 'nutrition'].includes(selection)) throw new Error('TEST PREMISE: unknown public-domain selection');
  if (corpus.nutritionRecipes !== undefined && !Array.isArray(corpus.nutritionRecipes))
    throw new Error('TEST PREMISE: nutritionRecipes must be an array when supplied');
  const availableRecipes = [corpus.richRecipe, corpus.noNutritionRecipe, ...(corpus.nutritionRecipes ?? [])]
    .filter((item): item is PublicRecipe => item !== undefined);
  assertPublicDomainWorkAdmission(corpus, [...availableRecipes, ...(corpus.book ? [corpus.book] : [])]);
  for (const item of availableRecipes) {
    if (!item.source.author || !item.source.observation)
      throw new Error('TEST PREMISE: real recipes need source attribution and nonempty structure');
    for (const citation of [...item.ingredients, ...item.steps, ...item.measures, ...item.substitutions]) sourceQuote(citation.evidence);
  }
  const book = corpus.book;
  if (book) {
    if (book.releases.some(release => [release.realization, release.realizationRevision, release.language, release.platform]
      .some(value => value !== null && (typeof value !== 'string' || !value.trim()))))
      throw new Error('TEST PREMISE: release correspondence/platform must retain actual strings or explicit nulls');
    for (const evidence of [book.description.evidence, book.author.evidence,
      ...book.releases.map(item => item.evidence), ...book.chapters.map(item => item.body)]) sourceQuote(evidence);
  }
  if (selection === 'book') {
    if (!book) throw new Error('TEST PREMISE: selected Book fixture is missing');
    if (book.releases.length < 2 || book.chapters.length < 2
      || book.chapters.some(chapter => chapter.bodyText.length < 200
        || !chapter.body.exact.replace(/\s+/gu, ' ').includes(chapter.bodyText.replace(/\s+/gu, ' ').trim())))
      throw new Error('TEST PREMISE: real Book needs genuine releases and meaningful chapter bodies');
    return;
  }
  if (selection === 'recipe' && !corpus.richRecipe) throw new Error('TEST PREMISE: selected rich Recipe fixture is missing');
  if (selection === 'nutrition' && (!corpus.noNutritionRecipe || !Array.isArray(corpus.nutritionRecipes)))
    throw new Error('TEST PREMISE: selected nutrition fixture needs its no-nutrition control and entire nutrition matrix');
  const recipes = selection === 'recipe' ? [corpus.richRecipe!]
    : [corpus.noNutritionRecipe!, ...corpus.nutritionRecipes!];
  for (const item of recipes) {
    if (!item.source.author || !item.source.observation
      || !item.ingredients.length || !item.steps.length)
      throw new Error('TEST PREMISE: real recipes need source attribution and nonempty structure');
    const serving = item.measures.find(measure => measure.value.kind === 'servings')?.value.value;
    if (!serving || serving.numerator <= 0 || serving.denominator <= 0
      || new Set(item.order).size !== item.order.length
      || [...item.ingredients, ...item.steps].some(entry => !item.order.includes(entry.occurrence)))
      throw new Error('TEST PREMISE: recipes need positive source servings and a complete distinct occurrence receipt');
    if (item.nutrition === 'absent' && item.measures.some(measure => measure.value.kind === 'nutrient'))
      throw new Error('TEST PREMISE: do not invent nutrition absent from the source');
    if (item.nutrition === 'stated' && !item.measures.some(measure => measure.value.kind === 'nutrient'))
      throw new Error('TEST PREMISE: a stated-nutrition source must contain reviewed nutrient values');
  }
  if (selection === 'recipe') {
    const rich = corpus.richRecipe!;
    const names = rich.ingredients.map(item => item.qualifier.name);
    if (!names.some((name, index) => name && names.indexOf(name) !== index)
      || !rich.steps.some(item => item.qualifier.usesIngredient.length)
      || !rich.ingredients.some(item => item.qualifier.amount && item.qualifier.amount.denominator > 1
        && item.qualifier.scaling === 'linear')
      || !rich.measures.some(item => item.value.kind === 'servings')
      || !rich.measures.some(item => item.value.kind === 'cooking-duration'))
      throw new Error('TEST PREMISE: rich real recipe needs duplicate uses, fractional amounts, linked steps, servings and duration');
    return;
  }
  if (corpus.noNutritionRecipe!.nutrition !== 'absent') throw new Error('TEST PREMISE: missing no-nutrition source control');
  const nutrients = corpus.nutritionRecipes!.flatMap(item => item.measures.filter(measure => measure.value.kind === 'nutrient'));
  if (nutrients.some(item => !item.value.unit || !item.value.nutrient || !item.value.basis
    || !item.value.coverage || !item.value.provenance))
    throw new Error('TEST PREMISE: every source nutrient needs explicit units, basis, coverage and provenance');
  for (const [field, values] of [['basis', ['per-serving', 'whole-recipe']],
    ['coverage', ['complete', 'partial', 'unknown']], ['provenance', ['declared', 'source-stated', 'computed']]] as const) {
    if (values.some(value => !nutrients.some(item => item.value[field] === value)))
      throw new Error(`TEST PREMISE: retained nutrition evidence must exercise ${field}: ${values.join(', ')}`);
  }
  if (!corpus.nutritionRecipes!.some(item => item.substitutions.length))
    throw new Error('TEST PREMISE: missing author-declared exact substitute occurrence evidence');
}

// These are the existing custodian's immutable release receipts, not a new readiness declaration.
const borrowedBookReceipts = {
  producer: '67f2daa27512f56e20ddf44f6d60ac5fc64f1b55756ec912534a470dbd50621c',
  ready: '0fa18b85f40cc548f6a5c7f359199d7ec186b8058a7ae74463332068e251b675',
  qualification: 'fe64d6ed0a649b21cd78d7f99a8c025a08672b9fb05fea67441987100e246144',
  physical: 'a2f0aef93367e2330c4ad9dc9b236b425b7de230dbd21a1c1a3bcddd4426879c',
  owner: 'ffaa87a9875391f2062a114d763c75bf20092ec8054e6b297ae88de2f6182653',
  corpus: '767717d646390e440a2048eacd9b4b8d5d51afa43ad2f483399b2261866eb13c',
  personas: 'ae4aa80ec68007bef5ec65540472d5a914cefe2d2e90bc1d3e87774748b89ece',
} as const;
type BorrowedBookRecords = Record<keyof typeof borrowedBookReceipts, unknown>;
function borrowedPremise(condition: unknown, detail: string): asserts condition {
  if (!condition) throw new Error(`TEST PREMISE: borrowed Book ${detail}; no product assertion reached`);
}
function borrowedRecord(value: unknown): Record<string, unknown> {
  borrowedPremise(value && typeof value === 'object' && !Array.isArray(value), 'receipt is missing');
  return value as Record<string, unknown>;
}

/** Pure binding check over already digest-admitted custodian receipts. No runtime operation. */
export function assertPublicDomainBorrowedBook(corpus: PublicDomainCorpus, selection: PublicDomainSelection,
  records: BorrowedBookRecords): { main: string; account: string } {
  borrowedPremise(selection === 'book', 'attachment is Book-only');
  const execution = borrowedRecord(borrowedRecord(corpus).execution);
  const producer = borrowedRecord(records.producer), ready = borrowedRecord(records.ready);
  const qualification = borrowedRecord(records.qualification), physical = borrowedRecord(records.physical);
  const owner = borrowedRecord(records.owner), original = borrowedRecord(structuredClone(records.corpus));
  const product = '76c5955006dbea2016e84465d8f3e79fdf4fc979';
  const support = 'd2f04140fe615eadef0379a52c26291e6e083217';
  const run = 'book-current-site-20261020-r1', project = `rezics-qa-${run}`;
  const main = 'http://127.0.0.1:42963', account = 'http://127.0.0.1:42701';
  borrowedPremise(execution.productBaseline === publicDomainBaseline && execution.productRevision === product
    && execution.frontendRevision === product && execution.fixtureGeneration === 'recipes-build-mw0book-8b7d14'
    && typeof execution.testRevision === 'string' && /^[a-f0-9]{40}$/.test(execution.testRevision)
    && producer.productRevision === product && producer.consumerSupportRevision === support
    && producer.fixtureGeneration === execution.fixtureGeneration && producer.releasedTo === 'G-2823'
    && ready.productRevision === product && ready.supportRevision === support
    && qualification.productRevision === product && qualification.overlayRevision === support,
  'product/support/frontend/generation pins differ');
  borrowedPremise(ready.exit === 0 && qualification.exit === 0 && physical.exit === 0
    && ready.runId === run && ready.project === project && qualification.project === project
    && borrowedRecord(producer.copy).runId === run && borrowedRecord(producer.copy).project === project
    && ready.main === main && ready.account === account
    && borrowedRecord(producer.endpoints).main === main && borrowedRecord(producer.endpoints).account === account,
  'copy qualification or endpoints differ');
  borrowedPremise(ready.pid === owner.pid && Number.isSafeInteger(owner.pid) && Number(owner.pid) > 0
    && borrowedRecord(qualification.ownerProcess).pid === owner.pid
    && borrowedRecord(qualification.ownerProcess).startTicks === owner.startTicks
    && borrowedRecord(qualification.ownerProcess).script === owner.script,
  'custodian process identity differs');
  const artifacts = borrowedRecord(producer.artifacts), runtime = borrowedRecord(producer.runtime);
  borrowedPremise(borrowedRecord(artifacts.publicDomainConsumer).sha256 === borrowedBookReceipts.corpus
    && borrowedRecord(artifacts.custody).sha256 === borrowedRecord(execution.retainedCustody).sha256
    && borrowedRecord(artifacts.stoppedBackup).sha256 === borrowedRecord(physical.backupManifest).sha256
    && borrowedRecord(physical.backupManifest).verified === true
    && runtime.product === product && runtime.testRevision === support && runtime.runId === run
    && isDeepStrictEqual(runtime.model, qualification.model)
    && borrowedRecord(qualification.compatibility).digest === producer.compatibilityDigest
    && Array.isArray(borrowedRecord(qualification.migrations).pending)
    && (borrowedRecord(qualification.migrations).pending as unknown[]).length === 0
    && borrowedRecord(qualification.native).moduleVersion === '0.5.43'
    && borrowedRecord(qualification.native).instanceId === '11d5871b-af7e-44e7-927b-667c943ed3e7'
    && borrowedRecord(qualification.native).publicSearchWriteEpoch === '4'
    && borrowedRecord(qualification.native).profilesSha256 === 'd3b0d41321fbd5c38bce4b8fa8327d381fb8be0ba601f6922c839ea0146f406e',
  'backup/native/model custody differs');
  // Only the executable test/support pin is projected; every retained fixture identity/value stays exact.
  borrowedRecord(original.execution).testRevision = execution.testRevision;
  borrowedPremise(isDeepStrictEqual(original, corpus) && isDeepStrictEqual(records.personas, corpus.personas)
    && borrowedRecord(producer.bookNative).work === corpus.book.work,
  'corpus or retained personas differ');
  const identities = personaNames.filter(name => name !== 'visitor').map(name => corpus.personas.identities[name]);
  borrowedPremise(identities.every(identity => identity.accountId && identity.actingSubject && identity.email && identity.password)
    && new Set(identities.map(identity => identity.accountId)).size === 5
    && new Set(identities.map(identity => identity.actingSubject)).size === 5,
  'five distinct retained people are required');
  return { main, account };
}

export function loadPublicDomainBorrowedBook(corpus: PublicDomainCorpus, selection: PublicDomainSelection) {
  const pin = { file: Bun.env.REZICS_PUBLIC_DOMAIN_BORROWED_BOOK!, sha256: Bun.env.REZICS_PUBLIC_DOMAIN_BORROWED_BOOK_SHA256! };
  const pins = borrowedRecord(admissionJson(pin, 'borrowed Book attachment'));
  const records = {} as BorrowedBookRecords;
  for (const name of Object.keys(borrowedBookReceipts) as Array<keyof BorrowedBookRecords>) {
    const evidence = borrowedRecord(pins[name]);
    borrowedPremise(evidence.sha256 === borrowedBookReceipts[name], `${name} differs from the released custodian evidence`);
    records[name] = admissionJson(evidence as unknown as AuditFilePin, `borrowed Book ${name}`);
    if (name === 'personas' || name === 'corpus')
      borrowedPremise((statSync(localFile(String(evidence.file))).mode & 0o777) === 0o600, 'private evidence must be mode 0600');
  }
  borrowedPremise((statSync(localFile('.temp/goal/public-domain-corpus.json')).mode & 0o777) === 0o600,
    'private manifest must be mode 0600');
  const endpoints = assertPublicDomainBorrowedBook(corpus, selection, records);
  borrowedPremise(Bun.env.REZICS_QA_RUN_ID === borrowedRecord(records.ready).runId, 'existing run identity differs');
  const owner = borrowedRecord(records.owner), pid = Number(owner.pid);
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').slice(1).join(') ').split(' ');
    const args = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
    borrowedPremise(stat[19] === owner.startTicks && !['Z', 'X'].includes(stat[0]!)
      && args.includes(String(owner.script)), 'custodian is stale or changed');
  } catch (cause) { throw new Error('TEST PREMISE: borrowed Book custodian is unavailable', { cause }); }
  return endpoints;
}

function borrowedAuthFailure(persona: string, operation: string, status: number | null,
  oauthError: string | null = null, accountCode: string | null = null) {
  return Object.assign(new Error(`Borrowed Book ${persona} ${operation} failed: HTTP ${status ?? 'unavailable'}; `
    + `OAuth error ${oauthError ?? 'unreported'}; Account code ${accountCode ?? 'unreported'}`),
  { persona, operation, status, oauthError, accountCode });
}

async function checkBorrowedAuthCleanup(response: Response, persona: string, operation: string) {
  if (response.ok) return;
  // Responses and transport errors can contain credentials. Only known protocol codes leave cleanup.
  const body: unknown = await response.json().catch(() => null);
  const fields = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  const oauthErrors = ['invalid_request', 'invalid_client', 'invalid_grant', 'unauthorized_client',
    'unsupported_token_type', 'unsupported_grant_type', 'invalid_scope', 'access_denied', 'server_error', 'temporarily_unavailable'];
  const accountCodes = ['MISSING_OR_NULL_ORIGIN', 'INVALID_ORIGIN', 'UNAUTHORIZED', 'FORBIDDEN', 'TOO_MANY_REQUESTS'];
  const oauthError = typeof fields.error === 'string' && oauthErrors.includes(fields.error) ? fields.error : null;
  const accountCode = typeof fields.code === 'string' && accountCodes.includes(fields.code) ? fields.code : null;
  throw borrowedAuthFailure(persona, operation, response.status, oauthError, accountCode);
}

/** Fresh normal OAuth handles only. This lifetime owns no applications, restore driver or runtime. */
export async function attachPublicDomainBook(corpus: PublicDomainCorpus, endpoints: { main: string; account: string }): Promise<PersonaSessions> {
  const started = performance.now(), retained = corpus.personas;
  const resource = borrowedRecord(retained.auth).resource;
  borrowedPremise(typeof resource === 'string' && resource.length > 0, 'retained OAuth resource is missing');
  const cleanups: Array<() => Promise<void>> = [];
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    const results = await Promise.allSettled(cleanups.map(cleanup => cleanup()));
    const failures = results.filter(result => result.status === 'rejected');
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Borrowed Book auth cleanup failed');
  })();
  const visitor = personaSession(endpoints.main, endpoints.account, null);
  const people = {} as Record<Exclude<typeof personaNames[number], 'visitor'>, PersonaSession>;
  try {
    for (const name of personaNames.filter(name => name !== 'visitor')) {
      const identity = retained.identities[name];
      const anonymous = personaSession(endpoints.main, endpoints.account, null, undefined, undefined,
        undefined, name, undefined, undefined, retained.auth.accountOrigin);
      const login = await anonymous.account('POST', '/api/auth/sign-in/email', { email: identity.email, password: identity.password });
      const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
      let oauth: LocalOAuthSession | undefined;
      if (cookie) cleanups.push(async () => {
        const failures: unknown[] = [];
        if (oauth) for (const [token, hint] of [[oauth.refreshToken, 'refresh_token'], [oauth.accessToken, 'access_token']] as const) {
          if (!token) continue;
          const operation = `revoke ${hint}`;
          try {
            const revoked = await fetch(`${endpoints.account}/api/auth/oauth2/revoke`, { method: 'POST',
              headers: { 'content-type': 'application/x-www-form-urlencoded' }, signal: AbortSignal.timeout(30_000),
              body: new URLSearchParams({ token, token_type_hint: hint, client_id: retained.auth.clientId }) })
              .catch(() => { throw borrowedAuthFailure(name, operation, null); });
            await checkBorrowedAuthCleanup(revoked, name, operation);
          } catch (error) { failures.push(error); }
        }
        try {
          const signedOut = await fetch(`${endpoints.account}/api/auth/sign-out`, { method: 'POST',
            headers: { cookie, origin: retained.auth.accountOrigin }, signal: AbortSignal.timeout(30_000) })
            .catch(() => { throw borrowedAuthFailure(name, 'sign-out', null); });
          await checkBorrowedAuthCleanup(signedOut, name, 'sign-out');
        } catch (error) { failures.push(error); }
        if (failures.length) throw new AggregateError(failures, `Borrowed Book ${name} auth cleanup failed`);
      });
      const user = await answer<{ user: { id: string } }>(Promise.resolve(login));
      borrowedPremise(cookie && user.user.id === identity.accountId, `normal sign-in selected a different Account for ${name}`);
      oauth = await signIn({ account: retained.auth.accountOrigin, service: endpoints.account,
        clientId: retained.auth.clientId, redirectUri: retained.auth.redirectUris[0]!, scope: retained.auth.scope, resource }, cookie);
      const person = personaSession(endpoints.main, endpoints.account, identity.accountId, cookie, oauth,
        undefined, name, undefined, undefined, retained.auth.accountOrigin);
      person.actingSubject = identity.actingSubject;
      await answer(person.main('PUT', '/v1/me/session-agent', { actingSubject: identity.actingSubject, expectedRevision: null }));
      people[name] = person;
    }
    return { realm: retained.realm, space: retained.space, zone: retained.zone, visibility: retained.visibility,
      visitor, ...people, elapsedSeconds: (performance.now() - started) / 1000, close };
  } catch (error) {
    try { await close(); } catch (cleanup) { throw new AggregateError([error, cleanup], 'Borrowed Book attach and auth cleanup failed'); }
    throw error;
  }
}

/** Default consumers restore; an explicit qualified Book borrower attaches without lifecycle ownership. */
export async function publicDomainFixture(selection: PublicDomainSelection) {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Use goalctl test with an isolated QA stack');
  const corpus = loadPublicDomainCorpus(selection);
  if (Bun.env.REZICS_PUBLIC_DOMAIN_BORROWED_BOOK !== undefined
    || Bun.env.REZICS_PUBLIC_DOMAIN_BORROWED_BOOK_SHA256 !== undefined) {
    const endpoints = loadPublicDomainBorrowedBook(corpus, selection);
    const people = await attachPublicDomainBook(corpus, endpoints);
    return { corpus, people, preparation: undefined, close: people.close };
  }
  const smokeWork = selection === 'book' ? corpus.book.work
    : selection === 'recipe' ? corpus.richRecipe.work : corpus.noNutritionRecipe.work;
  const target = `public-domain-${selection}-${randomUUID().slice(0, 8)}`;
  let people: PersonaSessions | undefined;
  let copyEnvironment: Record<string, string> = {};
  const driver = createCorpusBackupDriver({ sourceRunId: Bun.env.REZICS_QA_RUN_ID,
    directory: resolve('.temp/goal/public-domain-copies'), resumeSource: false,
    async quiesce() { throw new Error('Public domain outcome consumers restore the retained backup; they never rebuild it'); },
    async smokeRead(input) {
      const environment = { ...input.apps, REZICS_QA_RUN_ID: input.runId,
        REZICS_QA_STACK_MODE: 'scale', REZICS_QA_STACK_TIER: 'integration', REZICS_STACK_PROFILE: 'qa' };
      copyEnvironment = environment;
      const previous = new Map(Object.keys(environment).map(key => [key, Bun.env[key]]));
      Object.assign(Bun.env, environment);
      try {
        [people] = await restorePersonaRealms([corpus.personas]);
        if (!people) throw new Error('Retained public corpus personas are missing');
        await answer(people.visitor.main('GET', `/v1/works/${short(smokeWork)}`));
        input.signal.throwIfAborted();
        return () => people!.close();
      } catch (error) { await people?.close(); throw error; }
      finally {
        for (const [key, value] of previous) {
          if (value === undefined) delete Bun.env[key]; else Bun.env[key] = value;
        }
      }
    },
  });
  await driver.restore(corpus.backup, target, AbortSignal.timeout(600_000));
  const preparation = driver.preparation(target);
  expect(preparation?.totalMs).toBeLessThanOrEqual(600_000);
  const previous = new Map(Object.keys(copyEnvironment).map(key => [key, Bun.env[key]]));
  Object.assign(Bun.env, copyEnvironment);
  return { corpus, people: people!, preparation, close: async () => {
    try { await driver.stop(target); }
    finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete Bun.env[key]; else Bun.env[key] = value;
      }
    }
  } };
}

/** Setup asserts the grant, truthful publication and anonymous non-null receipt
 * before any test.failing body can classify an outcome failure. */
export async function publishPublicRecipe(people: PersonaSessions, recipe: PublicRecipe): Promise<void> {
  const publisher = people[recipe.publisher];
  await grantPersonaFixtureAuthority(publisher, [{ scope: `work:publish:${recipe.work}`, action: 'work.publish' }]);
  const receipt = await answer<{ publicationDecision: string }>(publisher.main('POST', '/v1/work-publications', {
    profile: 'work-structure-publication-v1', operation: 'publish', work: recipe.work,
    actingSubject: publisher.actingSubject, expectedWorkHead: recipe.workRevision,
    expectedMainVersion: recipe.mainVersion, structure: recipe.structure, expectedStructureHead: recipe.revision,
    expectedPublicationHead: null, disclosure: 'public', rightsBasis: 'public-domain', sourceObservation: recipe.source.observation,
  }), 201);
  expect(receipt.publicationDecision).toBeString();
  const page = await answer<RecipePage | null>(people.visitor.main('GET', `/v1/recipes/works/${short(recipe.work)}`));
  expect(page, 'TEST PREMISE: successful publication must have an anonymous non-null recipe').not.toBeNull();
  expect(page?.revision).toBe(recipe.revision);
  expect(page?.structure).toBe(recipe.structure);
}

export async function addPrivateRecipeDraft(people: PersonaSessions, recipe: PublicRecipe): Promise<void> {
  await answer(people[recipe.publisher].main('POST', `/v1/compositions/${short(recipe.structure)}/changes`, {
    profile: 'recipe-composition', expectedHead: recipe.revision, actingSubject: people[recipe.publisher].actingSubject,
    operations: [{ op: 'insert', parent: recipe.structure, position: 'last', role: 'ingredient', qualifier: {
      type: 'ingredient-line', originalText: { value: privateRecipeText, language: 'en' },
      optional: false, scaling: 'not-scalable', substituteFor: [], parseStatus: 'unparsed',
    } }],
  }));
}

export async function recipePages(call: Call, person: PersonaSession, recipe: PublicRecipe, servings?: number) {
  const pages: RecipePage[] = [], seen = new Set<string>();
  let cursor: string | undefined;
  do {
    const query = new URLSearchParams();
    if (cursor) query.set('cursor', cursor);
    else if (servings !== undefined) query.set('servings', String(servings));
    const page = await answer<RecipePage>(call('GET', viewer(person, `/v1/recipes/works/${short(recipe.work)}?${query}`)));
    expect(page).toMatchObject({ profile: 'recipe-work-page-v1', structure: recipe.structure, revision: recipe.revision });
    expect(page.occurrences.length).toBeLessThanOrEqual(100);
    expect(JSON.stringify(page)).not.toContain(privateRecipeText);
    pages.push(page);
    cursor = page.next;
    if (cursor) { expect(seen.has(cursor), 'Recipe continuation must advance').toBe(false); seen.add(cursor); }
    expect(pages.length).toBeLessThanOrEqual(Math.ceil(recipe.order.length / 100) + 1);
  } while (cursor);
  expect(pages.flatMap(page => page.occurrences.map(item => item.occurrence))).toEqual(recipe.order);
  return pages;
}

/** Cook's durable API state is whole-Work standing. Step/timer UI behavior is a
 * separate browser obligation; an API standing receipt does not prove that UI. */
export async function ownCookProgress(call: Call, people: PersonaSessions, name: keyof Pick<PersonaSessions,
  'visitor' | 'stranger' | 'member' | 'owner' | 'moderator' | 'operator'>, recipe: PublicRecipe) {
  const person = people[name], path = `/v1/works/${short(recipe.work)}/progress`;
  const other = name === 'owner' ? people.stranger : people.owner;
  if (name === 'visitor') {
    await answer(call('PUT', path, { actingSubject: other.actingSubject, expectedVersion: 0, standing: 'started' }), 401);
    return;
  }
  type Standing = { work: string; parts: false; standing: string; version: number; replayed?: boolean };
  const read = await answer<Standing>(call('GET', viewer(person, path)));
  expect(read).toMatchObject({ work: recipe.work, parts: false });
  const key = randomUUID();
  const body = { actingSubject: person.actingSubject, expectedVersion: read.version, standing: 'started' };
  const saved = await answer<Standing>(call('PUT', path, body, key));
  expect(saved).toMatchObject({ work: recipe.work, standing: 'started', version: read.version + 1 });
  expect(await answer(call('PUT', path, body, key))).toMatchObject({ ...saved, replayed: true });
  await answer(call('PUT', path, { ...body, standing: 'completed' }), 409);
  const refreshed = await call('GET', viewer(person, path));
  expect(refreshed.headers.get('cache-control')).toBe('private, no-store');
  expect(await answer(Promise.resolve(refreshed))).toMatchObject({ standing: 'started', version: saved.version });
  await answer(call('GET', `${path}?${new URLSearchParams({ actingSubject: other.actingSubject! })}`), 403);
  await answer(call('PUT', path, { ...body, actingSubject: other.actingSubject }), 403);
}
