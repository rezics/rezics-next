import type { Meta, StoryObj } from '@storybook/react-vite';
import { useMemo } from 'react';
import { GameReader } from '../features/catalogue/game-reader/view';
import { WorkReadingBinding } from '../features/pages/work-reading-binding';
import { gameExample, type GameExample } from '../features/catalogue/game-reader/examples';
import { game, gameSummary } from '../kernel/fixtures/game-showcase';
import { selectGameShowcase } from '../kernel/fake/game-showcase';
import { getLocale } from '../paraglide/runtime';
import { subjectHref } from '../subject/subject-href';
import { AppShell } from '../shell/shell';
import { PageStory, PatternStory } from './page';

/** The posted URL uses the ordinary Subject identity, cover, synopsis, actions and native reader. */
function GameWorkVisit() {
  const locale = getLocale();
  useMemo(() => selectGameShowcase(), [locale]);
  const summary = gameSummary(game.id, locale);
  return (
    <PageStory
      key={locale}
      visitor="Signed In"
      previewNewTabs
      path={subjectHref({ id: game.id, label: summary.label.value }, locale).href}
      ratingsFixture="subject-ratings-global"
    />
  );
}

function GameReaderStory({ scenario = 'work' }: { scenario?: GameExample }) {
  const locale = getLocale();
  const fixture = useMemo(() => gameExample(scenario, locale), [scenario, locale]);
  return (
    <PatternStory path={`/subjects/${fixture.address.id}/harbour-game`} visitor="Signed Out">
      <AppShell>
        <main className="mx-auto w-full max-w-5xl space-y-6 p-4 sm:p-8">
          <h1 className="text-3xl font-semibold">Harbour game</h1>
          <WorkReadingBinding>
            <GameReader {...fixture.address} locale={locale} source={fixture} reader={null} transport={fixture.read} />
          </WorkReadingBinding>
        </main>
      </AppShell>
    </PatternStory>
  );
}
const meta = {
  title: 'Catalogue/Game reader',
  id: 'pages-catalogue-game-reader',
  component: GameReaderStory,
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Work and exact release retains its original story ID and mounts the ordinary Game Subject through PageStory, including the admitted identity, cover, synopsis and actions before compact facts. Open Editions deliberately to browse exact releases and their native comparison/evidence. Harbour Lights is the existing synthetic CC0 fixture family, not a provider recording or native acceptance. Explicitly named Reader entries isolate bundled vocabulary and typed response examples. Use phone390/desktop1280, either theme and each existing locale; execution and visual review remain with the verifier.',
      },
    },
  },
} satisfies Meta<typeof GameReaderStory>;
export default meta;
type Story = StoryObj<typeof meta>;
export const WorkAndExactRelease: Story = { render: () => <GameWorkVisit /> };
export const ReaderWorkFacts: Story = { name: 'Reader · Work facts and exact release', args: { scenario: 'work' } };
export const VisualNovelUnsupportedPlatform: Story = {
  name: 'Reader · Visual novel with unsupported platform',
  args: { scenario: 'visual-novel' },
};
export const ExplicitTba: Story = { name: 'Reader · Explicit TBA', args: { scenario: 'tba' } };
export const Empty: Story = { name: 'Reader · Empty', args: { scenario: 'empty' } };
export const MissingConfiguration: Story = {
  name: 'Reader · Missing configuration',
  args: { scenario: 'unconfigured' },
};
export const UnavailableContinuation: Story = {
  name: 'Reader · Unavailable continuation',
  args: { scenario: 'continuation-unavailable' },
};
