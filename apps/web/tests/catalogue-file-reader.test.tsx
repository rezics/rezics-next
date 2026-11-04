import { expect, mock, test } from 'bun:test';
import { planReads, platformRegistry } from '@rezics/composition';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as start from '../.storybook/react-start';
import type { SubjectRead } from '@rezics/client';
import type { Release } from '@rezics/definitions';
import {
  catalogueFileProfileFixture,
  catalogueFile,
  catalogueEpisode,
} from '../src/kernel/fake/catalogue-file-profile';
import type { SubjectPageData } from '../src/features/pages/subject';
import { subjectPageMessages } from '../src/features/pages/route-support';
import {
  catalogueFileDestinationHref,
  catalogueFileSourceReturnHref,
} from '../src/features/catalogue/catalogue-file-reader/navigation';

mock.module('@tanstack/react-start', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));
const { SubjectPage } = await import('../src/features/pages/subject');

function ordinaryPage(publicRead: SubjectRead): SubjectPageData {
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
      { type: 'Statements', props: { id: 'file-facts', properties: ['schema:name', 'wdt:P4092'] } },
      { type: 'RelationGroups', props: { id: 'file-relations', property: 'schema:encodesCreativeWork', limit: 20 } },
    ],
  };
  const page: SubjectPageData = {
    subject: publicRead.subject.id,
    profile: 'catalogue-file-reader-test',
    template: { scope: 'base', key: 'schema:MediaObject' },
    document,
    reads: {},
  };
  const plan = planReads(platformRegistry, document, {
    subject: page.subject,
    account: null,
  });
  for (const [key, read] of Object.entries(plan.reads)) {
    if (read.kind === 'subject') page.reads[key] = { status: 200, body: publicRead };
    else if (read.kind === 'relations') page.reads[key] = { status: 200, body: { relations: [], next: null } };
    else if (read.kind === 'links') page.reads[key] = { status: 200, body: { links: [], next: null } };
  }
  return page;
}

function renderSubject(
  page: SubjectPageData,
  read: SubjectRead,
  release: Release,
  digest: string,
  fileSource?: string,
  statementPropose: 'allowed' | 'denied' | 'unavailable' = 'allowed',
) {
  const supported = !!release.types[read.subject.type];
  page.catalogue = {
    state: supported ? 'released' : 'unsupported',
    type: read.subject.type,
    ...(supported ? { digest, definitions: { types: release.types, properties: release.properties } } : {}),
  };
  page.viewer = {
    state: 'account',
    account: '019a1b2c-3d4e-7f00-8a00-ed170e000195',
    context: read.subject.context,
    actions: { statementPropose },
  };
  return renderToStaticMarkup(
    createElement(SubjectPage, {
      page,
      locale: 'en',
      messages: subjectPageMessages(),
      fileSource,
      renderJsonLd: false,
    }),
  );
}

test('ordinary Subject separates file facts from its directed episode relation and returns to its reader anchor', async () => {
  const result = await catalogueFileProfileFixture('ready').read('forward:schema:encodesCreativeWork');
  if (!result.ok || !result.stream) throw new Error('Expected the admitted file read');
  const page = ordinaryPage(result.public);
  const html = renderSubject(page, result.public, result.release, result.digest);
  const destination = catalogueFileDestinationHref(`/en/subjects/${catalogueEpisode}/episode-1`, catalogueFile, 'en');
  expect(html).toContain('data-slot="catalogue-file-reader-technical"');
  expect(html).toContain('data-slot="catalogue-file-reader-associations"');
  expect(html).toContain('data-direction="forward"');
  expect(html).toContain(`href="${destination}"`);
  expect(catalogueFileSourceReturnHref(catalogueFile, 'en')).toContain('#catalogue-file-reader');
  expect(html).toContain('not proof of possession');
  expect(html).not.toContain('data-slot="catalogue-file-reader-ownership"');
});

test('retired associations cannot add a destination return, and unsupported file types keep ordinary facts', async () => {
  const current = await catalogueFileProfileFixture('ready').read('forward:schema:encodesCreativeWork');
  if (!current.ok) throw new Error('Expected the current file read');
  const retiredRead = structuredClone(current.public);
  const assertion = retiredRead.subject.statements['schema:encodesCreativeWork']?.[0];
  if (!assertion) throw new Error('Expected the current file association');
  retiredRead.subject.statements['schema:encodesCreativeWork'] = [
    {
      ...assertion,
      rezics: { ...assertion.rezics, release: 'sha256:retired' },
    },
  ];
  const retiredHtml = renderSubject(ordinaryPage(retiredRead), retiredRead, current.release, current.digest);
  expect(retiredHtml).not.toContain(`/subjects/${catalogueEpisode}/episode-1?fileSource=`);

  const missing = await catalogueFileProfileFixture('unreleased').read();
  if (!missing.ok) throw new Error('Expected generic facts without file definitions');
  const unsupportedRead = structuredClone(missing.public);
  unsupportedRead.subject.type = 'wd:Q82753';
  const source = current.public.subject.statements['wdt:P4092']?.[0];
  if (!source) throw new Error('Expected a generic fact example');
  unsupportedRead.subject.statements['schema:name'] = [
    {
      ...source,
      id: '00000000-0000-4000-8000-00000000a219',
      property: { id: 'schema:name', data_type: 'string' },
      value: { type: 'value', content: 'Generic file title' },
      rezics: { ...source.rezics, release: missing.digest },
    },
  ];
  const unsupportedPage = ordinaryPage(unsupportedRead);
  const unsupportedHtml = renderSubject(
    unsupportedPage,
    unsupportedRead,
    missing.release,
    missing.digest,
    unsupportedRead.subject.id,
  );
  expect(unsupportedHtml).toContain(
    'Current definitions do not admit this subject as a catalogue file or release group.',
  );
  expect(unsupportedHtml).toContain('Generic file title');
  expect(unsupportedHtml).not.toMatch(/href="\/en\/subjects\/[^\"]+\/file(?:\?|\")/);
});

test('native page action decisions keep denied and unavailable correction controls closed', async () => {
  const result = await catalogueFileProfileFixture('ready').read();
  if (!result.ok) throw new Error('Expected the current recorded catalogue definitions');
  const denied = renderSubject(
    ordinaryPage(result.public),
    result.public,
    result.release,
    result.digest,
    undefined,
    'denied',
  );
  const unavailable = renderSubject(
    ordinaryPage(result.public),
    result.public,
    result.release,
    result.digest,
    undefined,
    'unavailable',
  );
  expect(denied).not.toContain('data-slot="catalogue-file-reader-correction"');
  expect(unavailable).not.toContain('data-slot="catalogue-file-reader-correction"');
  expect(denied).toContain('Episode 1 file A');
  expect(unavailable).toContain('Episode 1 file A');
});

test('return destinations stay in the same locale and accept only a subject path', () => {
  expect(catalogueFileDestinationHref(`/en/subjects/${catalogueEpisode}/episode-1`, catalogueFile, 'en')).toContain(
    `fileSource=${catalogueFile}#catalogue-file-reader`,
  );
  expect(
    catalogueFileDestinationHref(`/ja/subjects/${catalogueEpisode}/episode-1`, catalogueFile, 'en'),
  ).toBeUndefined();
  expect(catalogueFileDestinationHref('https://example.test/en/subjects/episode', catalogueFile, 'en')).toBeUndefined();
});
