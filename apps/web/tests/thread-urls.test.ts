import { afterAll, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { slug } from '@rezics/definitions/slug';
import recording from '../src/kernel/recorded/thread.json';

const app = join(import.meta.dir, '..');
const thread = structuredClone(recording.thread);
thread.title = 'Ｆlight notes: 星の王子さま!';
thread.subjectIds = [];
const board = { id: thread.boardId, title: 'Reading room', realmId: 'realm-one' };
const author = { id: thread.authorId, displayName: 'Aviator', handle: 'aviator', state: 'active', avatar: null };
const opening = 'A careful reader follows the little prince across the stars. '.repeat(5).trim();
thread.firstPost.body.doc.content = [{ type: 'paragraph', attrs: { id: 'opening' }, content: [{ type: 'text', text: opening }] }] as never;
const reply = { ...thread.firstPost, id: 'reply-one', body: { ...thread.firstPost.body, doc: { type: 'doc', content: [{ type: 'paragraph', attrs: { id: 'reply' }, content: [{ type: 'text', text: 'A thoughtful reply.' }] }] } } };
const calls: string[] = [];
let erased = false;
let empty = false;
const fake = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
  const url = new URL(request.url);
  calls.push(url.pathname + url.search);
  const path = url.pathname;
  if (path === `/v1/threads/${thread.id}`) return Response.json({ thread: { ...thread, title: erased ? null : thread.title, firstPost: erased ? { ...thread.firstPost, body: null, availability: 'erased' } : thread.firstPost, replyCount: 7 } });
  if (path === `/v1/threads/${thread.id}/posts`) return Response.json({ posts: url.searchParams.has('cursor') ? [reply] : [thread.firstPost, reply], next: 'page-two' });
  if (path === `/v1/boards/${board.id}`) return Response.json({ board });
  if (path === `/v1/boards/${board.id}/threads`) return Response.json({ threads: empty ? [] : [{ ...thread, replyCount: 7 }], next: 'page-two' });
  if (path === '/v1/realms/realm-one') return Response.json({ realm: { realmId: 'realm-one', title: 'Star readers' } });
  if (path === '/v1/accounts') return Response.json({ accounts: [author] });
  return Response.json({ code: 'not_found' }, { status: 404 });
} });
let child: ReturnType<typeof spawn> | undefined;
let output = '';
let origin: string | undefined;
async function site() {
  if (origin) return origin;
  const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() });
  origin = probe.url.origin;
  await probe.stop(true);
  await mkdir(join(app, '../../.temp/thread-urls'), { recursive: true });
  child = spawn('bun', ['run', 'dev', '--host', '127.0.0.1', '--port', new URL(origin).port, '--strictPort'], {
    cwd: app, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, KERNEL_ORIGIN: fake.url.origin, PUBLIC_ORIGIN: 'https://rezics.com', WEB_TEST_STATE_DIR: join(app, '../../.temp/thread-urls/state'), AUTH_ISSUER: '', WEBSITE_CLIENT_ID: '' },
  });
  child.stdout!.on('data', (chunk) => output = (output + chunk).slice(-6000));
  child.stderr!.on('data', (chunk) => output = (output + chunk).slice(-6000));
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    try { const response = await fetch(`${origin}/en/boards/${board.id}`); if (response.status === 200) { await response.text(); return origin; } } catch {}
    if (child.exitCode !== null) throw new Error(output);
    await Bun.sleep(250);
  }
  throw new Error(output);
}
afterAll(async () => { child?.kill('SIGTERM'); if (child) await new Promise(resolve => child!.once('close', resolve)); await fake.stop(true); });
async function read(path: string) {
  const base = await site();
  calls.length = 0;
  const response = await fetch(`${base}${path}`, { redirect: 'manual' });
  return { response, html: await response.text(), calls: [...calls] };
}
const canonical = `/en/threads/${thread.id}/${encodeURIComponent(slug(thread.title))}`;
const graphs = (html: string) => [...html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>(.*?)<\/script>/gs)].map(match => JSON.parse(match[1]!));
const meta = (html: string, name: string) => new RegExp(`<meta[^>]*(?:name|property)="${name}"[^>]*content="([^"]*)"`).exec(html)?.[1];

test('canonical, bare and outdated thread URLs preserve cursor and have bounded reads; inaccessible ids are 404', async () => {
  for (const locale of ['en', 'zh-Hans']) {
    const path = canonical.replace('/en/', `/${locale}/`);
    const page = await read(path);
    expect(page.response.status).toBe(200);
    expect(page.calls.filter(call => call.startsWith(`/v1/threads/${thread.id}`))).toHaveLength(2);
    expect(page.calls.filter(call => !call.includes('pages:read')).length).toBe(5);
    for (const suffix of ['', '/outdated']) {
      const hop = await read(`/${locale}/threads/${thread.id}${suffix}?cursor=opaque%2Bcursor`);
      expect(hop.response.status).toBe(301);
      expect(hop.response.headers.get('location')).toBe(`${path}?cursor=opaque%2Bcursor`);
      expect(hop.calls).toEqual([`/v1/threads/${thread.id}`]);
    }
    for (const id of ['unknown', 'unreadable', 'removed']) expect((await read(`/${locale}/threads/${id}/anything`)).response.status).toBe(404);
  }
  erased = true;
  try {
    const hop = await read(`/en/threads/${thread.id}/old`);
    expect(hop.response.status).toBe(301);
    expect(hop.response.headers.get('location')).toBe(`/en/threads/${thread.id}/thread`);
    expect((await read(`/en/threads/${thread.id}/thread`)).response.status).toBe(200);
  } finally { erased = false; }
}, 300_000);

test('every thread link uses the shared canonical href, including board, agent, subject and creation links', async () => {
  const { threadHref } = await import('../src/threads/thread-href');
  expect(threadHref(thread)).toBe(canonical.slice(3));
  expect(threadHref({ id: thread.id, title: null })).toBe(`/threads/${thread.id}/thread`);
  const page = await read(`/en/boards/${board.id}`);
  expect(page.html).toContain(canonical);
  for (const file of ['routes/boards/$id.tsx', 'routes/boards/$id_.new.tsx', 'features/pages/account.tsx']) {
    const source = await Bun.file(join(app, 'src', file)).text();
    expect(source).toContain('threadHref(');
    expect(source).not.toMatch(/`[^`]*\/threads\/\$\{/);
  }
  const overview = await Bun.file(join(app, 'src/features/pages/overview.tsx')).text();
  // Subject discussion/review slots may still be unavailable, but any real thread link must use the helper.
  if (/\/threads\//.test(overview)) expect(overview).toContain('threadHref(');
});

test('thread head describes the opening, article card and one forum/breadcrumb graph using visible replies', async () => {
  const page = await read(canonical);
  expect(page.html).toContain(`${thread.title} – REZICS`);
  const description = meta(page.html, 'description')!;
  expect(description.length).toBeLessThanOrEqual(160);
  expect(description).toBe(opening.slice(0, 161).slice(0, opening.slice(0, 161).lastIndexOf(' ')));
  expect(meta(page.html, 'og:type')).toBe('article');
  expect(meta(page.html, 'og:image')).toBe('https://rezics.com/cards/default.png');
  const data = graphs(page.html);
  expect(data).toHaveLength(1);
  const posting = data[0]['@graph'].find((node: any) => node['@type'] === 'DiscussionForumPosting');
  expect(posting).toMatchObject({ headline: thread.title, text: opening, author: { '@type': 'Person', name: 'Aviator', url: 'https://rezics.com/en/@aviator' }, datePublished: thread.createdAt, url: `https://rezics.com${canonical}`, comment: [{ '@type': 'Comment', text: 'A thoughtful reply.', datePublished: reply.createdAt, author: { '@type': 'Person', name: 'Aviator' } }], interactionStatistic: { '@type': 'InteractionCounter', interactionType: 'https://schema.org/CommentAction', userInteractionCount: 7 } });
  expect(data[0]['@graph'].find((node: any) => node['@type'] === 'BreadcrumbList').itemListElement.map((item: any) => item.name)).toEqual(['Star readers', 'Reading room', thread.title]);
  expect(meta(page.html, 'robots')).toBeUndefined();
  expect(meta((await read(`${canonical}?cursor=page-two`)).html, 'robots')).toBe('noindex, follow');
});

test('board head names board and Realm, embeds CollectionPage and breadcrumbs, and noindexes empty or later pages', async () => {
  const page = await read(`/en/boards/${board.id}`);
  expect(page.html).toContain('Reading room – REZICS');
  expect(meta(page.html, 'description')).toContain('Reading room');
  expect(meta(page.html, 'description')).toContain('Star readers');
  const data = graphs(page.html);
  expect(data).toHaveLength(1);
  expect(data[0]['@graph'].map((node: any) => node['@type'])).toEqual(['CollectionPage', 'BreadcrumbList']);
  expect(meta(page.html, 'robots')).toBeUndefined();
  expect(meta((await read(`/en/boards/${board.id}?cursor=page-two`)).html, 'robots')).toBe('noindex, follow');
  empty = true;
  try { expect(meta((await read(`/en/boards/${board.id}`)).html, 'robots')).toBe('noindex, follow'); } finally { empty = false; }
});

test('board and thread cursors use fallback Valibot validation and reads use public query factories', async () => {
  for (const file of ['routes/boards/$id.tsx', 'routes/threads/$id_.$slug.tsx']) {
    const source = await Bun.file(join(app, 'src', file)).text();
    expect(source).toContain('validateSearch:');
    expect(source).toContain('v.fallback(');
    expect(source).toContain('loaderDeps:');
    expect(source).toContain('ensureQueryData(');
  }
  const source = await Bun.file(join(app, 'src/threads/thread-queries.ts')).text();
  expect(source).toContain('queryOptions(');
  expect(source).toContain('publicRead');
  expect(source).toContain('credentialMode');
});
