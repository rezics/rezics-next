import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { continuationSubject } from '../kernel/fake/view-continuation';
import { subjectViewHref } from '../subject/subject-href';
import { PageStory, pageReady } from './page';

const meta = { title: 'Pages/Subject Continuation', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
const path = subjectViewHref(continuationSubject, 'en', 'editions').replace(/^\/en/, '');

async function continuationReady(context: { canvasElement: HTMLElement }, later: boolean) {
  await pageReady(context);
  const canvas = within(context.canvasElement);
  await expect(canvas.getByText(later ? 'Later edition 3' : 'First edition 24')).toBeVisible();
  const next = context.canvasElement.querySelector('a[data-slot="next-page"]');
  await expect(next).toHaveAttribute('href', expect.stringContaining('?cursor=continuation-next'));
}

export const Editions: Story = {
  play: (context) => continuationReady(context, false),
  render: () => <PageStory visitor="Signed Out" path={path} />,
};
export const EditionsSecondPage: Story = {
  play: (context) => continuationReady(context, true),
  render: () => <PageStory visitor="Signed Out" path={`${path}?cursor=continuation-next`} />,
};
