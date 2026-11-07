import { ConditionEditor } from './condition-editor';
import type { SavedQueryConditionInputProps } from '../library/saved-query-editor/presentation';

/** Default route adapter: retain Search's editor, admission, entity lookups and tree operations. */
export function SavedQueryConditionInput(props: SavedQueryConditionInputProps) {
  return <ConditionEditor {...props} embedded />;
}
