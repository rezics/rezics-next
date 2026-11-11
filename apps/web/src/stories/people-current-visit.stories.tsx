import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { useMemo } from 'react';
import { candidateContext } from '../subject/candidates';
import { PeopleCurrentVisitView } from '../features/catalogue/people-current-visit-view';
import {
  peopleCurrentVisitHref,
  peopleCurrentVisitReturnHref,
  validatePeopleCurrentVisitSearch,
  type PeopleCurrentVisitSearch,
} from '../features/catalogue/people-current-visit';
import { PeopleProfileEditor } from '../features/catalogue/people-profile-view';
import { peopleProfileFixture, peoplePersonId } from '../kernel/fake/catalogue-people-profile';
import { getLocale } from '../paraglide/runtime';
import { m } from '../paraglide/messages.js';
import { AppShell } from '../shell/shell';
import { PatternStory } from './page';

const otherContext = '00000000-0000-4000-8000-000000000801';
const realm = '00000000-0000-4000-8000-000000000802';
const localeNames = ['en', 'zh-Hant', 'zh-Hans', 'ja', 'ko', 'fr', 'de', 'es'] as const;
type VisitState =
  | 'global'
  | 'unsupported'
  | 'selected-global'
  | 'unavailable-return'
  | 'removed-selection'
  | 'cancelled-focus';

function PeopleCurrentVisitStory({ state }: { state: VisitState }) {
  const locale = getLocale();
  const fixture = useMemo(() => peopleProfileFixture('ready', locale, 'person'), [locale]);
  const context = state === 'global' || state === 'cancelled-focus' ? candidateContext : otherContext;
  const sourceAddress = `/${locale}/subjects/${peoplePersonId}/mira-sato?context=${context}${state === 'unsupported' ? `&realm=${realm}` : ''}`;
  const entry = peopleCurrentVisitHref({
    id: peoplePersonId,
    label: 'Mira Sato',
    locale,
    context,
    ...(state === 'unsupported' ? { realm } : {}),
    definition: 'released:sha256-story-release',
    reader: 'person-page-reader-story',
    sourceAddress,
  });
  const url = new URL(entry, 'https://rezics.invalid');
  const search = Object.fromEntries(url.searchParams.entries());
  const parsed = validatePeopleCurrentVisitSearch(search, peoplePersonId, locale);
  const visit: PeopleCurrentVisitSearch =
    parsed.kind === 'origin' && state === 'selected-global' ? { ...parsed, correction: 'global' } : parsed;

  if (state === 'unavailable-return' || state === 'removed-selection')
    return (
      <PatternStory visitor="Signed Out" path={sourceAddress}>
        <AppShell>
          <article className="mx-auto w-full max-w-3xl space-y-4 p-4 sm:p-6">
            <h1 className="text-2xl font-semibold">{m.people_profile_title()}</h1>
            <p role="status">
              {state === 'removed-selection' ? m.people_facts_changed() : m.subject_view_unavailable()}
            </p>
            <a className="underline" href={sourceAddress}>
              {m.people_current_visit_return()}
            </a>
          </article>
        </AppShell>
      </PatternStory>
    );

  return (
    <PatternStory visitor="Signed In" path={entry}>
      <AppShell>
        <PeopleCurrentVisitView
          locale={locale}
          pathname={url.pathname}
          visit={visit}
          renderEditor={(origin) =>
            origin ? (
              <PeopleProfileEditor
                id={peoplePersonId}
                locale={locale}
                currentVisit={origin}
                returnHref={peopleCurrentVisitReturnHref(origin)}
                session="signed-in"
                transport={fixture.transport}
                propose={fixture.propose}
                review={fixture.review}
                onNavigate={() => {}}
              />
            ) : null
          }
        />
      </AppShell>
    </PatternStory>
  );
}

function AllLocales() {
  return (
    <div className="grid gap-4 p-4 md:grid-cols-2">
      {localeNames.map((locale) => {
        const address = `/${locale}/subjects/${peoplePersonId}/mira-sato?context=${otherContext}`;
        const visit = validatePeopleCurrentVisitSearch(
          {
            visit: JSON.stringify({
              version: 1,
              id: peoplePersonId,
              context: otherContext,
              locale,
              definition: 'released:sha256-story-release',
              reader: 'person-page-reader-story',
              returnAddress: address,
            }),
          },
          peoplePersonId,
          locale,
        );
        return (
          <section key={locale} lang={locale} className="rounded-xl border border-border p-4">
            <p className="mb-3 text-xs font-medium uppercase">{locale}</p>
            <PeopleCurrentVisitView
              locale={locale}
              pathname={`/${locale}/subjects/${peoplePersonId}/mira-sato/people`}
              visit={visit}
              renderEditor={() => null}
            />
          </section>
        );
      })}
    </div>
  );
}

const meta = {
  title: 'Catalogue/Person correction current visit',
  id: 'pages-catalogue-person-correction-current-visit',
  component: PeopleCurrentVisitStory,
  tags: ['autodocs'],
  parameters: {
    layout: 'fullscreen',

    docs: {
      description: {
        component:
          'The selected public Person origin remains return intent. Unsupported Context and Realm visits require a deliberate fresh Global choice. Return uses the existing public reader; the stories do not establish native execution or browser acceptance.',
      },
    },
  },
} satisfies Meta<typeof PeopleCurrentVisitStory>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Global: Story = { args: { state: 'global' } };
export const UnsupportedOrigin: Story = { args: { state: 'unsupported' } };
export const DeliberateGlobalChoice: Story = { args: { state: 'selected-global' } };
export const UnavailableFreshReturn: Story = { args: { state: 'unavailable-return' } };
export const RemovedSelection: Story = { args: { state: 'removed-selection' } };
export const CancelledFocus: Story = {
  args: { state: 'cancelled-focus' },
  play: async ({ canvasElement }) => {
    const choice = await within(canvasElement).findByRole('link', { name: m.people_current_visit_choose_global() });
    const returnLink = await within(canvasElement).findByRole('link', { name: m.people_current_visit_return() });
    choice.focus();
    await expect(choice).toHaveFocus();
    await expect(returnLink).not.toHaveFocus();
  },
};
export const AllLocalesUnsupported: Story = {
  args: { state: 'unsupported' },
  render: () => <AllLocales />,
  globals: { locale: 'en' },
};
