import { PAGE_GLOBAL_CONTEXT } from '@rezics/composition';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { PlainLink, type Stmt } from '../features/pages/shared';
import { WorkCastWindow } from '../features/catalogue/work-cast/view';
import { creditAssertion } from '../features/catalogue/credit-inspection/model';
import { qualifiedNotes } from '../features/pages/qualified-relations';
import type { Item, RowValue } from '../features/pages/overview';
import { qualifiedStatement, qualifiedRealm, qualifiedSubject } from '../kernel/fake/qualified-relations';
import { subjectHref, subjectViewHref } from '../subject/subject-href';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { AppShell } from '../shell/shell';
import { workCastVisitReturn, workCastVisitReturnFragment } from '../features/pages/subject-visit-navigation';
import { PageStory, PatternStory } from './page';

const id = (number: number) => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const work = id(1);
const performer = id(10);
const firstCharacter = id(20);
const secondCharacter = id(21);
const role = id(30);
const castNode = 'cast';

type Scenario = 'qualified' | 'two-characters' | 'spoiler' | 'unavailable-target' | 'unavailable-credit' | 'changed';

function summary(subject: string, label: string, type: string, language = 'en') {
  return { id: subject, type, types: [type], label: { value: label, language }, cover: null };
}

function snak(property: string, dataType: string, content: unknown) {
  return { property: { id: property, data_type: dataType }, value: { type: 'value', content } };
}

function credit(statement: string, characterIds: string[], locale: string, gated = false, missing = false): Item {
  const qualifiers = [
    ...characterIds.map((character) => snak('wdt:P453', 'wikibase-item', character)),
    snak('wdt:P3831', 'wikibase-item', role),
    snak('wdt:P1932', 'monolingualtext', { text: '佐藤ミナ', language: 'ja' }),
    ...(gated ? [snak('rezics:spoilerLevel', 'quantity', { amount: '2', unit: '1' })] : []),
  ];
  const assertion = {
    ...qualifiedStatement(statement, 'wdt:P725', performer, qualifiers),
    references: [
      { parts: [snak('schema:url', 'url', 'https://example.org/credits')] },
    ],
  } as Stmt;
  const characters = [firstCharacter, secondCharacter].map((character, index) =>
    summary(character, index ? 'The Archivist / 記録係' : 'The Traveller / 旅人', 'wd:Q95074', 'ja'),
  );
  const related = {
    [performer]: summary(performer, 'Mina Sato / 佐藤ミナ', 'schema:Person', 'ja'),
    [role]: summary(role, 'Voice performer', 'skos:Concept'),
    ...Object.fromEntries(characters.filter((entry) => characterIds.includes(entry.id)).map((entry) => [entry.id, entry])),
  };
  const qualified = qualifiedNotes(assertion, related, locale);
  const value: Item = {
    id: performer,
    label: { text: 'Mina Sato / 佐藤ミナ', lang: 'ja' },
    type: 'schema:Person',
    summary: related[performer]!,
    statement,
    notes: [],
    qualified,
    gated,
    ...(!missing
      ? {
          credit: creditAssertion({
            subject: work,
            property: 'wdt:P725',
            statement,
            assertion,
            related,
          }),
        }
      : {}),
  };
  return value;
}

function Visit({ scenario = 'qualified', visitor = 'Signed Out' }: { scenario?: Scenario; visitor?: 'Signed In' | 'Signed Out' }) {
  const locale = getLocale();
  const items =
    scenario === 'two-characters'
      ? [credit(id(40), [firstCharacter, secondCharacter], locale)]
      : scenario === 'spoiler'
        ? [credit(id(41), [firstCharacter], locale, true)]
        : scenario === 'unavailable-target'
          ? [credit(id(42), [id(99)], locale)]
          : scenario === 'unavailable-credit'
            ? [credit(id(43), [firstCharacter], locale, false, true)]
            : [credit(id(40), [firstCharacter], locale)];
  const context = { id: PAGE_GLOBAL_CONTEXT, population: { kind: 'global' as const } };
  const value = {
    subject: work,
    subjectLabel: 'A visual novel with a long bilingual title / 物語の長い題名',
    locale,
    context,
    link: PlainLink,
    reader: { spoilerLevel: 0, suitability: 'show' as const },
    labels: { spoilerShow: m.subject_spoiler_show({}, { locale: locale as never }), spoilerHide: m.subject_spoiler_hide({}, { locale: locale as never }), cover: {} },
    unlabelled: m.subject_value_unlabelled({}, { locale: locale as never }),
    spoilerShow: m.subject_spoiler_show({}, { locale: locale as never }),
  } as unknown as RowValue & { subject: string; subjectLabel: string };
  const selected = scenario === 'changed' ? id(99) : id(40);
  const returnState = workCastVisitReturn(
    workCastVisitReturnFragment({
      context: PAGE_GLOBAL_CONTEXT,
      node: castNode,
      presentation: 'character',
      statement: selected,
      character: firstCharacter,
      history: [null],
    }),
  );
  const address = subjectViewHref({ id: work, label: value.subjectLabel }, locale, 'credits');
  const restartHref = `${address}?node=${castNode}`;
  const navigation = {
    view: 'credits',
    node: castNode,
    cursor: 'cast-window-2',
    hasPrevious: true,
    previousCursor: null,
    previousHref: restartHref,
    returnHistory: [null],
    previousHistory: [],
    returnState,
    restartHref,
  };
  return (
    <PatternStory visitor={visitor} path={address}>
      <AppShell>
        <main className="mx-auto w-full max-w-5xl space-y-6 bg-background p-4 text-foreground sm:p-8">
          <h1 className="text-3xl font-semibold [overflow-wrap:anywhere]">{value.subjectLabel}</h1>
          <WorkCastWindow
            items={items}
            value={value}
            label="Voice credits"
            navigation={navigation}
          />
        </main>
      </AppShell>
    </PatternStory>
  );
}

const meta = {
  title: 'Pages/Catalogue/Work cast visit',
  component: Visit,
  args: { scenario: 'qualified', visitor: 'Signed Out' },
  parameters: {
    layout: 'fullscreen',
    viewport: {
      options: {
        phone390: { name: 'Phone 390', styles: { width: '390px', height: '844px' } },
        desktop1440: { name: 'Desktop 1440', styles: { width: '1440px', height: '960px' } },
      },
    },
  },
} satisfies Meta<typeof Visit>;
export default meta;
type Story = StoryObj<typeof meta>;

export const QualifiedPair: Story = { globals: { locale: 'en', viewport: { value: 'phone390' }, theme: 'light' } };
export const SamePerformerTwoCharacters: Story = { args: { scenario: 'two-characters' }, globals: { locale: 'ja', viewport: { value: 'desktop1440' }, theme: 'dark' } };
export const ConcealedAssociation: Story = {
  args: { scenario: 'spoiler' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.queryByText('Mina Sato / 佐藤ミナ')).not.toBeInTheDocument();
    await userEvent.click(canvas.getByRole('button', { name: m.subject_spoiler_show() }));
    await expect(canvas.findByRole('link', { name: /Mina Sato/ })).resolves.toBeVisible();
  },
};
export const UnavailableCharacterTarget: Story = {
  args: { scenario: 'unavailable-target', visitor: 'Signed In' },
  globals: { locale: 'zh-Hant', viewport: { value: 'phone390' }, theme: 'dark' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(new RegExp(m.subject_value_unlabelled()))).toBeVisible();
    await expect(canvas.getByRole('link', { name: /Mina Sato/ })).toHaveAttribute('target', '_blank');
  },
};
export const OriginalCreditUnavailable: Story = { args: { scenario: 'unavailable-credit' }, globals: { locale: 'ja', viewport: { value: 'desktop1440' }, theme: 'light' } };
export const CurrentTargetReturn: Story = {
  globals: { locale: 'en', viewport: { value: 'desktop1440' }, theme: 'dark' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvasElement.querySelector('[data-slot="work-cast-window"]')).toHaveAttribute('data-presentation', 'character');
    await expect(canvasElement.ownerDocument.activeElement).toBe(canvasElement.querySelector(`li[data-statement="${id(40)}"]`));
    await expect(canvas.getByRole('link', { name: m.work_cast_previous_window() })).toHaveAttribute('href', expect.stringContaining('node=cast'));
  },
};
export const ChangedRowAfterReturn: Story = {
  args: { scenario: 'changed' },
  globals: { locale: 'zh-Hant', viewport: { value: 'phone390' }, theme: 'light' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('status')).toHaveTextContent(m.work_cast_window_changed());
    await expect(canvas.getByRole('link', { name: m.subject_relation_restart() })).toHaveAttribute('href', expect.stringContaining('node=cast'));
  },
};
export const OrdinarySignedInPhoneLight: Story = { args: { visitor: 'Signed In' }, globals: { locale: 'en', viewport: { value: 'phone390' }, theme: 'light' } };
export const OrdinarySignedInDesktopDark: Story = { args: { visitor: 'Signed In' }, globals: { locale: 'en', viewport: { value: 'desktop1440' }, theme: 'dark' } };
export const SimplifiedChinesePhoneDark: Story = { globals: { locale: 'zh-Hans', viewport: { value: 'phone390' }, theme: 'dark' } };
export const KoreanDesktopLight: Story = { globals: { locale: 'ko', viewport: { value: 'desktop1440' }, theme: 'light' } };
export const FrenchPhoneLight: Story = { globals: { locale: 'fr', viewport: { value: 'phone390' }, theme: 'light' } };
export const GermanDesktopDark: Story = { globals: { locale: 'de', viewport: { value: 'desktop1440' }, theme: 'dark' } };
export const SpanishDesktopLight: Story = { globals: { locale: 'es', viewport: { value: 'desktop1440' }, theme: 'light' } };

const retryRoute = new URL(subjectHref({ id: qualifiedSubject.id, label: qualifiedSubject.label }, 'en').href, 'https://rezics.test');
retryRoute.searchParams.set('realm', qualifiedRealm);
export const CurrentRetryAfterReadFailure: Story = {
  name: 'Current retry after a fresh relation-read failure',
  globals: { locale: 'en', viewport: { value: 'phone390' }, theme: 'dark' },
  render: () => <PageStory visitor="Signed Out" path={`${retryRoute.pathname}${retryRoute.search}`} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('link', { name: /^More:/ }));
    const retry = await canvas.findByRole('link', { name: m.subject_section_retry() });
    await userEvent.click(retry);
    await waitFor(() => expect(canvasElement.querySelector('[data-slot="continue-group"]')).toBeNull());
    await expect(canvasElement.querySelector('[data-slot="work-cast-window"]')).not.toBeNull();
  },
};
