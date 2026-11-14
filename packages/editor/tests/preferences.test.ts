import { expect, test } from 'bun:test';
import {
  editorPreferenceDefaults,
  editorPreferencesEqual,
  editorShortcutIssue,
  normalizeEditorShortcut,
  mergeEditorPreferences,
  resolveEditorPreferences,
  validateEditorPreferences,
  validateEditorPreferencePatch,
} from '../src/preferences.ts';

test('preference equality ignores JSON object key order but retains ordered commands and sparse overrides', () => {
  const first = {
    lineSpacing: 1.8,
    textSize: 20,
    keyboardBindings: { bold: 'Mod-Shift-j', italic: '' },
    pinnedCommands: ['bold', 'italic'],
  };
  const reordered = {
    pinnedCommands: ['bold', 'italic'],
    keyboardBindings: { italic: '', bold: 'Mod-Shift-j' },
    textSize: 20,
    lineSpacing: 1.8,
  };
  expect(editorPreferencesEqual(first, reordered)).toBe(true);
  expect(editorPreferencesEqual(first, { ...reordered, pinnedCommands: ['italic', 'bold'] })).toBe(false);
  expect(editorPreferencesEqual({}, { textSize: 16 })).toBe(false);
});

test('private account, device and session layers resolve independently and reset exposes the lower layer', () => {
  const account = { textSize: 18, typeface: 'serif' as const, keyboardBindings: { bold: 'Mod-Shift-j' } };
  const device = { textSize: 20, spellcheck: false };
  const session = { textSize: 22 };
  expect(resolveEditorPreferences(account, device, session)).toMatchObject({
    textSize: 22,
    typeface: 'serif',
    spellcheck: false,
  });
  expect(resolveEditorPreferences(account, device, mergeEditorPreferences(session, null)!)).toMatchObject({
    textSize: 20,
  });
  expect(account.textSize).toBe(18);
  const resolved = resolveEditorPreferences(account);
  resolved.pinnedCommands.push('bold');
  expect(resolveEditorPreferences().pinnedCommands).toEqual([]);
  expect(editorPreferenceDefaults.textSize).toBe(16);
});

test('merge patch removes one field or the editor namespace and replaces ordered arrays', () => {
  const original = { textSize: 20, lineSpacing: 2, pinnedCommands: ['bold', 'italic'] as const };
  const stored = {
    ...original,
    pinnedCommands: [...original.pinnedCommands],
    keyboardBindings: { bold: 'Mod-Shift-j', italic: '' },
  };
  expect(
    mergeEditorPreferences(stored, { textSize: null, pinnedCommands: ['italic'], keyboardBindings: { bold: null } }),
  ).toEqual({
    lineSpacing: 2,
    pinnedCommands: ['italic'],
    keyboardBindings: { italic: '' },
  });
  expect(mergeEditorPreferences(stored, null)).toEqual({});
  expect(stored.textSize).toBe(20);
});

test('bounded closed values and admitted command vocabulary reject malformed preferences', () => {
  for (const invalid of [
    { unknown: true },
    { textSize: 11 },
    { textSize: 16.5 },
    { lineSpacing: 3 },
    { customFont: 'x'.repeat(129) },
    { customFont: 'serif; color:red' },
    { writingWidth: 121 },
    { pinnedCommands: ['bold', 'bold'] },
    { hiddenCommands: ['unsupported'] },
    { keyboardBindings: { unknown: 'Mod-j' } },
  ]) {
    expect(validateEditorPreferences(invalid)).toBe(false);
  }
  expect(validateEditorPreferencePatch({ textSize: null, keyboardBindings: { bold: null } })).toBe(true);
  expect(validateEditorPreferences({ textSize: null })).toBe(false);
});

test('shortcuts preserve native input and detect conflicts with defaults or portable primary modifiers', () => {
  expect(normalizeEditorShortcut('shift-mod-J')).toBe('Mod-Shift-j');
  expect(validateEditorPreferences({ keyboardBindings: { bold: 'shift-mod-J' } })).toBe(false);
  expect(validateEditorPreferencePatch({ keyboardBindings: { bold: 'shift-mod-J' } })).toBe(false);
  expect(editorShortcutIssue('bold', 'Mod-v')?.reason).toBe('reserved');
  expect(editorShortcutIssue('bold', 'Ctrl-Space')?.reason).toBe('reserved');
  expect(editorShortcutIssue('bold', 'b')?.reason).toBe('invalid');
  expect(editorShortcutIssue('italic', 'Ctrl-b')?.command).toBe('bold');
  expect(validateEditorPreferences({ keyboardBindings: { italic: 'Mod-b' } })).toBe(false);
  expect(validateEditorPreferences({ keyboardBindings: { bold: '', italic: 'Mod-b' } })).toBe(true);
  expect(
    mergeEditorPreferences({ keyboardBindings: { bold: '', italic: 'Mod-b' } }, { keyboardBindings: { bold: null } }),
  ).toBeNull();
});
