import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { createKernelClient, SESSION_HEADER } from '@rezics/client';
import {
  PROFILE_FORMAT,
  planReads,
  platformRegistry,
  profileDigest,
  type CompositionDocument,
  type PresentationProfile,
} from '@rezics/composition';
import recorded from '../src/kernel/recorded/subject.json';
import {
  anonymousPreviewFetch,
  loadPresentationPreview,
  matchesPinnedTemplate,
  presentationPreviewClient,
  previewInput,
  type PresentationPreview,
} from '../src/features/pages/presentation-preview';
import { PresentationPreviewPanel, PublishedPresentationPage } from '../src/features/pages/presentation-preview-view';
import { PresentationViewEditor } from '../src/features/pages/curate-view-editor';
import { CurationPublicationRecovery } from '../src/features/pages/curation-publish-view';
import { CurationPublication } from '../src/features/pages/curation-publish';
import { withTemplate } from '../src/features/pages/curate';
import type { SubjectPageData } from '../src/features/pages/subject';
import { m } from '../src/paraglide/messages.js';

const document: CompositionDocument = {
  root: { props: {} },
  content: [
    { type: 'SubjectHeader', props: { id: 'header' } },
    { type: 'Summary', props: { id: 'about' } },
  ],
};
const routeDocument: CompositionDocument = {
  root: { props: {} },
  content: [{ type: 'Heading', props: { id: 'home', text: { en: 'Published home' }, level: 1 } }],
};
const profile: PresentationProfile = {
  format: PROFILE_FORMAT,
  generic: document,
  bases: [{ base: 'schema:CreativeWork', document }],
  types: [{ type: 'schema:Book', document }],
  routes: [{ route: '/', document: routeDocument }],
};
const digest = profileDigest(profile);
const subject = recorded.subject.id;
const input = { target: { subject }, locale: 'en' };
function closedDisclosureContaining(html: string, content: string): string | undefined {
  return [...html.matchAll(/<details\b([^>]*)>([\s\S]*?)<\/details>/g)].find(
    ([, attributes, body]) => !/\bopen(?:\s|=|$)/.test(attributes ?? '') && (body ?? '').includes(content),
  )?.[0];
}
function textOutsideDisclosures(html: string): string {
  return html.replace(/<details\b[^>]*>[\s\S]*?<\/details>/g, '').replace(/<[^>]+>/g, ' ');
}
function page(template: SubjectPageData['template'] = { scope: 'type', key: 'schema:Book' }): SubjectPageData {
  const plan = planReads(platformRegistry, document, { subject });
  return {
    subject,
    profile: digest,
    template,
    document,
    reads: Object.fromEntries(Object.keys(plan.reads).map((key) => [key, { status: 200, body: recorded }])),
  };
}
const answer = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', [SESSION_HEADER]: 'anonymous-observation' },
  });
type Read = {
  path: string;
  method: string;
  body: unknown;
  headers: Headers;
  cache: RequestCache;
  credentials: RequestCredentials;
  redirect: RequestRedirect;
};
function kernel(
  result = page(),
  options: {
    status?: number;
    headDigest?: string;
    pinned?: PresentationProfile;
    published?: PresentationProfile;
    pageBody?: unknown;
  } = {},
) {
  const seen: Read[] = [];
  const published = options.published ?? profile;
  const publishedDigest = profileDigest(published);
  const client = presentationPreviewClient('https://kernel.invalid', (async (input, init) => {
    const request = new Request(input, init);
    const path = decodeURIComponent(new URL(request.url).pathname);
    seen.push({
      path,
      method: request.method,
      body: request.method === 'POST' ? await request.json() : null,
      headers: request.headers,
      cache: request.cache,
      credentials: request.credentials,
      redirect: request.redirect,
    });
    if (path === '/v1/pages:read') return answer(options.status ?? 200, options.pageBody ?? result);
    if (path === '/v1/presentation/active')
      return answer(200, { digest: options.headDigest ?? publishedDigest, head: 17 });
    if (path === `/v1/presentation/profiles/${publishedDigest}`)
      return answer(200, { digest: publishedDigest, profile: options.pinned ?? published });
    throw new Error(`Unexpected IO: ${request.method} ${path}`);
  }) as typeof fetch);
  return { client, seen };
}

test('the existing curation workflow inspects native active resolution and the anonymous current page', async () => {
  const { client, seen } = kernel();
  const result = await loadPresentationPreview(client, input);
  expect(result).toEqual({ ok: true, target: input.target, locale: 'en', head: 17, page: page() });
  expect(seen.map(({ method, path }) => `${method} ${path}`).sort()).toEqual(
    ['GET /v1/presentation/active', `GET /v1/presentation/profiles/${digest}`, 'POST /v1/pages:read'].sort(),
  );
  expect(seen[0]!.body).toEqual({ target: { subject }, languages: ['en'] });
  for (const read of seen) {
    expect(read.headers.has('authorization')).toBe(false);
    expect(read.headers.has('cookie')).toBe(false);
    expect(read.headers.has(SESSION_HEADER)).toBe(false);
    expect(read.cache).toBe('no-store');
    expect(read.credentials).toBe('omit');
    expect(read.redirect).toBe('manual');
  }
  if (!result.ok) throw new Error('Expected current page');
  const html = renderToString(createElement(PublishedPresentationPage, { result }));
  expect(html).toContain('The Little Prince');
  expect(html).toContain('data-slot="subject-header"');
  expect(html).toContain('font-serif text-3xl');
  expect(html).not.toContain('application/ld+json');
  expect(html).not.toContain('<title>');
  expect(html).not.toContain('subject-purchase');
});

test.each([document, routeDocument])('subject preview stays attached to its requested address %#', async (document) => {
  const published = { ...profile, generic: document, bases: [], types: [] };
  const aggregate = page({ scope: 'generic', key: null });
  aggregate.profile = profileDigest(published);
  aggregate.document = document;
  if (document === routeDocument) aggregate.reads = {};
  expect((await loadPresentationPreview(kernel(aggregate, { published }).client, input)).ok).toBe(true);
  const { client, seen } = kernel(aggregate, { published });
  const target = { subject: '00000000-0000-4000-8000-000000000099' };
  expect(await loadPresentationPreview(client, { ...input, target })).toEqual({ ok: false, reason: 'unavailable' });
  expect(seen.map(({ path }) => path)).toEqual(['/v1/pages:read']);
});

test('anonymous mode strips ambient credentials and a client session token on every request', async () => {
  const observed: Request[] = [];
  const client = createKernelClient('https://kernel.invalid', {
    headers: { authorization: 'Bearer curator-private', cookie: 'rezics-session=private' },
    session: 'private-session',
    fetch: anonymousPreviewFetch((async (input, init) => {
      observed.push(new Request(input, init));
      return answer(200, { digest, head: 17 });
    }) as typeof fetch),
  });
  await client.presentation.active.get();
  await client.presentation.active.get();
  expect(observed).toHaveLength(2);
  for (const request of observed) {
    expect(request.headers.get('authorization')).toBeNull();
    expect(request.headers.get('cookie')).toBeNull();
    expect(request.headers.get(SESSION_HEADER)).toBeNull();
  }
});

test('pinned provenance uses the shared helper and native selection without guessing a type hierarchy', () => {
  for (const template of [
    { scope: 'type', key: 'schema:Book' },
    { scope: 'base', key: 'schema:CreativeWork' },
    { scope: 'generic', key: null },
  ] as const)
    expect(matchesPinnedTemplate(profile, page(template))).toBe(true);
  expect(matchesPinnedTemplate(profile, { ...page(), document: routeDocument })).toBe(false);
  expect(matchesPinnedTemplate(profile, page({ scope: 'base', key: 'schema:Thing' }))).toBe(false);
  expect(matchesPinnedTemplate(profile, page({ scope: 'generic', key: 'invented' }))).toBe(false);
});

test('supported routes render their actual active document; unknown routes never preview a generic shell', async () => {
  const routed = {
    ...page(),
    subject: null,
    document: routeDocument,
    template: { scope: 'route', key: '/' } as const,
    reads: {},
  };
  const result = await loadPresentationPreview(kernel(routed).client, { target: { route: '/' }, locale: 'ja' });
  expect(result.ok).toBe(true);
  if (result.ok)
    expect(renderToString(createElement(PublishedPresentationPage, { result }))).toContain('Published home');
  const unknown = { ...routed, document, template: { scope: 'generic', key: null } as const };
  // The native API itself permits generic route fallback. Inspection still refuses an unsupported route.
  expect(
    await loadPresentationPreview(kernel(unknown).client, { target: { route: '/unknown' }, locale: 'en' }),
  ).toEqual({ ok: false, reason: 'missing' });
});

test('unknown, private, removed, denied and unready targets stay failures without privileged fallback', async () => {
  for (const [status, reason] of [
    [404, 'missing'],
    [410, 'missing'],
    [401, 'denied'],
    [403, 'denied'],
    [503, 'unavailable'],
  ] as const) {
    const { client, seen } = kernel(page(), {
      status,
      pageBody: { code: 'not_found', privateSource: 'must not escape' },
    });
    expect(await loadPresentationPreview(client, input)).toEqual({ ok: false, reason });
    expect(seen).toHaveLength(1);
  }
  for (const status of [403, 404, 503]) {
    const broken = page();
    const key = Object.keys(broken.reads)[0]!;
    broken.reads[key] = { status, body: { privateSource: 'must not escape' } };
    expect(await loadPresentationPreview(kernel(broken).client, input)).toEqual({
      ok: false,
      reason: status === 403 ? 'denied' : status === 404 ? 'missing' : 'unavailable',
    });
  }
});

test('an admitted native subject may use a configured static template without another body read', async () => {
  const published = { ...profile, types: [{ type: 'schema:Book', document: routeDocument }] };
  const native = { ...page(), profile: profileDigest(published), document: routeDocument, reads: {} };
  const { client, seen } = kernel(native, { published });
  const result = await loadPresentationPreview(client, input);
  expect(result.ok).toBe(true);
  if (result.ok)
    expect(renderToString(createElement(PublishedPresentationPage, { result }))).toContain('Published home');
  expect(seen).toHaveLength(3);
  const unknown = kernel(native, { status: 404, published });
  expect(await loadPresentationPreview(unknown.client, input)).toEqual({ ok: false, reason: 'missing' });
  expect(unknown.seen).toHaveLength(1);
});

test('a native account redirect is reported without a second aggregate or an invented subject page', async () => {
  const { client, seen } = kernel(page(), { status: 308, pageBody: { redirect: { from: subject, to: 'reader' } } });
  expect(await loadPresentationPreview(client, input)).toEqual({ ok: false, reason: 'redirect', handle: 'reader' });
  expect(seen).toHaveLength(1);
});

test('profile changes, mismatching documents and unverified immutable bodies cannot produce a preview', async () => {
  expect(
    await loadPresentationPreview(kernel(page(), { headDigest: `sha256:${'f'.repeat(64)}` }).client, input),
  ).toEqual({ ok: false, reason: 'changed' });
  expect(
    await loadPresentationPreview(kernel(page(), { pinned: { ...profile, generic: routeDocument } }).client, input),
  ).toEqual({ ok: false, reason: 'unavailable' });
  expect(await loadPresentationPreview(kernel({ ...page(), document: routeDocument }).client, input)).toEqual({
    ok: false,
    reason: 'unavailable',
  });
});

test('current Realm and terminal subject selection is retained without another subject or source read', async () => {
  const realm = '00000000-0000-4000-8000-000000000007';
  const original = '00000000-0000-4000-8000-000000000008';
  const selected = page();
  selected.context = {
    id: recorded.subject.context,
    population: { kind: 'realm', id: realm, title: 'Published Realm' },
  };
  const selectedPlan = planReads(platformRegistry, document, { subject, context: selected.context });
  selected.reads = Object.fromEntries(
    Object.keys(selectedPlan.reads).map((key) => [key, { status: 200, body: recorded }]),
  );
  const { client, seen } = kernel(selected);
  const result = await loadPresentationPreview(client, { target: { subject: original, realm }, locale: 'zh-Hant' });
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.page.subject).toBe(subject);
    expect(result.page.context).toEqual(selected.context);
    expect(result.page.reads).toEqual(selected.reads);
    expect(result.target).toEqual({ subject: original, realm });
  }
  expect(seen[0]!.body).toEqual({ target: { subject: original, realm }, languages: ['zh-Hant', 'zh', 'zh-Hans'] });
  expect(seen).toHaveLength(3);
});

test('preview cannot accept unpublished draft descriptors, credentials or fake subject facts', async () => {
  const { client, seen } = kernel();
  for (const unsafe of [
    { ...input, reads: { private: { kind: 'subject', id: subject } } },
    { ...input, profile },
    { ...input, document },
    { ...input, credentialMode: 'session' },
    { ...input, target: { subject, type: 'schema:Book' } },
    { ...input, target: { subject, realm: 'private' } },
    { ...input, target: { route: '/', realm: subject } },
    { ...input, target: { route: '//private.invalid' } },
  ]) {
    expect(previewInput(unsafe)).toBeNull();
    expect(await loadPresentationPreview(client, unsafe)).toEqual({ ok: false, reason: 'invalid' });
  }
  expect(seen).toHaveLength(0);
});

test('presentation editing and published preview put draft meaning first and keep exact evidence in closed details', async () => {
  const draft = withTemplate(profile, { scope: 'type', key: 'schema:Book' }, routeDocument);
  const before = structuredClone(draft);
  const { client } = kernel();
  const result = await loadPresentationPreview(client, input);
  expect(draft).toEqual(before);
  expect(result.ok && result.page.document).toEqual(document);
  const html = renderToString(
    createElement(PresentationPreviewPanel, {
      locale: 'en',
      initial: result,
      read: async (): Promise<PresentationPreview> => result,
    }),
  );
  expect(html).toContain(m.presentation_editor_preview_current());
  expect(html).toContain('Unpublished editor changes are not rendered.');
  expect(html).toContain('The Little Prince');
  expect(html).not.toContain('Published home');
  const previewText = textOutsideDisclosures(html);
  expect(previewText).not.toContain(m.presentation_preview_precedence());
  expect(previewText).not.toContain(m.presentation_preview_head());
  const resolverDetails = closedDisclosureContaining(html, m.presentation_preview_precedence());
  expect(resolverDetails).toBeDefined();
  const previewDetails = closedDisclosureContaining(html, m.presentation_preview_head_help());
  expect(previewDetails).toBeDefined();
  expect(previewDetails).toContain('17');
  expect(previewDetails).toContain(digest);
  expect(previewDetails).toContain(subject);

  const editorHtml = renderToString(
    createElement(PresentationViewEditor, {
      initial: { ok: true, reader: '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e10', profile, digest, head: 17 },
      locale: 'en',
      transport: {
        publish: async () => ({ ok: true, digest, head: 18 }),
        read: async () => ({ ok: true, reader: '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e10', profile, digest, head: 17 }),
      },
    }),
  );
  const editorText = textOutsideDisclosures(editorHtml);
  expect(editorText).toContain(m.presentation_editor_draft_summary());
  expect(editorText).toContain(m.curation_saved());
  expect(editorText).toContain(m.curation_publish());
  expect(editorText).toContain(m.curation_view_discard());
  expect(editorText).toContain(m.curation_reload());
  expect(editorText).not.toContain(m.presentation_editor_version_reference({ head: 17, digest }));
  expect(editorText).not.toContain(m.curation_fallback());
  expect(
    closedDisclosureContaining(editorHtml, m.presentation_editor_version_reference({ head: 17, digest })),
  ).toBeDefined();
  expect(closedDisclosureContaining(editorHtml, m.curation_fallback())).toBeDefined();

  const publication = new CurationPublication(
    '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e10',
    {
      publish: async () => ({ ok: false, reason: 'stale' }),
      read: async () => ({ ok: true, reader: '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e10', profile, digest, head: 18 }),
    },
    () => 'test-publication-key',
  );
  await publication.start(profile, 17);
  const recoveryHtml = renderToString(
    createElement(CurationPublicationRecovery, {
      publication,
      profile,
      head: 17,
      onPublished: () => undefined,
      onReviewed: () => undefined,
    }),
  );
  const recoveryText = textOutsideDisclosures(recoveryHtml);
  expect(recoveryText).toContain(m.presentation_editor_publication_stale());
  expect(recoveryText).toContain(m.curation_retry_original());
  expect(recoveryText).toContain(m.curation_reload_head());
  expect(recoveryText).toContain(m.curation_discard());
  expect(recoveryText).toContain(m.curation_reconcile());
  expect(recoveryText).not.toContain(m.presentation_editor_version_reference({ head: 17, digest }));
  expect(recoveryText).not.toContain(m.curation_actual_head({ head: 18, digest }));
  expect(
    closedDisclosureContaining(recoveryHtml, m.presentation_editor_version_reference({ head: 17, digest })),
  ).toBeDefined();
  expect(closedDisclosureContaining(recoveryHtml, m.curation_actual_head({ head: 18, digest }))).toBeDefined();
});
