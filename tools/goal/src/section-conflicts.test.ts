import { expect, test } from 'bun:test';
import { resolveInsertedSections } from './section-conflicts.ts';

const hunk = (ours: string, base: string, theirs: string) =>
  `<<<<<<< HEAD\n${ours}||||||| base\n${base}=======\n${theirs}>>>>>>> worker\n`;

test('sections both sides inserted at one place are kept, the checked-out side first', () => {
  const text = `# Module\n\nIntro.\n\n${hunk('## Avatars\n\nAvatar text.\n\n', '', '## Authored fields\n\nField text.\n\n')}## Later\n`;
  expect(resolveInsertedSections(text)).toBe(
    '# Module\n\nIntro.\n\n## Avatars\n\nAvatar text.\n\n## Authored fields\n\nField text.\n\n## Later\n',
  );
});

test('a heading after a paragraph gets its blank line; table rows continue the table', () => {
  expect(resolveInsertedSections(hunk('Text.\n', '', '## Next\n'))).toBe('Text.\n\n## Next\n');
  expect(resolveInsertedSections(`| a | b |\n| - | - |\n${hunk('| 1 | 2 |\n', '', '| 3 | 4 |\n')}`)).toBe(
    '| a | b |\n| - | - |\n| 1 | 2 |\n| 3 | 4 |\n',
  );
});

test('a hunk where both sides changed common text is left to a person', () => {
  expect(resolveInsertedSections(hunk('New wording.\n', 'Old wording.\n', 'Other wording.\n'))).toBeUndefined();
  expect(resolveInsertedSections('<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> worker\n')).toBeUndefined();
});

test('nested, unmatched or malformed conflict structure is left to a person', () => {
  expect(resolveInsertedSections(hunk('## Ours\n\n<<<<<<< nested\n', '', '## Theirs\n'))).toBeUndefined();
  expect(resolveInsertedSections(`${hunk('a\n', '', 'b\n')}>>>>>>> extra\n`)).toBeUndefined();
  expect(resolveInsertedSections(hunk('Title\n=======\n', '', '## Next\n'))).toBeUndefined();
});
