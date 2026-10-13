import type { Meta, StoryObj } from '@storybook/react-vite';
import { useEffect, useState, type ReactNode } from 'react';
import { expect, within } from 'storybook/test';
import type { AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import homeRendering from '../../../../tests/qa/fixtures/outcomes/zone/home-rendering.json';
import { surfaceText } from '../address/messages.ts';
import { spaceHref } from '../address/path.ts';
import { BFF_PREFIX, browserMainApi } from '../api/browser.ts';
import { ReaderActionsProvider } from '../catalogue/reader-actions.tsx';
import { localizedPath } from '../../i18n/locale.ts';
import { zoneText } from '../realm/adapt.ts';
import { RealmMembership } from '../realm/membership.tsx';
import { realmMessagesFor } from '../realm/story-page.tsx';
import { realmHref, siteHref } from '../realm/route.ts';
import type { ZonePresentationRead } from '../realm/types.ts';
import { messages as shellMessages } from '../shell/messages.ts';
import LocalizedLink from '../shell/localized-link.tsx';
import { PageContainer } from '../shell/page.tsx';
import { recordedFetch, type RecordedState } from '../stories/recorded-fetch.ts';
import { LookMenu } from './look-menu.tsx';
import { zoneMessagesFor } from './fixtures.ts';
import { ZonePageMissing } from './page-missing.tsx';
import { MemberList } from './site-pages.tsx';
import type { SiteLink } from './site-navigation.tsx';
import { zoneTheme } from './theme.ts';
import { ZoneFrame, ZoneMasthead } from './zone-frame.tsx';
import { loadZoneHomeModules, readCompleteZonePresentation, readZoneRouteAnswer, zoneHomeIdentity,
  zoneHomePage, ZonePublishedHome } from './zone-home-recorded-page.tsx';

const record = homeRendering as AnswerRecord;
const persona = 'visitor';
const locale = 'en';
const messages = zoneMessagesFor(locale);
const realmMessages = realmMessagesFor(locale);

function sample(label: string) {
  const found = record.personas[persona].find(answer => answer.label === label);
  if (!found) throw new Error(`Missing recorded zone home answer: ${label}`);
  return found;
}

function pathId(label: string) {
  return new URL(sample(label).path, 'https://recorded.invalid').pathname.split('/')[3]!;
}

function queryValue(label: string, name: string) {
  const value = new URL(sample(label).path, 'https://recorded.invalid').searchParams.get(name);
  if (value === null) throw new Error(`Recorded ${label} has no ${name}`);
  return value;
}

function presentationOf(label: string) {
  return sample(label).answer as ZonePresentationRead;
}

function recordedName(label: string) {
  const name = presentationOf(label).name;
  if (!name) throw new Error(`Recorded ${label} has no name`);
  return name;
}

function nodes(value: unknown): Record<string, unknown>[] {
  if (!value || typeof value !== 'object') return [];
  const node = value as Record<string, unknown>;
  const nested = [node.doc, ...(Array.isArray(node.content) ? node.content : [])];
  return [node, ...nested.flatMap(nodes)];
}

function documentTexts(document: unknown): string[] {
  return nodes(document).flatMap(node => typeof node.text === 'string' ? [node.text] : []);
}

const published = presentationOf('published-presentation');
const publishedHome = published.home;
if (!publishedHome) throw new Error('Recorded published presentation has no home');
const publishedKey = published.address.key;
const emptyKey = presentationOf('empty-home-presentation').address.key;
const ownerText = documentTexts(publishedHome.document)[0];
const placeholder = publishedHome.blocks.find(block => block.status === 'placeholder');
const resolvedBlock = publishedHome.blocks.find(block => block.status === 'resolved');
if (!ownerText || !placeholder || !resolvedBlock) throw new Error('Recorded home is missing its text or blocks');
const slide = published.presentation.slides[0];
if (!slide?.title || !('href' in slide)) throw new Error('Recorded home is missing its slide');
const mount = published.navigation[0];
if (!mount) throw new Error('Recorded home is missing its mount');
const draftPath = queryValue('unpublished-route-refused', 'path');
const refusalTitle = (sample('unpublished-route-refused').answer as { title?: string }).title;
if (!refusalTitle) throw new Error('Recorded route refusal has no title');

function privateDraftText() {
  const draft = record.personas.owner?.find(item => item.label === 'draft-content-revision');
  const extra = documentTexts((draft?.answer as { body?: { document?: unknown } } | undefined)?.body?.document)
    .filter(text => !documentTexts(publishedHome?.document).includes(text));
  if (!extra[0]) throw new Error('The recorded owner draft has no text beyond the published home');
  return extra[0];
}

const homePath = (key: string, path: readonly string[] = []) => localizedPath(spaceHref(key, 'site', path), locale);
const desktop = { locale, viewport: { value: 'desktop' } };
const phone = { locale, viewport: { value: 'phone' } };

function ZoneHomeFrame({ identity, links, children }: {
  identity: ReturnType<typeof zoneHomeIdentity>; links: readonly SiteLink[]; children: ReactNode;
}) {
  const { zone } = identity;
  const theme = zoneTheme(zone.tokens, { reader: 'light', enabled: true });
  const actions = <>
    {zone.realm ? <RealmMembership realm={zone.realm} realmName={zone.name.value} initial={null} signedIn={false}
      signInHref="/auth/start" rulesHref={zone.links.about}
      actions={{ kind: 'signed-out', signInHref: '/auth/start' }} locale={locale} messages={realmMessages} /> : null}
    {zone.realm ? <LocalizedLink href={realmHref(locale, identity.context.ref)}
      className="rounded-md border border-border px-3 py-2 text-sm hover:bg-accent">
      {surfaceText.community[locale]}
    </LocalizedLink> : null}
    {zone.realm ? <LookMenu enabled labels={{ menu: messages.lookLabel, zone: messages.lookZone,
      standard: messages.lookStandard, help: messages.lookHelp, saveFailed: messages.lookSaveFailed }} /> : null}
  </>;
  return <ZoneFrame zone={zone} dataZone={zone.slug ?? identity.context.zone ?? identity.context.ref} theme={theme}
    pkg={null} actions={actions} members={null} masthead={<ZoneMasthead zone={zone} members={null} actions={actions} />}
    tabs={null} site={{ label: zone.realm ? surfaceText.site[locale] : zone.name.value, links }}>
    <ReaderActionsProvider signedIn={false} signInHref="/auth/start">{children}</ReaderActionsProvider>
  </ZoneFrame>;
}

/** The published Zone home a visitor reads, from the recorded answers for that state. */
function RecordedZoneHome({ label, state }: { label: string; state: RecordedState }) {
  const [shown, setShown] = useState<ReactNode>(null);
  const [error, setError] = useState<Error | null>(null);
  useEffect(() => {
    let active = true;
    const selected = sample(label);
    const selections = selected.operationId === 'getV1ZonesByIdRoutes'
      ? [{ label: 'published-presentation', state: 'populated' as const }, { label, state }]
      : [{ label, state }];
    const replay = recordedFetch(record, persona, selections, { pathPrefix: BFF_PREFIX });
    const main = browserMainApi('https://recorded.invalid', { anonymous: true, fetcher: replay.fetcher });
    async function load() {
      const zone = pathId(selected.operationId === 'getV1ZonesByIdRoutes' ? 'published-presentation' : label);
      const presentation = await readCompleteZonePresentation(main, zone);
      if (!presentation.ok) throw new Error(`Recorded zone presentation failed: ${presentation.failure}`);
      const identity = zoneHomeIdentity(presentation.data, locale, realmMessages.home);
      if (selected.operationId === 'getV1ZonesByIdRoutes') {
        const route = await readZoneRouteAnswer(main, zone, queryValue(label, 'path'));
        if (route.ok) throw new Error('Recorded route refusal resolved as a page');
        if (route.failure !== 'missing') throw new Error(`Recorded route failed as ${route.failure}`);
        if (!active) return;
        setShown(<ZoneHomeFrame identity={identity} links={identity.links}>
          <ZonePageMissing title={messages.pageMissingTitle} body={messages.pageMissingBody}
            back={messages.pageMissingBack} href={spaceHref(identity.context.ref, 'site', [])} />
        </ZoneHomeFrame>);
        return;
      }
      const page = zoneHomePage(presentation.data.home);
      const loaded = await loadZoneHomeModules(page, presentation.data.presentation, {
        moduleData: presentation.data.moduleData, slideMedia: presentation.data.slideMedia,
      }, identity.context, messages.moduleHeroCarousel);
      const empty = <PageContainer>
        <MemberList members={presentation.data.navigation.map(item => ({
          id: item.target, href: siteHref(locale, identity.context.ref, [item.segment]),
          name: zoneText(item.name), kind: null,
        }))} />
      </PageContainer>;
      if (!active) return;
      setShown(<ZoneHomeFrame identity={identity} links={identity.links}>
        <ZonePublishedHome page={page} modules={loaded.modules} images={loaded.images}
          representedShowcases={loaded.representedShowcases} zone={identity.zone} pkg={null} locale={locale}
          messages={messages} empty={empty} />
      </ZoneHomeFrame>);
    }
    void load().catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason : new Error(String(reason)));
    });
    return () => { active = false; replay.dispose(); };
  }, [label, state]);
  if (error) throw error;
  if (!shown) return <PageContainer><p role="status" aria-busy="true">{shellMessages.loading}</p></PageContainer>;
  return shown;
}

const meta = {
  title: 'Zones/Zone home',
  component: RecordedZoneHome,
  parameters: { route: { pathname: homePath(publishedKey) } },
  globals: { locale },
} satisfies Meta<typeof RecordedZoneHome>;
export default meta;
type Story = StoryObj<typeof meta>;

async function expectPopulated(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  const highlight = await canvas.findByRole('link', { name: slide.title });
  await expect(highlight).toHaveAttribute('href', slide.href);
  const prose = canvas.getByText(ownerText!);
  const unavailable = canvas.getByText(placeholder!.fallback);
  await expect(prose).toBeVisible();
  await expect(unavailable).toBeVisible();
  await expect(highlight.compareDocumentPosition(prose) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  await expect(prose.compareDocumentPosition(unavailable) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  await expect(canvas.queryByText(resolvedBlock!.fallback)).toBeNull();
  await expect(canvas.queryByText(privateDraftText())).toBeNull();
  await expect(canvas.getByRole('heading', { name: recordedName('published-presentation') })).toBeVisible();
  const navigation = within(canvas.getByRole('navigation', { name: surfaceText.site[locale] }));
  const links = navigation.getAllByRole('link');
  await expect(links.map(link => link.textContent)).toEqual([realmMessages.home, mount!.name.value]);
  await expect(links[0]).toHaveAttribute('aria-current', 'page');
  const reference = navigation.getByRole('link', { name: mount!.name.value });
  await expect(reference.getAttribute('href') ?? '').toContain(mount!.segment);
  await expect(reference.getAttribute('href') ?? '').not.toContain('cursor');
}

async function expectEmpty(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  await expect(await canvas.findByRole('heading', { name: recordedName('empty-home-presentation') })).toBeVisible();
  const navigation = within(canvas.getByRole('navigation', { name: recordedName('empty-home-presentation') }));
  await expect(navigation.getByRole('link', { name: realmMessages.home })).toHaveAttribute('aria-current', 'page');
  await expect(navigation.queryByRole('link', { name: mount!.name.value })).toBeNull();
  await expect(canvas.queryByRole('heading', { name: recordedName('published-presentation') })).toBeNull();
  await expect(canvas.queryByText(ownerText!)).toBeNull();
  await expect(canvas.queryByText(placeholder!.fallback)).toBeNull();
  await expect(canvas.queryByText(realmMessages.emptyHomeTitle)).toBeNull();
}

async function expectRefusal(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  await expect(await canvas.findByRole('heading', { name: messages.pageMissingTitle })).toBeVisible();
  await expect(canvas.getByText(messages.pageMissingBody)).toBeVisible();
  await expect(canvas.getByRole('link', { name: messages.pageMissingBack })).toBeVisible();
  await expect(canvas.getByRole('heading', { name: recordedName('published-presentation') })).toBeVisible();
  const navigation = within(canvas.getByRole('navigation', { name: surfaceText.site[locale] }));
  const reference = navigation.getByRole('link', { name: mount!.name.value });
  await expect(reference.getAttribute('href') ?? '').toContain(mount!.segment);
  await expect(reference.getAttribute('href') ?? '').not.toContain('cursor');
  await expect(canvas.queryByText(ownerText!)).toBeNull();
  await expect(canvas.queryByText(placeholder!.fallback)).toBeNull();
  await expect(canvas.queryByText(privateDraftText())).toBeNull();
  await expect(canvas.queryByRole('heading', { name: refusalTitle })).toBeNull();
  await expect(canvas.queryByText(refusalTitle)).toBeNull();
}

async function expectLoading(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  const status = await canvas.findByRole('status');
  await expect(status).toHaveTextContent(shellMessages.loading);
  await expect(status).toHaveAttribute('aria-busy', 'true');
  await expect(canvas.queryByRole('heading', { name: recordedName('published-presentation') })).toBeNull();
  await expect(canvas.queryByText(ownerText!)).toBeNull();
  await expect(canvas.queryByText(placeholder!.fallback)).toBeNull();
}

export const PopulatedVisitor: Story = {
  args: { label: 'published-presentation', state: 'populated' },
  globals: desktop,
  play: async ({ canvasElement }) => { await expectPopulated(canvasElement); },
};

export const PopulatedVisitorPhone: Story = { ...PopulatedVisitor, globals: phone };

export const EmptyVisitor: Story = {
  args: { label: 'empty-home-presentation', state: 'empty' },
  globals: desktop,
  parameters: { route: { pathname: homePath(emptyKey) } },
  play: async ({ canvasElement }) => { await expectEmpty(canvasElement); },
};

export const EmptyVisitorPhone: Story = { ...EmptyVisitor, globals: phone };

export const ErrorVisitor: Story = {
  args: { label: 'unpublished-route-refused', state: 'error' },
  globals: desktop,
  parameters: { route: { pathname: homePath(publishedKey, draftPath.split('/').filter(Boolean)) } },
  play: async ({ canvasElement }) => { await expectRefusal(canvasElement); },
};

export const ErrorVisitorPhone: Story = { ...ErrorVisitor, globals: phone };

export const LoadingVisitor: Story = {
  args: { label: 'published-presentation', state: 'loading' },
  globals: desktop,
  play: async ({ canvasElement }) => { await expectLoading(canvasElement); },
};

export const LoadingVisitorPhone: Story = { ...LoadingVisitor, globals: phone };
