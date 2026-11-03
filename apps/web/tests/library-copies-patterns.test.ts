import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { routes, setCopiesStoryMode } from '../src/kernel/fake/copies-page-stories';
import recording from '../src/kernel/recorded/library-copies.json' with { type: 'json' };

const storiesPath = join(import.meta.dir, '../src/stories/library-copies-patterns.stories.tsx');
const recordedEdition = recording.copies[0]!.subject.label;

function storyBlock(source: string, name: string) {
  const start = source.indexOf(`export const ${name}`);
  expect(start).toBeGreaterThanOrEqual(0);
  const next = source.indexOf('\nexport const ', start + 1);
  return source.slice(start, next === -1 ? undefined : next);
}

test('Copies form review frames AppShell, exposes create refusal, and keeps the constructed 422', async () => {
  const source = await Bun.file(storiesPath).text();
  expect(source).toContain('<AppShell>');
  expect(source).toContain('<PatternStory visitor="Signed In" path={path}>');
  expect(source).toContain("phone390: { name: 'Phone 390', styles: { width: '390px', height: '844px' }");
  expect(source).toContain("desktop1280: { name: 'Desktop 1280', styles: { width: '1280px', height: '900px' }");
  expect(source).not.toContain('phone: { name: \'Phone\'');
  expect(source).toContain('m.library_copy_edition()');
  expect(source).not.toContain('/Edition|版本/');
  expect(storyBlock(source, 'CreateRefused')).not.toContain('!dev');
  expect(storyBlock(source, 'CreateRefused')).toContain('recordedEdition');
  expect(storyBlock(source, 'CreateRefused')).toContain('m.library_copy_failure()');
  expect(storyBlock(source, 'EditFormOpen')).toContain("sheet ? 'button' : 'menuitem'");
  expect(storyBlock(source, 'StaleDelete')).toContain('m.library_copy_edit()');
  expect(storyBlock(source, 'StaleDelete')).not.toContain('getAllByRole');
  for (const name of [
    'AddFormOpen',
    'EditFormOpen',
    'CreateRefused',
    'MultipleCopyTypes',
    'HistoricalMeaningUnavailable',
    'StaleDelete',
  ])
    expect(source).toContain(`export const ${name}`);

  expect(recordedEdition).toBe('The Little Prince');
  setCopiesStoryMode('refusal');
  const created = routes.find((route) => route.method === 'POST' && route.path === '/v1/copies')?.story?.({
    request: new Request('http://kernel.local/v1/copies', { method: 'POST' }),
    recordings: {},
    match: null,
  });
  expect(created).toEqual({
    status: 422,
    type: 'https://rezics.com/problems/invalid_request',
    code: 'invalid_request',
  });
});
