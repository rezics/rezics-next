import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import navigationAndTheme from '../../../../tests/qa/fixtures/outcomes/zone/navigation-and-theme.json';
import { addressKey, spaceHref } from '../address/path.ts';
import type { CanonicalAddress } from '@rezics/model/address';
import { localizedPath } from '../../i18n/locale.ts';
import { messages as realmMessages } from '../realm/messages.ts';
import type { ZonePresentationRead } from '../realm/types.ts';
import { messages as shellMessages } from '../shell/messages.ts';
import { messages as zoneMessages } from '../zones/messages.ts';
import { messages as editorMessages } from './messages.ts';
import { zoneNavigationPath, zoneThemePath } from './routes.ts';
import { RecordedNavigationTheme } from './zone-navigation-theme-recorded-page.tsx';
import { zoneIdFromRecordedPath } from './zone-navigation-theme-recorded-page.ts';

const record = navigationAndTheme as AnswerRecord;
const locale = 'en';
// Route parameters stay independent of the answer selected for this Zone.
const publishedZoneId = '6fb6dc7e-79f0-8b61-8d2e-96f29bf19977';
const emptyZoneId = '0343da38-4096-8bfb-8e4d-4f9644c76f72';
const copy = editorMessages[locale];

function sample(persona: AnswerPersona, label: string) {
  const found = record.personas[persona].find(item => item.label === label);
  if (!found) throw new Error(`Missing recorded sample ${persona}/${label}`);
  return found;
}

function presentationOf(persona: AnswerPersona, label: string) {
  return sample(persona, label).answer as ZonePresentationRead;
}

function sitePath(persona: AnswerPersona, label: string) {
  const address = presentationOf(persona, label).address as CanonicalAddress;
  return localizedPath(spaceHref(addressKey(address), 'site'), locale);
}

function mountedPath(persona: AnswerPersona, presentation: string, routeLabel: string) {
  const address = presentationOf(persona, presentation).address as CanonicalAddress;
  const route = sample(persona, routeLabel).answer as { mount: { segment: string } };
  return localizedPath(spaceHref(addressKey(address), 'site', [route.mount.segment]), locale);
}

function prose(document: unknown): string[] {
  const out: string[] = [];
  const visit = (node: unknown) => {
    if (!node || typeof node !== 'object') return;
    if ('type' in node && node.type === 'text' && 'text' in node && typeof node.text === 'string') out.push(node.text);
    if ('content' in node && Array.isArray(node.content)) node.content.forEach(visit);
    if ('doc' in node) visit(node.doc);
  };
  visit(document);
  return out;
}

const phone = { viewport: { value: 'phone' }, locale };

const meta = {
  title: 'Zone editor/Navigation and theme recorded',
  component: RecordedNavigationTheme,
  args: { record, locale, zoneId: publishedZoneId },
  globals: { locale },
} satisfies Meta<typeof RecordedNavigationTheme>;
export default meta;
type Story = StoryObj<typeof meta>;

export const PublishedVisitor: Story = {
  args: { persona: 'visitor', presentation: 'published-presentation', presentationState: 'populated' },
  parameters: { route: { pathname: sitePath('visitor', 'published-presentation') } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const answer = presentationOf('visitor', 'published-presentation');
    await expect(await canvas.findByRole('heading', { level: 1, name: answer.name! })).toBeVisible();
    const navigation = within(canvas.getByRole('navigation', { name: answer.name! }));
    await expect(navigation.getAllByRole('link').map(link => link.textContent)).toEqual([
      realmMessages.home, ...answer.navigation.map(mount => mount.name.value),
    ]);
    for (const text of prose(answer.home?.document)) await expect(canvas.getByText(text)).toBeVisible();
    const slide = answer.presentation.slides[0];
    if (slide && 'title' in slide && typeof slide.title === 'string') await expect(canvas.getByText(slide.title)).toBeVisible();
    await expect(canvasElement.querySelector('[data-zone-site-home-surface]')).toHaveAttribute(
      'data-zone-site-home-surface', answer.presentation.tokens.pageSurface);
  },
};
export const PublishedVisitorPhone: Story = { ...PublishedVisitor, globals: phone };

export const RepublishedOwner: Story = {
  args: { persona: 'owner', presentation: 'republished-presentation', presentationState: 'populated' },
  parameters: { route: { pathname: sitePath('owner', 'republished-presentation') } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const answer = presentationOf('owner', 'republished-presentation');
    await expect(await canvas.findByRole('heading', { level: 1, name: answer.name! })).toBeVisible();
    const navigation = within(canvas.getByRole('navigation', { name: answer.name! }));
    await expect(navigation.getAllByRole('link').map(link => link.textContent)).toEqual([
      realmMessages.home, ...answer.navigation.map(mount => mount.name.value),
    ]);
    await expect(answer.navigation).toHaveLength(2);
    for (const text of prose(answer.home?.document)) await expect(canvas.getByText(text)).toBeVisible();
    await expect(canvasElement.querySelector('[data-zone-site-home-surface]')).toHaveAttribute(
      'data-zone-site-home-surface', answer.presentation.tokens.pageSurface);
  },
};
export const RepublishedOwnerPhone: Story = { ...RepublishedOwner, globals: phone };

export const EmptyHomeVisitor: Story = {
  args: { persona: 'visitor', zoneId: emptyZoneId, presentation: 'empty-home-presentation', presentationState: 'empty' },
  parameters: { route: { pathname: sitePath('visitor', 'empty-home-presentation') } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const answer = presentationOf('visitor', 'empty-home-presentation');
    await expect(await canvas.findByRole('heading', { level: 1, name: answer.name! })).toBeVisible();
    const navigation = within(canvas.getByRole('navigation', { name: answer.name! }));
    await expect(navigation.getAllByRole('link').map(link => link.textContent)).toEqual([realmMessages.home]);
    await expect(canvasElement.querySelector('[data-zone-members]')?.querySelectorAll('li')).toHaveLength(0);
  },
};
export const EmptyHomeVisitorPhone: Story = { ...EmptyHomeVisitor, globals: phone };

export const EmptyIndexVisitor: Story = {
  args: {
    persona: 'visitor', presentation: 'published-presentation', presentationState: 'populated',
    route: 'published-index-empty', routeState: 'empty', path: '/published-link',
  },
  parameters: { route: { pathname: mountedPath('visitor', 'published-presentation', 'published-index-empty') } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const answer = presentationOf('visitor', 'published-presentation');
    await expect(await canvas.findByRole('heading', { level: 1, name: answer.name! })).toBeVisible();
    const members = canvasElement.querySelector('[data-zone-members]');
    await expect(members).not.toBeNull();
    await expect(members?.querySelectorAll('li')).toHaveLength(0);
    await expect(canvas.queryByRole('link', { name: realmMessages.showMore })).toBeNull();
  },
};
export const EmptyIndexVisitorPhone: Story = { ...EmptyIndexVisitor, globals: phone };

export const ThemeOwner: Story = {
  args: { persona: 'owner', configuration: 'draft-configuration', configurationState: 'populated' },
  parameters: {
    route: { pathname: localizedPath(zoneThemePath(zoneIdFromRecordedPath(sample('owner', 'draft-configuration').path)), locale) },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const answer = sample('owner', 'draft-configuration').answer as { name: string };
    const acting = new URL(sample('owner', 'draft-configuration').path, 'https://recorded.invalid').searchParams.get('actingSubject');
    await expect(await canvas.findByRole('heading', { level: 1, name: answer.name })).toBeVisible();
    await expect(canvas.getByRole('radio', { name: copy.themeCompact })).toBeChecked();
    await expect(canvas.getByRole('radio', { name: copy.themeCards })).toBeChecked();
    await expect(canvas.getByRole('radio', { name: copy.themeComfortable })).not.toBeChecked();
    await expect(canvas.getByRole('radio', { name: copy.themeFlat })).not.toBeChecked();
    if (acting) await expect(canvas.getAllByText(acting).length).toBeGreaterThan(0);
  },
};
export const ThemeOwnerPhone: Story = { ...ThemeOwner, globals: phone };

export const ThemeRefusedStranger: Story = {
  args: { persona: 'stranger', configuration: 'draft-configuration-refused', configurationState: 'error' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('alert')).toBeVisible();
    await expect(canvas.getByRole('heading', { name: copy.deniedTitle })).toBeVisible();
    await expect(canvas.queryByRole('radio', { name: copy.themeCompact })).toBeNull();
  },
};
export const ThemeRefusedStrangerPhone: Story = { ...ThemeRefusedStranger, globals: phone };

export const ThemeStaleOwner: Story = {
  args: {
    persona: 'owner', save: 'stale-configuration-refused',
    presentation: 'published-presentation', presentationState: 'populated',
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const answer = presentationOf('owner', 'published-presentation');
    await expect(await canvas.findByRole('heading', { level: 1, name: answer.name! })).toBeVisible();
    const alert = await canvas.findByRole('alert');
    await expect(alert).toHaveTextContent(copy.themeStaleTitle);
    await expect(canvas.getByRole('radio', { name: copy.themeComfortable })).toBeChecked();
    await expect(canvas.getByRole('radio', { name: copy.themeFlat })).toBeChecked();
  },
};
export const ThemeStaleOwnerPhone: Story = { ...ThemeStaleOwner, globals: phone };

export const LoadingVisitor: Story = {
  args: { persona: 'visitor', presentation: 'published-presentation', presentationState: 'loading' },
  parameters: { route: { pathname: sitePath('visitor', 'published-presentation') } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const answer = presentationOf('visitor', 'published-presentation');
    const status = await canvas.findByRole('status');
    await expect(status).toHaveTextContent(shellMessages.loading);
    await expect(status).toHaveAttribute('aria-busy', 'true');
    for (const text of prose(answer.home?.document)) await expect(canvas.queryByText(text)).toBeNull();
    await expect(canvas.queryByRole('heading', { name: answer.name! })).toBeNull();
  },
};
export const LoadingVisitorPhone: Story = { ...LoadingVisitor, globals: phone };

export const RouteRefusedVisitor: Story = {
  args: {
    persona: 'visitor', presentation: 'published-presentation', presentationState: 'populated',
    route: 'unpublished-route-refused', routeState: 'error', path: '/draft-link',
  },
  parameters: { route: { pathname: sitePath('visitor', 'published-presentation') } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const answer = presentationOf('visitor', 'published-presentation');
    await expect(await canvas.findByRole('heading', { name: zoneMessages.pageMissingTitle })).toBeVisible();
    await expect(canvas.getByText(zoneMessages.pageMissingBody)).toBeVisible();
    const address = answer.address as CanonicalAddress;
    await expect(canvas.getByRole('link', { name: zoneMessages.pageMissingBack })).toHaveAttribute(
      'href', localizedPath(spaceHref(addressKey(address), 'site'), locale));
  },
};
export const RouteRefusedVisitorPhone: Story = { ...RouteRefusedVisitor, globals: phone };

const navigationOwnerArgs = {
  persona: 'owner' as const,
  navigation: 'draft-navigation-editor',
  navigationState: 'populated' as const,
  navigationDraft: 'showcase-editor',
  navigationHeads: 'draft-navigation',
  mountNames: 'mount-target-collection-name',
  mountWork: 'mount-target-work',
};

export const NavigationOwner: Story = {
  args: navigationOwnerArgs,
  parameters: {
    route: {
      pathname: localizedPath(zoneNavigationPath(zoneIdFromRecordedPath(sample('owner', 'draft-navigation-editor').path)), locale),
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const zone = sample('owner', 'draft-navigation-editor').answer as {
      name: string;
      mounts: { qualifier: { routeSegment: string } }[];
    };
    const named = sample('owner', 'mount-target-collection-name').answer as { name: { labels: { und: string } } };
    const pageName = named.name.labels.und;
    const acting = new URL(sample('owner', 'draft-navigation-editor').path, 'https://recorded.invalid')
      .searchParams.get('actingSubject');
    await expect(await canvas.findByRole('heading', { level: 1, name: zone.name })).toBeVisible();
    await expect(canvas.getByRole('heading', { name: copy.navTitle })).toBeVisible();
    const links = within(canvas.getByRole('list', { name: copy.linksLabel }));
    await expect(links.getAllByText(pageName)).toHaveLength(zone.mounts.length);
    await expect(links.getAllByRole('textbox').map(input => (input as HTMLInputElement).value)).toEqual(
      zone.mounts.map(mount => mount.qualifier.routeSegment));
    await expect(canvas.queryByRole('button', { name: copy.navContinue })).toBeNull();
    await expect(canvas.getByRole('button', { name: copy.save })).toBeDisabled();
    await expect(canvas.queryByText('Resource is unavailable')).toBeNull();
    if (acting) await expect(canvas.getAllByText(acting).length).toBeGreaterThan(0);
  },
};
export const NavigationOwnerPhone: Story = { ...NavigationOwner, globals: phone };

export const NavigationLoadingOwner: Story = {
  args: { persona: 'owner', navigation: 'draft-navigation-editor', navigationState: 'loading' },
  parameters: NavigationOwner.parameters,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const zone = sample('owner', 'draft-navigation-editor').answer as { name: string };
    const status = await canvas.findByRole('status');
    await expect(status).toHaveTextContent(shellMessages.loading);
    await expect(status).toHaveAttribute('aria-busy', 'true');
    await expect(canvas.queryByRole('heading', { name: zone.name })).toBeNull();
    await expect(canvas.queryByRole('list', { name: copy.linksLabel })).toBeNull();
  },
};
export const NavigationLoadingOwnerPhone: Story = { ...NavigationLoadingOwner, globals: phone };
