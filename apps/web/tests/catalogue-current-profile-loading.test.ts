import { expect, test } from 'bun:test';

const story = (path: string) => Bun.file(new URL(path, import.meta.url)).text();
const exported = (source: string, name: string) =>
  source.match(new RegExp(`export const ${name}\\b[\\s\\S]*?(?=\\nexport const|$)`))?.[0] ?? '';

test('Catalogue profile Loading stays creation; current-profile loading exports select existing subjects without creation controls', async () => {
  const [character, screen, people, addon] = await Promise.all([
    story('../src/stories/catalogue-character-profile.stories.tsx'),
    story('../src/stories/catalogue-screen-profile.stories.tsx'),
    story('../src/stories/catalogue-people-profile.stories.tsx'),
    story('../src/stories/catalogue-addon-profile.stories.tsx'),
  ]);

  expect(exported(character, 'Loading').trim()).toBe(
    "export const Loading: Story = { args: { scenario: 'loading' } };",
  );
  expect(exported(character, 'CurrentLoading').trim()).toBe(
    "export const CurrentLoading: Story = { args: { existing: true, scenario: 'loading' } };",
  );
  expect(exported(character, 'Created')).toContain('m.character_correct()');

  expect(exported(screen, 'Loading').trim()).toBe("export const Loading: Story = { args: { scenario: 'loading' } };");
  expect(exported(screen, 'CorrectionLoading').trim()).toBe(
    "export const CorrectionLoading: Story = { args: { correction: true, scenario: 'loading' } };",
  );
  expect(exported(screen, 'Created')).toContain('m.catalogue_create_created()');

  expect(exported(people, 'Loading').trim()).toBe("export const Loading: Story = { args: { scenario: 'loading' } };");
  expect(exported(people, 'PersonLoading').trim()).toBe(
    "export const PersonLoading: Story = { args: { mode: 'person', scenario: 'loading' } };",
  );
  expect(exported(people, 'OrganizationLoading').trim()).toBe(
    "export const OrganizationLoading: Story = { args: { mode: 'organization', scenario: 'loading' } };",
  );
  expect(exported(people, 'Create')).toContain('m.catalogue_create_submit()');

  expect(exported(addon, 'Loading').trim()).toBe("export const Loading: Story = { args: { scenario: 'loading' } };");
  expect(exported(addon, 'CurrentLoading').trim()).toBe(
    "export const CurrentLoading: Story = { args: { existing: true, scenario: 'loading' } };",
  );
  expect(exported(addon, 'Created')).toContain('m.addon_correct()');
});
