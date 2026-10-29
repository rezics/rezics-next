import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { PageStory, pageReady } from './page';

const zone = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e01';
const alternate = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e06';
const subject = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e01';
const preparing = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e04';
const unavailable = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e05';

const meta = { title: 'Pages/Zones', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

async function zoneHomeReady({ canvasElement }: { canvasElement: HTMLElement }) {
  await pageReady({ canvasElement });
  const view = within(canvasElement);
  await view.findByText('Field Notes');
  await view.findByRole('heading', { name: 'A clear view of the collection' });
  await view.findByRole('navigation', { name: 'Zone navigation' });
  await view.findByRole('link', { name: 'Kokoro' });
}

async function zoneSubjectReady({ canvasElement }: { canvasElement: HTMLElement }) {
  await pageReady({ canvasElement });
  const view = within(canvasElement);
  await view.findByRole('heading', { name: 'Kokoro' });
  await view.findByRole('navigation', { name: 'Subject views' });
  await view.findByText('Field Notes');
}

async function alternateAppearanceReady({ canvasElement }: { canvasElement: HTMLElement }) {
  await pageReady({ canvasElement });
  const view = within(canvasElement);
  const page = await view.findByRole('heading', { name: 'A clear view of the collection' });
  const zonePage = page.closest('[data-zone-page]');
  expect(zonePage).toHaveAttribute('data-density', 'comfortable');
  expect(zonePage).toHaveAttribute('data-radius', 'lg');
  expect(zonePage).toHaveAttribute('data-surface', 'flat');
}

export const Home: Story = {
  name: 'Home with mounted Collections',
  play: zoneHomeReady,
  render: () => <PageStory visitor="Signed Out" path={`/zones/${zone}`} />,
};

export const Subject: Story = {
  name: 'Subject page in a Zone',
  play: zoneSubjectReady,
  render: () => <PageStory visitor="Signed Out" path={`/zones/${zone}/subjects/${subject}`} />,
};

export const AlternateAppearance: Story = {
  name: 'Alternate appearance preset',
  play: alternateAppearanceReady,
  render: () => <PageStory visitor="Signed Out" path={`/zones/${alternate}`} />,
};

export const Preparing: Story = {
  name: 'Preparing page continues in the browser',
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/zones/${preparing}`} />,
};

export const Unavailable: Story = {
  name: 'Preparing page waits for the kernel',
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/zones/${unavailable}`} />,
};
