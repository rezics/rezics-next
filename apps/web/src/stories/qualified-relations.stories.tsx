import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { pageRelationProperties, SubjectPage } from '../features/pages/subject';
import { subjectPageMessages } from '../features/pages/route-support';
import { qualifiedRelationsPage, qualifiedRealm } from '../kernel/fake/qualified-relations';
import definitions from '../kernel/recorded/definitions-release.json';
import { relationDefinitions } from '../subject/relations';
import { getLocale } from '../paraglide/runtime.js';
import { AppShell } from '../shell/shell';
import { PatternStory } from './page';
import { longCredit, longCreditPage } from './qualified-relations-data';
import { m } from '../paraglide/messages.js';
const meta = {
  title: 'Subjects/Qualified Relations',
  id: 'pages-subjects-qualified-relations',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
function QualifiedRelationsReader({ error = false, long = false }: { error?: boolean; long?: boolean }) {
  const page = long
    ? longCreditPage()
    : qualifiedRelationsPage(
        error ? { realm: qualifiedRealm, continuation: { node: 'cast', cursor: 'refuse' }, error: 409 } : {},
      );
  const locale = getLocale();
  return (
    <PatternStory>
      <AppShell>
        <SubjectPage
          page={page}
          locale={locale}
          relations={relationDefinitions(definitions.release, pageRelationProperties(page), locale)}
          messages={subjectPageMessages()}
          renderJsonLd={false}
        />
      </AppShell>
    </PatternStory>
  );
}
export const Reader: Story = { render: () => <QualifiedRelationsReader /> };
export const ContextConflict: Story = { render: () => <QualifiedRelationsReader error /> };

const completeCredit: Story['play'] = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  const person = await canvas.findByRole('link', { name: longCredit.person });
  await expect(person).toBeVisible();
  const credit = person.closest('article')!;
  for (const text of [longCredit.role, longCredit.character, longCredit.name]) {
    await expect(credit).toHaveTextContent(text);
  }
  await expect(
    within(credit).getByRole('link', { name: `${m.subject_credit_role()}: ${longCredit.role}` }),
  ).toHaveAttribute('href', expect.stringContaining('/subjects/'));
  await expect(
    within(credit).getByRole('link', { name: `${m.subject_credit_character()}: ${longCredit.character}` }),
  ).toHaveAttribute('href', expect.stringContaining('/subjects/'));
  await expect(credit.querySelector('[lang="ja"]')).toHaveTextContent(longCredit.name);
  await expect(credit.querySelector('[data-slot="cover-card-secondary"]')).toBeNull();
  const cast = person.closest('section')!;
  await expect(
    within(cast).getByRole('link', { name: m.subject_section_more({ label: m.subject_cast() }) }),
  ).toHaveAttribute('href', expect.stringContaining('node=cast&cursor=cast-next'));
};

export const CompleteCredit: Story = {
  render: () => <QualifiedRelationsReader long />,
  play: completeCredit,
};
