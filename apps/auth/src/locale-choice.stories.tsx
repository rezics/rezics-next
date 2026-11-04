import { useState } from 'react';
import { AuthPage, AuthShell } from './frame';
import { LocaleChoice } from './locale-choice-view';
import { initializeDocumentLocale, observeLocaleComponent } from './locale-observation';
import { m } from './paraglide/messages.js';
import { reviewParameters } from './stories/accounts-operations/story';
import './styles.css';

export default {
  title: 'Pages/Auth/Language',
  parameters: reviewParameters,
  decorators: [
    (Story: () => React.ReactNode, context: { globals: Record<string, unknown> }) => {
      initializeDocumentLocale(String(context.globals.locale ?? 'en'));
      return <Story />;
    },
  ],
};

const Shell = observeLocaleComponent(function Shell() {
  const [draft, setDraft] = useState('');
  return (
    <AuthShell>
      <AuthPage heading={m.auth_login_heading()}>
        <label htmlFor="language-story-draft">{m.auth_login_email()}</label>
        <input
          id="language-story-draft"
          type="email"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
      </AuthPage>
    </AuthShell>
  );
});

export const CurrentLanguage = { render: () => <Shell /> };
// Select any autonym to review Apply/Cancel; Apply retains the entered draft.
export const MountedDraft = { render: () => <Shell /> };
export const LanguageControl = { render: () => <LocaleChoice /> };
