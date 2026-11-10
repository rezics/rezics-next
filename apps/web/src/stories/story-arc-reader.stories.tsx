import type { Meta, StoryObj } from '@storybook/react-vite';
import { useMemo } from 'react';
import { StoryArcReader } from '../features/catalogue/story-arc-reader/view';
import { arcExample, arcAddress, type ArcExample } from '../features/catalogue/story-arc-reader/examples';
import { getLocale } from '../paraglide/runtime';
import { AppShell } from '../shell/shell';
import { PatternStory } from './page';

function ArcStory({ scenario = 'admitted' }: { scenario?: ArcExample }) {
  const locale = getLocale();
  const fixture = useMemo(() => arcExample(scenario, locale), [scenario, locale]);
  return (
    <PatternStory path={`/subjects/${arcAddress.id}/harbour-arc`} visitor="Signed Out">
      <AppShell>
        <main className="mx-auto w-full max-w-5xl space-y-6 p-4 sm:p-8">
          <h1 className="text-3xl font-semibold">Harbour arc</h1>
          <StoryArcReader {...arcAddress} locale={locale} source={fixture} reader={null} transport={fixture.read} />
        </main>
      </AppShell>
    </PatternStory>
  );
}
const meta = {
  title: 'Catalogue/Story arc reader',
  id: 'pages-catalogue-story-arc-reader',
  component: ArcStory,
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component: 'Authored generated-client examples. Native and rendered acceptance are deferred to integration.',
      },
    },
  },
} satisfies Meta<typeof ArcStory>;
export default meta;
type Story = StoryObj<typeof meta>;
export const OrderedWorksAndQualifiedAppearances: Story = {};
export const MissingConfiguration: Story = { args: { scenario: 'unsupported' } };
export const UnavailableContinuation: Story = { args: { scenario: 'continuation-unavailable' } };
