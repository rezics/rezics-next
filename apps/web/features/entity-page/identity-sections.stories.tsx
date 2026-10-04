import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import type { UiLocale } from '../../i18n/define.ts';
import { messages } from '../work-page/messages.ts';
import { identityData, saber, alter, type IdentityState } from './identity-fixtures.ts';
import type { IdentitySectionKind } from './identity-relations.ts';
import { IdentitySectionsView } from './identity-views.tsx';
import { copyOf } from './messages.ts';
import { standaloneHrefFor } from './route.ts';
import { resourceHref } from '../address/path.ts';

const hrefFor = standaloneHrefFor({}, resourceHref('/e/', saber.reference));
function Sections({
  state,
  phone,
  locale,
}: {
  state: IdentityState;
  phone: boolean;
  locale: UiLocale;
}) {
  return (
    <div
      className="mx-auto grid max-w-4xl gap-10 p-4"
      style={phone ? { maxWidth: 390 } : undefined}
    >
      {(['family', 'units', 'represents', 'titles', 'holders'] as IdentitySectionKind[]).map(
        (kind) => (
          <IdentitySectionsView
            key={kind}
            data={identityData(kind, state)}
            self={alter}
            locale={locale}
            t={copyOf(locale)}
            messages={messages[locale]}
            hrefFor={hrefFor}
          />
        ),
      )}
    </div>
  );
}
const meta = {
  title: 'Entity page/Identity sections',
  component: Sections,
  args: { state: 'populated', phone: false, locale: 'en' },
  globals: { locale: 'en' },
} satisfies Meta<typeof Sections>;
export default meta;
type Story = StoryObj<typeof meta>;

async function checks(context: Parameters<NonNullable<Story['play']>>[0]) {
  const { canvasElement, args, id } = context;
  const browser =
    import.meta.env.VITE_IDENTITY_VISUAL === '1' ? (await import('vitest/browser')).page : null;
  if (browser) await browser.viewport(args.phone ? 390 : 1280, 844);
  const canvas = within(canvasElement);
  await expect(canvas.getAllByRole('heading', { level: 2 })).toHaveLength(5);
  if (args.state === 'empty' || args.state === 'spoiler-hidden') {
    await expect(canvasElement.querySelectorAll('[data-identity-member]')).toHaveLength(0);
    await expect(canvas.queryByText('Saber Alter')).not.toBeInTheDocument();
    await expect(canvas.queryByText('Saber')).not.toBeInTheDocument();
    await expect(canvasElement.querySelector('[data-identity-hub]')).toBeNull();
  } else {
    await expect(canvasElement.querySelector('[data-identity-hub]')).toHaveTextContent('Saber');
    await expect(canvas.getAllByText('Persona')).toHaveLength(1);
    await expect(canvas.getAllByText('Counterpart')).toHaveLength(1);
    await expect(canvasElement.querySelectorAll('[data-title-context]')).toHaveLength(3);
    if (args.state === 'below-threshold') {
      await expect(canvasElement.querySelectorAll('[data-rating-mean="withheld"]')).toHaveLength(9);
      await expect(
        canvas.getAllByText('4 more ratings will reveal the average.').length,
      ).toBeGreaterThan(0);
    }
  }
  await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  if (browser) {
    await document.fonts.ready;
    for (const region of canvasElement.querySelectorAll('section')) {
      const name = `${id}-${region.getAttribute('aria-labelledby')}`;
      if (region.getBoundingClientRect().height <= 800) {
        await browser.screenshot({
          element: region,
          path: `../../../../.temp/identity-pages/stories/${name}.png`,
        });
      } else {
        for (const [index, card] of [
          ...region.querySelectorAll('[data-identity-member]'),
        ].entries()) {
          await browser.screenshot({
            element: card,
            path: `../../../../.temp/identity-pages/stories/${name}-${index}.png`,
          });
        }
      }
    }
  }
}

export const PopulatedDesktop: Story = { play: checks };
export const PopulatedPhone: Story = {
  args: { phone: true },
  globals: { viewport: { value: 'phone' } },
  play: checks,
};
export const BelowThresholdDesktop: Story = { args: { state: 'below-threshold' }, play: checks };
export const BelowThresholdPhone: Story = {
  args: { state: 'below-threshold', phone: true },
  globals: { viewport: { value: 'phone' } },
  play: checks,
};
export const EmptyDesktop: Story = { args: { state: 'empty' }, play: checks };
export const EmptyPhone: Story = {
  args: { state: 'empty', phone: true },
  globals: { viewport: { value: 'phone' } },
  play: checks,
};
export const SpoilerHiddenDesktop: Story = { args: { state: 'spoiler-hidden' }, play: checks };
export const SpoilerHiddenPhone: Story = {
  args: { state: 'spoiler-hidden', phone: true },
  globals: { viewport: { value: 'phone' } },
  play: checks,
};
export const TraditionalChinesePhone: Story = {
  args: { locale: 'zh-Hant', phone: true },
  globals: { locale: 'zh-Hant', viewport: { value: 'phone' } },
};
export const Failed: Story = {
  render: () => (
    <IdentitySectionsView
      self={saber}
      data={{ ok: false, failure: 'unavailable' }}
      locale="en"
      t={copyOf('en')}
      messages={messages.en}
      hrefFor={hrefFor}
    />
  ),
};

export const StaleFamilyCursor: Story = {
  render: () => (
    <IdentitySectionsView
      self={saber}
      data={{ ok: false, failure: 'moved' }}
      locale="en"
      t={copyOf('en')}
      messages={messages.en}
      hrefFor={standaloneHrefFor(
        { family: 'stale-family', relations: 'stale-own' },
        resourceHref('/e/', saber.reference),
      )}
    />
  ),
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('link', { name: 'First page' })).toHaveAttribute(
      'href',
      `/en${resourceHref('/e/', saber.reference)}#identity-family`,
    );
  },
};
