import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  FILE_VISIT_COMPONENTS,
  fileProfileReleased,
  fileVisitBound,
  isFileOrGroupType,
  rawIdentifier,
} from '../src/features/catalogue/catalogue-file-profile/model';
import { CatalogueFileProfileEntry } from '../src/features/catalogue/catalogue-file-profile/entry';
import { RELEASE_ASSOCIATION_LIMIT } from '../src/features/catalogue/release-fidelity/model';
import { catalogueEntries } from '../src/features/catalogue/catalogue-entry';
import {
  catalogueEpisode,
  catalogueFile,
  catalogueFileProfileFixture,
  catalogueFileTwo,
  catalogueGroup,
  catalogueRelease,
} from '../src/kernel/fake/catalogue-file-profile';
import { m } from '../src/paraglide/messages.js';

test('a catalogue file keeps hash identity, group credits and an unknown codec value', async () => {
  const fixture = catalogueFileProfileFixture('unknown-codec');
  const page = await fixture.read();
  if (!page.ok) throw new Error('Expected a file profile');
  expect(page.profile).toBe('file');
  expect(isFileOrGroupType(page.release, 'schema:MediaObject')).toBe(true);
  expect(fileProfileReleased(page.release)).toBe(true);
  const hash = page.facts.technical?.find((fact) => fact.property === 'schema:sha256')?.statements[0];
  expect(rawIdentifier(hash!)?.raw).toBe('abc123def456');
  expect(page.facts.technical?.some((fact) => fact.statements[0]?.value.content === 'av1')).toBe(true);
  expect(page.release.properties['schema:encodingFormat']?.value).toMatchObject({ enum: ['h264', 'hevc'] });
  expect(page.facts.group?.some((fact) => fact.property === 'rezics:releaseGroup')).toBe(true);
  expect(page.facts.credits?.some((fact) => fact.property === 'schema:author')).toBe(true);
  expect(page.public.subject.type).not.toBe('rezics:AnimeRelease');
});

test('two files for one episode stay distinct from the release, and a concealed episode stays concealed', async () => {
  const fixture = catalogueFileProfileFixture('ready');
  const page = await fixture.read();
  if (!page.ok || !page.stream) throw new Error('Expected file streams');
  const episode = page.streams.find((stream) => stream.kind === 'episode');
  const group = page.streams.find((stream) => stream.kind === 'group');
  const siblings = page.streams.find((stream) => stream.kind === 'file');
  expect(episode).toBeDefined();
  expect(group).toBeDefined();
  expect(siblings).toBeDefined();
  const files = await fixture.read(siblings!.key);
  if (!files.ok) throw new Error('Expected sibling files for the same episode');
  const identities = files.rows.flatMap((row) => Object.keys(row.related));
  expect(identities).toContain(catalogueFileTwo);
  expect(identities).not.toContain(catalogueRelease);
  const concealed = await catalogueFileProfileFixture('concealed-episode').read();
  if (!concealed.ok) throw new Error('Expected concealed episode');
  expect(concealed.related ? concealed.public.related[catalogueEpisode]?.labels : {}).toEqual({});
  const unreleased = await catalogueFileProfileFixture('unreleased').read();
  expect(unreleased.ok && unreleased.profile).toBe('unreleased');
  expect(unreleased.ok && unreleased.streams).toEqual([]);
  expect(unreleased.ok && unreleased.visit.calls).toBe(2);
});

test('precise file correction uses the selected assertion; a stale read does not rewrite it', async () => {
  const fixture = catalogueFileProfileFixture('ready');
  const page = await fixture.read();
  if (!page.ok) throw new Error('Expected current file');
  const key = '00000000-0000-4000-8000-00000000a280';
  const original = page.public.subject.statements['schema:sha256']![0]!;
  const result = await fixture.propose({
    id: catalogueFile,
    key,
    statement: {
      property: { id: 'schema:sha256' },
      value: { type: 'value', content: 'ffffffffffffffff' },
      qualifiers: [],
      references: [],
      rank: 'normal',
    },
  });
  expect(result).toMatchObject({ ok: true });
  expect(page.public.subject.statements['schema:sha256']![0]).toEqual(original);
  const post = fixture.calls.find((call) => call.method === 'POST')!;
  expect(post.path).toBe(`/v1/subjects/${catalogueFile}/candidates`);
  expect(fixture.receipts.get(key)).toMatchObject({ candidate: '00000000-0000-4000-8000-00000000a299' });
  fixture.setScenario('stale');
  expect(await fixture.read()).toEqual({ ok: false, reason: 'stale' });
});

test('file visit work stays page-bounded at 32, 256 and 2048 related files', async () => {
  const bound = fileVisitBound();
  expect(FILE_VISIT_COMPONENTS).toBe(4);
  const firstPages: number[] = [];
  for (const scale of [32, 256, 2048]) {
    const fixture = catalogueFileProfileFixture('ready', 'en', scale);
    const first = await fixture.read('forward:schema:encodesCreativeWork');
    if (!first.ok) throw new Error(`Expected first file page at ${scale}`);
    expect(first.rows).toHaveLength(RELEASE_ASSOCIATION_LIMIT);
    expect(first.visit.calls).toBe(3);
    expect(first.visit.rows).toBeLessThanOrEqual(bound.rows);
    expect(first.visit.components.find((item) => item.id === 'association')?.rows).toBe(RELEASE_ASSOCIATION_LIMIT);
    firstPages.push(first.rows.length);
    const deep = await fixture.read('forward:schema:encodesCreativeWork', String(scale - RELEASE_ASSOCIATION_LIMIT));
    expect(deep.ok && deep.rows.length).toBeLessThanOrEqual(RELEASE_ASSOCIATION_LIMIT);
    const selected = await fixture.read('forward:schema:encodesCreativeWork', undefined, catalogueEpisode);
    expect(selected.ok && selected.detail?.subject.id).toBe(catalogueEpisode);
    expect(selected.ok && selected.visit.calls).toBe(4);
    expect(fixture.calls.filter((call) => call.path === `/v1/subjects/${catalogueEpisode}`)).toHaveLength(1);
  }
  expect(new Set(firstPages)).toEqual(new Set([RELEASE_ASSOCIATION_LIMIT]));
});

test('file companion entry is discoverable and eight locales keep the possession disclaimer', () => {
  const html = renderToStaticMarkup(
    createElement(CatalogueFileProfileEntry, {
      id: catalogueFile,
      type: 'schema:MediaObject',
      label: 'Episode 1 file A',
      locale: 'en',
    }),
  );
  expect(html).toContain('/file');
  expect(catalogueEntries.catalogueFile({ id: catalogueFile, type: 'bf:Instance', locale: 'en' })).toBeUndefined();
  expect(catalogueGroup).toContain('a204');
  expect(catalogueFileTwo).toContain('a202');
  for (const locale of ['en', 'zh-Hans', 'zh-Hant', 'ja', 'ko', 'de', 'fr', 'es'] as const) {
    const text = m.catalogue_file_disclaimer({}, { locale });
    expect(text.length).toBeGreaterThan(20);
  }
});
