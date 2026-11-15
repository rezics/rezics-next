import { RichTextEditor, type RichTextEditorProps } from '@rezics/editor';
import { localizedEditorPreferences, localizedEditorWorkbench } from './labels';
import { localizedBehaviorLabels, localizedTableLabels } from './behavior-labels';
import { localizedFormattingLabels } from './formatting-labels';
import { useEditorPreferences } from './preferences';
import { useEditorImagePresentation } from './media-presentation';
import { localizedMediaLabels } from './media-labels';
import { useMemo } from 'react';

/** Every Web authoring host uses one account/device/session preference binding. */
export function PreferredRichTextEditor(props: RichTextEditorProps) {
  const preferences = useEditorPreferences();
  const media = useEditorImagePresentation(props.value);
  const mediaVisitKey = useMemo(
    () => ({ viewer: media.visitKey, host: props.mediaVisitKey }),
    [media.visitKey, props.mediaVisitKey],
  );
  return (
    <RichTextEditor
      {...props}
      {...preferences}
      renderImage={props.renderImage ?? media.renderImage}
      mediaVisitKey={mediaVisitKey}
      preset={props.preset ?? (props.compact ? 'compact' : 'writing')}
      labels={{
        ...localizedBehaviorLabels(),
        ...localizedFormattingLabels(),
        ...localizedMediaLabels(),
        ...props.labels,
      }}
      preferencesLabels={localizedEditorPreferences()}
      workbenchLabels={localizedEditorWorkbench()}
      tableLabels={localizedTableLabels()}
    />
  );
}
