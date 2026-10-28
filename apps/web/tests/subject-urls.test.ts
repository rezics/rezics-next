import { afterAll, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { slug } from '@rezics/definitions/slug';
import { createFakeKernelFetch } from '../src/kernel/fake.ts';
import fixtures from '../src/kernel/fixtures.json';
import { demoAgentAccounts, demoAgentSubjects } from '../src/kernel/agent-fixtures.ts';
import definitionsRecording from '../src/kernel/recorded/definitions-release.json';

const app = join(import.meta.dir, '..');
const timeout = 300_000;
const locales = ['en', 'zh-Hans', 'zh-Hant', 'ja', 'ko', 'de', 'fr', 'es'] as const;
const kokoro = fixtures.subjects[0]!;
const redirected = Object.entries(fixtures.redirects)[0]!;
const subtypeId = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e70';
const emptyAgentId = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e71';
const failedAgentId = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e72';
const subtypeAccountId = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e73';
const emptyAccountId = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e74';
const failedAccountId = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e75';
const subtypeLabel = {
  en: 'Ada Researcher',
  'zh-Hans': '艾达研究员',
  'zh-Hant': '艾達研究員',
  ja: 'エイダ研究者',
  ko: '에이다 연구자',
  de: 'Ada Forscherin',
  fr: 'Ada chercheuse',
  es: 'Ada investigadora',
};
const agentSubjects = [
  { id: subtypeId, type: 'test:Researcher', labels: subtypeLabel, descriptions: {}, aliases: {}, statements: {} },
  {
    id: emptyAgentId,
    type: 'schema:Person',
    labels: { en: 'Unverified Person' },
    descriptions: {},
    aliases: {},
    statements: {},
  },
  {
    id: failedAgentId,
    type: 'schema:Organization',
    labels: { en: 'Unavailable Organization' },
    descriptions: {},
    aliases: {},
    statements: {},
  },
];
const agents = [
  ...demoAgentAccounts,
  {
    id: subtypeAccountId,
    handle: 'ada',
    kind: 'actor' as const,
    state: 'active' as const,
    displayName: 'Ada Researcher',
    bio: null,
    links: [],
    avatar: null,
    subject: subtypeId,
  },
  {
    id: emptyAccountId,
    handle: 'unverified',
    kind: 'actor' as const,
    state: 'active' as const,
    displayName: 'Unverified Person',
    bio: null,
    links: [],
    avatar: null,
    subject: null,
  },
  {
    id: failedAccountId,
    handle: 'unavailable',
    kind: 'organization' as const,
    state: 'active' as const,
    displayName: 'Unavailable Organization',
    bio: null,
    links: [],
    avatar: null,
    subject: null,
  },
];
const definitions = definitionsRecording as unknown as { digest: string; release: Record<string, unknown> };
const release = {
  ...definitions.release,
  types: {
    ...(definitions.release.types as Record<string, unknown>),
    'test:Researcher': { bases: ['schema:Person'], labels: subtypeLabel },
  },
};
const fake = createFakeKernelFetch({
  ...fixtures,
  subjects: [...fixtures.subjects, ...demoAgentSubjects, ...agentSubjects],
  accounts: agents,
  types: {
    ...fixtures.types,
    'schema:Person': { bases: ['schema:Thing'] },
    'schema:Organization': { bases: ['schema:Thing'] },
    'test:Researcher': { bases: ['schema:Person'] },
  },
} as never);

const kernelReads: string[] = [];
const accountLookups: string[] = [];
let failedAccountLookup = false;
const kernel = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/v1/definitions/active') return Response.json({ digest: definitions.digest });
    if (url.pathname === `/v1/definitions/releases/${encodeURIComponent(definitions.digest)}`)
      return Response.json({ digest: definitions.digest, release });
    if (request.method === 'POST' && url.pathname === '/v1/pages:read') {
      const body = (await request.clone().json()) as { target?: { subject?: string } };
      const subjectId = body.target?.subject;
      if (subjectId) kernelReads.push(`/v1/subjects/${subjectId}`);
      return fake(request);
    }
    const subject = /^\/v1\/subjects\/([^/]+)$/.exec(url.pathname);
    if (request.method === 'GET' && subject?.[1]) {
      const subjectId = decodeURIComponent(subject[1]);
      kernelReads.push(`/v1/subjects/${subjectId}`);
      const survivor = fixtures.redirects[subjectId];
      if (survivor)
        return Response.json(
          { redirect: { from: subjectId, to: survivor } },
          { status: 308, headers: { location: `/v1/subjects/${survivor}` } },
        );
      return fake(request);
    }
    if (url.pathname === '/v1/accounts' && url.searchParams.has('agent')) {
      const subjectId = url.searchParams.get('agent')!;
      accountLookups.push(subjectId);
      if (subjectId === failedAgentId && failedAccountLookup)
        return Response.json({ code: 'dependency_unavailable' }, { status: 503 });
      if (subjectId === subtypeId)
        return Response.json({ accounts: [{ id: subtypeAccountId, handle: 'ada' }], next: null });
      return Response.json({ accounts: [], next: null });
    }
    return fake(request);
  },
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

let child: ChildProcess | undefined;
let started: Promise<string> | undefined;
function site(): Promise<string> {
  started ??= (async () => {
    const port = await freePort();
    let output = '';
    const keep = (chunk: Buffer) => (output = (output + chunk.toString()).slice(-8000));
    child = spawn('bun', ['run', 'dev', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
      cwd: app,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        KERNEL_ORIGIN: kernel.url.origin,
        PUBLIC_ORIGIN: `http://127.0.0.1:${port}`,
        AUTH_ISSUER: `${kernel.url.origin}/auth`,
        WEBSITE_CLIENT_ID: 'rezics-website',
        API_RESOURCE: 'https://api.rezics.test',
        WEBSITE_SCOPES: 'media:create media:read',
      },
    });
    child.stdout!.on('data', keep);
    child.stderr!.on('data', keep);
    const origin = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 150_000;
    for (;;) {
      if (child.exitCode !== null) throw new Error(`dev server exited with ${child.exitCode}:\n${output}`);
      try {
        const response = await fetch(`${origin}/en`, { redirect: 'manual', signal: AbortSignal.timeout(60_000) });
        if (response.status < 500) return origin;
      } catch {}
      if (Date.now() > deadline) throw new Error(`dev server did not serve /en in time:\n${output}`);
      await Bun.sleep(500);
    }
  })();
  return started;
}

afterAll(async () => {
  kernel.stop(true);
  if (child?.pid)
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {}
});

async function response(path: string) {
  return fetch(`${await site()}${path}`, { redirect: 'manual', signal: AbortSignal.timeout(120_000) });
}

function canonicalPath(locale: (typeof locales)[number], id = kokoro.id, label = kokoro.labels[locale]!) {
  return `/${locale}/subjects/${id}/${slug(label)}`;
}

function links(html: string) {
  return [...html.matchAll(/<link\b[^>]*>/g)].map((match) => {
    const attributes = Object.fromEntries(
      [...match[0].matchAll(/([\w-]+)="([^"]*)"/g)].map((attribute) => [attribute[1]!.toLowerCase(), attribute[2]!]),
    );
    return attributes;
  });
}

test(
  'subject URLs use localized slugs, redirect aliases and merges once, classify agents, and keep subject links canonical',
  async () => {
    const origin = await site();

    // One canonical URL per locale: the heading, canonical and all alternates use the same displayed label.
    kernelReads.length = 0;
    accountLookups.length = 0;
    const canonical = await response(canonicalPath('en'));
    expect(canonical.status).toBe(200);
    const html = await canonical.text();
    const pageLinks = links(html);
    expect(pageLinks.find((link) => link.rel === 'canonical')?.href).toBe(`${origin}${canonicalPath('en')}`);
    for (const locale of locales) {
      expect(pageLinks.find((link) => link.rel === 'alternate' && link.hreflang === locale)?.href).toBe(
        `${origin}${canonicalPath(locale)}`,
      );
    }
    expect(kernelReads).toEqual([`/v1/subjects/${kokoro.id}`, `/v1/subjects/${kokoro.id}`]);
    expect(accountLookups).toEqual([]);

    kernelReads.length = 0;
    const relations = await response(`${canonicalPath('en')}/relations`);
    expect(relations.status).toBe(200);
    const relationsLinks = links(await relations.text());
    expect(relationsLinks.find((link) => link.rel === 'canonical')?.href).toBe(
      `${origin}${canonicalPath('en')}/relations`,
    );
    for (const locale of locales) {
      expect(relationsLinks.find((link) => link.rel === 'alternate' && link.hreflang === locale)?.href).toBe(
        `${origin}${canonicalPath(locale)}/relations`,
      );
    }

    // A bare id and an outdated slug each redirect to the current localized URL. Views and search survive.
    for (const path of [
      `/en/subjects/${kokoro.id}`,
      `/en/subjects/${kokoro.id}/editions`,
      `/en/subjects/${kokoro.id}/relations?property=schema%3Aauthor&cursor=next-page`,
      `/en/subjects/${kokoro.id}/old-title`,
      `/en/subjects/${kokoro.id}/old-title/relations?property=schema%3Aauthor&cursor=next-page`,
    ]) {
      kernelReads.length = 0;
      const redirectedPage = await response(path);
      expect(redirectedPage.status).toBe(301);
      const location = new URL(redirectedPage.headers.get('location')!, origin);
      const unqueriedPath = path.split('?', 1)[0]!;
      const view = unqueriedPath.endsWith('/relations')
        ? '/relations'
        : unqueriedPath.endsWith('/editions')
          ? '/editions'
          : '';
      expect(location.pathname).toBe(`${canonicalPath('en')}${view}`);
      if (path.includes('?')) expect(location.search).toBe('?property=schema%3Aauthor&cursor=next-page');
      expect(kernelReads).toEqual([`/v1/subjects/${kokoro.id}`]);
    }

    // The kernel follows its one 308 to the survivor; the site answers one 301 to the survivor's canonical URL.
    kernelReads.length = 0;
    const [oldId, survivorId] = redirected;
    const survivor = fixtures.subjects.find((subject) => subject.id === survivorId)!;
    const merge = await response(`/en/subjects/${oldId}/old-title`);
    expect(merge.status).toBe(301);
    expect(new URL(merge.headers.get('location')!, origin).href).toBe(
      `${origin}/en/subjects/${survivor.id}/${slug(survivor.labels.en!)}`,
    );
    expect(kernelReads).toEqual([`/v1/subjects/${oldId}`, `/v1/subjects/${survivorId}`]);

    // A Unicode survivor slug and its view are encoded safely in the one-hop redirect.
    kernelReads.length = 0;
    const jaMerge = await response(`/ja/subjects/${oldId}/outdated/relations?property=schema%3Aauthor`);
    expect(jaMerge.status).toBe(301);
    expect(new URL(jaMerge.headers.get('location')!, origin).pathname).toBe(
      `/ja/subjects/${survivor.id}/${encodeURIComponent(slug(survivor.labels.ja!))}/relations`,
    );
    expect(new URL(jaMerge.headers.get('location')!, origin).search).toBe('?property=schema%3Aauthor');
    expect(kernelReads).toEqual([`/v1/subjects/${oldId}`, `/v1/subjects/${survivorId}`]);

    // Unknown, unreadable and removed ids share the same 404 page.
    for (const id of [
      '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e90',
      '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e91',
      '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e92',
    ]) {
      kernelReads.length = 0;
      const missing = await response(`/en/subjects/${id}/missing`);
      expect(missing.status).toBe(404);
      expect(await missing.text()).toContain('Page not found');
      expect(kernelReads).toEqual([`/v1/subjects/${id}`]);
    }

    // A catalogue subtype of Person redirects only after its verified-account lookup.
    accountLookups.length = 0;
    kernelReads.length = 0;
    const verified = await response(`/en/subjects/${subtypeId}/outdated`);
    expect(verified.status).toBe(301);
    expect(new URL(verified.headers.get('location')!, origin).href).toBe(`${origin}/en/@ada`);
    expect(accountLookups).toEqual([subtypeId]);
    expect(kernelReads).toEqual([`/v1/subjects/${subtypeId}`]);

    // No verified identity or an unavailable lookup leaves an agent subject page readable.
    const noAccount = await response(`/en/subjects/${emptyAgentId}/${slug('Unverified Person')}`);
    expect(noAccount.status).toBe(200);
    expect(accountLookups).toContain(emptyAgentId);
    failedAccountLookup = true;
    const failedLookup = await response(`/en/subjects/${failedAgentId}/${slug('Unavailable Organization')}`);
    expect(failedLookup.status).toBe(200);
    expect(accountLookups).toContain(failedAgentId);
    failedAccountLookup = false;

    // All subject links go through the shared href builder; direct subject-link construction stays out of callers.
    const hrefModule = await import('../src/subject/subject-href.ts').catch(() => null);
    expect(hrefModule).not.toBeNull();
    if (hrefModule) {
      expect(hrefModule.subjectHref({ id: kokoro.id, label: 'Kokoro' }, 'en')).toEqual({
        to: '/subjects/$id/$slug',
        params: { id: kokoro.id, slug: 'kokoro' },
        href: canonicalPath('en'),
      });
    }
    const sourceFiles = ['ts', 'tsx'].flatMap((extension) =>
      [...new Bun.Glob(`**/*.${extension}`).scanSync({ cwd: join(app, 'src') })].map((path) => join(app, 'src', path)),
    );
    const bypasses: string[] = [];
    for (const file of sourceFiles) {
      if (file.endsWith('/subject/subject-href.ts') || file.includes('/routes/subjects/')) continue;
      const source = await Bun.file(file).text();
      if (
        /(?:to\s*=\s*["']\/subjects\/\$id|to:\s*["']\/subjects\/\$id|href\s*=\s*\{?`[^`]*subjects\/|href:\s*`[^`]*subjects\/)/.test(
          source,
        )
      )
        bypasses.push(file);
    }
    expect(bypasses).toEqual([]);
  },
  timeout,
);
