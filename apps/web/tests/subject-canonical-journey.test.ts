import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { createKernelClient, type SubjectRead } from '@rezics/client';
import { planReads, platformRegistry, type CompositionDocument } from '@rezics/composition';
import recordedSubject from '../src/kernel/recorded/subject.json';
import recordedPage from '../src/kernel/recorded/subject-page.json';
import { loadSubject } from '../src/subject/load-subject';
import { accountHref, canonicalRedirect, keepSearch, subjectUrlForView } from '../src/subject/subject-href';
import { formerHandleRedirect } from '../src/features/pages/agent';
import { loadSubjectPage, SubjectPage, subjectBody, type SubjectPageData } from '../src/features/pages/subject';
import { cachePublicPage } from '../src/security/page-cache';

const original = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e80';

test('the complete assigned visible journey uses actual current native data and preserves its privacy failure and request bounds', async () => {
  // Exercise the generated HTTP client against native recorded DTOs, without a second page/data protocol.
  // This focused transport case does not establish current native authorization or document-body delivery.
  const read = structuredClone(recordedSubject) as SubjectRead;
  read.subject.type = 'schema:Person';
  read.summary!.types = ['schema:Person', 'schema:Thing'];
  const calls: { path: string; authorization: string | null; redirect: RequestRedirect }[] = [];
  let handle: string | null = 'current_name';
  let concealed = false;
  let chained = false;
  const client = createKernelClient('https://kernel.invalid', {
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      calls.push({
        path: url.pathname,
        authorization: request.headers.get('authorization'),
        redirect: request.redirect,
      });
      if (
        url.pathname === `/v1/subjects/${original}` ||
        (chained && url.pathname === `/v1/subjects/${read.subject.id}`)
      )
        return Response.json({ redirect: { from: original, to: read.subject.id } }, { status: 308 });
      if (url.pathname === '/v1/accounts')
        return Response.json({ accounts: [{ id: original, handle, state: 'active', verified: true }] });
      return concealed ? Response.json({ code: 'not_found' }, { status: 404 }) : Response.json(read);
    },
  });
  const loaded = await loadSubject(client, original, 'ja');
  if (loaded.kind !== 'subject') throw new Error('Expected current public subject');
  expect(loaded.value.read).toEqual(read);
  const redirect = canonicalRedirect(subjectUrlForView(loaded.value, 'works'), '?cursor=a%2Fb&sort=recent', '#credits');
  expect(redirect).toEqual({
    href: '/ja/@current_name/works?cursor=a%2Fb&sort=recent#credits',
    statusCode: 301,
    headers: { 'Cache-Control': 'private, no-store' },
  });
  expect(loaded.value.paths.ja).toBe('/@current_name');
  expect(calls.map((call) => call.path)).toEqual([
    `/v1/subjects/${original}`,
    `/v1/subjects/${read.subject.id}`,
    '/v1/accounts',
  ]);
  expect(calls.every((call) => call.authorization === null)).toBe(true);
  expect(calls.slice(0, 2).every((call) => call.redirect === 'manual')).toBe(true);

  handle = null;
  const handleless = await loadSubject(client, read.subject.id, 'ja');
  if (handleless.kind !== 'subject') throw new Error('Expected handleless catalogue identity');
  expect(handleless.value.href).toContain(`/subjects/${read.subject.id}/`);
  expect(handleless.value.href).not.toContain('/@');
  concealed = true;
  calls.length = 0;
  expect(await loadSubject(client, read.subject.id, 'ja')).toEqual({ kind: 'missing' });
  expect(calls).toHaveLength(1);
  concealed = false;
  chained = true;
  calls.length = 0;
  await expect(loadSubject(client, original, 'ja')).rejects.toThrow('Subject read failed');
  expect(calls).toHaveLength(2);
  expect(keepSearch('/ja/subjects/id/%E6%9C%AC/works', '?q=a%20b', '#roles')).toBe(
    '/ja/subjects/id/%E6%9C%AC/works?q=a%20b#roles',
  );
  expect(canonicalRedirect(accountHref('en', 'Current_Name', 'works'), '', '', 308).statusCode).toBe(308);
});

test('non-agent ID canonicalization uses the admitted type summary without loading a definitions release', async () => {
  const read = structuredClone(recordedSubject) as SubjectRead;
  read.subject.type = 'schema:TVSeries';
  read.summary!.types = ['schema:TVSeries', 'schema:CreativeWork', 'schema:Thing'];
  read.account = null;
  const paths: string[] = [];
  const client = createKernelClient('https://kernel.invalid', {
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      paths.push(path);
      return path === `/v1/subjects/${read.subject.id}`
        ? Response.json(read)
        : Response.json({ code: 'unexpected_optional_read' }, { status: 500 });
    },
  });
  const loaded = await loadSubject(client, read.subject.id, 'en');
  if (loaded.kind !== 'subject') throw new Error('Expected the canonical public Subject');
  expect(loaded.value.href).toContain(`/subjects/${read.subject.id}/`);
  expect(paths).toEqual([`/v1/subjects/${read.subject.id}`]);
});

test('former handles use the current native forwarding decision and never cache mutable aliases or concealed pages', async () => {
  let forwards = true;
  let requests = 0;
  const client = createKernelClient('https://kernel.invalid', {
    fetch: async () => {
      requests++;
      return Response.json({
        accounts: forwards ? [{ id: original, state: 'active', handle: 'current', movedTo: 'current' }] : [],
      });
    },
  });
  expect(await formerHandleRedirect(client, 'former', 'fr', 'works', '?cursor=next#role')).toEqual({
    href: '/fr/@current/works?cursor=next#role',
    statusCode: 302,
    headers: { 'Cache-Control': 'private, no-store' },
  });
  forwards = false;
  expect(await formerHandleRedirect(client, 'former', 'fr', 'works')).toBeUndefined();
  expect(requests).toBe(2);
  for (const path of ['/en/@former', `/en/subjects/${original}/missing`]) {
    const response = await cachePublicPage(new Request(`https://rezics.invalid${path}`), {
      publicRoute: true,
      buildId: 'subject-reading',
      dehydratedData: () => ({}),
      render: async () => new Response('Page not found', { status: 404, headers: { 'content-type': 'text/html' } }),
    });
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.has('etag')).toBe(false);
  }
});

test('anonymous typed public POST renders current terms without private SSR or invented document bodies and propagates failure', async () => {
  const read = structuredClone(recordedSubject) as SubjectRead;
  // Native authored/imported statements carry document locators, rather than the recorder's embedded prose.
  const documentId = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e99';
  for (const statement of read.subject.statements['schema:abstract'] ?? [])
    statement.value = { type: 'value', content: { language: 'en', document: documentId, digest: '0'.repeat(64) } };
  const page = structuredClone(recordedPage) as SubjectPageData;
  const plan = planReads(platformRegistry, page.document as CompositionDocument, { subject: page.subject });
  for (const [key, planned] of Object.entries(plan.reads)) {
    if (planned.kind === 'subject') page.reads[key] = { status: 200, body: read };
  }
  page.subject = recordedSubject.subject.id;
  let unavailable = false;
  const calls: { path: string; body: string; authorization: string | null }[] = [];
  const client = createKernelClient('https://kernel.invalid', {
    fetch: async (input, init) => {
      const request = new Request(input, init);
      calls.push({
        path: new URL(request.url).pathname,
        body: await request.text(),
        authorization: request.headers.get('authorization'),
      });
      return unavailable ? Response.json({ code: 'dependency_unavailable' }, { status: 503 }) : Response.json(page);
    },
  });
  const result = await loadSubjectPage(client, recordedSubject.subject.id, undefined, 'en');
  if (result.kind !== 'page') throw new Error('Expected public page');
  const selected = subjectBody(result.page);
  expect(selected?.subject.release).toBe(recordedSubject.subject.release);
  expect(selected?.subject.resolution).toEqual(recordedSubject.subject.resolution);
  expect(selected?.account).toEqual(recordedSubject.account);
  const queryClient = new QueryClient();
  queryClient.setQueryData(['exposure', 'anonymous'], ['personal_library']);
  const router = createRouter({
    routeTree: createRootRoute({
      component: () =>
        createElement(SubjectPage, {
          page: result.page,
          locale: 'en',
          renderJsonLd: false,
          messages: {
            unknown: 'Unknown',
            none: 'None',
            unlabelled: 'Unlabelled',
            sources: 'Sources',
            aliases: 'Also known as',
          },
        }),
    }),
    history: createMemoryHistory({ initialEntries: [`/en/subjects/${recordedSubject.subject.id}`] }),
  });
  await router.load();
  const html = renderToStaticMarkup(
    createElement(QueryClientProvider, {
      client: queryClient,
      children: createElement(RouterProvider, { router }),
    }),
  );
  expect(html).toContain(recordedSubject.subject.labels.en!);
  expect(html).not.toContain('csrf');
  expect(html).not.toContain(documentId);
  expect(html).not.toContain('A pilot stranded');
  expect(html).toContain('subject-text-unavailable');
  expect(queryClient.getQueryData(['exposure', 'viewer'])).toBeUndefined();
  expect(queryClient.getQueryData(['session'])).toBeUndefined();
  expect(calls).toEqual([
    {
      path: '/v1/pages:read',
      body: JSON.stringify({ target: { subject: recordedSubject.subject.id }, languages: ['en'] }),
      authorization: null,
    },
  ]);
  unavailable = true;
  await expect(loadSubjectPage(client, recordedSubject.subject.id)).rejects.toThrow('dependency_unavailable');
});
