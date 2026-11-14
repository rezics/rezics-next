import { useEffect, useState } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
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
type Prepared = { key: string; kind: 'ready'; fixture: Fixture } | { key: string; kind: 'failed' };

/** Routed shell and installed product view; no story-specific editor, outline or release panel. */
export function StudioWorkbenchReview({
  profile = 'book',
  scenario = 'populated',
}: {
  profile?: StudioWorkbenchProfile;
  scenario?: StudioWorkbenchScenario;
}) {
  const locale = getLocale();
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [attempt, setAttempt] = useState(0);
  const key = `${profile}:${scenario}:${locale}:${attempt}`;
  useEffect(() => {
    let current = true;
    let fixture: Fixture | null = null;
    setPrepared(null);
    void (async () => {
      try {
        const value = await studioWorkbenchFixture(profile, scenario, locale);
        if (!current) {
          value.dispose();
          return;
        }
        fixture = value;
        setPrepared({ key, kind: 'ready', fixture: value });
      } catch {
        if (current) setPrepared({ key, kind: 'failed' });
      }
    })();
    return () => {
      current = false;
      fixture?.dispose();
    };
  }, [key, profile, scenario, locale]);
  return (
    <PatternStory path="/studio" visitor="Signed In">
      <AppShell>
        <div className="min-w-0">
          {prepared?.key === key && prepared.kind === 'ready' ? (
            <StudioWorkbench key={key} {...prepared.fixture.props} controller={prepared.fixture.controller} />
          ) : prepared?.key === key && prepared.kind === 'failed' ? (
            <section className="studio-stack" role="alert">
              <h1>{m.error_heading()}</h1>
              <p>{m.error_message()}</p>
              <Button type="button" variant="outline" onClick={() => setAttempt((value) => value + 1)}>
                {m.studio_workspace_retry({}, { locale })}
              </Button>
            </section>
          ) : (
            <p role="status">{m.studio_account_preparing({}, { locale })}</p>
          )}
        </div>
      </AppShell>
    </PatternStory>
  );
}
