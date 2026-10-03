import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { startHomeStack } from './feed-read-support.ts';
import { workProfileCorpusApi } from '../../../scripts/load/work-profile-corpus.ts';
import { seedPublicProfileWork } from '../../../scripts/load/work-profile-work.ts';

test('G1025: Following New applies follow/unfollow immediately and rebuilds only credited-author history', async () => {
  const home = await startHomeStack('g-1025-timeline', { projectionStart: 'current' });
  try {
    const author = await home.provision('Timeline poster',home.author.token);
    const credited = await home.provision('Timeline credited author',home.author.token);
    const reader = await home.provision('Timeline reader',home.reader.token);
    const api = (token: string) => workProfileCorpusApi('http://main.local',token,
      { fetch: ((input,init) => home.app.handle(new Request(input,init))) as typeof fetch });
    const authorApi = api(home.author.token), readerApi = api(home.reader.token);
    const work = await seedPublicProfileWork(authorApi,'g1025:timeline:work',
      { actingSubject: author,title: 'Timeline Work',body: 'Timeline selected text' });
    const followed = await readerApi.command<{ revision: string }>('g1025:timeline:follow', { method: 'POST',path: '/v1/follows',
      body: { profile: 'follow-command-v1',actingSubject: reader,target: credited,kind: 'agent',following: true,expectedRevision: null } });
    await home.project();
    const path = `/v1/feed?scope=following&sort=new&actingSubject=${encodeURIComponent(reader)}`;
    const read = async () => home.json<{ items: { target: { work: string }; reason: { target: string } }[];
      caughtUp: { state: string }; nextCursor: string | null }>(await home.call('GET',path,undefined,home.reader.token));
    expect((await read()).items).toEqual([]);
    const header = await authorApi.read<{ revision: string }>(`/v1/works/${work.work.slice(-36)}?actingSubject=${encodeURIComponent(author)}`);
    await authorApi.command('g1025:timeline:credit', { method: 'POST',path: `/v1/works/${work.work.slice(-36)}/agent-credits`,
      body: { profile: 'native-agent-credit-v1',credit: `https://rezics.com/id/${randomUUID()}`,agent: credited,role: 'author',
        expectedWorkHead: header.revision,actingSubject: author } });
    expect((await home.call('GET',path,undefined,home.reader.token)).status).toBe(503);
    await home.project();
    const after = await read();
    expect(after.items).toEqual([expect.objectContaining({ target: expect.objectContaining({ work: work.work }),
      reason: expect.objectContaining({ target: credited }) })]);
    expect(after.caughtUp.state).toBe('caught-up');
    await readerApi.command('g1025:timeline:unfollow', { method: 'POST',path: '/v1/follows',
      body: { profile: 'follow-command-v1',actingSubject: reader,target: credited,kind: 'agent',following: false,
        expectedRevision: followed.revision } });
    const empty = await read();
    expect(empty.items).toEqual([]); expect(empty.nextCursor).toBeNull();
    // A follow of the Work uses its own target index immediately, without an inbox fill.
    await readerApi.command('g1025:timeline:follow-work', { method: 'POST',path: '/v1/follows',
      body: { profile: 'follow-command-v1',actingSubject: reader,target: work.work,kind: 'work',following: true,expectedRevision: null } });
    expect((await read()).items.map(item => item.target.work)).toEqual([work.work]);
  } finally { await home.stop(); }
}, 120_000);
