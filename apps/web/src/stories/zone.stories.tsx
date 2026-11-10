import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import {
  staticZoneGuideFake as staticGuide,
  staticZoneHomeFake as staticHome,
  staticZoneOwnerFake as staticOwnerHome,
} from '../zones/static-fakes';
import staticSubject from '../kernel/recorded/subject.json';
import { PageStory, pageReady } from './page';

const zone = staticHome.zone.id;
const privateZone = staticOwnerHome.zone.id;
const subject = staticSubject.subject.id;
const hiddenZone = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e02';
const unavailableZone = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e05';

const withinBudgetZone = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e03';

const meta = {
  title: 'Community/Zone',
  id: 'pages-community-zone',
  parameters: {
    layout: 'fullscreen',
    viewport: {
      options: {
        phone390: { name: 'Phone 390', styles: { width: '390px', height: '844px' } },
        desktop1280: { name: 'Desktop 1280', styles: { width: '1280px', height: '900px' } },
      },
    },
  },
} satisfies Meta;
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
  const subjectLinks = view.getAllByRole('link', { name: subjectLabel });
  expect(subjectLinks.some((link) => link.getAttribute('href')?.includes(`/subjects/${subject}/`))).toBe(true);
  expect(subjectLinks.some((link) => link.getAttribute('href')?.includes(`/zones/${zone}/subjects/${subject}`))).toBe(
    true,
  );
  expect(canvasElement.querySelector('[data-zone-type-list]')).not.toBeNull();
  const seeAll = await view.findByRole('link', { name: m.home_see_all() });
  expect(seeAll).toHaveAttribute('href', `/${getLocale()}/zones/${zone}?list=books`);
  const more = await view.findByRole('link', { name: m.library_more() });
  expect(more.getAttribute('href')).toContain(`/zones/${zone}`);
  expect(more.getAttribute('href')).toContain('list=books');
  expect(more.getAttribute('href')).not.toContain('/search/list');
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
  parameters: { __id: 'pages-zones-home-with-mounted-collections' },
  name: 'Static home',
  play: staticHomeReady,
  render: () => <PageStory visitor="Signed Out" path={`/zones/${zone}`} />,
};

export const PrivateOwner: Story = {
  name: 'Private page for its owner',
  play: privateOwnerReady,
  render: () => <PageStory visitor="Signed In" credentialMode="session" path={`/zones/${privateZone}`} />,
};

export const Subject: Story = {
  parameters: { __id: 'pages-zones-subject-page-in-a-zone' },
  name: 'Configured static page',
  play: configuredPageReady,
  render: () => <PageStory visitor="Signed Out" path={`/zones/${zone}/guide`} />,
};

export const AlternateAppearance: Story = {
  parameters: { __id: 'pages-zones-alternate-appearance-preset' },
  name: 'Configured page appearance',
  play: configuredAppearanceReady,
  render: () => <PageStory visitor="Signed Out" path={`/zones/${zone}/guide`} />,
};

export const Preparing: Story = {
  parameters: { __id: 'pages-zones-preparing-page-continues-in-the-browser' },
  name: 'Unknown configured route',
  play: unknownZoneReady,
  render: () => <PageStory visitor="Signed Out" path={`/zones/${zone}/not-configured`} />,
};

export const Unavailable: Story = {
  parameters: { __id: 'pages-zones-preparing-page-waits-for-the-kernel' },
  name: 'Unavailable read',
  play: unavailableReady,
  render: () => <PageStory visitor="Signed Out" path={`/zones/${unavailableZone}`} />,
};

export const UnknownZone: Story = {
  name: 'Private or missing Zone',
  play: unknownZoneReady,
  render: () => <PageStory visitor="Signed Out" path={`/zones/${hiddenZone}`} />,
};

async function subjectReturnReady({ canvasElement }: { canvasElement: HTMLElement }) {
  await pageReady({ canvasElement });
  const view = within(canvasElement);
  const siteName = staticHome.zone.labels[getLocale()] ?? m.zone_home();
  const back = await view.findByRole('link', { name: m.zone_subject_return({ name: siteName }) });
  expect(back).toHaveAttribute('href', `/${getLocale()}/zones/${zone}`);
  await view.findByRole('navigation', { name: m.zone_navigation() });
}

async function preparedToUsefulReady({ canvasElement }: { canvasElement: HTMLElement }) {
  await pageReady({ canvasElement });
  const view = within(canvasElement);
  await view.findByRole('heading', { name: 'Field Notes' });
  expect(view.queryByRole('heading', { name: m.zone_preparing_heading() })).toBeNull();
}

async function keyboardNavigationReady({ canvasElement }: { canvasElement: HTMLElement }) {
  await staticHomeReady({ canvasElement });
  await userEvent.tab();
  const view = within(canvasElement);
  const navigation = view.getByRole('navigation', { name: m.zone_navigation() });
  expect(navigation.querySelector('a')).toHaveFocus();
}

export const PreparedToUseful: Story = {
  parameters: { __id: 'pages-zones-prepared-to-useful-completion' },
  name: 'Prepared page reaches a useful route',
  play: preparedToUsefulReady,
  globals: { viewport: { value: 'desktop1280' } },
  render: () => <PageStory visitor="Signed Out" path={`/zones/${withinBudgetZone}`} />,
};

export const SubjectReturn: Story = {
  parameters: { __id: 'pages-zones-subject-return-to-route' },
  name: 'Direct subject returns to the Zone route',
  play: subjectReturnReady,
  globals: { viewport: { value: 'desktop1280' } },
  render: () => <PageStory visitor="Signed Out" path={`/zones/${zone}/subjects/${subject}`} />,
};

export const SubjectReturnPhone: Story = {
  name: 'Direct subject return on a narrow layout',
  play: subjectReturnReady,
  globals: { viewport: { value: 'phone390' } },
  render: () => <PageStory visitor="Signed Out" path={`/zones/${zone}/subjects/${subject}`} />,
};

export const KeyboardNavigation: Story = {
  name: 'Keyboard Zone navigation',
  play: keyboardNavigationReady,
  globals: { viewport: { value: 'desktop1280' } },
  render: () => <PageStory visitor="Signed Out" path={`/zones/${zone}`} />,
};

async function typeListFullReady({ canvasElement }: { canvasElement: HTMLElement }) {
  await pageReady({ canvasElement });
  const view = within(canvasElement);
  await view.findByRole('heading', { level: 1 });
  expect(view.queryByRole('link', { name: m.home_see_all() })).toBeNull();
  const subjectLabel = staticSubject.subject.labels[getLocale()];
  expect(
    view
      .getAllByRole('link', { name: subjectLabel })
      .some((link) => link.getAttribute('href')?.includes(`/zones/${zone}/subjects/`)),
  ).toBe(true);
}

export const TypeListFull: Story = {
  parameters: { __id: 'pages-zones-type-list-full-page-on-route' },
  name: 'TypeList full page stays on the Zone route',
  play: typeListFullReady,
  globals: { viewport: { value: 'desktop1280' } },
  render: () => <PageStory visitor="Signed Out" path={`/zones/${zone}?list=books`} />,
};

export const TypeListFullPhone: Story = {
  name: 'TypeList full page on a narrow layout',
  play: typeListFullReady,
  globals: { viewport: { value: 'phone390' } },
  render: () => <PageStory visitor="Signed Out" path={`/zones/${zone}?list=books`} />,
};

export const HomePhone: Story = {
  name: 'Static home on a narrow layout',
  play: staticHomeReady,
  globals: { viewport: { value: 'phone390' } },
  render: () => <PageStory visitor="Signed Out" path={`/zones/${zone}`} />,
};

export const HomeLocales: Story = {
  name: 'Static home in every launch locale',
  play: staticHomeReady,
  globals: { locale: 'zh-Hant', viewport: { value: 'desktop1280' } },
  render: () => <PageStory visitor="Signed Out" path={`/zones/${zone}`} />,
};

export const HomeDe: Story = {
  globals: { locale: 'de', viewport: { value: 'phone390' } },
  play: staticHomeReady,
  render: () => <PageStory visitor="Signed Out" path={`/zones/${zone}`} />,
};
export const HomeJa: Story = {
  globals: { locale: 'ja', viewport: { value: 'desktop1280' } },
  play: staticHomeReady,
  render: () => <PageStory visitor="Signed Out" path={`/zones/${zone}`} />,
};
export const HomeKo: Story = {
  globals: { locale: 'ko', viewport: { value: 'phone390' } },
  play: staticHomeReady,
  render: () => <PageStory visitor="Signed Out" path={`/zones/${zone}`} />,
};
export const HomeFr: Story = {
  globals: { locale: 'fr', viewport: { value: 'desktop1280' } },
  play: staticHomeReady,
  render: () => <PageStory visitor="Signed Out" path={`/zones/${zone}`} />,
};
export const HomeEs: Story = {
  globals: { locale: 'es', viewport: { value: 'phone390' } },
  play: staticHomeReady,
  render: () => <PageStory visitor="Signed Out" path={`/zones/${zone}`} />,
};
export const HomeZhHans: Story = {
  globals: { locale: 'zh-Hans', viewport: { value: 'desktop1280' } },
  play: staticHomeReady,
  render: () => <PageStory visitor="Signed Out" path={`/zones/${zone}`} />,
};
