import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { traversalRealm, traversalSubjects, type TraversalScenario } from '../kernel/fake/edition-work';
import { subjectViewHref } from '../subject/subject-href';
import { PageStory, pageReady } from './page';
import { m } from '../paraglide/messages.js';

const meta = {
  title: 'Subjects/Edition Work',
  id: 'pages-subjects-edition-work',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
function Journey({ scenario, view = 'overview' }: { scenario: TraversalScenario; view?: string }) {
  const path = subjectViewHref(traversalSubjects[scenario], 'en', view, `?realm=${traversalRealm}`).replace(
    /^\/en/,
    '',
  );
  return <PageStory visitor="Signed Out" path={path} />;
}
export const Edition: Story = {
  play: pageReady,
  render: () => <Journey scenario="edition" />,
};
export const Work: Story = {
  play: async (context) => {
    await pageReady(context);
    const canvas = within(context.canvasElement);
    await expect(await canvas.findByRole('heading', { level: 1, name: traversalSubjects.work.label })).toBeVisible();
    const lastEdition = await canvas.findByRole('link', { name: 'Edition 12' });
    await expect(lastEdition).toBeVisible();
    const preview = lastEdition.closest('section') as HTMLElement;
    await expect(within(preview).getAllByRole('article')).toHaveLength(12);
    await expect(within(preview).queryByRole('link', { name: 'Edition 13' })).toBeNull();
    await expect(within(preview).getByRole('link', { name: m.home_see_all() })).toHaveAttribute(
      'href',
      expect.stringContaining(`/subjects/${traversalSubjects.work.id}/the-harbour/editions?realm=${traversalRealm}`),
    );
  },
  render: () => <Journey scenario="work" />,
};
export const EditionsOverTwelve: Story = {
  render: () => <Journey scenario="work" view="editions" />,
  play: async (context) => {
    await pageReady(context);
    await within(context.canvasElement).findByText('Edition 12');
    const stream = context.canvasElement.querySelector('[data-node="editions"]') as HTMLElement;
    const moreEditions = m.subject_section_more({ label: 'Editions' });
    await expect(within(stream).queryByText('Edition 15')).toBeNull();
    await expect(within(stream).getByRole('link', { name: moreEditions })).toHaveAttribute(
      'href',
      expect.stringContaining(`node=editions&cursor=fixture-editions-next&realm=${traversalRealm}`),
    );
    await userEvent.click(within(stream).getByRole('link', { name: moreEditions }));
    await expect(await within(stream).findByText('Edition 15')).toBeVisible();
    await expect(within(stream).getByText('Edition 12')).toBeVisible();
    await expect(stream.querySelector('[data-slot="continue-group"]')).toBeNull();
  },
};
export const IndependentRoles: Story = {
  render: () => <Journey scenario="creator" view="works" />,
  play: async (context) => {
    await pageReady(context);
    await within(context.canvasElement).findByText('author 12');
    await within(context.canvasElement).findByText('illustrator 12');
    const author = context.canvasElement.querySelector('[data-node="author"]') as HTMLElement;
    const illustrator = context.canvasElement.querySelector('[data-node="illustrator"]') as HTMLElement;
    const untouched = illustrator.innerHTML;
    const moreWrittenWorks = m.subject_section_more({ label: 'Written works' });
    const moreIllustratedWorks = m.subject_section_more({ label: 'Illustrated works' });
    await userEvent.click(within(author).getByRole('link', { name: moreWrittenWorks }));
    await expect(await within(author).findByText('author 15')).toBeVisible();
    await expect(illustrator.innerHTML).toBe(untouched);
    await expect(author.querySelector('[data-slot="continue-group"]')).toBeNull();
    const completedAuthor = author.innerHTML;
    await userEvent.click(within(illustrator).getByRole('link', { name: moreIllustratedWorks }));
    await expect(await within(illustrator).findByText('illustrator 14')).toBeVisible();
    await expect(illustrator.querySelector('[data-slot="continue-group"]')).toBeNull();
    await expect(author.innerHTML).toBe(completedAuthor);
  },
};
export const HiddenTarget: Story = {
  play: pageReady,
  render: () => <Journey scenario="hidden" />,
};
export const SourceUnavailable: Story = {
  play: pageReady,
  render: () => <Journey scenario="unavailable" />,
};
export const RoleConflict: Story = {
  render: () => <Journey scenario="conflict" view="works" />,
  play: async (context) => {
    await pageReady(context);
    await within(context.canvasElement).findByText('author 12');
    await within(context.canvasElement).findByText('illustrator 12');
    const author = context.canvasElement.querySelector('[data-node="author"]') as HTMLElement;
    const illustrator = context.canvasElement.querySelector('[data-node="illustrator"]') as HTMLElement;
    const untouched = illustrator.innerHTML;
    const moreWrittenWorks = m.subject_section_more({ label: 'Written works' });
    const moreIllustratedWorks = m.subject_section_more({ label: 'Illustrated works' });
    await userEvent.click(within(author).getByRole('link', { name: moreWrittenWorks }));
    await expect(await within(author).findByRole('alert')).toBeVisible();
    await expect(within(author).getByRole('alert')).toHaveTextContent(m.subject_relation_invalid());
    await expect(within(author).getByText('author 12')).toBeVisible();
    await expect(illustrator.innerHTML).toBe(untouched);
    await expect(within(author).getByRole('link', { name: m.subject_relation_restart() })).toHaveAttribute(
      'href',
      expect.stringContaining(`node=author&realm=${traversalRealm}`),
    );
    await userEvent.click(within(illustrator).getByRole('link', { name: moreIllustratedWorks }));
    await expect(await within(illustrator).findByText('illustrator 14')).toBeVisible();
    await expect(within(author).getByRole('alert')).toHaveTextContent(m.subject_relation_invalid());
  },
};
