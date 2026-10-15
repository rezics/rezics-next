import { afterAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { png, sha, startMediaStack, type MediaStack } from './media-support.ts';
import { ensureFixtureScopeGate, grantFixtureAuthority }
  from '../../../services/main/src/modules/access/fixture-authority.ts';
import { ensureFixtureAuthoritySubject, ensureFixturePrincipal }
  from '../../../services/main/tests/support/access-fixture-identity.ts';

let started: Promise<MediaStack> | undefined;
const stack = () => started ??= startMediaStack('media-reader');
afterAll(async () => { if (started) await (await started).stop(); });

const ID = 'https://rezics.com/id/';

async function sharedImage() {
  const fixture = await stack();
  const name = `shared-image-${randomUUID()}`;
  const hex = sha(`rezics-fixture:actor:${name}`);
  const actor = `${ID}${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  const principalId = await ensureFixturePrincipal(fixture.accessPool,
    { issuer: 'https://qa-wiki-fixture.test', subject: name });
  await ensureFixtureAuthoritySubject(fixture.accessPool, actor);
  for (const action of ['media.upload', 'media.manage']) await grantFixtureAuthority(fixture.accessPool, {
    scope: `media:owner:${actor}`, requireDispatch: true,
    representations: [{ principalId, actor, action, lifetime: '8 hours' }],
    grant: { actor, action, lifetime: '8 hours' },
  });
  const owner = await fixture.member(name, { stable: true });
  const bytes = png(256, 256), asset = await owner.upload(bytes);
  const visible = await fixture.publicWork(actor);
  const attach = async (target: string) => {
    const use = randomUUID();
    await fixture.store.createPublicationUses(randomUUID(), actor, target, [{ ...asset, use,
      sha256: sha(bytes), mediaType: 'image/png', width: 256, height: 256 }]);
    return { representation: asset.representation, use };
  };
  const own = await attach(visible.work);
  const descriptor = (use: string) => `/v1/media/representations/${asset.representation}?use=${use}`;
  const image = (use: string) => `/v1/media/representations/${asset.representation}/bytes?use=${use}`;
  const metadata = async (uses: string[]) => {
    const response = await fixture.call('POST', '/v1/media/metadata', {
      body: { items: uses.map(use => ({ representation: asset.representation, use })) },
    });
    expect(response.status, await response.clone().text()).toBe(200);
    return (await response.json()).items;
  };
  return { fixture, owner, bytes, asset, visible, own, attach, descriptor, image, metadata };
}

/** A settled restriction fixture; the real disclosure owner evaluates it. */
async function restrictImage(f: Awaited<ReturnType<typeof sharedImage>>, resource: string) {
  const caseId = randomUUID(), decisionId = randomUUID(), digest = sha(resource);
  const client = await f.fixture.accessPool.connect();
  try {
    await client.query('BEGIN');
    await ensureFixtureScopeGate(client, 'governance:platform');
    await client.query(`INSERT INTO access.governance_case
      (id,kind,authority_kind,authority_scope_id,context,target_owner,target_resource,target_component,disclosure)
      VALUES ($1,'content_report','platform','governance:platform','urn:rezics:context:global',
        'media',$2,'media_use','private')`, [caseId, resource]);
    await client.query(`INSERT INTO access.moderation_decision
      (id,kind,outcome,context,case_id,case_sequence,principal_id,acting_subject,authority_kind,authority_scope_id,
        authority_epoch,authority_proof_digest,idempotency_key,request_digest,rule_ref,rule_revision,rule_digest,
        evidence_digest,disclosure,statement_of_reasons)
      VALUES ($1::uuid,'content_moderation','restrict','urn:rezics:context:global',$2,1,$3,$4,
        'platform','governance:platform',0,$5,$1::text,$5,'urn:rezics:rule:image-disclosure','1',$5,$5,
        'private',$6::jsonb)`, [decisionId, caseId, f.owner.principalId, f.owner.actor, digest, {
      facts: 'This image occurrence is restricted.', scope: 'The exact media target.',
      duration: 'Until an attributable restoration.', automation: false,
      appealRoute: '/v1/public-reports/{caseId}/correspondence', contentLanguage: 'en',
      rule: { ref: 'urn:rezics:rule:image-disclosure', revision: '1', digest },
    }]);
    await client.query(`INSERT INTO access.moderation_decision_target
      (decision_id,ordinal,owner,resource,component,scope_kind,effect)
      VALUES ($1,1,'media',$2,'media_use','component','media_delivery')`, [decisionId, resource]);
    await client.query('UPDATE access.governance_case SET decision_head=$2,generation=1 WHERE id=$1',
      [caseId, decisionId]);
    await client.query(`INSERT INTO access.governance_enforcement
      (id,authority_scope_id,context,owner,resource,component,revision,effect,decision_id,decision_ordinal,state,fence_epoch)
      VALUES ($1,'governance:platform','urn:rezics:context:global','media',$2,'media_use',NULL,
        'media_delivery',$3,1,'restricted',1)`, [randomUUID(), resource, decisionId]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

test('a public page image serves its exact Use when the Asset also has a private attachment', async () => {
  const f = await sharedImage();
  const privateWork = await f.fixture.privateWork(f.owner.actor);
  const other = await f.attach(privateWork.work);
  expect(await f.metadata([f.own.use, other.use])).toEqual([
    expect.objectContaining({ status: 'available', use: f.own.use, url: f.image(f.own.use) }),
    { status: 'unavailable', reference: other },
  ]);
  const response = await f.fixture.call('GET', f.image(f.own.use));
  expect(response.status, await response.clone().text()).toBe(200);
  expect(response.headers.get('cache-control')).toBe('public, no-cache');
  expect(sha(new Uint8Array(await response.arrayBuffer()))).toBe(sha(f.bytes));
  const descriptor = await f.fixture.call('GET', f.descriptor(f.own.use));
  expect(descriptor.status).toBe(200);
  expect(await descriptor.json()).toMatchObject({ use: f.own.use, url: f.image(f.own.use) });
  expect((await f.fixture.call('GET', f.image(other.use))).status).toBe(404);
  // A bare representation can select the independently readable public Use;
  // the private sibling still cannot authorize its own exact delivery.
  const barePath = `/v1/media/representations/${f.asset.representation}/bytes`;
  const bare = await f.fixture.call('GET', barePath);
  expect(bare.status, await bare.clone().text()).toBe(200);
  expect(bare.headers.get('cache-control')).toBe('public, no-cache');
  expect(sha(new Uint8Array(await bare.arrayBuffer()))).toBe(sha(f.bytes));
  const cached = await f.fixture.main.handle(new Request(`http://main.local${barePath}`, {
    headers: { 'if-none-match': `"${sha(f.bytes)}"` },
  }));
  expect(cached.status).toBe(304);
  expect(cached.headers.get('etag')).toBe(`"${sha(f.bytes)}"`);
});

test('a restricted sibling Use never leaks through a public page image of the same Asset', async () => {
  const f = await sharedImage();
  const otherWork = await f.fixture.publicWork(f.owner.actor);
  const other = await f.attach(otherWork.work);
  await restrictImage(f, `${ID}${other.use}`);
  const items = await f.metadata([f.own.use, other.use]);
  expect(items).toEqual([
    expect.objectContaining({ status: 'available', use: f.own.use, url: f.image(f.own.use) }),
    { status: 'unavailable', reference: other },
  ]);
  expect(JSON.stringify(items[0])).not.toContain(other.use);
  expect(JSON.stringify(items[0])).not.toContain(otherWork.work);
  const response = await f.fixture.call('GET', f.image(f.own.use));
  expect(response.status, await response.clone().text()).toBe(200);
  expect(response.headers.get('cache-control')).toBe('public, no-cache');
  expect(sha(new Uint8Array(await response.arrayBuffer()))).toBe(sha(f.bytes));
  expect((await f.fixture.call('GET', f.descriptor(other.use))).status).toBe(404);
  for (const validator of [undefined, `"${sha(f.bytes)}"`]) {
    const hidden = await f.fixture.main.handle(new Request(`http://main.local${f.image(other.use)}`, {
      headers: validator ? { 'if-none-match': validator } : {},
    }));
    expect(hidden.status).toBe(404);
  }
  // Asset governance remains common to every occurrence despite exact Use audiences.
  await restrictImage(f, `${ID}${f.asset.asset}`);
  expect(await f.metadata([f.own.use])).toEqual([{ status: 'unavailable', reference: f.own }]);
  expect((await f.fixture.call('GET', f.image(f.own.use))).status).toBe(404);
});

test('signed-in public media readers need no Agent, and gain no private Work authority', async () => {
  const { member, publicWork, privateWork, call } = await stack();
  const owner = await member('image-owner');
  const reader = await member('image-reader');
  const visible = await publicWork(owner.actor);
  const hidden = await privateWork(owner.actor, `Private image ${randomUUID()}`);
  const bytes = png(256, 256);
  const asset = await owner.upload(bytes, 'public');
  const hiddenAsset = await owner.upload(png(256,256), 'public');
  const select = async (work: string, image = asset.asset) => {
    await owner.grant(`media:avatar:${work}`, 'media.avatar');
    const response = await owner.send('PUT', `/v1/resources/${work.slice(ID.length)}/avatar`, {
      profile: 'resource-avatar-selection-v1', expectedSelection: null, asset: image,
      crop: null, actingSubject: owner.actor,
    });
    expect(response.status).toBe(201);
    return (await response.json()).selection as string;
  };
  const visibleAvatar = await select(visible.work);
  await owner.grant(`work:read:${hidden.work}`, 'work.read');
  const hiddenAvatar = await select(hidden.work, hiddenAsset.asset);
  const prepare = async (work: string, image = asset.asset) => {
    await owner.grant(`content:draft:${work}`, 'content.draft');
    const response = await owner.send('POST', '/v1/media/publications', {
      profile: 'media-set-v1', resourceId: work, variantId: `urn:rezics:variant:${randomUUID()}`,
      expectedHead: null, assets: [image], actingSubject: owner.actor,
    });
    expect(response.status).toBe(201);
    return (await response.json()).body.items[0] as { use: string; representation: string };
  };
  const visibleItem = await prepare(visible.work);
  const hiddenItem = await prepare(hidden.work, hiddenAsset.asset);
  const paths = (avatar: string, item: typeof visibleItem) => [
    `/v1/media/avatars/${avatar}`, `/v1/media/uses/${item.use}`,
    `/v1/media/representations/${item.representation}/bytes?use=${item.use}`,
  ];
  for (const path of paths(visibleAvatar, visibleItem)) {
    for (const token of [undefined, reader.token]) {
      const response = await call('GET', path, { token });
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('image/png');
      expect(sha(new Uint8Array(await response.arrayBuffer()))).toBe(sha(bytes));
    }
  }
  const metadata = async (item: typeof visibleItem, actingSubject?: string) => {
    const response = await call('POST', '/v1/media/metadata', { token: reader.token,
      body: { items: [{ representation: item.representation, use: item.use }], ...(actingSubject ? { actingSubject } : {}) } });
    expect(response.status).toBe(200);
    return (await response.json()).items[0];
  };
  expect(await metadata(visibleItem)).toMatchObject({ status: 'available' });
  for (const path of paths(hiddenAvatar, hiddenItem)) {
    expect((await call('GET', path, { token: reader.token })).status).toBe(404);
  }
  expect(await metadata(hiddenItem)).toMatchObject({ status: 'unavailable' });
  const summaries = await call('POST', '/v1/resources/summaries', { token: reader.token,
    body: { profile: 'resource-summary-batch-v1', resources: [visible.work, hidden.work] } });
  expect(summaries.status).toBe(200);
  expect((await summaries.json()).summaries.map((item: { status: string }) => item.status)).toEqual(['available', 'unavailable']);
  const showcase = await call('POST', '/v1/resources/showcase', { token: reader.token,
    body: { profile: 'work-showcase-batch-v1', targets: [visible.work, hidden.work] } });
  expect(showcase.status).toBe(200);
  expect((await showcase.json()).items.map((item: { status: string }) => item.status)).toEqual(['available', 'unavailable']);
  await reader.grant(`work:read:${hidden.work}`, 'work.read');
  expect((await reader.read(`/v1/media/avatars/${hiddenAvatar}`)).status).toBe(200);
  expect(await metadata(hiddenItem, reader.actor)).toMatchObject({ status: 'available' });
  // A read grant still needs its explicit Agent; a bearer alone never starts using it.
  expect((await call('GET', `/v1/media/uses/${hiddenItem.use}`, { token: reader.token })).status).toBe(404);
});
