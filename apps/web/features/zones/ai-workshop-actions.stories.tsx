import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import type { ZoneCardLayout } from '@rezics/zone-sdk';
import type { UiLocale } from '../../i18n/define.ts';
import { localizedPath } from '../../i18n/locale.ts';
import aiWorkshop from '../../zones/official/ai-workshop/index.tsx';
import { WorkshopCard } from '../../zones/official/ai-workshop/slots.tsx';
import LocalizedLink from '../shell/localized-link.tsx';
import { messages as shellMessages } from '../shell/messages.ts';
import { ShellProvider } from '../shell/shell-provider.tsx';
import { NO_PLATFORM_ACCESS } from '../api/platform-access.ts';
import { officialWorks, officialZone } from './official-fixtures.ts';
import { zoneTheme } from './theme.ts';
import { installHostZoneAddresses } from './addresses.ts';

type Kind = 'prompt' | 'skill' | 'link';
const pick = (kind: Kind, locale: UiLocale) => officialWorks('ai-workshop', locale, 'rich')
  .find(work => kind === 'link' ? !work.hub : work.hub?.kind === kind)!;
const layouts: readonly ZoneCardLayout[] = ['cover', 'row', 'rail'];

// Browser stories receive the server adapter's plain-data result; the adjacent test resolves the real adapter.
function Actions({ kind, tryHref, locale }: { kind: Kind; tryHref?: string; locale: UiLocale }) {
  installHostZoneAddresses();
  const zone = officialZone('ai-workshop', locale);
  const theme = zoneTheme(zone.tokens, { reader: 'light', enabled: true });
  return <ShellProvider locale={locale} messages={shellMessages} initialTheme="light" initialCollapsed={false}
    platformAccess={NO_PLATFORM_ACCESS}>
    <div data-zone="ai-workshop" className={theme.className} style={theme.style}>
      <style>{aiWorkshop.css}</style>
      <div className="aw-page grid gap-6 py-6 sm:grid-cols-2">
        {layouts.map(layout => <section key={layout} aria-label={layout} className={layout === 'cover' ? 'sm:row-span-2' : ''}>
          <h2 className="mb-3 font-semibold capitalize">{layout}</h2>
          <WorkshopCard zone={zone} work={pick(kind, locale)} layout={layout} tryHref={tryHref}
            fallback={null} nextVolume={null} Link={LocalizedLink} />
        </section>)}
      </div>
    </div>
  </ShellProvider>;
}

const meta = {
  title: 'Zones/AI Workshop actions',
  component: Actions,
  args: { kind: 'prompt', locale: 'en' },
  render: (args, { globals }) => <Actions {...args} locale={(globals.locale as UiLocale | undefined) ?? args.locale} />,
} satisfies Meta<typeof Actions>;
export default meta;
type Story = StoryObj<typeof meta>;

const checks = (kind: Kind, open: boolean): NonNullable<Story['play']> => async ({ canvasElement, globals }) => {
  const locale = (globals.locale as UiLocale | undefined) ?? 'en';
  const work = pick(kind, locale);
  for (const layout of layouts) {
    const card = within(within(canvasElement).getByRole('region', { name: layout }));
    const action = card.queryByRole('link', { name: `${locale === 'en' ? 'Try it' : '试一试'} ${work.title!.value}` });
    if (open) {
      await expect(action).toBeVisible();
      await expect(action).toHaveAttribute('href', localizedPath(work.href, locale));
    } else await expect(action).toBeNull();
    await expect(card.getByRole('button')).toBeVisible();
    await expect(card.getByRole('heading', { name: work.title!.value })).toBeVisible();
  }
};

export const Open: Story = {
  args: { tryHref: pick('prompt', 'en').href },
  play: checks('prompt', true),
};
export const Closed: Story = { play: checks('prompt', false) };
export const UnavailableAccess: Story = { play: checks('prompt', false) };
export const NonHub: Story = { args: { kind: 'link' }, play: checks('link', true) };
export const SkillOpen: Story = {
  args: { kind: 'skill', tryHref: pick('skill', 'en').href },
  play: checks('skill', true),
};
export const OpenChinese: Story = { ...Open, globals: { locale: 'zh-Hans' } };
export const ClosedChinese: Story = { ...Closed, globals: { locale: 'zh-Hans' } };
