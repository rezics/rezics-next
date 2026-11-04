import { useMemo } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { peopleFactsExample } from '../features/catalogue/people-facts/examples';
import { PersonReader } from '../features/catalogue/person-reader/reader';
import { CharacterReader } from '../features/pages/showcase-people/character';
import { getLocale } from '../paraglide/runtime';
import { m } from '../paraglide/messages';
import { AppShell } from '../shell/shell';
import { PatternStory } from './page';

function Example({ character = false, oversized = false }: { character?: boolean; oversized?: boolean }) {
  const locale = getLocale();
  const fixture = useMemo(() => {
    const supplied = peopleFactsExample(character);
    if (oversized)
      supplied.rows[0]!.references[0]!.parts[0]!.value = {
        type: 'value',
        content: 'https://example.org/' + 'long'.repeat(300_000),
      };
    return supplied;
  }, [character, oversized]);
  const Reader = character ? CharacterReader : PersonReader;
  return (
    <PatternStory visitor="Signed Out">
      <AppShell>
        <main className="mx-auto min-w-0 max-w-4xl p-4 sm:p-6">
          <h1 className="text-2xl font-semibold">
            {character ? m.showcase_people_character() : m.person_reader_title()}
          </h1>
          <Reader public={fixture.read} release={fixture.release} documents={fixture.documents} locale={locale} />
        </main>
      </AppShell>
    </PatternStory>
  );
}
const meta = {
  title: 'Pages/Subjects/People fact windows',
  component: Example,
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Supplied response fixtures with duplicate assertions and mixed scripts. Not a capture of native seeded data.',
      },
    },
  },
} satisfies Meta<typeof Example>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Person: Story = {};
export const Character: Story = { args: { character: true } };
export const Overflow: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const field = canvasElement.querySelector('[id="profile-fact-wdt%3AP106"]')!.parentElement!;
    await userEvent.click(within(field).getByRole('button', { name: m.people_facts_browse() }));
    await userEvent.click(within(field).getByRole('button', { name: m.people_facts_next() }));
    await expect(within(field).getByText('Condition 21')).toBeVisible();
    await expect(canvas.getByText(m.people_facts_scope())).toBeVisible();
  },
};
export const LocalAdmissionUnavailable: Story = { args: { oversized: true } };
