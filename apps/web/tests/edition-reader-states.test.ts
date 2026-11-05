import { expect, test } from 'bun:test';
import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createKernelClient } from '@rezics/client';
import { fromPlainText } from '@rezics/document';
import { Button } from '@rezics/ui/shadcn/button';
import { createNativeEditionApi, type EditionMetadata } from '../src/content-editions/edition-api';
import {
  editionDocumentDigest,
  loadContentEdition,
  type ContentEditionState,
} from '../src/content-editions/edition-model';
import { ContentEditionReader } from '../src/content-editions/edition-view';
import { m } from '../src/paraglide/messages.js';
import { getLocale } from '../src/paraglide/runtime.js';

type Control = { children?: ReactNode; onClick?: () => void; disabled?: boolean };
function elements(node: ReactNode): ReactElement<Control>[] {
  return Children.toArray(node).flatMap((child) =>
    isValidElement<Control>(child) ? [child, ...elements(child.props.children)] : [],
  );
}

test('The default edition reader offers truthful terminal destinations and recoverable retry while keeping paid content and attribution protected', async () => {
  const editionId = '0192f3a0-6c1e-7b2a-9d4e-000000000001';
  const revisionId = '0192f3a0-6c1e-7b2a-9d4e-000000000003';
  const subjectId = '0192f3a0-6c1e-7b2a-9d4e-000000000020';
  const creatorId = '0192f3a0-6c1e-7b2a-9d4e-000000000090';
  const text = 'Only the genuinely delivered fixed document belongs in this reader.';
  const body = fromPlainText(text, 'blocks');
  const metadata: EditionMetadata = {
    editionId,
    editionRevision: '2',
    state: 'published',
    targetSubjectId: subjectId,
    creatorAccountId: creatorId,
    revisionId,
    sha256: await editionDocumentDigest(body),
    licence: 'CC-BY-SA-4.0',
  };
  let outcome: 'unavailable' | 'source' | 'published' | 'withdrawn' | 'draft' | 'refused' | 'mismatch' = 'unavailable';
  const paths: string[] = [];
  const api = createNativeEditionApi(
    createKernelClient('https://kernel.test', {
      fetch: (async (input, init) => {
        const request = new Request(input, init);
        const path = new URL(request.url).pathname;
        paths.push(path);
        expect(request.headers.get('authorization')).toBe('Bearer current-reader');
        expect(request.redirect).toBe('manual');
        expect(request.cache).toBe('no-store');
        if (outcome === 'unavailable' || outcome === 'source' || outcome === 'refused')
          return Response.json({}, { status: outcome === 'refused' ? 403 : outcome === 'source' ? 404 : 503 });
        if (path === `/v1/contentEditions/${editionId}`)
          return Response.json({
            ...metadata,
            state: outcome === 'withdrawn' || outcome === 'draft' ? outcome : 'published',
          });
        expect(path).toBe(`/v1/contentEditions/${editionId}/revision`);
        return Response.json({
          editionId,
          revisionId: outcome === 'mismatch' ? subjectId : revisionId,
          sha256: metadata.sha256,
          licence: metadata.licence,
          body,
        });
      }) as typeof fetch,
    }),
  );
  const context = {
    subject: async (id: string) => ({ id, label: 'A fixed reading' }),
    creator: async (id: string) => ({ id, name: 'A visible creator' }),
  };
  const load = () => loadContentEdition(api, editionId, 'Bearer current-reader', context);
  let page: ContentEditionState = await load();
  let pending: Promise<void> | undefined;
  const reader = (retrying = false) =>
    ContentEditionReader({
      editionId,
      page,
      retrying,
      onRetry: () => {
        pending = load().then((fresh) => {
          page = fresh;
        });
      },
    });
  const retry = (view: ReactNode) => elements(view).find((element) => element.type === Button);
  const concealed = (view: ReactNode) => {
    const markup = renderToStaticMarkup(view);
    for (const value of [
      text,
      metadata.sha256,
      metadata.licence,
      revisionId,
      subjectId,
      creatorId,
      'data-slot="document-body"',
      '<details',
      '/subjects/',
      '/media/',
      'A visible creator',
      'A fixed reading',
    ])
      expect(markup).not.toContain(value);
    expect(markup).toContain(`href="/${getLocale()}/orders"`);
    expect(markup).toContain(m.content_edition_purchases());
    return markup;
  };

  expect(page).toEqual({ state: 'unavailable', status: 503, reason: 'dependency' });
  expect(concealed(reader())).toContain(m.content_edition_unavailable());
  expect(retry(reader())?.props.children).toBe(m.content_edition_retry());
  outcome = 'published';
  retry(reader())!.props.onClick!();
  expect(retry(reader(true))?.props.disabled).toBe(true);
  concealed(reader(true));
  await pending;
  expect(paths).toEqual([
    `/v1/contentEditions/${editionId}`,
    `/v1/contentEditions/${editionId}`,
    `/v1/contentEditions/${editionId}/revision`,
  ]);
  expect(page.state).toBe('published');
  const published = renderToStaticMarkup(reader());
  for (const value of [text, metadata.licence, 'A fixed reading', 'A visible creator', m.content_edition_attribution()])
    expect(published).toContain(value);
  const details = published.match(/<details\b[^>]*>[\s\S]*?<\/details>/u)?.[0];
  expect(details).toBeDefined();
  expect(details).not.toMatch(/<details[^>]*\bopen\b/u);
  expect(details).toContain(`<summary`);
  expect(details).toContain(m.content_edition_details());
  for (const value of [editionId, revisionId, metadata.editionRevision, metadata.sha256])
    expect(details).toContain(`>${value}</dd>`);
  for (const value of [editionId, revisionId, metadata.sha256])
    expect(published.replace(details!, '')).not.toContain(value);
  expect(retry(reader())).toBeUndefined();

  for (const terminal of ['withdrawn', 'refused', 'draft'] as const) {
    outcome = terminal;
    const before = paths.length;
    page = await load();
    expect(page.state).toBe(terminal === 'draft' ? 'unavailable' : terminal);
    if (terminal === 'draft') expect(page).toEqual({ state: 'unavailable', status: 404, reason: 'not-published' });
    const markup = concealed(reader());
    expect(markup).toContain(
      terminal === 'withdrawn'
        ? m.content_edition_withdrawn()
        : terminal === 'refused'
          ? m.content_edition_refused()
          : m.content_edition_not_published(),
    );
    expect(markup).not.toContain(m.content_edition_retry());
    expect(retry(reader())).toBeUndefined();
    expect(paths.slice(before)).toEqual([`/v1/contentEditions/${editionId}`]);
  }
  const beforeSignIn = paths.length;
  page = await loadContentEdition(api, editionId, null, context);
  expect(page).toEqual({ state: 'refused', status: 401 });
  expect(concealed(reader())).toContain(
    `/auth/sign-in?return_to=${encodeURIComponent(`/${getLocale()}/editions/${editionId}`)}`,
  );
  expect(retry(reader())).toBeUndefined();
  expect(paths).toHaveLength(beforeSignIn);

  for (const state of ['source', 'mismatch'] as const) {
    outcome = state;
    page = await load();
    concealed(reader());
    expect(retry(reader())).toBeDefined();
    if (state === 'mismatch') {
      expect(page).toEqual({ state: 'version-mismatch', status: 502 });
      const markup = renderToStaticMarkup(reader());
      expect(markup.indexOf(m.content_edition_purchases())).toBeLessThan(markup.indexOf(m.content_edition_retry()));
      retry(reader())!.props.onClick!();
      concealed(reader(true));
      await pending;
      expect(page.state).toBe('version-mismatch');
      concealed(reader());
    }
  }
  page = await loadContentEdition(createNativeEditionApi(), editionId, 'Bearer current-reader');
  expect(page).toEqual({ state: 'unavailable', status: 503, reason: 'native-pending' });
  concealed(reader());
  expect(retry(reader())).toBeDefined();
  page = { state: 'loading' };
  expect(retry(reader())).toBeUndefined();
  expect(renderToStaticMarkup(reader())).not.toContain('/orders');
});
