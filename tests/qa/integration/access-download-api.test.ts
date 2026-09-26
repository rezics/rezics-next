import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { png, startMediaStack, type MediaStack } from './media-support.ts';

let started: Promise<MediaStack> | undefined;
const stack = () => started ??= startMediaStack('access-download');

test('IAM07: private media download is admitted, bounded, and drained by strong revocation', async () => {
  const h = await stack();
  try {
    const owner = await h.member('download-owner');
    const outsider = await h.member('download-outsider');
    const work = await h.privateWork(owner.actor);
    const bytes = png(32, 32, 100_000);
    const asset = await owner.upload(bytes, 'private');
    const readScope = `work:read:${work.work}`;
    await owner.grant(readScope, 'work.read');
    await owner.grant(`media:avatar:${work.work}`, 'media.avatar');
    const targetId = work.work.slice('https://rezics.com/id/'.length);
    const selection = await owner.send('PUT', `/v1/resources/${targetId}/avatar`, {
      profile: 'resource-avatar-selection-v1', expectedSelection: null, asset: asset.asset,
      crop: null, actingSubject: owner.actor,
    });
    expect(selection.status).toBe(201);

    await owner.grant(readScope, 'access.revoke');
    const downloadPath = `/v1/media/assets/${asset.asset}/bytes?target=${encodeURIComponent(work.work)}`
      + `&actingSubject=${encodeURIComponent(owner.actor)}`;
    const denied = await h.call('GET', downloadPath, { token: outsider.token });
    expect(denied.status).toBe(403);

    const [first, second] = await Promise.all([
      h.call('GET', downloadPath, { token: owner.token }),
      h.call('GET', downloadPath, { token: owner.token }),
    ]);
    expect([first.status, second.status]).toEqual([200, 200]);
    expect(first.headers.get('content-length')).toBe(String(bytes.length));
    expect(first.headers.get('cache-control')).toBe('private, no-store');

    const grant = await h.accessPool.query<{ id: string }>(`SELECT id FROM access.permission_grant
      WHERE scope_id = $1 AND action = 'work.read' AND active ORDER BY id LIMIT 1`, [readScope]);
    const gate = await h.accessPool.query<{ authority_epoch: string }>(
      'SELECT authority_epoch::text FROM access.scope_gate WHERE id = $1', [readScope]);
    const body = { profile: 'access-revocation-v1', revocationId: randomUUID(), issuerSubject: owner.actor,
      mode: 'strong', scopeId: readScope, expectedAuthorityEpoch: gate.rows[0]!.authority_epoch,
      target: { kind: 'permission_grant', id: grant.rows[0]!.id, expectedGeneration: '0' } };
    const revoked = await owner.send('POST', '/v1/access/revocations', body);
    if (revoked.status !== 200) throw new Error(`strong revoke: ${revoked.status} ${await revoked.text()}`);
    const revocation = await revoked.json() as { revocationId: string; state: string;
      affectedWork: number; pending: number };
    expect(revocation).toMatchObject({ state: 'draining', affectedWork: 2, pending: 2 });
    const statusPath = `/v1/access/revocations/${revocation.revocationId}?issuerSubject=`
      + encodeURIComponent(owner.actor);
    const status = () => h.call('GET', statusPath, { token: owner.token });
    expect(await (await status()).json()).toMatchObject({ state: 'draining', pending: 2 });

    const partial = first.body!.getReader();
    const firstChunk = await partial.read();
    expect(firstChunk.done).toBe(false);
    expect(firstChunk.value?.byteLength).toBe(64 * 1024);
    await partial.cancel();
    expect(await (await status()).json()).toMatchObject({ state: 'draining', pending: 1 });
    expect(new Uint8Array(await second.arrayBuffer())).toEqual(bytes);
    expect(await (await status()).json()).toMatchObject({ state: 'completed', pending: 0 });
    expect((await h.accessPool.query<{ state: string }>(`SELECT state FROM access.download_read_lease
      WHERE asset_id = $1 ORDER BY state`, [asset.asset])).rows.map(row => row.state))
      .toEqual(['aborted', 'delivered']);

    const held = await h.accessPool.query('UPDATE access.recovery_fence SET open = false WHERE id = true');
    expect(held.rowCount).toBe(1);
    expect((await h.call('GET', downloadPath, { token: owner.token })).status).toBe(503);
    await h.accessPool.query('UPDATE access.recovery_fence SET open = true WHERE id = true');

    const indexes = await h.accessPool.query<{ indexname: string }>(`SELECT indexname FROM pg_indexes
      WHERE schemaname = 'access' AND indexname = ANY($1::text[])`,
    [['download_read_pending_scope', 'download_read_pending_principal', 'revocation_affected_download_read']]);
    expect(indexes.rows.map(row => row.indexname).sort()).toEqual([
      'download_read_pending_principal', 'download_read_pending_scope', 'revocation_affected_download_read',
    ]);
  } finally { await h.stop(); }
}, 180_000);
