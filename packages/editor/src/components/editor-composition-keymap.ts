import { extensions, type KeyboardShortcutCommand } from '@tiptap/core';

// Tiptap 3.32.2 probes DOM deletion through shortcuts, which can dispatch during preedit.
// Remove this guard when inherited core probes preserve composition without an empty transaction.
export const EditorCompositionKeymap = extensions.Keymap.extend({
  addKeyboardShortcuts() {
    const inherited: Record<string, KeyboardShortcutCommand> = this.parent?.() ?? {};
    const guarded: Record<string, KeyboardShortcutCommand> = {};
    for (const [key, command] of Object.entries(inherited)) {
      guarded[key] = (props) => !this.editor.view.composing && command(props);
    }
    return guarded;
  },
});
