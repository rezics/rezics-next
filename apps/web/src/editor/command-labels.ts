import { editorCommandIds, type EditorPreferenceCommand } from '@rezics/editor/preferences';
import { localizedBehaviorLabels, localizedTableLabels } from './behavior-labels';
import { localizedEditorWorkbench } from './labels';
import { localizedFormattingLabels } from './formatting-labels';
import { localizedMediaLabels } from './media-labels';
import { m } from '../paraglide/messages.js';

/** Settings exposes the portable command vocabulary using the same localized action labels as the workbench. */
export function localizedEditorCommands() {
  const work = localizedEditorWorkbench();
  const names = {
    ...localizedBehaviorLabels(),
    ...localizedTableLabels(),
    ...localizedFormattingLabels(),
    ...localizedMediaLabels(),
    paragraph: m.editor_paragraph(),
    heading1: m.editor_heading_1(),
    heading2: m.editor_heading_2(),
    heading3: m.editor_heading_3(),
    bulletList: m.editor_bullet_list(),
    orderedList: m.editor_ordered_list(),
    taskList: m.editor_task_list(),
    blockquote: m.editor_quote(),
    codeBlock: m.editor_code_block(),
    horizontalRule: m.editor_horizontal_rule(),
    table: m.editor_table(),
    image: m.editor_image(),
    bold: m.editor_bold(),
    italic: m.editor_italic(),
    strike: m.editor_strike(),
    code: m.editor_inline_code(),
    link: m.editor_link(),
    clearFormatting: m.editor_clear_formatting(),
    undo: m.editor_undo(),
    redo: m.editor_redo(),
    find: work.find,
    findNext: work.nextMatch,
    findPrevious: work.previousMatch,
    replace: work.replaceWith,
    commandPalette: work.commandPalette,
  } satisfies Record<EditorPreferenceCommand, string>;
  return editorCommandIds.map((id) => ({ id, label: names[id] }));
}
