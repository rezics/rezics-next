import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { GovernanceRules } from '../src/modules/governance/rules.ts';
import { MediaInvalid, MediaStore } from '../src/modules/media/store.ts';
import { readZoneCampaignArt } from '../src/modules/zone/publication.ts';
import { S3ImmutableObjects } from '../src/infrastructure/immutable-objects.ts';
import { instrumentFetch } from '@rezics/observability/runtime';

const realm = `https://rezics.com/id/${randomUUID()}`;

test('G1026: live Realm rule references use one scoped batch, including duplicates and missing heads', async () => {
  const calls: unknown[][] = [];
  const owner = new GovernanceRules({ query: async (...args: unknown[]) => {
    calls.push(args);
    return { rows: [{ ref: 'urn:rule:a', revision: '2', digest: 'a'.repeat(64) }] };
  } } as unknown as Pool);
  const result = await owner.currentRealmHeads(realm, ['urn:rule:a','urn:rule:a','urn:rule:missing']);
  expect(calls).toHaveLength(1);
  expect(calls[0]![1]).toEqual([['urn:rule:a','urn:rule:missing'], `governance:realm:${realm}`]);
  expect(result.get('urn:rule:a')?.revision).toBe('2');
  expect(result.has('urn:rule:missing')).toBe(false);
  expect((await owner.currentRealmHeads(realm, [])).size).toBe(0);
  expect(calls).toHaveLength(1);
  await expect(owner.currentRealmHeads(realm, Array.from({ length: 13 }, () => 'urn:rule:a'))).rejects.toThrow();
  await expect(owner.currentRealmHeads('not-a-realm', ['urn:rule:a'])).rejects.toThrow();
});

test('Zone campaign art shares exact item lookups and preserves eligibility gates and output position', async () => {
  const uses = Array.from({ length: 6 }, () => randomUUID());
  const valid = { target: realm, asset: randomUUID(), role: 'publication-item', crop: null, focalArea: null, anchor: null,
    sha256: 'a'.repeat(64), mediaType: 'image/png', byteLength: 100,
    width: 320, height: 200, availability: 'available', clearance: 'cleared' as const,
    disclosure: 'public', moderation: 'none', lifecycle: 'active', objectNamespace: 'media/' };
  let calls = 0;
  const store = { itemDeliveryBatch: async (ids: readonly string[]) => {
    calls++;
    expect(ids).toEqual(uses);
    return new Map([
      [uses[0]!,valid],
      [uses[1]!,{ ...valid,target: `https://rezics.com/id/${randomUUID()}` }],
      [uses[2]!,{ ...valid,disclosure: 'private' }],
      [uses[3]!,{ ...valid,moderation: 'blocked' }],
      [uses[4]!,{ ...valid,lifecycle: 'retired' }],
      [uses[5]!,{ ...valid,width: 0 }],
    ]);
  }, renditions: { candidatesBatch: async (ids: readonly string[]) => {
    expect(ids).toEqual([uses[0]!]); return new Map();
  } } };
  const slides = uses.map((use,index) => ({ id: String(index), href: '/',
    art: { landscape: { use: `https://rezics.com/id/${use}` } } }));
  const result = await readZoneCampaignArt(store, realm, slides);
  expect(calls).toBe(1);
  expect(result.map(item => item.id)).toEqual(slides.map(item => item.id));
  expect(result[0]!.art.landscape).toEqual({ use: `https://rezics.com/id/${uses[0]}`,
    crop: null, cropWidth: 320, cropHeight: 200,
    url: `/v1/media/uses/${uses[0]}`,width: 320,height: 200,mediaType: 'image/png',srcset: [] });
  expect(result.slice(1).map(item => item.art.landscape)).toEqual(Array(5).fill(null));
  expect((await readZoneCampaignArt(store, null, slides)).every(slide => slide.art.landscape === null)).toBe(true);
  expect(calls).toBe(1);
});

test('G1026: publication item batch deduplicates valid IDs and rejects invalid or oversized input before SQL', async () => {
  const use = randomUUID();
  const calls: unknown[][] = [];
  const store = new MediaStore({ query: async (...args: unknown[]) => {
    calls.push(args);
    return { rows: [{ use,target: realm,byte_digest: 'a'.repeat(64),media_type: 'image/png',byte_length: 100,
      pixel_width: 320,pixel_height: 200,availability: 'available',clearance: 'cleared',
      disclosure: 'public',moderation: 'none',lifecycle: 'active',object_namespace: 'media/' }] };
  } } as unknown as Pool, {} as ConstructorParameters<typeof MediaStore>[1]);
  expect((await store.itemDeliveryBatch([use,use])).size).toBe(1);
  expect(calls[0]![1]).toEqual([[use]]);
  expect(await store.itemDelivery(use)).toMatchObject({ target: realm,width: 320 });
  expect(await store.itemDelivery('invalid')).toBeNull();
  expect((await store.itemDeliveryBatch([])).size).toBe(0);
  await expect(store.itemDeliveryBatch(['invalid'])).rejects.toBeInstanceOf(MediaInvalid);
  await expect(store.itemDeliveryBatch(Array(65).fill(use))).rejects.toBeInstanceOf(MediaInvalid);
  expect(calls).toHaveLength(2);
});

test('G1026: signed immutable-object uploads retain their known length under telemetry', async () => {
  let length: string | null = null;
  let stored = new Uint8Array();
  const peer = Bun.serve({ hostname: '127.0.0.1',port: 0,async fetch(request) {
    if (request.method === 'PUT') {
      length = request.headers.get('content-length');
      if (!length) return new Response(null,{ status: 411 });
      stored = new Uint8Array(await request.arrayBuffer());
      return new Response(null,{ status: 200 });
    }
    return new Response(stored);
  } });
  const restore = instrumentFetch(new Set(), 'http://127.0.0.1:1');
  try {
    const objects = new S3ImmutableObjects({ endpoint: peer.url.origin,bucket: 'g1026-qa',region: 'us-east-1',
      accessKeyId: 'fixture',secretAccessKey: 'fixture',prefix: 'g1026/' });
    const bytes = new TextEncoder().encode('Immutable community navigation');
    const digest = await objects.put(bytes);
    expect(length ?? '').toBe(String(bytes.length));
    expect(await objects.get(digest)).toEqual(bytes);
  } finally { restore(); await peer.stop(true); }
});
