import {
  ContentSection,
  ContentSectionBody,
  ContentSectionDescription,
  ContentSectionHeader,
  ContentSectionTitle,
} from '@rezics/ui/content-section';
import { m } from '../paraglide/messages.js';
import { useSettingsShell } from './adapters/shell';

export function DisplayPreferences() {
  const { AppearanceControls } = useSettingsShell();
  return (
    <ContentSection>
      <ContentSectionHeader>
        <ContentSectionTitle>
          <h2 id="settings-display-heading">{m.settings_display_heading()}</h2>
        </ContentSectionTitle>
        <ContentSectionDescription>{m.settings_display_text()}</ContentSectionDescription>
      </ContentSectionHeader>
      <ContentSectionBody>
        <AppearanceControls />
      </ContentSectionBody>
    </ContentSection>
  );
}
