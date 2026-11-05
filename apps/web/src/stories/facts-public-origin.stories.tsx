import type { Meta, StoryObj } from '@storybook/react-vite';
import { useMemo } from 'react';
import { FactsPublicReturnLink, FactsPublicVisitNotice } from '../features/catalogue/subject-facts-entry';
import { factsGlobalVisitHref } from '../features/catalogue/facts-public-visit';
import { subjectFactsFixture } from '../kernel/fake/subject-facts';
import { getLocale } from '../paraglide/runtime';
import { m } from '../paraglide/messages.js';
import { AppShell } from '../shell/shell';
import { subjectHref } from '../subject/subject-href';
import { PatternStory } from './page';

type State = 'observed-global' | 'unsupported-context' | 'unsupported-realm' | 'fresh-global' | 'invalid';

function Example({ state = 'observed-global' }: { state?: State }) {
  const locale = getLocale();
  const fixture = useMemo(() => subjectFactsFixture('ready', locale), [locale]);
  const subject = fixture.date.address.id;
  const base = subjectHref({ id: subject, label: 'Facts example' }, locale).href;
  const returnHref = `${base}${state === 'unsupported-realm' ? `?realm=${subject}` : ''}#connections`;
  const freshHref = factsGlobalVisitHref(`${base}/edit`, subject, locale, returnHref);
  return (
    <PatternStory visitor="Signed In">
      <AppShell>
        <main className="mx-auto w-full max-w-3xl space-y-4 p-6">
          <h1 className="font-sans text-2xl font-semibold">{m.facts_title({}, { locale: locale as never })}</h1>
          {state === 'observed-global' ? (
            <FactsPublicReturnLink href={returnHref} locale={locale} />
          ) : (
            <FactsPublicVisitNotice
              state={state === 'fresh-global' ? 'fresh' : state === 'invalid' ? 'invalid' : 'unsupported'}
              returnHref={returnHref}
              {...(state.startsWith('unsupported') ? { freshHref } : {})}
              locale={locale}
            />
          )}
        </main>
      </AppShell>
    </PatternStory>
  );
}

const meta = {
  title: 'Pages/Catalogue/Facts public correction origin',
  component: Example,
  parameters: {
    layout: 'fullscreen',
    viewport: {
      options: {
        phone390: { name: 'Phone 390', styles: { width: '390px', height: '844px' } },
        desktop1440: { name: 'Desktop 1440', styles: { width: '1440px', height: '900px' } },
      },
    },
    docs: {
      description: {
        component:
          'Typed Subject Facts fixture with the public return, unsupported Context/Realm, fresh Global and invalid-address notices. Review all eight locale globals, both themes and phone390/desktop1440; browser execution belongs to integration.',
      },
    },
  },
} satisfies Meta<typeof Example>;
export default meta;
type Story = StoryObj<typeof meta>;

export const ObservedGlobal: Story = {};
export const UnsupportedContext: Story = { args: { state: 'unsupported-context' } };
export const UnsupportedRealm: Story = { args: { state: 'unsupported-realm' } };
export const DeliberateFreshGlobal: Story = { args: { state: 'fresh-global' } };
export const InvalidAddress: Story = { args: { state: 'invalid' } };
