import type { Meta, StoryObj } from '@storybook/react-vite';
import { useMemo } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import {
  workReleaseComparisonExample,
  type ComparisonExample,
} from '../features/catalogue/game-reader/comparison-example';
import type { GameReaderTransport } from '../features/catalogue/game-reader/model';
import { GameReader } from '../features/catalogue/game-reader/view';
import { getLocale } from '../paraglide/runtime';
import { m } from '../paraglide/messages.js';
import { AppShell } from '../shell/shell';
import { PatternStory } from './page';

function WorkReleaseComparisonStory({ scenario = 'partial' }: { scenario?: ComparisonExample }) {
  const locale = getLocale();
  const fixture = useMemo(() => workReleaseComparisonExample(scenario, locale), [scenario, locale]);
  const transport = useMemo<GameReaderTransport>(
    () => async (address) => {
      if (scenario === 'retirement' && address.cursor)
        fixture.respond({ ...fixture.last, workReleaseCards: { state: 'available', cards: [] } });
      return fixture.read(address);
    },
    [fixture, scenario],
  );
  return (
    <PatternStory path={`/subjects/${fixture.address.id}/harbour-game`} visitor="Signed Out">
      <AppShell>
        <main className="mx-auto w-full max-w-5xl space-y-6 p-4 sm:p-8">
          <h1 className="text-3xl font-semibold">Harbour game</h1>
          <GameReader {...fixture.address} locale={locale} source={fixture} reader={null} transport={transport} />
        </main>
      </AppShell>
    </PatternStory>
  );
}

const meta = {
  title: 'Pages/Catalogue/Work release comparison',
  component: WorkReleaseComparisonStory,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof WorkReleaseComparisonStory>;
export default meta;
type Story = StoryObj<typeof meta>;

export const PartialReleaseDate: Story = {};
export const TbaReleaseDate: Story = { args: { scenario: 'tba' } };
export const WithheldAgeRating: Story = { args: { scenario: 'withheld' } };
export const UnavailableViewerAdvice: Story = { args: { scenario: 'advice-unavailable' } };
export const SparseReleaseWindow: Story = { args: { scenario: 'sparse' } };
export const RetiredComparisonAfterContinuation: Story = {
  args: { scenario: 'retirement' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: m.work_parts_more() }));
    await expect(canvas.queryByText(m.game_reader_compare_title())).not.toBeInTheDocument();
  },
};
export const ReleaseDetailReturn: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const detail = await canvas.findByRole('link', { name: m.game_reader_release_detail() });
    await expect(detail).toHaveAttribute('target', '_blank');
    await userEvent.click(detail);
    await expect(canvas.getByText(m.game_reader_compare_title())).toBeInTheDocument();
  },
};
