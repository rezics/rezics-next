import type { Meta, StoryObj } from '@storybook/react-vite';
import { useEffect, useMemo, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { GameReader } from '../features/catalogue/game-reader/view';
import { gameExample } from '../features/catalogue/game-reader/examples';
import { getLocale } from '../paraglide/runtime';
import { AppShell } from '../shell/shell';
import { PatternStory } from './page';

type Scenario = 'inspection' | 'missing-assertion' | 'retired';
function RecoveryExample({ scenario = 'inspection' }: { scenario?: Scenario }) {
  const locale = getLocale();
  const fixture = useMemo(() => {
    const example = gameExample('work', locale);
    if (scenario === 'missing-assertion') {
      delete example.first.links[0]!.assertion;
      delete example.first.links[0]!.summary;
    }
    return example;
  }, [locale, scenario]);
  const client = useMemo(() => {
    const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    query.setQueryData(['session'], { state: 'signed-out' });
    return query;
  }, [fixture]);
  const [source, setSource] = useState<object>({});
  useEffect(() => {
    if (scenario === 'retired') client.setQueryData(['exposure', 'viewer'], { spoilerLevel: 1 });
    return () => client.clear();
  }, [client, scenario]);
  return (
    <PatternStory path={`/subjects/${fixture.address.id}/harbour-game`} visitor="Signed Out">
      <AppShell>
        <main className="mx-auto w-full max-w-5xl space-y-6 p-4 sm:p-8">
          <h1 className="text-3xl font-semibold">Harbour game</h1>
          <QueryClientProvider client={client}>
            <GameReader
              {...fixture.address}
              locale={locale}
              realm="games"
              source={source}
              reader={null}
              transport={fixture.read}
              refresh={async () => {
                setSource({});
              }}
            />
          </QueryClientProvider>
        </main>
      </AppShell>
    </PatternStory>
  );
}
const meta = {
  title: 'Pages/Catalogue/Game reader recovery',
  component: RecoveryExample,
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Choose an exact association, close to its keyboard opener, or traverse More → Previous → Start. Retirement requires deliberate current-Subject recovery. Inspect phone390/desktop1280, both themes and all eight locales.',
      },
    },
  },
} satisfies Meta<typeof RecoveryExample>;
export default meta;
type Story = StoryObj<typeof meta>;
export const InspectAndRevisit: Story = {};
export const UnavailableAssertion: Story = { args: { scenario: 'missing-assertion' } };
export const RetiredCurrentSubject: Story = { args: { scenario: 'retired' } };
