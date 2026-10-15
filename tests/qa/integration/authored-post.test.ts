import { expect, test } from 'bun:test';
import { fromPlainText } from '@rezics/document';
import { startMediaStack } from './media-support.ts';
import { seedApi } from '../support/seed-checkpoints.ts';
import { initializeRelayCheckpoint, relayMainOutboxOnce } from '../../../services/main/src/modules/outbox/relay.ts';
import { Pool } from 'pg';

test('an author creates and replays an independent Post with exact native custody and Content', async () => {
  const stack = await startMediaStack('authored-post');
  const relay = new Pool({ connectionString: Bun.env.ACCOUNT_RELAY_DATABASE_URL });
  try {
    const dispatch = stack.env.fuseki.commandWithReceipt.bind(stack.env.fuseki);
    stack.env.fuseki.commandWithReceipt = async envelope => {
      const result = await dispatch(envelope);
      if (result.status !== 'committed') console.error('Post native command refusal', JSON.stringify(result));
      return result;
    };
    const author = await stack.member('author', { verified: true });
    const api = seedApi(stack, author.token);
    const { agent } = await api.command<{ agent: string }>('post:agent', { method: 'POST', path: '/v1/agents',
      body: { profile: 'agent-provision-v1', kind: 'person', displayName: 'Post author' } });
    const command = { method: 'POST' as const, path: '/v1/posts' as const,
      body: { profile: 'authored-post-v1', actingSubject: agent, language: 'en',
        title: { value: 'Independent Post', language: 'en' }, document: fromPlainText('Independent text', 'blocks') } };
    const created = await api.command<{ post: string; author: string; variantId: string; revisionId: string;
      byteDigest: string; replayed: boolean }>('post:create', command);
    expect(created).toMatchObject({ author: agent, replayed: false });
    expect(await api.command('post:create', command)).toEqual({ ...created, replayed: true });
    expect(await api.read(`/v1/posts/${created.post.slice(-36)}?actingSubject=${encodeURIComponent(agent)}`))
      .toMatchObject({ id: created.post, publisher: agent });
    const revision = (await stack.content.readExactBatch([created.revisionId], async ids => new Set(ids)))[0];
    expect(revision).toMatchObject({ status: 'available', reference: {
      resourceId: created.post, variantId: created.variantId, byteDigest: created.byteDigest,
    }, body: { body: 'Independent text' } });
    await initializeRelayCheckpoint(relay, 'authored-post', stack.env.lineage.dataEpoch);
    while (await relayMainOutboxOnce(stack.env.fuseki, relay, 'authored-post')) { /* drain this cut */ }
    const events = await relay.query<{ envelope: { data: { receipt: unknown } } }>(
      "SELECT envelope FROM relay.delivered_event WHERE envelope->>'type' = 'com.rezics.post.created.v1'");
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0]!.envelope.data.receipt).toMatchObject({
      action: 'work.create', outcome: 'succeeded', post: { id: created.post, publisher: agent },
    });
  } finally { try { await relay.end(); } finally { await stack.stop(); } }
});
