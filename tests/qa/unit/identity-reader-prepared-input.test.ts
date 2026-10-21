import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { selectTestGroups } from '../../../scripts/qa/test.ts';
import { outcomeTestViolations } from '../../../scripts/qa/repository-guards.ts';
import { checkIdentityReaderPin, identityReaderFixture, identityReaderOriginals, identityReaderOutputDirectory,
  validatePreparedIdentityReaderCorpus, validatePreparedIdentityReaderInput, validateIdentityReaderLease,
  type PreparedIdentityReaderInput, type IdentityReaderLease } from '../support/identity-reader-fixture.ts';

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
test('original assertion bytes remain frozen and loose wrappers start no hosted stack', () => {
  for (const original of identityReaderOriginals) {
    expect(checkIdentityReaderPin(original)).toBe(resolve(original.path));
    expect(outcomeTestViolations(original.path, readFileSync(original.path, 'utf8'))).toEqual([]);
  }
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
    for (const original of identityReaderOriginals)
      expect(createHash('sha256').update(readFileSync(original.path)).digest('hex')).toBe(original.sha256);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
