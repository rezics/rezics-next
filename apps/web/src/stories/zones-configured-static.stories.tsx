import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import {
  configuredStaticEmptyFake as emptyZone,
  configuredStaticZoneGuideFake as siteGuide,
  configuredStaticZoneHomeFake as siteHome,
  configuredStaticZonePrivateFake as privateZone,
} from '../zones/static-fakes';
import { PageStory, pageReady } from './page';

const unavailableZone = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e05';
const sourceClosedZone = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e1e';

const meta = {
  title: 'Community/Zones/Configured static site',
  id: 'pages-community-zones-configured-static-site',
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Fictional examples of configured routed documents with no planned source reads. Source-dependent examples are gated preview/deferred demonstrations, not an official launch roster.',
      },
    },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

type StoryTextPage = { document: unknown };

function localizedText(page: StoryTextPage, id: string): string {
  const document = page.document as { content?: { props?: Record<string, unknown> }[] };
  const value = document.content?.find((node) => node.props?.id === id)?.props?.text;
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const selected = (value as Record<string, unknown>)[getLocale()];
    if (typeof selected === 'string') return selected;
  }
  return '';
}

function localizedZonePath(id: string, route = ''): string {
  return `/${getLocale()}/zones/${id}${route ? `/${route}` : ''}`;
}

async function linkForHref(view: ReturnType<typeof within>, href: string): Promise<HTMLElement> {
  const links = await view.findAllByRole('link');
  const link = links.find((candidate) => candidate.getAttribute('href') === href);
  if (!link) throw new Error(`The configured Zone navigation omitted ${href}.`);
  expect(link).toHaveAccessibleName();
  return link;
}

async function staticJourneyReady({ canvasElement }: { canvasElement: HTMLElement }) {
  await pageReady({ canvasElement });
  const view = within(canvasElement);
  const homeTitle = siteHome.zone.labels[getLocale()];
  const homeCopy = localizedText(siteHome, 'tideglass-intro');
  const guideTitle = localizedText(siteGuide, 'tideglass-guide-title');
  const guideCopy = localizedText(siteGuide, 'tideglass-guide-copy');

  await view.findByRole('heading', { level: 1, name: homeTitle });
  await view.findByText(homeCopy);
  await view.findByRole('navigation', { name: m.zone_navigation() });

  const guideHref = localizedZonePath(siteHome.zone.id, 'guide');
  await userEvent.click(await linkForHref(view, guideHref));
  await view.findByRole('heading', { level: 1, name: guideTitle });
  await view.findByText(guideCopy);
  await view.findByRole('navigation', { name: m.zone_navigation() });

  const homeHref = localizedZonePath(siteHome.zone.id);
  await userEvent.click(await linkForHref(view, homeHref));
  await view.findByRole('heading', { level: 1, name: homeTitle });
  await view.findByText(homeCopy);
}

async function emptyDocumentReady({ canvasElement }: { canvasElement: HTMLElement }) {
  await pageReady({ canvasElement });
  const view = within(canvasElement);
  expect(canvasElement.querySelector('[data-zone-page]')).not.toBeNull();
  expect(view.queryByRole('heading', { name: m.not_found_heading() })).toBeNull();
  expect(view.queryByRole('heading', { name: m.error_heading() })).toBeNull();
}

async function unavailableReadReady({ canvasElement }: { canvasElement: HTMLElement }) {
  await pageReady({ canvasElement });
  const view = within(canvasElement);
  await view.findByRole('heading', { name: m.error_heading() });
  expect(view.queryByRole('heading', { name: m.zone_preparing_heading() })).toBeNull();
  expect(view.queryByRole('navigation', { name: m.zone_navigation() })).toBeNull();
}

async function privateMissingReady({ canvasElement }: { canvasElement: HTMLElement }) {
  await pageReady({ canvasElement });
  const view = within(canvasElement);
  await view.findByRole('heading', { name: m.not_found_heading() });
  expect(view.queryByRole('navigation', { name: m.zone_navigation() })).toBeNull();
  expect(view.queryByRole('heading', { name: siteHome.zone.labels.en })).toBeNull();
}

async function sourceClosedReady({ canvasElement }: { canvasElement: HTMLElement }) {
  await pageReady({ canvasElement });
  const view = within(canvasElement);
  await view.findByRole('heading', { name: m.error_heading() });
  expect(view.queryByRole('heading', { name: m.zone_preparing_heading() })).toBeNull();
  expect(view.queryByRole('navigation', { name: m.zone_navigation() })).toBeNull();
}

export const HomeGuideReturn: Story = {
  name: 'Configured home → guide → home',
  play: staticJourneyReady,
  render: () => <PageStory visitor="Signed Out" path={`/zones/${siteHome.zone.id}`} />,
};

export const EmptyDocument: Story = {
  name: 'Admitted empty document',
  play: emptyDocumentReady,
  render: () => <PageStory visitor="Signed Out" path={`/zones/${emptyZone.zone.id}`} />,
};

export const UnavailableRead: Story = {
  name: 'Unavailable routed read',
  play: unavailableReadReady,
  render: () => <PageStory visitor="Signed Out" path={`/zones/${unavailableZone}`} />,
};

export const PrivateOrMissing: Story = {
  name: 'Private Zone appears missing to an anonymous reader',
  play: privateMissingReady,
  render: () => <PageStory visitor="Signed Out" path={`/zones/${privateZone.zone.id}`} />,
};

export const SourceReadClosed: Story = {
  name: 'Gated preview/deferred: source read denied (403 platform_closed)',
  parameters: {
    docs: {
      description: {
        story: 'This denied source state is a gated preview/deferred demonstration, not public native readiness.',
      },
    },
  },
  play: sourceClosedReady,
  render: () => <PageStory visitor="Signed Out" path={`/zones/${sourceClosedZone}`} />,
};

export const SourceReadUnavailable: Story = {
  name: 'Gated preview/deferred: source read unavailable (503 presentation_not_ready)',
  parameters: {
    docs: {
      description: {
        story: 'Unavailable source response in a gated preview/deferred demonstration.',
      },
    },
  },
  play: unavailableReadReady,
  render: () => <PageStory visitor="Signed Out" path={`/zones/${unavailableZone}`} />,
};
