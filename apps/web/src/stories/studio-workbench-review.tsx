import { useEffect, useState } from 'react';
import { StudioWorkbench } from '../studio';
import {
  studioWorkbenchFixture,
  type StudioWorkbenchProfile,
  type StudioWorkbenchScenario,
} from '../kernel/fake/studio-workbench';
import { getLocale } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';
import { AppShell } from '../shell/shell';
import { PatternStory } from './page';

type Fixture = Awaited<ReturnType<typeof studioWorkbenchFixture>>;

/** Routed shell and installed product view; no story-specific editor, outline or release panel. */
export function StudioWorkbenchReview({
  profile = 'book',
  scenario = 'populated',
}: {
  profile?: StudioWorkbenchProfile;
  scenario?: StudioWorkbenchScenario;
}) {
  const locale = getLocale();
  const [prepared, setPrepared] = useState<{ key: string; fixture: Fixture } | null>(null);
  const key = `${profile}:${scenario}:${locale}`;
  useEffect(() => {
    let current = true;
    let fixture: Fixture | null = null;
    void studioWorkbenchFixture(profile, scenario, locale).then((value) => {
      fixture = value;
      if (current) setPrepared({ key, fixture: value });
      else value.dispose();
    });
    return () => {
      current = false;
      fixture?.dispose();
    };
  }, [key, profile, scenario, locale]);
  return (
    <PatternStory path="/studio" visitor="Signed In">
      <AppShell>
        <div className="min-w-0">
          {prepared?.key === key ? (
            <StudioWorkbench key={key} {...prepared.fixture.props} controller={prepared.fixture.controller} />
          ) : (
            <p role="status">{m.studio_account_preparing({}, { locale })}</p>
          )}
        </div>
      </AppShell>
    </PatternStory>
  );
}
