import { RichTextEditor, type RichTextEditorProps } from '@rezics/editor';
import { localizedEditorPreferences, localizedEditorWorkbench } from './labels';
import { localizedBehaviorLabels, localizedTableLabels } from './behavior-labels';
import { useEditorPreferences } from './preferences';

/** Every Web authoring host uses one account/device/session preference binding. */
export function PreferredRichTextEditor({ toolbar: _toolbar, ...props }: RichTextEditorProps) {
  const preferences = useEditorPreferences();
  return (
    <RichTextEditor
      {...props}
      {...preferences}
      preset={props.preset ?? (props.compact ? 'compact' : 'writing')}
      labels={{ ...localizedBehaviorLabels(), ...props.labels }}
      preferencesLabels={localizedEditorPreferences()}
      workbenchLabels={localizedEditorWorkbench()}
      tableLabels={localizedTableLabels()}
    />
  );
}
