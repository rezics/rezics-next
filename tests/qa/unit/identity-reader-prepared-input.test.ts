import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { selectTestGroups } from '../../../scripts/qa/test.ts';
import { checkIdentityReaderPin, identityReaderFixture, identityReaderOriginals, identityReaderOutputDirectory,
  validatePreparedIdentityReaderCorpus, validatePreparedIdentityReaderInput, validateIdentityReaderLease,
  validateIdentityReaderAdmission, validatePartialReaderCorpus, validatePartialReaderLease, validatePartialReaderReport,
  partialReaderSelection, partialReaderControls, partialReaderAttachment, readerInvalidBearerSurfaces,
  type PartialReaderInput, type PartialReaderLease, type PartialReaderCorpus, type ReaderOriginalTest,
  type PartialReaderDisposal, type PartialReaderSession,
  type PreparedIdentityReaderInput, type IdentityReaderLease } from '../support/identity-reader-fixture.ts';
import { personaSession } from '../support/personas.ts';

// These are stack-free shape examples, never live qualification or successful API answers.
const sha = 'a'.repeat(64);
const ref = { path: '.temp/retained-input', sha256: sha };
function input(): PreparedIdentityReaderInput {
  return { format: 'identity-reader-prepared-v1', sourceRoot: '/retained/product', productRevision: 'b'.repeat(40),
    productTree: 'c'.repeat(40), qualification: ref, sourceEquivalence: ref, corpus: ref, custodyModule: ref,
    custodyInput: ref, leaseId: 'finite-identity-reader', mainOrigin: 'http://127.0.0.1:42963',
    accountService: 'http://127.0.0.1:42701', accountOrigin: 'http://account.example',
    accountResource: 'urn:rezics:main', outputDirectory: '.temp/identity-reader-prepared/run' };
}
function corpus(): Record<string, any> {
  const names = ['stranger', 'member', 'owner', 'moderator', 'operator'];
  const book = (label: string, count: number) => ({ work: label, mainVersion: `${label}-version`, title: label,
    structure: `${label}-structure`, compositionRevision: `${label}-composition`, contribution: `${label}-contribution`,
    publicationDecision: `${label}-publication`, chapters: Array.from({ length: count }, (_, i) => ({
      post: `${label}-post-${i}`, variantId: `${label}-variant-${i}`, occurrence: `${label}-occurrence-${i}`,
      compositionRevision: `${label}-composition-${i}`, revisionId: `${label}-revision-${i}`, byteDigest: sha,
      text: `Retained phrase chapter ${i}`,
    })) });
  return { realm: { realm: 'public-realm', space: 'space', zone: 'zone', visibility: 'public',
    identities: Object.fromEntries(names.map(name => [name, { email: `${name}@example.test`, password: 'shape-only',
      accountId: `${name}-account`, actingSubject: `${name}-person` }])),
    auth: { clientId: 'original-client', scope: 'openid profile email work:read',
      accountOrigin: 'http://account.example', redirectUris: ['http://main.example/callback'] } },
    alternatives: Object.fromEntries(names.map(name => [name, `${name}-organization`])),
    emptyIdentity: { email: 'empty@example.test', password: 'shape-only', accountId: 'empty-account' },
    publicBook: book('public', 2), emptyBook: book('empty', 0), privateBook: book('private', 1),
    unpublishedBook: book('unpublished', 1), unpublishedRevision: 'unpublished-successor', phrase: 'Retained phrase' };
}
function lease(): IdentityReaderLease {
  const bound = input();
  return { ...bound, borrower: 'G-2775', custodian: 'G-2823', id: bound.leaseId, recordedJobId: 'actual-job',
    activatedAt: '2026-10-21T10:00:00.000Z', expiresAt: '2026-10-21T10:10:00.000Z', activation: ref,
    assertActive() {}, fault: { fail() {}, failures: 0 } };
}
const now = Date.parse('2026-10-21T10:01:00Z');
test('prepared input accepts complete shape without claiming live qualification', () => {
  expect(() => validatePreparedIdentityReaderInput(input())).not.toThrow();
  expect(() => validatePreparedIdentityReaderCorpus(corpus())).not.toThrow();
  expect(() => validateIdentityReaderLease(lease(), input(), now)).not.toThrow();
});
for (const [label, change, error] of [
  ['missing second Agent', (c: ReturnType<typeof corpus>) => { delete c.alternatives.stranger; }, 'stranger second distinct'],
  ['Person substituted for Organization', (c: ReturnType<typeof corpus>) => { c.alternatives.stranger = c.realm.identities.stranger.actingSubject; }, 'stranger second distinct'],
  ['foreign Account relabeled as empty', (c: ReturnType<typeof corpus>) => { c.emptyIdentity.accountId = c.realm.identities.owner.accountId; }, 'empty Account substitutes'],
  ['missing empty Account', (c: ReturnType<typeof corpus>) => { delete c.emptyIdentity; }, 'genuine no-Agent Account'],
  ['same Account for two personas', (c: ReturnType<typeof corpus>) => { c.realm.identities.member.accountId = c.realm.identities.owner.accountId; }, 'Account duplicated'],
  ['C28 five chapters substituted', (c: ReturnType<typeof corpus>) => { c.publicBook.chapters.push(...c.privateBook.chapters); }, 'publicBook requires 2'],
  ['public Book relabeled private', (c: ReturnType<typeof corpus>) => { c.privateBook = c.publicBook; }, 'substitutes another Book'],
  ['published revision relabeled successor', (c: ReturnType<typeof corpus>) => { c.unpublishedRevision = c.publicBook.chapters[0].revisionId; }, 'distinct unpublished successor'],
  ['missing chapter hash', (c: ReturnType<typeof corpus>) => { delete c.publicBook.chapters[0].byteDigest; }, 'chapter.byteDigest'],
  ['missing phrase control', (c: ReturnType<typeof corpus>) => { c.phrase = 'unmatched'; }, 'exact phrase control'],
  ['missing callback', (c: ReturnType<typeof corpus>) => { c.realm.auth.redirectUris = []; }, 'client/scope/callback'],
] as const) test(`prepared controls reject ${label} before any runtime attachment`, () => {
  const value = corpus(); change(value);
  expect(() => validatePreparedIdentityReaderCorpus(value)).toThrow(error);
});
for (const field of ['corpus', 'qualification', 'sourceEquivalence', 'custodyModule', 'custodyInput'] as const)
  test(`prepared input rejects unpinned ${field}`, () => {
    const value = { ...input(), [field]: { path: '.temp/file' } };
    expect(() => validatePreparedIdentityReaderInput(value)).toThrow(`${field} file/digest`);
  });
test('prepared input rejects endpoint rewriting and credential-bearing origins', () => {
  for (const mainOrigin of ['http://main.example/path', 'http://secret@main.example', 'file:///tmp/main'])
    expect(() => validatePreparedIdentityReaderInput({ ...input(), mainOrigin })).toThrow('exact HTTP origin');
});
for (const [label, change, error] of [
  ['expired admission', (l: IdentityReaderLease) => { l.expiresAt = '2026-10-21T10:00:01Z'; }, 'fresh finite'],
  ['future admission', (l: IdentityReaderLease) => { l.activatedAt = '2026-10-21T10:02:00Z'; }, 'fresh finite'],
  ['over-budget admission', (l: IdentityReaderLease) => { l.expiresAt = '2026-10-21T10:10:00.001Z'; }, 'fresh finite'],
  ['another lease', (l: IdentityReaderLease) => { l.id = 'released-C28-lease'; }, 'named recorded custody'],
  ['another runtime', (l: IdentityReaderLease) => { l.mainOrigin = 'http://127.0.0.1:754'; }, 'mainOrigin lease binding'],
  ['another source tree', (l: IdentityReaderLease) => { l.productTree = 'd'.repeat(40); }, 'productTree lease binding'],
  ['missing fault count', (l: IdentityReaderLease) => { l.fault = { fail() {}, failures: NaN }; }, 'fault/recovery/count'],
] as const) test(`prepared custody rejects ${label}`, () => {
  const value = lease(); change(value);
  expect(() => validateIdentityReaderLease(value, input(), now)).toThrow(error);
});
test('file admission detects changed retained bytes', () => {
  mkdirSync('.temp', { recursive: true });
  const dir = mkdtempSync(resolve('.temp/identity-reader-pin-')), path = resolve(dir, 'private.json');
  try {
    writeFileSync(path, '{}', { mode: 0o600 });
    const sha256 = createHash('sha256').update('{}').digest('hex');
    expect(checkIdentityReaderPin({ path, sha256 })).toBe(path);
    writeFileSync(path, '{"changed":true}');
    expect(() => checkIdentityReaderPin({ path, sha256 })).toThrow('digest differs');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('explicit prepared opt-in never falls back to original corpus preparation', async () => {
  const previous = Bun.env.REZICS_IDENTITY_READER_PREPARED_INPUT;
  try {
    Bun.env.REZICS_IDENTITY_READER_PREPARED_INPUT = '';
    await expect(identityReaderFixture()).rejects.toThrow('REZICS_IDENTITY_READER_PREPARED_INPUT missing');
  } finally {
    if (previous === undefined) delete Bun.env.REZICS_IDENTITY_READER_PREPARED_INPUT;
    else Bun.env.REZICS_IDENTITY_READER_PREPARED_INPUT = previous;
  }
});
test('prepared output rejects peer-tree and symlink escapes before writing', () => {
  mkdirSync('.temp', { recursive: true });
  const dir = mkdtempSync(resolve('.temp/identity-reader-output-'));
  try {
    mkdirSync(resolve(dir, '.temp'));
    symlinkSync(resolve(dir, '..'), resolve(dir, '.temp/peer'));
    expect(identityReaderOutputDirectory(resolve(dir, '.temp/own/run'), dir)).toBe(resolve(dir, '.temp/own/run'));
    expect(() => identityReaderOutputDirectory(resolve(dir, 'outside'), dir)).toThrow('without symlink escape');
    expect(() => identityReaderOutputDirectory(resolve(dir, '.temp/peer/run'), dir)).toThrow('without symlink escape');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('prepared original selection uses loose wrappers without starting a hosted stack', () => {
  mkdirSync('.temp', { recursive: true });
  const dir = mkdtempSync(resolve('.temp/identity-reader-selection-'));
  try {
    const wrappers = identityReaderOriginals.map((original, i) => {
      const path = resolve(dir, `original-${i}.test.ts`);
      writeFileSync(path, `import ${JSON.stringify(resolve(original.path))};\n`);
      return path;
    });
    const groups = selectTestGroups(wrappers);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.tier).toBeUndefined();
    expect(groups[0]!.command[0]).toBe('bun');
    expect(groups[0]!.command[1]).toEqual(['test', ...wrappers]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// Partial inputs are pure shape examples. They neither create nor qualify retained controls.
function partialInput(): PartialReaderInput {
  return { ...input(), format: 'identity-reader-partial-v1', requiredControls: ['oauth-principals', 'public-references', 'phrase'],
    selectedOriginalTests: readerInvalidBearerSurfaces.map<ReaderOriginalTest>(surface =>
      `D4-008 / invalid bearer: ${surface} returns authentication refusal without anonymous retry`),
  };
}
function partialCorpus(): Record<string, any> {
  const { realm, publicBook, phrase } = corpus();
  // Five chapters are lawful for these seven refusal bodies, never for the two-chapter reader/search bodies.
  const value: PartialReaderCorpus = {
    realm: { ...realm, auth: { clientId: realm.auth.clientId, scope: realm.auth.scope,
      accountOrigin: realm.auth.accountOrigin, redirectUris: realm.auth.redirectUris } },
    publicBook: { work: publicBook.work, mainVersion: publicBook.mainVersion,
      chapters: Array.from({ length: 5 }, (_, i) => ({ occurrence: `actual-occurrence-${i}`, revisionId: `actual-revision-${i}` })) },
    phrase,
  };
  return value;
}
function partialLease(): PartialReaderLease {
  const { fault: _fault, ...bound } = lease();
  return { ...bound, corpusSha256: sha, qualificationSha256: sha,
    selectedOriginalTests: partialInput().selectedOriginalTests, requiredControls: partialInput().requiredControls,
    retainSession() { throw new Error('shape-only session registry must not be invoked'); },
    async closeAttachment() { throw new Error('shape-only attachment must not be invoked'); },
  };
}
const selected = (body: 'links' | 'search' | 'concealment'): PartialReaderInput => {
  const title = { links: 'public Book contents, chapter and default links select the same published bytes',
    search: 'audited public phrase search and its continuation lead to readable chapters',
    concealment: 'empty, private, unpublished and missing reader data remain distinct' }[body];
  return { ...partialInput(), selectedOriginalTests: [`D4-008 / visitor: ${title}` as ReaderOriginalTest],
    requiredControls: body === 'concealment' ? ['oauth-principals', 'concealment']
      : ['oauth-principals', 'public-references', 'two-chapter-book', 'original-introduction', ...(body === 'search' ? ['phrase' as const] : [])] };
};
test('partial seven-body admission needs genuine public references and five principals, without identity or fault controls', () => {
  expect(() => validateIdentityReaderAdmission(partialInput())).not.toThrow();
  expect(() => validatePartialReaderCorpus(partialCorpus(), partialInput())).not.toThrow();
  expect(() => validatePartialReaderLease(partialLease(), partialInput(), now)).not.toThrow();
  expect(() => validatePreparedIdentityReaderInput(partialInput())).toThrow('input format');
  expect(() => validatePreparedIdentityReaderCorpus(partialCorpus())).toThrow('identities/alternatives');
  const plan = partialReaderSelection(partialInput());
  expect(plan.selected).toHaveLength(7);
  expect(plan.unselected).toHaveLength(25);
  const pattern = new RegExp(plan.pattern);
  for (const title of plan.selected) {
    expect(pattern.test(title)).toBe(true);
    expect(pattern.test(`prefix ${title}`)).toBe(false);
    expect(pattern.test(`${title} suffix`)).toBe(false);
  }
  for (const { title } of plan.unselected) expect(pattern.test(title)).toBe(false);
});
for (const [label, change, error] of [
  ['missing OAuth persona', (c: ReturnType<typeof partialCorpus>) => { delete c.realm.identities.operator; }, 'operator retained identity'],
  ['missing callback', (c: ReturnType<typeof partialCorpus>) => { c.realm.auth.redirectUris = []; }, 'OAuth client/scope/callback'],
  ['duplicate principal', (c: ReturnType<typeof partialCorpus>) => { c.realm.identities.member.accountId = c.realm.identities.owner.accountId; }, 'Account duplicated'],
  ['missing public chapter', (c: ReturnType<typeof partialCorpus>) => { c.publicBook.chapters = []; }, 'at least one'],
  ['missing exact revision', (c: ReturnType<typeof partialCorpus>) => { delete c.publicBook.chapters[0].revisionId; }, 'chapter references'],
  ['missing phrase', (c: ReturnType<typeof partialCorpus>) => { delete c.phrase; }, 'phrase control'],
  ['fabricated alternatives', (c: ReturnType<typeof partialCorpus>) => { c.alternatives = {}; }, 'not an admitted control'],
  ['fake fault capability', (c: ReturnType<typeof partialCorpus>) => { c.fault = {}; }, 'not an admitted control'],
] as const) test(`partial admission rejects ${label} before runtime attachment`, () => {
  const value = partialCorpus(); change(value);
  expect(() => validatePartialReaderCorpus(value, partialInput())).toThrow(error);
});
test('partial selectors reject slicing, broad patterns, unsupported bodies and mismatched required controls', () => {
  for (const title of ['D4-008', '.*', 'D4-008 / visitor: missing UUID',
    'D4-008 / visitor: owner failure is unavailable and recovery retains the Book and Account',
    'D4-008 / authenticated empty Account: public reading requires no anonymous authority change'])
    expect(() => validateIdentityReaderAdmission({ ...partialInput(), selectedOriginalTests: [title] })).toThrow('unsupported whole-original');
  expect(() => validateIdentityReaderAdmission({ ...partialInput(), selectedOriginalTests: [] })).toThrow('nonempty distinct');
  expect(() => validateIdentityReaderAdmission({ ...partialInput(), selectedOriginalTests: [partialInput().selectedOriginalTests[0], partialInput().selectedOriginalTests[0]] })).toThrow('nonempty distinct');
  expect(() => validateIdentityReaderAdmission({ ...partialInput(), requiredControls: ['oauth-principals'] })).toThrow('requiredControls differ');
  expect(() => validateIdentityReaderAdmission({ ...partialInput(), requiredControls: ['oauth-principals', 'public-references', 'fault'] })).toThrow('requiredControls differ');
});
test('partial controls throw on all unavailable access including nested references and fault counters', () => {
  const value = partialCorpus(); validatePartialReaderCorpus(value, partialInput());
  const controls = partialReaderControls(value, partialInput());
  expect(controls.corpus.publicBook.chapters[0]!.revisionId).toBe('actual-revision-0');
  for (const key of ['emptyIdentity', 'alternatives', 'emptyBook', 'privateBook', 'unpublishedBook', 'unpublishedRevision'] as const)
    expect(() => controls.corpus[key]).toThrow('unavailable partial control');
  expect(() => controls.corpus.publicBook.chapters[0]!.byteDigest).toThrow('unavailable partial control');
  expect(() => controls.fault.failures).toThrow('unavailable partial control fault');
  expect(() => controls.fault.fail(true)).toThrow('unavailable partial control fault');
  const extra = { ...value, emptyBook: corpus().emptyBook };
  expect(() => partialReaderControls(extra, partialInput()).corpus.emptyBook).toThrow('unavailable partial control');
});
for (const body of ['links', 'search'] as const) test(`whole ${body} rejects the retained five-chapter Book and requires the original introduction`, () => {
  expect(() => validatePartialReaderCorpus(partialCorpus(), selected(body))).toThrow('requires 2 exact chapters');
  const { realm, publicBook, phrase } = corpus();
  const value = { realm, publicBook, phrase, introduction: 'An original catalogue introduction about a garden beside a river.' };
  expect(() => validatePartialReaderCorpus(value, selected(body))).not.toThrow();
  expect(() => validatePartialReaderCorpus({ ...value, introduction: 'replacement' }, selected(body))).toThrow('exact original introduction');
  if (body === 'search') expect(() => validatePartialReaderCorpus({ ...value, phrase: 'unmatched' }, selected(body))).toThrow('exact phrase');
});
test('admitted whole-link controls retain original iteration and previous/next array boundaries', () => {
  const { realm, publicBook } = corpus();
  const value = { realm, publicBook, introduction: 'An original catalogue introduction about a garden beside a river.' };
  validatePartialReaderCorpus(value, selected('links'));
  const { chapters } = partialReaderControls(value, selected('links')).corpus.publicBook;
  expect(chapters.map(chapter => chapter.occurrence)).toEqual(publicBook.chapters.map((chapter: any) => chapter.occurrence));
  for (const [index, chapter] of chapters.entries()) {
    expect(chapter.revisionId).toBe(publicBook.chapters[index].revisionId);
    expect(chapters[index - 1]?.occurrence ?? null).toBe(publicBook.chapters[index - 1]?.occurrence ?? null);
    expect(chapters[index + 1]?.occurrence ?? null).toBe(publicBook.chapters[index + 1]?.occurrence ?? null);
  }
  expect(() => Reflect.get(chapters[0]!, 'unknown')).toThrow('unavailable partial control');
});
test('whole concealment requires empty, private, unpublished and successor controls together', () => {
  const { realm, emptyBook, privateBook, unpublishedBook, unpublishedRevision } = corpus();
  const value = { realm, emptyBook, privateBook, unpublishedBook, unpublishedRevision };
  expect(() => validatePartialReaderCorpus(value, selected('concealment'))).not.toThrow();
  for (const field of ['emptyBook', 'privateBook', 'unpublishedBook', 'unpublishedRevision'] as const) {
    const missing = { ...value }; delete missing[field];
    expect(() => validatePartialReaderCorpus(missing, selected('concealment'))).toThrow();
  }
  expect(() => validatePartialReaderCorpus({ ...value, privateBook: unpublishedBook }, selected('concealment'))).toThrow('substitutes');
});
test('partial lease binds exact selected bodies, pinned controls and real attachment disposal without requiring fault injection', () => {
  for (const value of [
    { ...partialLease(), corpusSha256: 'b'.repeat(64) },
    { ...partialLease(), qualificationSha256: 'b'.repeat(64) },
    { ...partialLease(), selectedOriginalTests: [] },
    { ...partialLease(), requiredControls: [] },
    { ...partialLease(), retainSession: undefined },
    { ...partialLease(), closeAttachment: undefined },
    { ...partialLease(), expiresAt: '2026-10-21T10:00:01Z' },
    { ...partialLease(), mainOrigin: 'http://127.0.0.1:754' },
  ]) expect(() => validatePartialReaderLease(value as PartialReaderLease, partialInput(), now)).toThrow();
});
test('partial execution receipt rejects zero matches, skipped selected bodies, failures and unexpected extra bodies', () => {
  const titles = partialReaderSelection(partialInput()).selected;
  const passed = titles.map(title => `<testcase name="${title}"/>`).join('');
  expect(() => validatePartialReaderReport(passed, titles)).not.toThrow();
  expect(() => validatePartialReaderReport(passed + '<testcase name="unselected"><skipped/></testcase>', titles)).not.toThrow();
  for (const xml of ['', passed.replace(/<testcase[^>]+\/>/, ''),
    passed.replace('/>', '><skipped/></testcase>'), passed.replace('/>', '><failure/></testcase>'),
    passed + passed, passed + '<testcase name="unadmitted"/>'])
    expect(() => validatePartialReaderReport(xml, titles)).toThrow();
});
test('goalctl forwards the anchored whole-body selector and Bun executes exactly those complete tests', () => {
  mkdirSync('.temp', { recursive: true });
  const dir = mkdtempSync(resolve('.temp/identity-reader-partial-selector-'));
  try {
    const plan = partialReaderSelection(partialInput()), path = resolve(dir, 'selection.test.ts');
    const junit = resolve(dir, 'selected.xml');
    writeFileSync(path, `import {test} from 'bun:test';\n` + [...plan.selected, ...plan.unselected.map(cell => cell.title)]
      .map(title => `test(${JSON.stringify(title)},()=>{${plan.selected.includes(title) ? '' : "throw Error('unselected body executed')"}});`).join('\n'));
    const flags = ['--test-name-pattern', plan.pattern, '--reporter=junit', `--reporter-outfile=${junit}`];
    const groups = selectTestGroups([path, ...flags]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.tier).toBeUndefined();
    expect(groups[0]!.command).toEqual(['bun', ['test', path, ...flags]]);
    execFileSync('bun', ['test', path, ...flags], { stdio: 'pipe' });
    expect(() => validatePartialReaderReport(readFileSync(junit, 'utf8'), plan.selected)).not.toThrow();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// Behavioral unit boundary only: no real Account, OAuth server, custody or runtime cleanup is qualified here.
function attachmentUnit() {
  mkdirSync('.temp', { recursive: true });
  const dir = mkdtempSync(resolve('.temp/identity-reader-cleanup-unit-'));
  const admitted = partialInput(), controls = partialCorpus();
  validatePartialReaderCorpus(controls, admitted);
  const flags = { expired: false, tokenStatus: 200, signOutStatus: 200, absenceStatus: 200,
    retainFailure: false, closeFailure: false, accountMismatch: false, sessionPersists: false };
  const foreign = 'unit-foreign-cookie=untouched', live = new Set([foreign]);
  const registered: PartialReaderSession[] = [], owned = new Map<string, PartialReaderSession>();
  const events: string[] = [], cleanup: { method: string; path: string; cookie: string; origin: string | null }[] = [];
  let count = 0, activeCalls = 0;
  let mutate: (receipt: PartialReaderDisposal) => void = () => {};
  const visitor = personaSession(admitted.mainOrigin, admitted.accountService, null);
  visitor.account = async (method, path, body) => {
    if (method !== 'POST' || path !== '/api/auth/sign-in/email') throw new Error('unexpected unit Account call');
    const principal = Object.values(controls.realm.identities).find(identity => identity.email === (body as { email: string }).email);
    if (!principal) throw new Error('unit login did not use a retained principal');
    const cookie = `unit-child-${++count}=own`;
    live.add(cookie); events.push('cookie');
    return Response.json({ user: { id: flags.accountMismatch ? 'unexpected-unit-account' : principal.accountId } },
      { headers: { 'set-cookie': cookie + '; HttpOnly; Path=/' } });
  };
  const current = Date.now();
  const bound: PartialReaderLease = { ...partialLease(),
    activatedAt: new Date(current - 1000).toISOString(), expiresAt: new Date(current + 599000).toISOString(),
    assertActive() { activeCalls++; if (flags.expired) throw new Error('unit ordinary read lease expired'); },
    retainSession(session) {
      events.push(session.oauth ? 'retain-oauth' : 'retain-cookie');
      registered.push({ ...session }); owned.set(session.cookie, { ...session });
      if (flags.retainFailure) throw new Error('unit private registration rejected');
    },
    async closeAttachment() {
      events.push('cleanup');
      if (flags.closeFailure) throw new Error('unit custodian cleanup rejected');
      const sessions: PartialReaderDisposal['sessions'] = [];
      // Explicit fake custodian performs the real owner's two-request protocol for its exact registry only.
      for (const session of owned.values()) {
        const headers = { cookie: session.cookie, origin: admitted.accountOrigin };
        const request = async (method: string, path: string) => {
          cleanup.push({ method, path, cookie: headers.cookie, origin: headers.origin });
          if (path === '/api/auth/sign-out') {
            if (flags.signOutStatus === 200 && !flags.sessionPersists) live.delete(headers.cookie);
            return Response.json({}, { status: flags.signOutStatus });
          }
          if (path === '/api/auth/get-session')
            return Response.json(live.has(headers.cookie) ? { session: { id: 'unit-still-present' } } : null,
              { status: flags.absenceStatus });
          throw new Error('unexpected unit cleanup request');
        };
        const signOut = await request('POST', '/api/auth/sign-out');
        const absence = await request('GET', '/api/auth/get-session');
        const after: unknown = await absence.json();
        sessions.push({ accountId: session.accountId, cookieSha256: createHash('sha256').update(session.cookie).digest('hex'),
          signOutStatus: signOut.status, absenceStatus: absence.status, sessionAfterSignOut: after as null,
          ownCookieSessionAbsenceConfirmed: signOut.status === 200 && absence.status === 200 && after === null });
      }
      const receipt: PartialReaderDisposal = { format: 'identity-reader-own-session-disposal-v1', leaseId: bound.id,
        recordedJobId: bound.recordedJobId, accountService: admitted.accountService, accountOrigin: admitted.accountOrigin,
        sessions, peerSessionsChanged: false, refreshFamilyRevocation: 'UNCONFIRMED', finalBearerIntrospection: 'UNCONFIRMED' };
      mutate(receipt);
      const path = resolve(dir, 'disposal.json'), bytes = JSON.stringify(receipt);
      writeFileSync(path, bytes, { mode: 0o600 });
      return { path, sha256: createHash('sha256').update(bytes).digest('hex') };
    },
  };
  const attachment = partialReaderAttachment(controls, visitor, admitted, bound, async (url, init) => {
    const target = new URL(url);
    if (target.origin !== admitted.accountService) throw new Error('unit OAuth left retained Account boundary');
    if (target.pathname === '/api/auth/oauth2/authorize') {
      events.push('authorize');
      expect(owned.has(new Headers(init?.headers).get('cookie')!)).toBe(true);
      const callback = new URL(controls.realm.auth.redirectUris[0]!);
      callback.searchParams.set('code', 'unit-code');
      callback.searchParams.set('state', target.searchParams.get('state')!);
      return new Response(null, { status: 302, headers: { location: callback.href } });
    }
    if (target.pathname === '/api/auth/oauth2/token') {
      events.push('token');
      return Response.json(flags.tokenStatus === 200
        ? { access_token: 'unit-access-token', refresh_token: 'unit-refresh-token', token_type: 'Bearer',
          expires_in: 300, scope: controls.realm.auth.scope } : { error: 'unit-token-refused' }, { status: flags.tokenStatus });
    }
    throw new Error('unexpected unit HTTP request');
  });
  return { attachment, flags, registered, events, cleanup, foreign, live,
    activeCalls: () => activeCalls, mutateReceipt(fn: typeof mutate) { mutate = fn; },
    expire() { flags.expired = true; bound.expiresAt = new Date(Date.now() - 1).toISOString(); },
    remove() { rmSync(dir, { recursive: true, force: true }); } };
}

test('actual partial login retains its own cookie before OAuth failure and cleanup preserves the foreign session', async () => {
  const unit = attachmentUnit();
  try {
    unit.flags.tokenStatus = 503;
    await expect(unit.attachment.login('stranger', '/reader/next')).rejects.toThrow('unit-token-refused');
    expect(unit.events).toEqual(['cookie', 'retain-cookie', 'authorize', 'token']);
    expect(unit.registered).toHaveLength(1);
    expect(unit.registered[0]!.oauth).toBeUndefined();
    await unit.attachment.close();
    expect(unit.cleanup).toEqual([
      { method: 'POST', path: '/api/auth/sign-out', cookie: unit.registered[0]!.cookie, origin: input().accountOrigin },
      { method: 'GET', path: '/api/auth/get-session', cookie: unit.registered[0]!.cookie, origin: input().accountOrigin },
    ]);
    expect([...unit.live]).toEqual([unit.foreign]);
  } finally { unit.remove(); }
});

test('actual partial OAuth augments each same own cookie and closes exactly the five created sessions', async () => {
  const unit = attachmentUnit();
  try {
    for (const name of ['stranger', 'member', 'owner', 'moderator', 'operator'] as const) {
      const result = await unit.attachment.login(name, '/reader/next');
      const [cookie, grant] = unit.registered.slice(-2);
      expect(cookie!.accountId).toBe(`${name}-account`);
      expect(grant!.cookie).toBe(cookie!.cookie);
      expect(grant!.accountId).toBe(cookie!.accountId);
      expect(cookie!.oauth).toBeUndefined();
      expect(grant!.oauth!.accessToken).toBe('unit-access-token');
      expect(result.person.accountId).toBe(grant!.accountId);
      expect(result.callbacks).toHaveLength(1);
      expect(JSON.parse(result.state).next).toBe('/reader/next');
    }
    await unit.attachment.close();
    expect(unit.cleanup).toHaveLength(10);
    expect(new Set(unit.cleanup.map(call => call.cookie)).size).toBe(5);
    expect(unit.cleanup.some(call => call.cookie === unit.foreign)).toBe(false);
    expect(unit.registered.some(session => session.cookie === unit.foreign)).toBe(false);
    expect([...unit.live]).toEqual([unit.foreign]);
  } finally { unit.remove(); }
});

test('partial close performs only own cleanup after ordinary reads expire and prevents further login', async () => {
  const unit = attachmentUnit();
  try {
    const result = await unit.attachment.login('stranger', '/reader/next');
    unit.expire();
    expect(() => result.request('GET', '/api/me')).toThrow('fresh finite ten-minute lease');
    await expect(unit.attachment.login('member', '/reader/next')).rejects.toThrow('fresh finite ten-minute lease');
    const calls = unit.activeCalls();
    await unit.attachment.close();
    expect(unit.activeCalls()).toBe(calls);
    expect(unit.cleanup).toHaveLength(2);
    expect([...unit.live]).toEqual([unit.foreign]);
    await expect(unit.attachment.login('member', '/reader/next')).rejects.toThrow('attachment is closing');
  } finally { unit.remove(); }
});

for (const [flag, error] of [['retainFailure', 'private registration rejected'],
  ['accountMismatch', 'changed Account identity']] as const)
  test(`partial login ${flag} still retains the newly returned own cookie for cleanup`, async () => {
    const unit = attachmentUnit();
    try {
      unit.flags[flag] = true;
      await expect(unit.attachment.login('stranger', '/reader/next')).rejects.toThrow(error);
      expect(unit.registered).toHaveLength(1);
      expect(unit.events).not.toContain('authorize');
      await unit.attachment.close();
      expect([...unit.live]).toEqual([unit.foreign]);
    } finally { unit.remove(); }
  });

for (const flag of ['signOutStatus', 'absenceStatus', 'sessionPersists', 'closeFailure'] as const)
  test(`partial close propagates ${flag} failure rather than accepting cleanup`, async () => {
    const unit = attachmentUnit();
    try {
      await unit.attachment.login('stranger', '/reader/next');
      if (flag === 'signOutStatus' || flag === 'absenceStatus') unit.flags[flag] = 503;
      else unit.flags[flag] = true;
      unit.expire();
      await expect(unit.attachment.close()).rejects.toThrow(flag === 'closeFailure' ? 'custodian cleanup rejected' : 'session absence not established');
      expect(unit.live.has(unit.foreign)).toBe(true);
    } finally { unit.remove(); }
  });

for (const [label, change] of [
  ['foreign session substituted', (r: PartialReaderDisposal) => { r.sessions[0]!.cookieSha256 = createHash('sha256').update('unit-foreign-cookie=untouched').digest('hex'); }],
  ['missing own session', (r: PartialReaderDisposal) => { r.sessions = []; }],
  ['duplicate own session', (r: PartialReaderDisposal) => { r.sessions.push(r.sessions[0]!); }],
  ['another Account', (r: PartialReaderDisposal) => { r.sessions[0]!.accountId = 'foreign-unit-account'; }],
  ['another lease', (r: PartialReaderDisposal) => { r.leaseId = 'another-lease'; }],
  ['unconfirmed absence', (r: PartialReaderDisposal) => { r.sessions[0]!.ownCookieSessionAbsenceConfirmed = false; }],
  ['overstated revocation', (r: PartialReaderDisposal) => { Object.assign(r, { refreshFamilyRevocation: 'confirmed' }); }],
] as const) test(`partial close rejects receipt with ${label}`, async () => {
  const unit = attachmentUnit();
  try {
    await unit.attachment.login('stranger', '/reader/next');
    unit.mutateReceipt(change);
    await expect(unit.attachment.close()).rejects.toThrow('own-');
    expect(unit.live.has(unit.foreign)).toBe(true);
  } finally { unit.remove(); }
});
