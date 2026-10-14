import { fileURLToPath } from 'node:url';
import { repositoryGlob } from '../../../scripts/lib/repository-files.ts';
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

test('authentication wrappers have one admitted subject capability and no legacy derivation', () => {
  const directory = new URL('../src/', import.meta.url);
  const cookieParsers = repositoryGlob(fileURLToPath(directory), '**/*.ts')
    .filter(file => /\.get\(\s*['"]cookie['"]\s*\)|\bparseCookies\s*\(/.test(
      readFileSync(new URL(String(file), directory), 'utf8')));
  expect(cookieParsers).toEqual(['authentication-cookies.ts']);
  for (const file of ['recovery-auth.ts', 'security-activity.ts', 'methods.ts', 'account-settings.ts']) {
    const source = readFileSync(new URL(file, directory), 'utf8');
    expect(source).not.toMatch(/\bauthenticationSubject(?:Rule)?\s*\(|\bchallengeIdentifier\b|\bdecodeJwt\b|\bcreateCookieGetter\b/);
    expect(source).not.toMatch(/request(?:\.clone\(\))?\.(?:json|text|formData)\s*\(/);
  }
  const source = readFileSync(new URL('authentication-subject.ts', directory), 'utf8');
  expect(source).not.toMatch(/consumeVerification|deleteVerification|decodeJwt|\.searchParams\b/);
  expect(source).toContain('ORDER BY "createdAt" DESC LIMIT 2');
  const app = readFileSync(new URL('app.ts', directory), 'utf8');
  const guard = app.slice(app.indexOf('const guardedAuthHandler'), app.indexOf('const app ='));
  expect(guard).not.toMatch(/getSession|authenticationBody|request\.(?:json|text|formData)\s*\(/);
  expect(app).toContain('prepareAuthentication(auth, request)');
  expect(app).toContain('guardedAuthHandler(request, subject, db)');
});

// Table rows whose policy is unchanged remain attached to exact owning tests.
// These inventory checks prove the evidence exists; the Goal batch runs owners.
const ownerParity = [
  ['P01', 'account-auth-form-recovery.test.ts', 'authentication rejects non-JSON media types before provider proof verification'],
  ['P02', 'account-auth-form-recovery.test.ts', 'every JSON authentication admission rejects ambiguous keys before lock or provider selection'],
  ['P03', 'account-auth-form-recovery.test.ts', 'strict authentication parsing preserves provider values and binds the same email lock owner'],
  ['P04', 'security-activity.integration.test.ts', 'authentication failure activity follows the session or signed challenge, never ignored identity fields'],
  ['P05', 'security-activity.integration.test.ts', '${provider} refuses B\'s proof with A\'s session before provider and records only B for a sole proof'],
  ['P06', 'security-activity.integration.test.ts', '${provider} refuses B\'s proof with A\'s session before provider and records only B for a sole proof'],
  ['P10', 'security-activity.integration.test.ts', 'authentication failure activity follows the session or signed challenge, never ignored identity fields'],
  ['P11', 'account-totp-budget.test.ts', 'signed-in TOTP guesses share the immutable user reauthentication budget'],
  ['P13', 'methods.integration.test.ts', 'methods: recovery fences credential writes already waiting on the old session'],
  ['P14', 'account-totp-budget.test.ts', '${path} refunds provider outages and owner checkout timeouts'],
  ['P15', 'account-settings.integration.test.ts', 'SR-5: a counterless authenticator can step up; failed persistence grants no proof'],
  ['P16', 'recovery-factors.integration.test.ts', 'a passkey registration started before recovery cannot finish with an old or newly signed-in session'],
  ['P19', 'recovery-factors.integration.test.ts', 'recovery atomically revokes passkeys, TOTP, backup codes, links, sessions and OAuth authority; a lost response retries once'],
  ['P20', 'security-activity.integration.test.ts', 'activity: private paginated events, coarse devices, failure summary and session revocation'],
  ['P21', 'email-turnstile.integration.test.ts', 'email protection: embedded auth handlers retain target limits after challenge verification'],
  ['P22', 'admin.integration.test.ts', 'admin: audit failure rolls back, concurrent owner suspension preserves an available owner, passwordless reset recovers'],
  ['P23', 'g-580-registration.test.ts', 'persistent registration budget ignores forged IPs and trusts only configured socket peers'],
  ['P29', 'guardian-consent.integration.test.ts', 'guardian consent: withdrawal invalidates an existing approval and permits deletion while retaining both participants as evidence'],
  ['P30', 'sessions.integration.test.ts', 'Verified signup creates a usable Account session without another sign-in'],
] as const;
for (const [row, file, id] of ownerParity)
  test(`${row} parity inventory: ${file} -> ${id}`, () => {
    expect(readFileSync(new URL(file, import.meta.url), 'utf8')).toContain(id);
  });
for (const row of ['P25', 'P26', 'P27', 'P28'])
  test.skip(`${row} parity inventory: out of scope; separately claimed OAuth adapter acceptance`, () => {});
