import type { RichTextEditorLabels } from '@rezics/ui';
import { m } from '../paraglide/messages.js';
import { getLocale, type Locale } from '../paraglide/runtime.js';
import type { StudioFailure, StudioFeedback, StudioOperation } from './contract';

/** Presentation only. Commands, replay, editor locks and completion detection use the contract identities. */
export function workspaceOperationMessage(operation: StudioOperation, locale: Locale = getLocale()): string {
  const options = { locale };
  switch (operation) {
    case 'open':
      return m.studio_workspace_opening({}, options);
    case 'create':
    case 'native-create':
      return m.studio_workspace_creating({}, options);
    case 'save':
      return m.studio_workspace_saving({}, options);
    case 'documents':
      return m.studio_workspace_loading({}, options);
    case 'versions':
      return m.studio_workspace_loading_versions({}, options);
    case 'revision':
      return m.studio_workspace_reading_version({}, options);
    case 'organize':
      return m.studio_workspace_saving_outline({}, options);
    case 'review':
      return m.studio_workspace_reviewing({}, options);
    case 'withdraw-review':
      return m.studio_withdraw_reviewing({}, options);
    case 'publish':
      return m.studio_workspace_publishing({}, options);
    case 'withdraw':
      return m.studio_withdraw_pending({}, options);
    case 'publications':
      return m.studio_workspace_loading_publications({}, options);
  }
}

export function workspaceFeedbackMessage(
  result: StudioFeedback | 'review-required',
  locale: Locale = getLocale(),
): string {
  const options = { locale };
  switch (result) {
    case 'discarded':
      return m.studio_workspace_discarded({}, options);
    case 'created':
    case 'native-created':
      return m.studio_account_created({}, options);
    case 'saved':
      return m.studio_workspace_saved({}, options);
    case 'saved-newer':
      return m.studio_workspace_saved_newer({}, options);
    case 'restored':
      return m.studio_workspace_restored({}, options);
    case 'organized':
      return m.studio_workspace_organized({}, options);
    case 'published':
      return m.studio_workspace_published({}, options);
    case 'article-published':
      return m.studio_account_published({}, options);
    case 'withdrawn':
      return m.studio_withdraw_done({}, options);
    case 'review-required':
      return m.studio_workspace_review_required({}, options);
  }
}

/** Native explanations are displayed separately, without parsing or translating supplied information. */
export function workspaceFailureMessage(kind: StudioFailure['kind'], locale: Locale = getLocale()): string {
  const options = { locale };
  switch (kind) {
    case 'denied':
      return m.studio_workspace_failure_denied({}, options);
    case 'unavailable':
      return m.studio_workspace_failure_unavailable({}, options);
    case 'stale':
      return m.studio_workspace_failure_stale({}, options);
    case 'withdrawn':
      return m.studio_workspace_failure_withdrawn({}, options);
    case 'invalid':
      return m.studio_workspace_failure_invalid({}, options);
    case 'uncertain':
      return m.studio_workspace_failure_uncertain({}, options);
  }
}

/** Reuse the shared editor vocabulary while retaining caller upload and mention presentation. */
export function workspaceEditorLabels(locale: Locale = getLocale()): RichTextEditorLabels {
  const options = { locale };
  return {
    toolbar: m.editor_toolbar({}, options),
    blocks: m.editor_blocks({}, options),
    undo: m.editor_undo({}, options),
    redo: m.editor_redo({}, options),
    hideKeyboard: m.editor_hide_keyboard({}, options),
    formatting: m.editor_formatting({}, options),
    turnInto: m.editor_turn_into({}, options),
    paragraph: m.editor_paragraph({}, options),
    heading1: m.editor_heading_1({}, options),
    heading2: m.editor_heading_2({}, options),
    heading3: m.editor_heading_3({}, options),
    bulletList: m.editor_bullet_list({}, options),
    orderedList: m.editor_ordered_list({}, options),
    taskList: m.editor_task_list({}, options),
    quote: m.editor_quote({}, options),
    codeBlock: m.editor_code_block({}, options),
    horizontalRule: m.editor_horizontal_rule({}, options),
    table: m.editor_table({}, options),
    insertBlock: m.editor_insert_block({}, options),
    slashEmpty: m.editor_slash_empty({}, options),
    mentionAccounts: m.editor_mention_accounts({}, options),
    mentionLoading: m.editor_mention_loading({}, options),
    bold: m.editor_bold({}, options),
    italic: m.editor_italic({}, options),
    strike: m.editor_strike({}, options),
    inlineCode: m.editor_inline_code({}, options),
    link: m.editor_link({}, options),
    clearFormatting: m.editor_clear_formatting({}, options),
    url: m.editor_url({}, options),
    apply: m.editor_apply({}, options),
    cancel: m.editor_cancel({}, options),
    unlink: m.editor_unlink({}, options),
    editLink: m.editor_edit_link({}, options),
    openLink: m.editor_open_link({}, options),
    invalidUrl: m.editor_invalid_url({}, options),
    image: m.editor_image({}, options),
    uploadFile: m.editor_upload_file({}, options),
    imageAlt: m.editor_image_alt({}, options),
    editImageAlt: m.editor_edit_image_alt({}, options),
    insertImage: m.editor_insert_image({}, options),
    uploading: m.editor_uploading({}, options),
    uploadFailed: m.editor_upload_failed({}, options),
    retryUpload: m.editor_retry_upload({}, options),
    dismissUpload: m.editor_dismiss_upload({}, options),
    unsupportedImage: m.editor_unsupported_image({}, options),
    imageLimit: m.editor_image_limit({}, options),
    documentError: m.editor_document_error({}, options),
  };
}
