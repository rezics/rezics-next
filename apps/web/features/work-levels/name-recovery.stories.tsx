import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { useState } from 'react';
import { StoryRouteContext } from '../../.storybook/next-navigation.ts';
import type { UiLocale } from '../../i18n/define.ts';
import { AppShell } from '../shell/app-shell.tsx';
import { PageContainer } from '../shell/page.tsx';
import { messages as shellMessages } from '../shell/messages.ts';
import shellJapanese from '../shell/messages/ja.ts';
import { messages as pageMessages } from '../work-page/messages.ts';
import { ConnectionsSection, type Franchise } from './connections.tsx';
import { RealizationRow } from './editions.tsx';
import * as fixture from './fixtures.ts';
import { copyOf } from './messages.ts';
import { PartsSection } from './parts.tsx';
import { PartsPreviewView } from './previews.tsx';
import type { NameSummary } from './types.ts';

type Surface = 'parts' | 'connections' | 'edition' | 'preview';

/** A local RSC snapshot fixture, without backend or account writes. */
function NameSection({ surface = 'parts', locale = 'en', undisclosed = false }: {
  surface?: Surface; locale?: UiLocale; undisclosed?: boolean;
}) {
  const [attempt, setAttempt] = useState(0);
  const t = copyOf(locale);
  const names = new Map<string, NameSummary>([...fixture.names, ...fixture.translators]);
  const failed = fixture.iri(surface === 'edition' ? 'a1' : '101');
  names.set(failed, attempt < 2 ? { reference: failed, status: 'unavailable-read' }
    : undisclosed ? { reference: failed, status: 'unavailable' }
    : fixture.summary(failed, 'Recovered name', 'en', surface === 'edition' ? 'resource' : 'work'));
  names.set(fixture.iri('102'), fixture.summary(fixture.iri('102'), 'Known sibling Work'));
  names.set(fixture.iri('103'), { reference: fixture.iri('103'), status: 'unavailable' });
  names.set(fixture.iri('301'), fixture.summary(fixture.iri('301'), ''));
  names.set(fixture.iri('7'), fixture.summary(fixture.iri('7'), 'Known source version', 'en', 'main-version'));
  const shared = { names, workRef: fixture.workRef, locale, t, pageMessages: pageMessages[locale] };
  const collection = fixture.relationEntries[0]!.counterparts[0]!;
  const franchise: Franchise = { collection, parts: new Map(), members: { ok: true, data: {
    collection: collection.reference, next: null, members: ['101', '102', '103', '301'].map((id, index) => ({
      occurrence: fixture.iri(`95${index}`), role: 'member', parent: collection.reference,
      target: fixture.iri(id), orderKey: `${index}`, labels: [],
    })),
  } } };
  if (!fixture.realizations.ok) throw new Error('Expected a successful edition fixture');
  const realization = { ...fixture.realizations.data.items[0]!, translators: [fixture.iri('a1')] };
  return <StoryRouteContext value={{ pathname: '/w/index-new-testament/connections',
    search: '?grain=series&partsAfter=opaque-selected-page', onPush: () => { throw new Error('A name retry must retain the route'); },
    onRefresh: () => setAttempt(value => value + 1) }}>
    <AppShell locale={locale} messages={locale === 'ja' ? shellJapanese : shellMessages}
      theme={locale === 'ja' ? 'dark' : 'light'} navCollapsed={false} account={null}>
      <PageContainer className="grid max-w-4xl gap-6">
        <h1 className="font-semibold text-2xl">A Certain Magical Index</h1>
        <label className="grid gap-1 text-sm">Reading note
          <input className="rounded-md border border-input bg-background px-3 py-2" />
        </label>
        {surface === 'parts' ? <PartsSection {...shared} parts={fixture.parts} wholes={fixture.wholes} query={{ grain: 'series' }} />
          : surface === 'connections' ? <ConnectionsSection {...shared} relations={fixture.relations} franchises={[franchise]}
            current={fixture.current} query={{ grain: 'series' }} />
          : surface === 'preview' ? <PartsPreviewView {...shared} parts={fixture.parts} wholes={fixture.wholes} />
          : <section aria-label={t.realizations} className="grid gap-4">
            <h2 className="font-semibold text-xl">{t.realizations}</h2>
            <ul><RealizationRow realization={realization} all={[realization]} releases={[]} names={names} locale={locale} t={t} showLanguage /></ul>
          </section>}
      </PageContainer>
    </AppShell>
  </StoryRouteContext>;
}

const meta = { title: 'Work/Name section recovery', component: NameSection } satisfies Meta<typeof NameSection>;
export default meta;
type Story = StoryObj<typeof meta>;

const verifyRecovery: NonNullable<Story['play']> = async ({ canvasElement, args }) => {
  const canvas = within(canvasElement);
  const locale = args.locale ?? 'en';
  const t = copyOf(locale), recovery = pageMessages[locale];
  const known = args.surface === 'edition' ? '台灣角川' : 'Known sibling Work';
  const sibling = canvas.getByText(known);
  const siblingHref = sibling.closest('a')?.getAttribute('href');
  const retry = canvas.getByRole('button', { name: recovery.retry });
  await expect(canvasElement.querySelector('[data-name-state="unavailable"]')).toHaveTextContent(t.unavailable);
  await expect(sibling).toBeVisible();
  if (args.surface === 'edition') {
    await expect(canvas.getByText('Known source version')).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'https://example.com/evidence' })).toBeVisible();
  } else {
    await expect(canvasElement.querySelector('[data-name-state="undisclosed"]')).toHaveTextContent(t.nameNotShown);
    await expect(canvasElement.querySelector('[data-name-state="unnamed"]')).toHaveTextContent(t.unnamed);
  }
  await userEvent.type(canvas.getByRole('textbox', { name: 'Reading note' }), 'Keep this note');
  retry.focus();
  await userEvent.keyboard('{Enter}');
  await expect(canvasElement.querySelector('[data-name-state="unavailable"]')).toBeVisible();
  await expect(retry).toHaveFocus();
  await expect(canvas.getByRole('status')).toHaveTextContent(t.namesUnavailable);
  await userEvent.keyboard(' ');
  await expect(canvasElement.querySelector('[data-name-state="unavailable"]')).toBeNull();
  await expect(retry).toHaveFocus();
  await expect(canvas.getByRole('status')).toHaveTextContent(args.undisclosed ? t.nameNotShown : t.namesRestored);
  await expect(canvas.getByRole('textbox', { name: 'Reading note' })).toHaveValue('Keep this note');
  await expect(canvas.getByText(known)).toBeVisible();
  await expect(canvas.getByText(known).closest('a')?.getAttribute('href')).toBe(siblingHref);
  if (args.undisclosed) {
    await expect(canvas.queryByText('Recovered name')).toBeNull();
    await expect(canvas.queryByText(t.namesRestored)).toBeNull();
  } else await expect(canvas.getByText('Recovered name')).toBeVisible();
  await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
};

export const PartsRecoverInPlace: Story = { play: verifyRecovery };
export const ConnectionsRecoverInPlace: Story = { args: { surface: 'connections' }, play: verifyRecovery };
export const EditionCreditsRecoverInPlace: Story = { args: { surface: 'edition' }, play: verifyRecovery };
export const PreviewPhoneDarkJapanese: Story = {
  args: { surface: 'preview', locale: 'ja' },
  globals: { locale: 'ja', theme: 'dark', viewport: { value: 'phone' } },
  play: verifyRecovery,
};
export const UndisclosedAfterRetry: Story = { args: { surface: 'edition', undisclosed: true }, play: verifyRecovery };
