import { expect, test } from 'bun:test';

const read = (path: string) => Bun.file(new URL(path, import.meta.url)).text();

function story(source: string, name: string) {
  return source.split(`export const ${name}: Story = `)[1]?.split(/export const /)[0];
}

test('Character LongWorkReference and Game Proposed leave phone390 and desktop1280 as shared globals', async () => {
  const character = await read('../src/stories/catalogue-character-profile.stories.tsx');
  const game = await read('../src/stories/catalogue-game-profile.stories.tsx');
  const preview = await read('../.storybook/preview.tsx');
  const longWork = story(character, 'LongWorkReference');
  const proposed = story(game, 'Proposed');
  expect(longWork).toContain("args: { existing: true, work: true, workLabel: 'long' }");
  expect(longWork).toContain('[data-slot="fictional-work-reference"]');
  expect(longWork).not.toMatch(/globals:\s*\{\s*viewport/);
  expect(proposed).toContain('args: { correction: true }');
  expect(proposed).toContain('m.correction_proposed()');
  expect(proposed).toContain('largeTouchTargets');
  expect(proposed).not.toMatch(/globals:\s*\{\s*viewport/);
  expect(story(character, 'UncertainRetry')).toContain(
    "globals: { viewport: { value: 'phone390', isRotated: false } }",
  );
  expect(story(character, 'Created')).toContain('play:');
  expect(story(game, 'Created')).toContain('play:');
  for (const source of [character, game, preview]) {
    expect(source).toContain("phone390: { name: 'Phone 390', styles: { width: '390px'");
    expect(source).toContain("desktop1280: { name: 'Desktop 1280', styles: { width: '1280px'");
  }
});
