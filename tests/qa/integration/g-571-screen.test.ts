import { afterAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { png, sha, startMediaStack, type MediaStack } from './media-support.ts';
import { clearQueued, flagged, realmMediaFixture, screening } from './g-571-screen-support.ts';
import { SCREEN_POLICY } from '../../../services/main/src/modules/media-screen/policy.ts';
import { IMAGE_INFERENCE_POLICY, type ImageMetadata } from '../../../services/main/src/modules/media/presentation.ts';

let started: Promise<MediaStack> | undefined;
const stack = () => started ??= startMediaStack('g-571-screen', { autoClearUploads: false, library:true });
afterAll(async () => { if (started) await (await started).stop(); });
async function json<T>(response:Response,status=200):Promise<T> {
  const body=await response.text();expect(response.status,body).toBe(status);return JSON.parse(body) as T;
}

test('G571: HTTP image evidence, independent labels and protected occurrence concealment preserve authority, privacy and replay',async()=>{
  const s=await stack();const owner=await s.member('image-editor');const outsider=await s.member('image-outsider');
  const staff=await s.member('image-administrator');
  for (const action of ['media.inference','media.labels','media.conceal']) await owner.grant(`media:owner:${owner.actor}`,action);
  await staff.grant('agent:controller','agent.control');
  await s.accessPool.query('SELECT access.seed_platform_grants($1,$2)', [
    staff.principalId, `urn:rezics:access-receipt:${sha(staff.actor)}`,
  ]);
  const work=await s.publicWork(owner.actor);await owner.grant(`content:publish:${work.work}`,'media.use');
  const bytes=png(48,48);const image=await owner.upload(bytes);
  const path=`/v1/media/representations/${image.representation}`;
  const metadata=async()=>json<ImageMetadata>(await owner.read(path));
  let current=await metadata();expect(current.nsfw).toBe('unknown');expect(current.canEdit).toBe(true);
  const inference={actingSubject:owner.actor,sha256:sha(bytes),model:SCREEN_POLICY.model,
    modelVersion:SCREEN_POLICY.version,weightsDigest:SCREEN_POLICY.weightsDigest,policyVersion:IMAGE_INFERENCE_POLICY,
    status:'completed',result:'nsfw',scores:flagged};
  expect((await owner.send('POST',`${path}/inferences`,{...inference,sha256:sha('other bytes')})).status).toBe(409);
  expect((await owner.send('POST',`${path}/inferences`,{...inference,result:'sfw'})).status).toBe(400);
  const inferKey=randomUUID();await json(await owner.send('POST',`${path}/inferences`,inference,inferKey),201);
  expect(await json(await owner.send('POST',`${path}/inferences`,inference,inferKey))).toMatchObject({replayed:true});
  current=await metadata();expect(current.nsfw).toBe('nsfw');expect(current.ageRating.status).toBe('unassessed');
  const batch=await json<{items:Array<ImageMetadata & {status:string}>}>(await s.call('POST','/v1/media/metadata',{
    body:{items:[{representation:image.representation}]}}));
  expect(batch.items[0]).toMatchObject({status:'available',nsfw:'nsfw',canEdit:false,canProtect:false});
  expect(JSON.stringify(batch)).not.toMatch(/scores|thresholds|weightsDigest/);
  const label=(value:string,authority='author',mode='edit')=>({actingSubject:authority==='platform'?staff.actor:owner.actor,
    field:'nsfw',basis:current.controls.nsfw.basis,expectedValueHead:current.controls.nsfw.valueHead,value,authority,mode});
  await json(await owner.send('POST',`${path}/labels`,label('sfw')),201);
  current=await metadata();expect(current.nsfw).toBe('sfw');
  await json(await owner.send('POST',`${path}/inferences`,inference),201);
  expect((await metadata()).nsfw).toBe('sfw');
  expect((await outsider.send('POST',`${path}/labels`,label('nsfw'))).status).toBe(403);
  const lock=label('sfw','platform','lock');const lockKey=randomUUID();
  await json(await staff.send('POST',`${path}/labels`,lock,lockKey),201);
  expect(await json(await staff.send('POST',`${path}/labels`,lock,lockKey))).toMatchObject({replayed:true});
  current=await metadata();expect(current.controls.nsfw.locked).toBe(true);
  expect(current.controls.nsfw.canEdit).toBe(false);
  expect(current.controls.ageRating.canEdit).toBe(true);
  const adminRead=await json<ImageMetadata>(await staff.read(path));
  expect(adminRead.controls.nsfw).toMatchObject({locked:true,canEdit:true,canProtect:true});
  expect((await owner.send('POST',`${path}/labels`,label('nsfw'))).status).toBe(403);
  expect((await owner.send('POST',`${path}/labels`,{...label('sfw','author','lock')})).status).toBe(403);
  await json(await staff.send('POST',`${path}/labels`,label('sfw','platform','unlock')),201);
  current=await metadata();expect(current.controls.nsfw.locked).toBe(false);
  await json(await owner.send('POST',`${path}/labels`,{actingSubject:owner.actor,field:'ageRating',
    basis:current.controls.ageRating.basis,expectedValueHead:current.controls.ageRating.valueHead,
    value:{status:'assessed',labels:['r18','r18g']},authority:'author',mode:'edit'}),201);
  const use=await json<{use:string}>(await owner.send('POST','/v1/media/uses',{actingSubject:owner.actor,
    target:work.work,representation:image.representation,occurrence:randomUUID(),conceal:true}),201);
  const withUse=await json<ImageMetadata>(await s.call('GET',`${path}?use=${use.use}`));
  expect(withUse).toMatchObject({conceal:true,nsfw:'sfw',ageRating:{status:'assessed',labels:['r18','r18g']}});
  const conceal={actingSubject:staff.actor,basis:withUse.controls.conceal!.basis,
    expectedValueHead:withUse.controls.conceal!.valueHead,value:true,mode:'lock',authority:'platform'};
  await json(await staff.send('POST',`/v1/media/uses/${use.use}/conceal`,conceal),201);
  const lockedUse=await json<ImageMetadata>(await owner.read(`${path}?use=${use.use}`));
  expect((await owner.send('POST',`/v1/media/uses/${use.use}/conceal`,{...conceal,actingSubject:owner.actor,
    basis:lockedUse.controls.conceal!.basis,expectedValueHead:lockedUse.controls.conceal!.valueHead,
    value:false,mode:'edit',authority:'author'})).status).toBe(403);
  expect((await s.call('GET',`${path}/bytes?use=${use.use}`)).status).toBe(200);
  const privateImage=await owner.upload(png(49,49),'private');
  const privatePath=`/v1/media/representations/${privateImage.representation}`;
  expect((await s.call('GET',privatePath)).status).toBe(404);
  expect((await outsider.read(privatePath)).status).toBe(404);
  expect((await owner.read(privatePath)).status).toBe(200);
  const privateBatch=await json<{items:unknown[]}>(await s.call('POST','/v1/media/metadata',{body:{items:[
    {representation:image.representation},{representation:privateImage.representation}]}}));
  expect(privateBatch.items).toMatchObject([{status:'available'},{status:'unavailable'}]);
  expect((await s.contentPool.query('SELECT count(*)::int AS n FROM media.inference_observation WHERE representation_id = $1',
    [image.representation])).rows[0].n).toBe(2);
  // Access is shared by the shard; earlier fixtures can retain pending tickets.
  // Every media admission belonging to this journey must still be terminal.
  expect((await s.accessPool.query(`SELECT id,action,state FROM access.admission
    WHERE principal_id = ANY($1::uuid[]) AND action LIKE 'media.%' AND state <> 'sealed'`,
    [[owner.principalId,outsider.principalId,staff.principalId]])).rows).toEqual([]);
},180_000);

 test('G571: NSFW and classifier failure do not block byte surfaces or create a governance decision',async()=>{
  const s=await stack();const owner=await s.member('display-only');const work=await s.publicWork(owner.actor);
  await owner.grant(`media:avatar:${work.work}`,'media.avatar');await owner.grant(`media:owner:${owner.actor}`,'media.inference');
  const bytes=png(50,50);const image=await owner.upload(bytes);
  const selection=await json<{selection:string}>(await owner.send('PUT',`/v1/resources/${work.work.slice(-36)}/avatar`,{
    profile:'resource-avatar-selection-v1',asset:image.asset,expectedSelection:null,actingSubject:owner.actor}),201);
  const basis=(await s.store.publicationBasis([image.asset],owner.actor))[0]!;
  const use=randomUUID();await s.store.createPublicationUses(randomUUID(),owner.actor,work.work,[{...basis,use}]);
  const realmURL=await realmMediaFixture(s,work,{...basis,use});
  const observation={actingSubject:owner.actor,sha256:sha(bytes),model:SCREEN_POLICY.model,modelVersion:SCREEN_POLICY.version,
    weightsDigest:SCREEN_POLICY.weightsDigest,policyVersion:IMAGE_INFERENCE_POLICY,status:'completed',result:'nsfw',scores:flagged};
  await json(await owner.send('POST',`/v1/media/representations/${image.representation}/inferences`,observation),201);
  for (const url of [`/v1/media/avatars/${selection.selection}`,`/v1/media/uses/${use}`,realmURL,
    `/v1/media/representations/${image.representation}/bytes`]) expect((await s.call('GET',url)).status).toBe(200);
  const meta=await json<ImageMetadata>(await owner.read(`/v1/media/representations/${image.representation}`));
  expect(meta.nsfw).toBe('nsfw');
  expect((await s.accessPool.query('SELECT 1 FROM access.governance_case WHERE target_resource = $1',
    [`https://rezics.com/id/${image.asset}`])).rowCount).toBe(0);
  const failure=await owner.upload(png(51,51));
  await json(await owner.send('POST',`/v1/media/representations/${failure.representation}/inferences`,{
    ...observation,sha256:(await s.store.readUpload(failure.upload))!.sha256,status:'unavailable',result:'unknown',scores:undefined}),201);
  expect((await json<ImageMetadata>(await owner.read(`/v1/media/representations/${failure.representation}`))).nsfw).toBe('unknown');
  expect((await s.call('GET',`/v1/media/representations/${failure.representation}/bytes`)).status).toBe(200);
  const {store}=screening(s);
  expect(await store.reviewOriginal(image.representation,'cleared',randomUUID(),'rejected')).toBe('applied');
  for (const url of [`/v1/media/avatars/${selection.selection}`,`/v1/media/uses/${use}`,realmURL,
    `/v1/media/representations/${image.representation}/bytes`]) expect((await s.call('GET',url)).status).toBe(404);
},180_000);

test('G571: exact-byte copy suppression crosses owners, is bounded and idempotent; later copies activate suppressed', async () => {
  const s = await stack();
  await clearQueued(s);
  const bytes = png(70, 70);
  const owners = await Promise.all(['copy-a', 'copy-b', 'copy-c', 'copy-d'].map(name => s.member(name)));
  const images = await Promise.all(owners.slice(0, 3).map(owner => owner.upload(bytes)));
  await clearQueued(s);
  await expect(s.store.suppressIdenticalCopies(sha(bytes), null, 101)).rejects.toThrow();
  await expect(s.store.suppressIdenticalCopies('invalid-digest')).rejects.toThrow();
  const before = (await s.contentPool.query('SELECT sequence FROM content.owner_control WHERE singleton')).rows[0].sequence;
  let batch = await s.store.suppressIdenticalCopies(sha(bytes), null, 1);
  const after = (await s.contentPool.query('SELECT sequence FROM content.owner_control WHERE singleton')).rows[0].sequence;
  expect(BigInt(after)).toBe(BigInt(before) + 2n); // marker and one asset history invalidate media generations

  expect(batch.suppressed).toBe(1);
  expect(batch.continuation).not.toBeNull();
  // The byte marker denies all copies before remaining state histories settle.
  for (const image of images) expect((await s.store.readUpload(image.upload))?.clearance).toBe('rejected');
  while (batch.continuation) batch = await s.store.suppressIdenticalCopies(sha(bytes), batch.continuation, 1);
  for (const image of images) expect((await s.store.readAsset(image.asset))?.moderation).toBe('suppressed');
  expect(await s.store.suppressIdenticalCopies(sha(bytes))).toEqual({ suppressed: 0, continuation: null });
  const fourth = await owners[3]!.upload(bytes);
  expect(fourth).toMatchObject({ status: 'activated', clearance: 'rejected', clearanceReason: 'restricted', reason: null });
  const replay = await s.call('PUT', `/v1/media/uploads/${fourth.upload}/bytes`, { token: owners[3]!.token, raw: bytes });
  const replayBody = await replay.json();
  expect(replayBody).toMatchObject({ status: 'activated', clearance: 'rejected', clearanceReason: 'restricted', reason: null });
  expect(JSON.stringify(replayBody)).not.toMatch(/identical|hash|match|digest/i);
  expect((await s.store.readAsset(fourth.asset))?.moderation).toBe('suppressed');
  expect(await (await owners[3]!.read(`/v1/media/uploads/${fourth.upload}`)).json()).toMatchObject({
    status: 'activated', clearance: 'rejected', reason: null, clearanceReason: 'restricted' });
  expect((await s.contentPool.query('SELECT count(*)::int AS n FROM media.transform_job WHERE source_id = $1',
    [fourth.representation])).rows[0].n).toBe(0);
}, 180_000);
