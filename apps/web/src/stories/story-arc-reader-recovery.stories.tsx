import type { Meta, StoryObj } from '@storybook/react-vite';
import { useMemo } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { StoryArcReader } from '../features/catalogue/story-arc-reader/view';
import { arcAddress, arcExample } from '../features/catalogue/story-arc-reader/examples';
import type { ArcTransport } from '../features/catalogue/story-arc-reader/model';
import { m } from '../paraglide/messages';
import { getLocale } from '../paraglide/runtime';
import { AppShell } from '../shell/shell';
import { PatternStory } from './page';

function RecoveryStory({ outcome = 'invalid' }: { outcome?: 'invalid' | 'withheld' | 'unavailable' | 'member' }) {
  const locale = getLocale();
  const fixture = useMemo(() => {
    const native = arcExample('admitted', locale);
    const read: ArcTransport = (address) =>
      address.cursor && outcome !== 'member' ? Promise.resolve({ ok: false, reason: outcome }) : native.read(address);
    return { read };
  }, [locale, outcome]);
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
  title: 'Pages/Catalogue/Story arc recovery',
  component: RecoveryStory,
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Bounded native-operation examples for deliberate recovery and exact member evidence. Native and rendered acceptance remain with integration.',
      },
    },
  },
} satisfies Meta<typeof RecoveryStory>;
export default meta;
type Story = StoryObj<typeof meta>;
const more: NonNullable<Story['play']> = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await userEvent.click(await canvas.findByRole('button', { name: m.work_parts_more() }));
  await expect(canvas.findByRole('button', { name: m.arc_reader_discover() })).resolves.toBeVisible();
};
export const RejectedAddressWithFreshDiscovery: Story = { play: more };
export const WithheldRowsWithCurrentSubjectRecovery: Story = { args: { outcome: 'withheld' }, play: more };
export const PriorAdmittedPageAndExactFailedFrontier: Story = { args: { outcome: 'unavailable' }, play: more };
export const SelectedMemberAndFilteredAppearances: Story = {
  args: { outcome: 'member' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: m.arc_reader_characters() }));
    await expect(canvas.findByRole('button', { name: m.arc_reader_back() })).resolves.toBeVisible();
    await expect(canvas.getAllByRole('button', { name: m.arc_reader_inspect() })[0]).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  },
};
