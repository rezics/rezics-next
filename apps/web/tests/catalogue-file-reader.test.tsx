import { expect, mock, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { planReads, platformRegistry } from '@rezics/composition';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as start from '../.storybook/react-start';
import type { SubjectRead } from '@rezics/client';
import type { Release } from '@rezics/definitions';
import { catalogueFileProfileFixture, catalogueFile, catalogueEpisode } from '../src/kernel/fake/catalogue-file-profile';
import type { SubjectPageData } from '../src/features/pages/subject';
import { subjectPageMessages } from '../src/features/pages/route-support';
import { catalogueFileDestinationHref, catalogueFileSourceReturnHref } from '../src/features/catalogue/catalogue-file-reader/navigation';

mock.module('@tanstack/react-start', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));
const [{ SubjectPage }, { catalogueFileReaderDefinitionsKey }] = await Promise.all([
  import('../src/features/pages/subject'),
  import('../src/features/catalogue/catalogue-file-reader/reader'),
]);

function ordinaryPage(publicRead: SubjectRead, relationRows: readonly unknown[] = []): SubjectPageData {
  const document: SubjectPageData['document'] = {
    root: { props: {} },
    content: [
      {
        type: 'Slot',
        props: {
          id: 'header',
          name: 'header',
          children: [
            { type: 'SubjectHeader', props: { id: 'subject-header' } },
            { type: 'Slot', props: { id: 'actions', name: 'actions', children: [] } },
          ],
        },
      },
      { type: 'Statements', props: { id: 'file-facts', properties: ['schema:name', 'schema:sha256'] } },
      { type: 'RelationGroups', props: { id: 'file-relations', property: 'schema:encodesCreativeWork', limit: 20 } },
    ],
  };
  const page: SubjectPageData = {
    subject: publicRead.subject.id,
    profile: 'catalogue-file-reader-test',
    template: { scope: 'base', key: 'rezics:CatalogueFile' },
    document,
    reads: {},
  };
  const plan = planReads(platformRegistry, document, {
    subject: page.subject,
    account: null,
  });
  for (const [key, read] of Object.entries(plan.reads)) {
    if (read.kind === 'subject') page.reads[key] = { status: 200, body: publicRead };
    else if (read.kind === 'relations' && read.property === 'schema:encodesCreativeWork')
      page.reads[key] = { status: 200, body: { relations: relationRows, next: null } };
  }
  return page;
}

function renderSubject(page: SubjectPageData, read: SubjectRead, release: Release, digest: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(catalogueFileReaderDefinitionsKey(read, page, 'en'), { ok: true, release, digest });
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(SubjectPage, {
        page,
        locale: 'en',
        messages: subjectPageMessages(),
        renderJsonLd: false,
      }),
    ),
  );
}

test('ordinary Subject separates file facts from its directed episode relation and returns to its reader anchor', async () => {
  const result = await catalogueFileProfileFixture('ready').read('forward:schema:encodesCreativeWork');
  if (!result.ok || !result.stream) throw new Error('Expected the admitted file read');
  const row = result.rows.find((item) => item.summary?.id === catalogueEpisode);
  if (!row?.statement || !row.summary) throw new Error('Expected the disclosed episode relation');
  const relation = {
    property: result.stream.property,
    statement: row.statement,
    summary: row.summary,
    related: row.related,
  };
  const page = ordinaryPage(result.public, [relation]);
  const html = renderSubject(page, result.public, result.release, result.digest);
  const destination = catalogueFileDestinationHref(
    `/en/subjects/${catalogueEpisode}/episode-1`,
    catalogueFile,
    'en',
  );
  expect(html).toContain('data-slot="catalogue-file-reader-technical"');
  expect(html).toContain('data-slot="catalogue-file-reader-associations"');
  expect(html).toContain('data-direction="forward"');
  expect(html).toContain(`href="${destination}"`);
  expect(catalogueFileSourceReturnHref(catalogueFile, 'en')).toContain('#catalogue-file-reader');
  expect(html).toContain('not proof of possession');
  expect(html).not.toContain('data-slot="catalogue-file-reader-ownership"');
});

test('retired relations cannot add a destination return, and unsupported file types keep ordinary facts', async () => {
  const current = await catalogueFileProfileFixture('ready').read('forward:schema:encodesCreativeWork');
  if (!current.ok || !current.stream || !current.rows[0]?.statement) throw new Error('Expected the current file read');
  const retiredStatement = {
    ...current.rows[0].statement,
    rezics: { ...current.rows[0].statement.rezics, release: 'sha256:retired' },
  };
  const retiredRow = { ...current.rows[0], statement: retiredStatement, property: current.stream.property };
  const retiredPage = ordinaryPage(current.public, [retiredRow]);
  const retiredHtml = renderSubject(retiredPage, current.public, current.release, current.digest);
  expect(retiredHtml).not.toContain(`/subjects/${catalogueEpisode}/episode-1?fileSource=`);

  const missing = await catalogueFileProfileFixture('unreleased').read();
  if (!missing.ok) throw new Error('Expected generic facts without file definitions');
  const unsupportedRead = structuredClone(missing.public);
  unsupportedRead.subject.type = 'schema:MediaObject';
  const source = current.public.subject.statements['schema:sha256']?.[0];
  if (!source) throw new Error('Expected a generic fact example');
  unsupportedRead.subject.statements['schema:name'] = [{
    ...source,
    id: '00000000-0000-4000-8000-00000000a219',
    property: { id: 'schema:name', data_type: 'string' },
    value: { type: 'value', content: 'Generic file title' },
    rezics: { ...source.rezics, release: missing.digest },
  }];
  const unsupportedPage = ordinaryPage(unsupportedRead);
  const unsupportedHtml = renderSubject(unsupportedPage, unsupportedRead, missing.release, missing.digest);
  expect(unsupportedHtml).toContain('not admitted as a catalogue file or release group');
  expect(unsupportedHtml).toContain('Generic file title');
  expect(unsupportedHtml).not.toContain('/file');
});

test('return destinations stay in the same locale and accept only a subject path', () => {
  expect(catalogueFileDestinationHref(`/en/subjects/${catalogueEpisode}/episode-1`, catalogueFile, 'en')).toContain(
    `fileSource=${catalogueFile}#catalogue-file-reader`,
  );
  expect(catalogueFileDestinationHref(`/ja/subjects/${catalogueEpisode}/episode-1`, catalogueFile, 'en')).toBeUndefined();
  expect(catalogueFileDestinationHref('https://example.test/en/subjects/episode', catalogueFile, 'en')).toBeUndefined();
});
