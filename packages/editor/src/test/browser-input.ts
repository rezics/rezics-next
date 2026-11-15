import type { Editor } from '@tiptap/core';
import { userEvent } from 'storybook/test';

/** Native provider events in browser checks; interactive Storybook keeps its explicitly synthetic driver. */
export async function editorBrowserInput() {
  const browser = await import('vitest/browser').catch(() => null);
  return browser ? { events: browser.userEvent, native: true } : { events: userEvent, native: false };
}

export async function moveToEditorEnd(editor: Editor, textbox: HTMLElement) {
  const input = await editorBrowserInput();
  await input.events.click(textbox);
  if (input.native) await input.events.keyboard('{Control>}{End}{/Control}');
  else {
    // Testing Library cannot implement contenteditable Ctrl+End. This fallback is fixture setup, not native proof.
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    editor.view.focus();
    console.info('Interactive Storybook uses a programmatic end caret and synthetic keyboard events.');
  }
  return input.events;
}
