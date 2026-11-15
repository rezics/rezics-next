export { RichTextEditor, type RichTextEditorProps } from './components/rich-text-editor.tsx';
export { richTextEditorLabels, type RichTextEditorLabels } from './components/editor-labels.ts';
export type {
  ImageUploader,
  UploadedImage,
  UploadState,
  UploadAttachment,
  UploadAttachmentActions,
} from './components/editor-uploads.ts';
export type { MentionAccount, MentionSource } from './components/editor-mention.tsx';
export {
  EditorPreferencesPanel,
  editorPreferencesLabels,
  type EditorPreferencesPanelProps,
  type EditorPreferencesLabels,
  type EditorPreferencesScope,
  type EditorPreferencesStatus,
  type EditorPreferenceControl,
} from './components/editor-preferences.tsx';
export { editorWorkbenchLabels, type EditorWorkbenchLabels } from './components/editor-workbench-labels.ts';
export type { EditorPreset } from './components/editor-workbench.tsx';
export {
  tableControlLabels,
  type TableControlLabels,
  type TableControlLabels as EditorTableLabels,
} from './components/editor-upstream/reactjs-tiptap-editor/table-labels.ts';
export { behaviorControlLabels, type BehaviorControlLabels } from './components/editor-behavior-labels.ts';
export { editorMediaLabels, type EditorMediaLabels } from './components/editor-media-labels.ts';
export { AuthorFormattingControls } from './components/editor-formatting-controls.tsx';
export { formattingControlLabels, type FormattingControlLabels } from './components/editor-formatting-labels.ts';
export type {
  DocumentImageOccurrence,
  DocumentMediaOccurrence,
  DocumentImageRenderer,
  DocumentMediaRenderer,
} from './components/document-media.tsx';
