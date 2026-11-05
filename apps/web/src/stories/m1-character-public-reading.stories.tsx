import type { Meta, StoryObj } from '@storybook/react-vite';
import { useMemo } from 'react';
import { CharacterReader } from '../features/pages/showcase-people/character';
import { OverviewContext } from '../features/pages/overview';
import { characterPublicExample } from '../features/catalogue/character-public-reading/examples';
import { getLocale } from '../paraglide/runtime';
import { PatternStory } from './page';

function Example({ state = 'current' }: { state?: 'current' | 'spoiler' | 'stale' | 'unavailable' }) {
  const locale = getLocale();
  const fixture = useMemo(() => characterPublicExample(locale, state), [locale, state]);
  return (
    <PatternStory>
      <main className="mx-auto max-w-5xl p-4 sm:p-6">
        <OverviewContext.Provider value={fixture.value}>
          <CharacterReader
            public={fixture.profile.read}
            release={fixture.profile.release}
            locale={locale}
            associations={{ source: fixture, viewer: null, read: fixture.read }}
          />
        </OverviewContext.Provider>
      </main>
    </PatternStory>
  );
}
const meta = {
  title: 'Pages/Subjects/Character public reading',
  component: Example,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof Example>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Current: Story = {};
export const Spoiler: Story = { args: { state: 'spoiler' } };
export const Stale: Story = { args: { state: 'stale' } };
export const Unavailable: Story = { args: { state: 'unavailable' } };
