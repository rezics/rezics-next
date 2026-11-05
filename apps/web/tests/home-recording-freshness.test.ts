import { expect, test } from 'bun:test';
import { profileDigest, resolveTemplate, type PresentationProfile } from '@rezics/composition';
import platformJson from '@rezics/composition/profiles/platform.json';
import { recordingSnapshot, selectsRecording } from '../scripts/record.ts';

const platform = platformJson as PresentationProfile;
const document = resolveTemplate(platform, { route: '/' }).document;
const locales = ['en', 'de', 'es', 'fr', 'ja', 'ko', 'zh-Hans', 'zh-Hant'];
const names = locales.map((locale) => (locale === 'en' ? 'home-page' : `home-page-${locale}`));

test('the actual writer refreshes every Home document including localized fields and removed nodes', () => {
  for (const name of names) {
    const current = { profile: profileDigest(platform), template: { scope: 'route', key: '/' }, document, reads: {} };
    const previous = structuredClone(current);
    previous.document.content.splice(1, 0, { type: 'SearchBox', props: { id: 'search' } });
    const heading = previous.document.content[0]!.props as Record<string, unknown>;
    heading.text = { en: 'Old heading' };
    const result = recordingSnapshot(name, current, previous) as typeof current;
    expect(result).toEqual(current);
    expect(result.document.content.map((node) => node.type)).toEqual([
      'Heading',
      'Slot',
      'TypeList',
      'TypeList',
      'TypeList',
      'TypeList',
    ]);
    expect(result.document.content[1]).toEqual({
      type: 'Slot',
      props: { id: 'personal', name: 'personal', children: [] },
    });
    expect(result.document).toEqual(document);
  }
});

test('the actual selector refreshes all Home locale names while preserving other exact selections', () => {
  for (const name of names)
    expect(selectsRecording(name, ['definitions-active', 'definitions-release', 'home-page'])).toBe(true);
  expect(selectsRecording('subject-page', ['home-page'])).toBe(false);
  expect(selectsRecording('home-page-xx', ['home-page'])).toBe(false);
  expect(selectsRecording('home-page', ['home-page-ja'])).toBe(false);
  expect(selectsRecording('home-page-ja', ['home-page-ja'])).toBe(true);
  expect(selectsRecording('subject-page-zh-Hans', ['subject-page'])).toBe(false);
  expect(selectsRecording('subject-page', ['subject-page'])).toBe(true);
  expect(selectsRecording('anything', [])).toBe(true);
});

test('non-Home recordings retain stable story strings, array shape and UUID keys', () => {
  const oldId = '11111111-1111-4111-8111-111111111111';
  const newId = '22222222-2222-4222-8222-222222222222';
  const previous = {
    id: oldId,
    title: 'Story',
    rows: [{ id: oldId, label: 'Old' }],
    reads: { [oldId]: { title: 'Old read' } },
  };
  const current = {
    id: newId,
    title: 'Live',
    rows: [
      { id: newId, label: 'New' },
      { id: newId, label: 'Extra' },
    ],
    reads: { [newId]: { title: 'Live read', added: true } },
    added: true,
  };
  expect(recordingSnapshot('subject-page', current, previous)).toEqual({
    ...previous,
    rows: [{ id: oldId, label: 'New' }],
    reads: { [oldId]: { title: 'Old read', added: true } },
    added: true,
  });
  // Similar names do not opt unrelated snapshots into Home freshness.
  expect(recordingSnapshot('home-page-xx', current, previous)).toEqual(
    recordingSnapshot('subject-page', current, previous),
  );
  for (const name of ['definitions-active', 'definitions-release'])
    expect(recordingSnapshot(name, current, previous)).toEqual(current);
});

for (const [index, name] of names.entries()) {
  test(`normally generated ${name} matches the current Home template and locale`, async () => {
    const recorded = await Bun.file(new URL(`../src/kernel/recorded/${name}.json`, import.meta.url)).json();
    expect(recorded.status).toBe(200);
    expect(recorded.profile).toBe(profileDigest(platform));
    expect(recorded.template).toEqual({ scope: 'route', key: '/' });
    expect(recorded.document).toEqual(document);
    expect(recorded.document.content.map((node: { type: string }) => node.type)).not.toContain('SearchBox');
    for (const read of Object.values(recorded.reads) as { body: { subjects?: { label?: { language: string } }[] } }[])
      for (const subject of read.body.subjects ?? [])
        if (subject.label) expect(subject.label.language).toBe(locales[index]);
  });
}
