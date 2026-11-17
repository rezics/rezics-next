import { expect, test } from 'bun:test';
import { generateKeyPair, SignJWT } from 'jose';
import {
  captureArchiveSenderCredential,
  captureEntryRestoreCredential,
  originalEntryRestoreCredential,
  readArchiveSender,
} from '../src/library/entry-restore-credential';
import type { SessionEnv } from '../src/session/client';
import { SESSION_COOKIE } from '../src/session/cookies';
import { prepareExpectedReader } from '../src/session/expected-reader';

// Snapshot of the mounted Website registration (134 scopes, 2,189 ASCII bytes).
const scope = `
openid offline_access access:grant account:delete account:manage account:read account:read_erasure
account:read_public_identity account:reinstate account:set_rate_tier account:suspend account:update
account:verify_agent board:create board:pin_advice board:read classification_ballot:read_aggregate
classification_ballot:read_own classification_ballot:set collection:create collection:delete collection:read
collection:update commerce_sale:list context:accept context:adopt context:create context:delete context:read
context:restore copy:create copy:delete copy:list copy:read copy:update definitions:activate definitions:publish
definitions:read document:erase edition:read edition:sell edition:unpublish entitlement:list entitlement:read
exposure:close exposure:manage_read exposure:open exposure:read feed_item:list follow:create follow:delete
follow:list follow:read library_archive:read library_entry:delete library_entry:list library_entry:read
library_entry:update library_pin:list library_pin:update media:complete media:create media:erase
media:import_from_url media:read media:read_reservation moderation:hide moderation:read_reports
moderation:takedown offer:create offer:list offer:manage offer:read openapi:read order:create order:read
order:reconcile organization:create payout_statement:list payout_statement:mark_paid payout_statement:read
post:create post:erase post:read post:revise presentation:activate presentation:publish presentation:read
progress_session:create progress_session:list progress_session:read progress_session:update published_log:create
published_log:delete published_log:read rating:vote reaction:set realm:approve_claim realm:ban realm:create
realm:join realm:manage realm:participate realm:publish realm:read realm:restore recent_search:read
recent_search:write report:create source_fence:read source_fence:takedown source_statistic:write space:create
space:manage space:read space:restore statement:delete statement:propose statement:restore subject:batch_write
subject:create subject:merge subject:read thread:create thread:read thread:watch viewer_actions:read
zone:configure zone:create zone:delete zone:publish zone:purge zone:read zone:restore
`
  .trim()
  .replace(/\s+/g, ' ');

test('Archive JSON reopens the mounted-scope sender after refresh only for its original binding', async () => {
  const origin = 'https://rezics.test';
  const otherOrigin = 'https://other.rezics.test';
  const issuer = 'https://auth.test';
  const audience = 'https://api.test';
  const clientId = 'rezics-website';
  const reader = '00000000-0000-4000-8000-000000000001';
  const csrfToken = 'a'.repeat(22);
  const key = (await generateKeyPair('ES256')).privateKey;
  const issuedAt = Math.floor(Date.now() / 1000);
  const sign = (scope: string) =>
    new SignJWT({ scope, client_id: clientId, authn_epoch: 1, auth_time: issuedAt, amr: ['pwd'] })
      .setProtectedHeader({ alg: 'ES256', typ: 'at+jwt', kid: 'fixture' })
      .setIssuer(issuer)
      .setAudience(audience)
      .setSubject(reader)
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + 300)
      .sign(key);
  const originalToken = await sign(scope);
  let accessToken = originalToken;
  let subject = reader;
  const env = {
    SITE_ORIGINS: [origin, otherOrigin].join(','),
    AUTH_ISSUER: issuer,
    API_RESOURCE: audience,
    WEBSITE_SCOPES: scope,
    WEBSITE_CLIENT_ID: clientId,
    WEBSITE_CLIENT_KEY: 'test-key',
    SESSIONS: {
      idFromName: (id: string) => id,
      get: () => ({ credentialIfFresh: async () => ({ status: 'active', subject, accessToken, csrfToken }) }),
    },
  } as unknown as SessionEnv;
  const prepare = async (sessionId = 'a'.repeat(43), site = origin) => {
    const request = new Request(site + '/_serverFn/archive', {
      method: 'POST',
      headers: { origin: site, cookie: SESSION_COOKIE + '=' + sessionId, 'X-CSRF-Token': csrfToken },
    });
    const prepared = await prepareExpectedReader(request, env, {
      expectedReader: subject,
      expectedCredential: csrfToken,
    });
    expect(Boolean(prepared)).toBe(true);
    return request;
  };
  const initial = await prepare();
  const sender = readArchiveSender({ sender: await captureArchiveSenderCredential(initial, env) });
  expect(sender?.length).toBeGreaterThan(3200);
  await expect(captureEntryRestoreCredential(initial, env)).rejects.toThrow('Restore credential exceeds form bound');
  expect(() => readArchiveSender({ sender: 'A'.repeat(32 * 1024) })).toThrow('Invalid archive sender');

  accessToken = await sign('openid offline_access');
  const retry = await prepare();
  const reopened = await originalEntryRestoreCredential(retry, env, sender);
  expect(reopened === 'Bearer ' + originalToken).toBe(true);
  const oldSender = readArchiveSender({ sender: await captureEntryRestoreCredential(retry, env) });
  const oldAuthorization = await originalEntryRestoreCredential(retry, env, oldSender);
  expect(!!oldSender && oldAuthorization === 'Bearer ' + accessToken).toBe(true);

  expect(await originalEntryRestoreCredential(await prepare('b'.repeat(43)), env, sender)).toBeNull();
  expect(await originalEntryRestoreCredential(await prepare(undefined, otherOrigin), env, sender)).toBeNull();
  subject = '00000000-0000-4000-8000-000000000002';
  expect(await originalEntryRestoreCredential(await prepare(), env, sender)).toBeNull();
  await expect(originalEntryRestoreCredential(retry, { ...env, API_RESOURCE: otherOrigin }, sender)).rejects.toThrow();
});
