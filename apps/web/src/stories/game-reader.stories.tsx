import type { Meta, StoryObj } from '@storybook/react-vite';
import { useMemo } from 'react';
import { GameReader } from '../features/catalogue/game-reader/view';
import { gameExample, type GameExample } from '../features/catalogue/game-reader/examples';
import { getLocale } from '../paraglide/runtime';
import { AppShell } from '../shell/shell';
import { PatternStory } from './page';

function GameReaderStory({ scenario = 'work' }: { scenario?: GameExample }) {
  const locale = getLocale();
  const fixture = useMemo(() => gameExample(scenario, locale), [scenario, locale]);
  return (
    <PatternStory path={`/subjects/${fixture.address.id}/harbour-game`} visitor="Signed Out">
      <AppShell>
        <main className="mx-auto w-full max-w-5xl space-y-6 p-4 sm:p-8">
          <h1 className="text-3xl font-semibold">Harbour game</h1>
          <GameReader {...fixture.address} locale={locale} source={fixture} reader={null} transport={fixture.read} />
        </main>
      </AppShell>
    </PatternStory>
  );
}
const meta = {
  title: 'Pages/Catalogue/Game reader',
  component: GameReaderStory,
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Bundled vocabulary and typed response examples. Native and rendered acceptance remain separate. Use phone390/desktop1280, either theme and each existing locale.',
      },
    },
  },
} satisfies Meta<typeof GameReaderStory>;
export default meta;
type Story = StoryObj<typeof meta>;
export const WorkAndExactRelease: Story = {};
export const VisualNovelUnsupportedPlatform: Story = { args: { scenario: 'visual-novel' } };
export const ExplicitTba: Story = { args: { scenario: 'tba' } };
export const Empty: Story = { args: { scenario: 'empty' } };
export const MissingConfiguration: Story = { args: { scenario: 'unconfigured' } };
export const UnavailableContinuation: Story = { args: { scenario: 'continuation-unavailable' } };
