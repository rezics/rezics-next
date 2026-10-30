import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { traversalRealm, traversalSubjects, type TraversalScenario } from '../kernel/fake/edition-work';
import { subjectViewHref } from '../subject/subject-href';
import { PageStory, pageReady } from './page';
import { m } from '../paraglide/messages.js';

const meta = {
  title: 'Pages/Subjects/Edition Work',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
const phone = {
  viewport: {
    viewports: { phone390: { name: 'Phone 390', styles: { width: '390px', height: '844px' }, type: 'mobile' } },
    defaultViewport: 'phone390',
  },
};
const desktop = {
  viewport: {
    viewports: { desktop1280: { name: 'Desktop 1280', styles: { width: '1280px', height: '900px' }, type: 'desktop' } },
    defaultViewport: 'desktop1280',
  },
};
function Journey({ scenario, view = 'overview' }: { scenario: TraversalScenario; view?: string }) {
  const path = subjectViewHref(traversalSubjects[scenario], 'en', view, `?realm=${traversalRealm}`).replace(
    /^\/en/,
    '',
  );
  return <PageStory visitor="Signed Out" path={path} />;
}
export const EditionPhone390: Story = {
  parameters: phone,
  play: pageReady,
  render: () => <Journey scenario="edition" />,
};
export const WorkDesktop1280: Story = {
  parameters: desktop,
  play: pageReady,
  render: () => <Journey scenario="work" />,
};
export const EditionsOverTwelve: Story = {
  parameters: phone,
  render: () => <Journey scenario="work" view="editions" />,
  play: async (context) => {
    await pageReady(context);
    const stream = context.canvasElement.querySelector('[data-node="editions"]') as HTMLElement;
    await userEvent.click(within(stream).getByRole('link', { name: m.subject_relations_more() }));
    await expect(await within(stream).findByText('Edition 15')).toBeVisible();
    await expect(stream.querySelector('[data-slot="continue-group"]')).toBeNull();
  },
};
export const IndependentRoles: Story = {
  parameters: desktop,
  render: () => <Journey scenario="creator" view="works" />,
  play: async (context) => {
    await pageReady(context);
    const author = context.canvasElement.querySelector('[data-node="author"]') as HTMLElement;
    const illustrator = context.canvasElement.querySelector('[data-node="illustrator"]') as HTMLElement;
    const untouched = illustrator.innerHTML;
    await userEvent.click(within(author).getByRole('link', { name: m.subject_relations_more() }));
    await expect(await within(author).findByText('author 15')).toBeVisible();
    await expect(illustrator.innerHTML).toBe(untouched);
  },
};
export const HiddenTarget: Story = {
  parameters: phone,
  play: pageReady,
  render: () => <Journey scenario="hidden" />,
};
export const SourceUnavailable: Story = {
  parameters: desktop,
  play: pageReady,
  render: () => <Journey scenario="unavailable" />,
};
export const RoleConflict: Story = {
  parameters: phone,
  render: () => <Journey scenario="conflict" view="works" />,
  play: async (context) => {
    await pageReady(context);
    const author = context.canvasElement.querySelector('[data-node="author"]') as HTMLElement;
    const illustrator = context.canvasElement.querySelector('[data-node="illustrator"]') as HTMLElement;
    const untouched = illustrator.innerHTML;
    await userEvent.click(within(author).getByRole('link', { name: m.subject_relations_more() }));
    await expect(await within(author).findByRole('alert')).toBeVisible();
    await expect(within(author).getByText('author 12')).toBeVisible();
    await expect(illustrator.innerHTML).toBe(untouched);
  },
};
