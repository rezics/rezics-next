import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import staticGuide from '../kernel/recorded/zone-static-guide.json';
import staticHome from '../kernel/recorded/zone-static-home.json';
import staticOwnerHome from '../kernel/recorded/zone-static-owner-home.json';
import staticSubject from '../kernel/recorded/zone-static-subject.json';
import { PageStory, pageReady } from './page';

const zone = staticHome.zone.id;
const privateZone = staticOwnerHome.zone.id;
const subject = staticSubject.subject.id;
const hiddenZone = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e02';
const unavailableZone = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e05';

const meta = { title: 'Pages/Community/Zone', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

type RecordedTextPage = { document: { content: { props: Record<string, unknown> }[] } };

function recordedText(page: RecordedTextPage, id: string): string {
  const node = page.document.content.find((item) => item.props.id === id);
  const value = node?.props.text;
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && value !== null && !Array.isArray(value))
    return (value as Record<string, string>)[getLocale()] ?? '';
  return '';
}

async function staticHomeReady({ canvasElement }: { canvasElement: HTMLElement }) {
  await pageReady({ canvasElement });
  const view = within(canvasElement);
  await view.findByRole('heading', { name: staticHome.zone.labels[getLocale()] });
  await view.findByText(recordedText(staticHome, 'zone-copy'));
  await view.findByRole('navigation', { name: m.zone_navigation() });
  const subjectLabel = staticSubject.subject.labels[getLocale()];
  const subjectLink = await view.findByRole('link', { name: subjectLabel });
  expect(subjectLink).toHaveAttribute('href', expect.stringContaining(`/subjects/${subject}/`));
  await view.findByRole('link', { name: zoneRouteLabel('guide') });
}

function zoneRouteLabel(route: string): string {
  return (route.split('/').at(-1) ?? route).replaceAll('-', ' ').replace(/\b\p{L}/gu, (letter) => letter.toUpperCase());
}

async function configuredPageReady({ canvasElement }: { canvasElement: HTMLElement }) {
  await pageReady({ canvasElement });
  const view = within(canvasElement);
  await view.findByRole('heading', { name: recordedText(staticGuide, 'guide-title') });
  await view.findByText(recordedText(staticGuide, 'guide-copy'));
  await view.findByRole('navigation', { name: m.zone_navigation() });
}

async function configuredAppearanceReady({ canvasElement }: { canvasElement: HTMLElement }) {
  await configuredPageReady({ canvasElement });
  const view = within(canvasElement);
  const page = await view.findByRole('heading', { name: recordedText(staticGuide, 'guide-title') });
  const surface = page.closest('[data-zone-page]');
  expect(surface).toHaveAttribute('data-density', 'comfortable');
  expect(surface).toHaveAttribute('data-radius', 'md');
  expect(surface).toHaveAttribute('data-surface', 'cards');
}

async function privateOwnerReady({ canvasElement }: { canvasElement: HTMLElement }) {
  await pageReady({ canvasElement });
  const view = within(canvasElement);
  await view.findByRole('heading', { name: staticOwnerHome.zone.labels[getLocale()] });
  await view.findByText(recordedText(staticOwnerHome, 'private-copy'));
  await view.findByRole('navigation', { name: m.zone_navigation() });
  expect(view.queryByRole('searchbox')).toBeNull();
  expect(view.queryByRole('button', { name: /scope|mount|prepare|edit/i })).toBeNull();
}

async function unknownZoneReady({ canvasElement }: { canvasElement: HTMLElement }) {
  await pageReady({ canvasElement });
  const view = within(canvasElement);
  await view.findByRole('heading', { name: m.not_found_heading() });
  expect(view.queryByRole('navigation', { name: m.zone_navigation() })).toBeNull();
  expect(view.queryByText(staticHome.zone.labels.en)).toBeNull();
}

async function unavailableReady({ canvasElement }: { canvasElement: HTMLElement }) {
  await pageReady({ canvasElement });
  const view = within(canvasElement);
  await view.findByRole('heading', { name: m.error_heading() });
  expect(view.queryByRole('heading', { name: m.zone_preparing_heading() })).toBeNull();
  expect(view.queryByRole('navigation', { name: m.zone_navigation() })).toBeNull();
}

export const Home: Story = {
  id: 'pages-zones-home-with-mounted-collections',
  name: 'Static home',
  play: staticHomeReady,
  render: () => <PageStory visitor="Signed Out" path={`/zones/${zone}`} />,
};

export const PrivateOwner: Story = {
  name: 'Private page for its owner',
  play: privateOwnerReady,
  render: () => <PageStory visitor="Signed In" path={`/zones/${privateZone}`} />,
};

export const Subject: Story = {
  id: 'pages-zones-subject-page-in-a-zone',
  name: 'Configured static page',
  play: configuredPageReady,
  render: () => <PageStory visitor="Signed Out" path={`/zones/${zone}/guide`} />,
};

export const AlternateAppearance: Story = {
  id: 'pages-zones-alternate-appearance-preset',
  name: 'Configured page appearance',
  play: configuredAppearanceReady,
  render: () => <PageStory visitor="Signed Out" path={`/zones/${zone}/guide`} />,
};

export const Preparing: Story = {
  id: 'pages-zones-preparing-page-continues-in-the-browser',
  name: 'Unknown configured route',
  play: unknownZoneReady,
  render: () => <PageStory visitor="Signed Out" path={`/zones/${zone}/not-configured`} />,
};

export const Unavailable: Story = {
  id: 'pages-zones-preparing-page-waits-for-the-kernel',
  name: 'Unavailable read',
  play: unavailableReady,
  render: () => <PageStory visitor="Signed Out" path={`/zones/${unavailableZone}`} />,
};

export const UnknownZone: Story = {
  name: 'Private or missing Zone',
  play: unknownZoneReady,
  render: () => <PageStory visitor="Signed Out" path={`/zones/${hiddenZone}`} />,
};

export const DirectTargetsClosed: Story = {
  name: 'Direct subject routes are closed',
  play: unknownZoneReady,
  render: () => <PageStory visitor="Signed Out" path={`/zones/${zone}/subjects/${subject}`} />,
};
