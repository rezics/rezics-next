import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import type { UiLocale } from '../../i18n/define.ts';
import { messages as pageMessages } from '../work-page/messages.ts';
import { EditionsSection } from './editions.tsx';
import * as fixture from './fixtures.ts';
import { copyOf } from './messages.ts';
import { EditionsPreviewView } from './previews.tsx';
import { ReleaseView } from './release-page.tsx';

const names = new Map([...fixture.names, ...fixture.translators,
  [fixture.iri('7'), fixture.summary(fixture.iri('7'), 'Sword Art Online (bunko)', 'en', 'main-version')]]);

function Page({ locale, view = 'section' }: { locale: UiLocale; view?: 'section' | 'preview' | 'release' }) {
  const t = copyOf(locale);
  const release = fixture.releases.ok ? fixture.releases.data.items[1]! : undefined;
  return <div className="mx-auto grid max-w-[46rem] gap-8 px-4 py-8 sm:px-8">
    {view === 'preview'
      ? <EditionsPreviewView realizations={fixture.realizations} releases={fixture.releases} workRef={fixture.workRef}
        locale={locale} pageMessages={pageMessages[locale]} t={t} />
      : view === 'release' && release
        ? <ReleaseView release={release} names={names} locale={locale} t={t}
          sources={fixture.realizations.ok ? [fixture.realizations.data.items[0]!] : []}
          realizations={new Map(fixture.realizations.ok ? [[fixture.iri('r1'), { ok: true as const, data: fixture.realizations.data.items[1]! }]] : [])} />
        : <EditionsSection realizations={fixture.realizations} sources={[]} releases={fixture.releases} names={names} workRef={fixture.workRef}
          query={{}} locale={locale} t={t} pageMessages={pageMessages[locale]} />}
  </div>;
}

const meta = { title: 'Work levels/Editions', component: Page, args: { locale: 'en' } } satisfies Meta<typeof Page>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Volume 1 editions: zh-Hant and zh-Hans stand apart, each naming source continuity, who translated it and whether it is verified. */
export const GroupedByLanguageAndScript: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const groups = [...canvasElement.querySelectorAll('[data-language-group]')].map(group => group.getAttribute('data-language-group'));
    await expect(groups).toEqual(['ja', 'zh-Hant', 'zh-Hans']);
    const hant = canvasElement.querySelector('[data-language-group="zh-Hant"]') as HTMLElement;
    await expect(within(hant).getByText('Verified')).toBeVisible();
    await expect(within(hant).getByText(/Source text:/)).toBeVisible();
    await expect(within(hant).getByText('Lin Mei')).toBeVisible();
    // A text that follows a Main Version names it, so the web serial's continuity and the bunko's differ.
    const japanese = canvasElement.querySelector('[data-language-group="ja"]') as HTMLElement;
    await expect(within(japanese).getByText(/Main Version:/)).toBeVisible();
    await expect(within(japanese).getByText('Sword Art Online (bunko)')).toBeVisible();
    const hans = canvasElement.querySelector('[data-language-group="zh-Hans"]') as HTMLElement;
    await expect(within(hans).getByText('Unofficial')).toBeVisible();
    await expect(within(hans).getByText('Unverified')).toBeVisible();
    await expect(within(hans).getByText('Source not resolved yet')).toBeVisible();
    await expect(canvas.getByRole('region', { name: 'Releases' })).toBeVisible();
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
};

/** An omnibus lists each volume it covers; a withdrawn web text is unavailable, which is not unknown identity. */
export const ReleasesWithOmnibus: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('Covers 3 Works')).toBeVisible();
    await expect(canvas.getByText('Withdrawn')).toBeVisible();
    await expect(canvas.getByText(/its text is unavailable/)).toBeVisible();
    await expect(canvas.getByRole('link', { name: '9780316371247' })).toHaveAttribute('href', '/en/isbn/9780316371247');
    await expect(canvas.getByText('Paperback')).toBeVisible();
    await expect(canvas.getByText('US')).toBeVisible();
  },
};

export const TraditionalChinese: Story = { args: { locale: 'zh-Hant' }, globals: { viewport: { value: 'phone' } },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('region', { name: '文本與譯本' })).toBeVisible();
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  } };

export const Preview: Story = { args: { view: 'preview' },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('link', { name: 'All editions and releases' }))
      .toHaveAttribute('href', `/en/w/${fixture.workRef}/editions#realizations`);
  } };

export const ReleasePage: Story = { args: { view: 'release' },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { level: 1 })).toHaveTextContent('とある魔術の禁書目録 1〜3 合本');
    await expect(canvasElement.querySelectorAll('[data-coverage]')).toHaveLength(3);
    await expect(canvas.getAllByText('Main Version').length).toBe(3);
    // The translation names the language it follows, though this release does not carry that text.
    await expect(canvas.getAllByText(/Source text:/)[0]).toBeVisible();
    await expect(canvas.getAllByText('Japanese')[0]).toBeVisible();
    // The release page lists what it covers once.
    await expect(canvas.queryByText('Covers 3 Works')).toBeNull();
  } };
