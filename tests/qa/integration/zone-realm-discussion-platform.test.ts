import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import type { Static } from 'typebox';
import { AccessExposure } from '../../../services/main/src/modules/access/exposure.ts';
import { AccessPlatformAdministrators } from '../../../services/main/src/modules/access/platform-administrator.ts';
import { AccessPlatformGrants } from '../../../services/main/src/modules/access/platform-grants.ts';
import { relayMainOutboxOnce } from '../../../services/main/src/modules/outbox/relay.ts';
import type { realmAboutThread, realmThread } from '../../../services/main/src/modules/realm-reply/thread-contract.ts';
import { startHomeStack } from './feed-read-support.ts';
import { arrange, local, type Posted } from './zone-realm-discussion-support.ts';
import { cloneQaOwnerDatabases } from '../support/databases.ts';

async function isolatedPlatformHome() {
  const runId = Bun.env.REZICS_QA_RUN_ID;
  if (!runId) throw new Error('Run through the isolated integration QA tier');
  const owners = await cloneQaOwnerDatabases(runId, ['access', 'content', 'relay'], 'owner');
  const environment = {
    ACCESS_DATABASE_URL: owners.urls.access,
    CONTENT_DATABASE_URL: owners.urls.content,
    ACCOUNT_RELAY_DATABASE_URL: owners.urls.relay,
    PLATFORM_FIRST_ADMIN_ACCOUNT: undefined,
  };
  const previous = Object.keys(environment).map(key => [key, Bun.env[key]] as const);
  try {
    // Home captures these owner URLs at startup. Restore the batch environment
    // before requests; the administrator designation belongs only to its clones.
    for (const [key, value] of Object.entries(environment)) {
      if (value === undefined) delete Bun.env[key]; else Bun.env[key] = value;
    }
    const home = await startHomeStack('zone-realm-discussion-platform');
    return { ...home, stop: async () => { try { await home.stop(); } finally { await owners.close(); } } };
  } catch (error) {
    await owners.close();
    throw error;
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete Bun.env[key]; else Bun.env[key] = value;
    }
  }
}

test('Zone-page posting requires a platform grant before reservation while its lookup and existing thread stay public', async () => {
  const home = await isolatedPlatformHome();
  try {
    const a = await arrange(home), page = await a.page('closed-posting');
    // This owner proves actual grants, without the QA stack's open-groups setting.
    home.deps.platformAccess = new AccessExposure(home.stack.accessPool, { REZICS_PLATFORM_OPEN_GROUPS: '' });
    const before = await a.effects(page.about);
    expect(before).toEqual({ threads: 0, operations: 0, replies: 0, revisions: 0 });
    const key = randomUUID(), body = 'A granted contribution';
    const refused = await a.post(page, a.author, body, home.author.token, key);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ code: 'platform_closed' });
    expect(await a.effects(page.about)).toEqual(before);

    const authorAccess = await home.json<{ groups: string[]; operations: string[] }>(
      await home.call('GET', '/v1/me/platform-access', undefined, home.author.token));
    expect(authorAccess.groups).not.toContain('realm-reply');
    expect(authorAccess.operations).not.toContain('postV1RealmsByRealmAbout-posts');
    const designation = await new AccessPlatformAdministrators(home.stack.accessPool).designateFirst(
      home.reader.principal.issuer, home.reader.principal.subject, () => undefined);
    expect(designation.status).toBe('granted');
    const principal = { ...home.reader.principal, emailVerified: true };
    const grants = new AccessPlatformGrants(home.stack.accessPool);
    const context = async () => ({ principal, issuerSubject: a.reader,
      expectedAuthorityEpoch: (await grants.readPage(principal, a.reader)).authorityEpoch });
    const receipt = (input: unknown) => ({ idempotencyKey: randomUUID(),
      requestDigest: createHash('sha256').update(JSON.stringify(input)).digest('hex') });
    const grantId = randomUUID(), permission = 'platform:use:realm-reply';
    const issued = await grants.create(await context(), grantId, permission,
      { principalId: home.author.principalId }, null, receipt([grantId, permission, home.author.principalId]));
    expect(issued.grant.permission).toBe(permission);
    expect((await home.json<{ groups: string[] }>(await home.call('GET', '/v1/me/platform-access',
      undefined, home.author.token))).groups).toContain('realm-reply');
    const posted = await home.json<Posted>(await a.post(page, a.author, body, home.author.token, key), 201);
    expect(posted).toMatchObject({ realm: a.realm.realm, about: page.about, author: a.author });
    expect(await home.json(await a.post(page, a.author, body, home.author.token, key))).toEqual(posted);

    await grants.revoke(await context(), grantId, issued.grant.generation, receipt([grantId, 'revoke']));
    const after = await a.effects(page.about);
    for (const [actor, token, retryKey] of [[a.author, home.author.token, key],
      [a.reader, home.reader.token, randomUUID()]] as const) {
      const closed = await a.post(page, actor, body, token, retryKey);
      expect(closed.status).toBe(403);
      expect(await closed.json()).toMatchObject({ code: 'platform_closed' });
      expect(await a.effects(page.about)).toEqual(after);
    }

    for (let batch = 0; ; batch++) {
      if (batch === 400) throw new Error('Discussion relay exceeded its fixture budget');
      if (!await relayMainOutboxOnce(home.stack.fuseki, home.relay, home.deps.relayPosition.consumer,
        { ownerOutbox: home.stack.env.receiptCustody })) break;
    }
    await home.project();
    for (const [token, actingSubject] of [[undefined, undefined],
      [home.reader.token, a.reader], [home.author.token, a.author]] as const) {
      const lookupQuery = new URLSearchParams({ about: page.about });
      const threadQuery = new URLSearchParams({ sort: 'new' });
      if (actingSubject) {
        lookupQuery.set('actingSubject', actingSubject);
        threadQuery.set('actingSubject', actingSubject);
      }
      const lookup = await home.json<Static<typeof realmAboutThread>>(await home.call('GET',
        `/v1/realms/${local(a.realm.realm)}/about-thread?${lookupQuery}`,
        undefined, token));
      expect(lookup).toEqual({ realm: a.realm.realm, about: page.about,
        thread: { reply: posted.reply, rootRevision: page.targetRevision } });
      const thread = await home.json<Static<typeof realmThread>>(await home.call('GET',
        `/v1/realms/${local(a.realm.realm)}/threads/${local(posted.reply)}?${threadQuery}`, undefined, token));
      expect(thread.items.map(item => item.reply)).toEqual([posted.reply]);
    }
    expect(await a.effects(page.about)).toEqual(after);
  } finally { await home.stop(); }
}, 180_000);
