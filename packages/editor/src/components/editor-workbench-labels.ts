/** Interface copy is independent of the language of authored content. */
export const editorWorkbenchLabels = {
  find: 'Find and replace',
  findDescription: 'Search this document. Replacements share the document’s undo history.',
  searchFor: 'Find text',
  replaceWith: 'Replace with',
  caseSensitive: 'Match case',
  wholeWord: 'Whole words',
  nextMatch: 'Next match',
  previousMatch: 'Previous match',
  replaceCurrent: 'Replace match',
  replaceAll: 'Replace all',
  noMatches: 'No matches',
  matchCount: '{current} of {total} matches',
  tooManyMatches: 'Too many matches. Use a more specific search before replacing all.',
  closeFind: 'Close find and replace',
  commandPalette: 'Commands',
  commandSearch: 'Search available commands',
  noCommands: 'No matching commands',
  outline: 'Outline and statistics',
  outlineEmpty: 'Headings will appear here.',
  wordCount: '{count} words',
  characterCount: '{count} characters',
  readingTime: '{count} min read',
  editorSettings: 'Editor settings',
  settingsDescription: 'Adjust your writing experience without changing document content.',
  pinnedCommands: 'Pinned commands',
  close: 'Close',
};

export type EditorWorkbenchLabels = { readonly [K in keyof typeof editorWorkbenchLabels]: string };

export function editorLabel(template: string, values: Readonly<Record<string, string | number>>): string {
  return template.replace(/\{(\w+)\}/g, (placeholder, key: string) => String(values[key] ?? placeholder));
}
