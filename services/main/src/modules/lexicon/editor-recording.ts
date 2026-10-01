import type { DefinitionState } from '../semantic/change.ts';
import { SemanticChangeRejected } from '../semantic/command.ts';

export interface EditorRecording {
  editorRecordable?: boolean;
  writePath?: 'derivation' | 'relation';
}

/** Metadata is admitted and retained with the meaning, not inferred from kind names. */
export function checkedEditorRecording(row: Record<string, unknown>): EditorRecording {
  const invalid = () => {
    throw new SemanticChangeRejected('invalid', 'editor recording metadata is invalid');
  };
  if (row.editorRecordable !== undefined && typeof row.editorRecordable !== 'boolean') invalid();
  if (row.writePath !== undefined && row.writePath !== 'derivation' && row.writePath !== 'relation')
    invalid();
  if (
    (row.editorRecordable !== undefined || row.writePath !== undefined) &&
    row.kind !== 'relation'
  )
    invalid();
  if (row.editorRecordable === true && (!row.notation || !row.workSubjectRole || !row.writePath))
    invalid();
  return {
    ...(row.editorRecordable === undefined
      ? {}
      : { editorRecordable: row.editorRecordable as boolean }),
    ...(row.writePath === undefined
      ? {}
      : { writePath: row.writePath as EditorRecording['writePath'] }),
  };
}

/** Legacy admitted manifests remain unrecordable until explicitly revised. */
export function editorRecording(state: Pick<DefinitionState, 'editorRecordable' | 'writePath'>) {
  return { editorRecordable: state.editorRecordable ?? false, writePath: state.writePath ?? null };
}
