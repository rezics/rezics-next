import type { Meta, StoryObj } from '@storybook/react-vite';
import { useMemo } from 'react';
import { PersonOverview } from '../features/catalogue/person-reader/reader';
import { personReaderExample } from '../features/catalogue/person-reader/examples';
import { getLocale } from '../paraglide/runtime';
import { AppShell } from '../shell/shell';
import { PatternStory } from './page';

function Example({ state = 'admitted' }: { state?: Parameters<typeof personReaderExample>[0] }) {
  const locale = getLocale();
  const fixture = useMemo(() => personReaderExample(state), [state, locale]);
  return (
    <PatternStory>
      <AppShell>
        <main className="mx-auto w-full max-w-4xl p-4 sm:p-6">
          <PersonOverview
            source={fixture}
            viewer={null}
            public={fixture.read}
            documents={fixture.documents}
            locale={locale}
            load={async () => fixture.release}
          />
        </main>
      </AppShell>
    </PatternStory>
  );
}

const meta = {
  title: 'Pages/Subjects/Person biography',
  component: Example,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof Example>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Admitted: Story = {};
export const Empty: Story = { args: { state: 'empty' } };
export const Withheld: Story = { args: { state: 'withheld' } };
export const Unsupported: Story = { args: { state: 'unsupported' } };
