import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { fromPlainText, type DocumentSnapshot } from '@rezics/document';
import {
  nativeEditionApi,
  type EditionApi,
  type EditionMetadata,
  type EditionRevision,
} from '../src/content-editions/edition-api';
import {
  editionDocumentDigest,
  loadContentEdition,
  type ContentEditionState,
} from '../src/content-editions/edition-model';
import { ContentEditionReader } from '../src/content-editions/edition-view';
import { m } from '../src/paraglide/messages.js';

const id = '0192f3a0-6c1e-7b2a-9d4e-000000000001';
const subjectId = '0192f3a0-6c1e-7b2a-9d4e-000000000020';
const creatorId = '0192f3a0-6c1e-7b2a-9d4e-000000000090';
const revisionId = '0192f3a0-6c1e-7b2a-9d4e-000000000003';
const fixedText = 'These are the fixed purchased words, not today’s post.';
const body: DocumentSnapshot = {
  version: 'rezics-document-v1',
  profile: 'blocks',
  doc: {
    type: 'doc',
    content: [
      { type: 'paragraph', attrs: { id: 'fixed-p1' }, content: [{ type: 'text', text: fixedText }] },
      { type: 'image', attrs: { id: 'fixed-image', src: creatorId, alt: 'The fixed illustration' } },
    ],
  },
};
const html = (page: ContentEditionState, editionId = id) =>
  renderToStaticMarkup(createElement(ContentEditionReader, { editionId, page }));

async function fixture() {
  const metadata: EditionMetadata = {
    editionId: id,
    editionRevision: '2',
    state: 'published',
    targetSubjectId: subjectId,
    creatorAccountId: creatorId,
    revisionId,
    sha256: await editionDocumentDigest(body),
    licence: 'CC-BY-SA-4.0',
  };
  const revision: EditionRevision = {
    editionId: id,
    revisionId,
    sha256: metadata.sha256,
    licence: metadata.licence,
    body,
  };
  const calls: { path: string; authorization: string }[] = [];
  const api: EditionApi = {
    async readMetadata(editionId, authorization) {
      calls.push({ path: `/v1/contentEditions/${editionId}`, authorization });
      return { state: 'available', value: metadata };
    },
    async readRevision(editionId, authorization) {
      calls.push({ path: `/v1/contentEditions/${editionId}/revision`, authorization });
      return { state: 'available', value: revision };
    },
  };
  return { api, metadata, revision, calls };
}

test('owned fixed native edition route reads exact document version through protected API and shows honest unavailable refusal without alternate source or invented paid image URL', async () => {
  const { api, metadata, calls } = await fixture();
  const identityCalls: string[] = [];
  const ready = await loadContentEdition(api, id, 'Bearer actual-buyer', {
    subject: async (point) => {
      identityCalls.push(point);
      return { id: point, label: 'A readable subject' };
    },
    creator: async (point) => {
      identityCalls.push(point);
      return { id: point, name: 'Visible creator' };
    },
  });
  expect(ready.state).toBe('published');
  const rendered = html(ready);
  for (const text of [
    fixedText,
    metadata.licence,
    revisionId,
    metadata.sha256,
    'A readable subject',
    'Visible creator',
  ])
    expect(rendered).toContain(text);
  expect(rendered).toContain(`data-block-id="fixed-p1"`);
  expect(rendered).toContain(`/subjects/${subjectId}/`);
  expect(rendered).toContain(m.content_edition_image_unavailable());
  for (const forbidden of ['<img', '/media/', '/original', '<main', '<pre', '/posts/', '/accounts/', 'checkout'])
    expect(rendered).not.toContain(forbidden);
  expect(calls).toEqual([
    { path: `/v1/contentEditions/${id}`, authorization: 'Bearer actual-buyer' },
    { path: `/v1/contentEditions/${id}/revision`, authorization: 'Bearer actual-buyer' },
  ]);
  expect(identityCalls.sort()).toEqual([subjectId, creatorId].sort());

  const unknownIdentity = await loadContentEdition(api, id, 'Bearer actual-buyer', {
    subject: async () => ({ id: creatorId, label: 'Unrelated subject' }),
    creator: async () => {
      throw new Error('Identity unavailable');
    },
  });
  expect(unknownIdentity.state).toBe('published');
  expect(html(unknownIdentity)).toContain(fixedText);
  expect(html(unknownIdentity)).toContain(`>${m.content_edition_heading()}</h1>`);
  expect(html(unknownIdentity)).not.toContain('Unrelated subject');
  expect(html(unknownIdentity)).not.toContain('/subjects/');
  expect(html(ready, creatorId)).not.toContain(fixedText);

  const route = await Bun.file(new URL('../src/routes/editions/$id.tsx', import.meta.url)).text();
  expect(route).toContain("createFileRoute('/editions/$id')");
  expect(route).toContain('readContentEdition');
  expect(route).toContain('router.invalidate()');
  expect(route).toContain('gcTime: 0');
  expect(route).not.toContain('publicCache: true');
});

test('current denial, missing producer, withdrawal, malformed wire and mismatches discard all prior document facts; retry re-reads both exact sources', async () => {
  const { api, metadata, revision, calls } = await fixture();
  const concealed = (page: ContentEditionState) => {
    const rendered = html(page);
    for (const value of [
      fixedText,
      metadata.licence,
      revisionId,
      metadata.sha256,
      'data-slot="document-body"',
      '/media/',
      '/subjects/',
    ])
      expect(rendered).not.toContain(value);
    expect(page.state).not.toBe('published');
  };
  concealed(await loadContentEdition(api, id, null));
  expect(calls).toHaveLength(0);
  const pending = await loadContentEdition(nativeEditionApi, id, 'Bearer actual-buyer');
  expect(pending).toEqual({ state: 'unavailable', status: 503, reason: 'native-pending' });
  concealed(pending);
  expect(html(pending)).toContain(m.content_edition_unavailable());

  for (const value of [
    { ...metadata, editionId: creatorId },
    { ...metadata, extra: true },
    { ...metadata, state: 'draft' },
    { ...metadata, state: 'withdrawn' },
  ]) {
    const page = await loadContentEdition(
      { ...api, readMetadata: async () => ({ state: 'available', value }) as never },
      id,
      'Bearer actual-buyer',
    );
    concealed(page);
    expect(page.state).toBe(
      value.state === 'withdrawn' ? 'withdrawn' : value.state === 'draft' ? 'unavailable' : 'version-mismatch',
    );
  }
  expect(calls).toHaveLength(0); // No revision is fetched for an invalid or unpublished edition.

  for (const field of ['editionId', 'revisionId', 'sha256', 'licence'] as const) {
    const value = { ...revision, [field]: field === 'sha256' ? '0'.repeat(64) : 'different' };
    const page = await loadContentEdition(
      { ...api, readRevision: async () => ({ state: 'available', value }) },
      id,
      'Bearer actual-buyer',
    );
    expect(page.state).toBe('version-mismatch');
    concealed(page);
  }
  for (const value of [
    { ...revision, body: fromPlainText('A substituted current post') },
    { ...revision, extra: 'not in the closed schema' },
    { ...revision, body: { ...body, extra: true } },
  ]) {
    const page = await loadContentEdition(
      { ...api, readRevision: async () => ({ state: 'available', value }) as never },
      id,
      'Bearer actual-buyer',
    );
    expect(page.state).toBe('version-mismatch');
    concealed(page);
  }
  for (const stage of ['readMetadata', 'readRevision'] as const) {
    for (const status of [401, 403] as const) {
      const page = await loadContentEdition(
        { ...api, [stage]: async () => ({ state: 'refused', status }) },
        id,
        'Bearer actual-buyer',
      );
      expect(page).toEqual({ state: 'refused', status });
      expect(html(page)).toContain(m.content_edition_refused());
      concealed(page);
    }
    for (const failure of [
      async () => ({ state: 'unavailable', status: 404, reason: 'source' }) as const,
      async () => {
        throw new Error('Protected source disconnected');
      },
    ])
      concealed(await loadContentEdition({ ...api, [stage]: failure }, id, 'Bearer actual-buyer'));
  }
  calls.length = 0;
  concealed(
    await loadContentEdition(
      { ...api, readRevision: async () => ({ state: 'refused', status: 403 }) },
      id,
      'Bearer actual-buyer',
    ),
  );
  expect((await loadContentEdition(api, id, 'Bearer actual-buyer')).state).toBe('published');
  expect(calls.map((call) => call.path)).toEqual([
    `/v1/contentEditions/${id}`,
    `/v1/contentEditions/${id}`,
    `/v1/contentEditions/${id}/revision`,
  ]);
  concealed({ state: 'loading' });
});
