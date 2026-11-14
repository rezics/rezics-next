import type { Editor } from '@tiptap/core';
import type { ResolvedEditorPreferences } from '../preferences.ts';

const preferences = new WeakMap<Editor, ResolvedEditorPreferences>();

/** Presentation changes invalidate command selectors without touching document bytes or history. */
export function setEditorCommandPreferences(editor: Editor, value: ResolvedEditorPreferences): void {
  preferences.set(editor, value);
  if (!editor.isDestroyed) editor.view.dispatch(editor.state.tr.setMeta('editorCommandPreferences', true));
}

export function orderedEditorCommands<T extends { id: string }>(
  commands: readonly T[],
  value: Pick<ResolvedEditorPreferences, 'hiddenCommands' | 'pinnedCommands' | 'commandOrder'>,
): T[] {
  const hidden = new Set<string>(value.hiddenCommands);
  const order = new Map<string, number>(
    [...new Set([...value.pinnedCommands, ...value.commandOrder])].map((id, index) => [id, index]),
  );
  return commands
    .filter((command) => !hidden.has(command.id))
    .sort((a, b) => (order.get(a.id) ?? Infinity) - (order.get(b.id) ?? Infinity));
}

export function editorCommandsForPresentation<T extends { id: string }>(commands: readonly T[], editor: Editor): T[] {
  const value = preferences.get(editor);
  return value ? orderedEditorCommands(commands, value) : [...commands];
}

type ShortcutEvent = Pick<
  KeyboardEvent,
  'key' | 'code' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'isComposing' | 'keyCode' | 'getModifierState'
>;

/** Native composition and AltGr never enter the command matcher. */
export function editorShortcutMatches(event: ShortcutEvent, chord: string): boolean {
  if (
    !chord ||
    event.isComposing ||
    event.keyCode === 229 ||
    ['Process', 'Dead'].includes(event.key) ||
    event.getModifierState?.('AltGraph')
  )
    return false;
  const parts = chord.split('-');
  const key = parts.pop()!;
  const mod = parts.includes('Mod');
  if (mod && ((!event.ctrlKey && !event.metaKey) || (event.ctrlKey && event.metaKey))) return false;
  if (!mod && (event.ctrlKey !== parts.includes('Ctrl') || event.metaKey !== parts.includes('Meta'))) return false;
  if (event.altKey !== parts.includes('Alt') || event.shiftKey !== parts.includes('Shift')) return false;
  if (event.ctrlKey && event.altKey && !parts.includes('Alt')) return false;
  const physical = /^(?:Key|Digit)(.)$/.exec(event.code)?.[1]?.toLowerCase();
  return (
    event.key.toLowerCase() === key.toLowerCase() ||
    physical === key.toLowerCase() ||
    (key === 'Space' && event.key === ' ')
  );
}
