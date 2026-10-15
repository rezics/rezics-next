import { expect, test } from 'bun:test';
import { fromPlainText } from '@rezics/document';
import { startMediaStack } from './media-support.ts';
import { seedApi } from '../support/seed-checkpoints.ts';

test('an author creates and replays an independent Post with exact native custody and Content', async () => {
  const stack = await startMediaStack('authored-post');
  try {
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
  } finally { await stack.stop(); }
});
