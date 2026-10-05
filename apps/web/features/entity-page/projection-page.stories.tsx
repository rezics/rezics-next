import type { Meta, StoryObj } from '@storybook/react-vite';
import { useMemo } from 'react';
import { expect, waitFor, within } from 'storybook/test';
import type { UiLocale } from '../../i18n/define.ts';
import { localizedPath } from '../../i18n/locale.ts';
import { resourceHref } from '../address/path.ts';
import * as scoped from '../scoped-rating/fixtures.ts';
import { messages as scopedMessages } from '../scoped-rating/messages.ts';
import { PlaceJudgments } from '../scoped-rating/place-judgments.tsx';
import { ProjectionHeader } from '../scoped-rating/projection-header.tsx';
import { messages as workMessages } from '../work-page/messages.ts';
import * as fixture from './fixtures.ts';
import { copyOf } from './messages.ts';
import { ProjectionFactsView } from './projection-views.tsx';
import { standaloneHrefFor } from './route.ts';
import type { StatementItem, StatementPage } from './types.ts';

// A place's own page: who is in what, the facts that hold there most specific first, then its ratings. Reviews and discussion
// follow as on every page and have their own stories.

const phone = { viewport: { value: 'phone' } } as const;
const fits = async () =>
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
const place = scoped.placeEpisode3;
const hrefFor = standaloneHrefFor({}, resourceHref('/e/', place.projection.id));

const reached = (item: StatementItem, dimensions: number, exact: number): StatementItem =>
  ({ ...item, frameMatch: { dimensions, exact, score: dimensions * 16 + exact } }) as StatementItem;
const base = fixture.statements();
const [name, alias, birth, member] = base.groups.flatMap((group) => group.items) as [
  StatementItem,
  StatementItem,
  StatementItem,
  StatementItem,
];
/** Main answers the most specific claims first; this is the order it would. */
const facts = (): StatementPage => ({
  ...base,
  groups: [
    { predicate: member.predicate!, items: [reached(member, 2, 1)] },
    { predicate: birth.predicate!, items: [reached(birth, 1, 0)] },
    { predicate: name.predicate!, items: [reached(name, 0, 0)] },
    { predicate: alias.predicate!, items: [reached(alias, 0, 0)] },
  ],
});

function PlacePage({ locale, empty }: { locale: UiLocale; empty: boolean }) {
  const api = useMemo(
    () => scoped.memoryScopedRatingApi({ ...scoped.populated, signedIn: true }),
    [],
  );
  return (
    <div className="mx-auto grid max-w-4xl gap-10 p-4 sm:p-6">
      <ProjectionHeader
        summary={place.summary}
        level={1}
        page
        locale={locale}
        messages={scopedMessages[locale]}
      />
      <ProjectionFactsView
        page={{ ok: true, data: empty ? { ...base, groups: [] } : facts() }}
        names={new Map()}
        cursor={undefined}
        hrefFor={hrefFor}
        t={copyOf(locale)}
        messages={workMessages[locale]}
      />
      <section aria-labelledby="work-ratings" className="grid gap-4">
        <h2 id="work-ratings" className="font-semibold text-xl tracking-tight">
          {workMessages[locale].ratings}
        </h2>
        <PlaceJudgments
          target={place.projection.id}
          api={api}
          actingSubject="https://rezics.com/id/019a5c00-0000-7000-8000-0000000000aa"
          signInHref="/auth/start"
          locale={locale}
          messages={scopedMessages[locale]}
        />
      </section>
    </div>
  );
}

const meta = {
  title: 'Entity page/Place',
  component: PlacePage,
  args: { locale: 'en', empty: false },
  globals: { viewport: { value: 'desktop' } },
  parameters: {
    route: { pathname: localizedPath(resourceHref('/e/', place.projection.id), 'en') },
  },
} satisfies Meta<typeof PlacePage>;
export default meta;
type Story = StoryObj<typeof meta>;

/** The place's header names the subject and where; its facts come most specific first; its own question follows. */
export const Populated: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { level: 1, name: 'Elizabeth Bennet' })).toBeVisible();
    await expect(canvas.getByRole('list', { name: 'In' })).toBeVisible();
    const reach = [...canvasElement.querySelectorAll('[data-fact-reach]')].map((node) =>
      node.getAttribute('data-fact-reach'),
    );
    await expect(reach).toEqual(['here', 'wider', 'everywhere']);
    await waitFor(
      () =>
        expect(
          canvas.getByRole('heading', { name: 'How well written is this character here?' }),
        ).toBeVisible(),
      { timeout: 4000 },
    );
    await fits();
  },
};
export const PopulatedPhone: Story = { ...Populated, globals: phone };
export const PopulatedDarkPhone: Story = { ...Populated, globals: { ...phone, theme: 'dark' } };

/** Nothing has been stated for this place: the section says so quietly and the questions still show. */
export const NoFacts: Story = {
  args: { empty: true },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('No statements yet')).toBeVisible();
    await waitFor(
      () =>
        expect(
          canvas.getByRole('heading', { name: 'How well written is this character here?' }),
        ).toBeVisible(),
      { timeout: 4000 },
    );
  },
};

const localized = (locale: UiLocale): Story => ({
  globals: phone,
  args: { locale },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole('heading', { level: 2, name: copyOf(locale).projectionFacts }),
    ).toBeVisible();
    await expect(canvasElement.querySelectorAll('[data-fact-reach]')).toHaveLength(3);
    await fits();
  },
});
export const TraditionalChinese: Story = localized('zh-Hant');
export const SimplifiedChinese: Story = localized('zh-Hans');
export const Japanese: Story = localized('ja');
export const Korean: Story = localized('ko');
export const German: Story = localized('de');
export const French: Story = localized('fr');
export const Spanish: Story = localized('es');
