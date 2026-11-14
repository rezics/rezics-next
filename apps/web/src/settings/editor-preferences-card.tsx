import { EditorPreferencesPanel } from '@rezics/editor';
import {
  ContentSection,
  ContentSectionBody,
  ContentSectionDescription,
  ContentSectionHeader,
  ContentSectionTitle,
} from '@rezics/ui/content-section';
import { localizedEditorPreferences } from '../editor/labels';
import { localizedEditorCommands } from '../editor/command-labels';
import { useEditorPreferences } from '../editor/preferences';
import type { ReadingPreferences } from './preferences';
import type { ReadingIO } from './reading-preferences';

/** The native account namespace and browser overrides share the same controlled settings UI. */
export function EditorPreferencesCard({
  initial,
  io,
  version,
  onVersionChange,
}: {
  initial?: ReadingPreferences;
  io?: ReadingIO;
  version?: number;
  onVersionChange?: (version: number) => void;
} = {}) {
  const binding = useEditorPreferences({ initial, io, version, onVersionChange });
  const labels = localizedEditorPreferences();
  return (
    <ContentSection>
      <ContentSectionHeader>
        <ContentSectionTitle>
          <h2 id="settings-editor-heading">{labels.heading}</h2>
        </ContentSectionTitle>
        <ContentSectionDescription>{labels[`${binding.preferencesScope}Description`]}</ContentSectionDescription>
      </ContentSectionHeader>
      <ContentSectionBody>
        <EditorPreferencesPanel
          value={binding.preferencesPanelValue}
          onChange={binding.onPreferencesChange}
          scope={binding.preferencesScope}
          onScopeChange={binding.onPreferencesScopeChange}
          availableScopes={binding.preferencesScopes}
          status={binding.preferencesStatus}
          disabled={binding.preferencesDisabled}
          onRetry={binding.onPreferencesRetry}
          onReload={binding.onPreferencesReload}
          labels={labels}
          commands={localizedEditorCommands()}
        />
      </ContentSectionBody>
    </ContentSection>
  );
}
