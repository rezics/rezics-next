import { useMemo, useRef, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { pickText } from '@rezics/composition';
import type { Release } from '@rezics/definitions';
import { CreditInspection } from '../features/catalogue/credit-inspection/view';
import { creditAssertion, type CreditVisit } from '../features/catalogue/credit-inspection/model';
import { CoverList } from '../features/pages/cover-list';
import { holderItems, type RowValue } from '../features/pages/overview';
import { relationFixture, relationActor, relationProperty } from '../kernel/fake/catalogue-relations';
import definitions from '../kernel/recorded/definitions-release.json';
import { defaultReader } from '../subject/reader';
import { GREGORIAN_CALENDAR } from '../subject/time-presentation';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { ConnectedStory } from './connected-story';

const meta = { title: 'Pages/Subjects/Person credit visit', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
type Mode = 'normal' | 'two' | 'concealed' | 'partial' | 'context' | 'replaced' | 'refused' | 'unavailable' | 'late';

/** Real card, value, evidence and native editor families, with the bounded released request fixture. */
function PersonCreditVisit({ mode = 'normal', signedIn = false }: { mode?: Mode; signedIn?: boolean }) {
  const locale = getLocale();
  const fixture = useMemo(() => {
    const fixture = relationFixture('ready', locale);
    fixture.candidate.id = fixture.original.id;
    fixture.original.qualifiers.find((part) => part.property.id === 'wdt:P1932')!.value = {
      type: 'value',
      content: '悠木 碧 / A very long original professional credited name for this performance',
    };
    const role = '00000000-0000-8000-8000-000000000310';
    fixture.publicRead.related[role] = { type: 'skos:Concept', labels: { en: 'Narration' } };
    fixture.original.qualifiers.push({
      property: { id: 'wdt:P3831', data_type: 'wikibase-item' },
      value: { type: 'value', content: role },
    });
    for (const statement of [fixture.original, fixture.sibling])
      statement.references[0]!.parts.push({
        property: { id: 'schema:datePublished', data_type: 'time' },
        value: {
          type: 'value',
          content: { time: '+2024-00-00T00:00:00Z', precision: 9, calendarmodel: GREGORIAN_CALENDAR },
        },
      });
    fixture.candidate.statement = structuredClone(fixture.original);
    if (mode === 'refused') fixture.setActions([]);
    if (mode === 'partial') fixture.original.references[0]!.parts[0]!.value = { type: 'somevalue' };
    return fixture;
  }, [locale, mode]);
  const release = definitions.release as unknown as Release;
  const labels = Object.fromEntries(
    Object.entries(release.properties).map(([id, property]) => [id, pickText(property.labels, locale).text]),
  );
  const visit: CreditVisit = {
    person: relationActor,
    node: 'voice',
    reader: null,
    context: fixture.publicRead.subject.context,
    release: fixture.publicRead.subject.release,
    definition: fixture.publicRead.subject.release,
    propertyLabel: labels[relationProperty]!,
    labels,
    stream: { kind: 'links', id: relationActor, property: relationProperty, cursor: 'opaque-current-page', limit: 20 },
    ...(mode === 'context' ? { realm: '00000000-0000-8000-8000-000000000020' } : {}),
  };
  const rows = [fixture.original, fixture.sibling].map((statement) => ({
    subject: fixture.id,
    property: relationProperty,
    statement: statement.id,
    creditSlot: {
      ...fixture.slot,
      key: statement.id === fixture.original.id ? fixture.slot.key : '00000000-0000-8000-8000-000000000103',
    },
    label: 'A work with a long multilingual title — 旅する物語與配音紀錄',
    assertion: statement,
    related: Object.fromEntries(
      Object.entries(fixture.publicRead.related).map(([id, value]) => [
        id,
        { id, type: value.type, label: { value: value.labels.en, language: 'en' } },
      ]),
    ),
  }));
  const credits = rows.map((row) => creditAssertion(row)!);
  const [selected, setSelected] = useState<number | undefined>(mode === 'concealed' || mode === 'two' ? undefined : 0);
  const [retired, setRetired] = useState(false);
  const [revisionAttempts, setRevisionAttempts] = useState(0);
  const live = useRef(true);
  const value: RowValue = {
    locale,
    link: (props) => <a {...props} />,
    reader: defaultReader,
    labels: {
      spoilerShow: m.subject_spoiler_show(),
      documentSpoiler: m.thread_reveal_spoiler(),
      cover: { withheld: '', reveal: '', credit: '', via: '' },
    },
    unlabelled: m.subject_value_unlabelled(),
    spoilerShow: m.subject_spoiler_show(),
  };
  const items = holderItems({ links: rows }, 20, locale)!.items.map((item, index) => ({
    ...item,
    gated: mode === 'concealed',
    supportSlot: (
      <button className="min-h-11 underline" onClick={() => setSelected(index)}>
        {m.credit_inspect()} · {index + 1}
      </button>
    ),
  }));
  return (
    <ConnectedStory storyId="person-credit-visit">
      <main className="mx-auto max-w-5xl space-y-6 p-4 sm:p-8">
        <h1 className="text-2xl font-semibold">悠木 碧 · {m.subject_works()}</h1>
        {retired && <p role="status">{m.credit_return_unavailable()}</p>}
        <CoverList items={items} value={value} label={m.subject_works()} />
        {selected !== undefined && (
          <CreditInspection
            key={selected}
            credit={credits[selected]!}
            visit={visit}
            title={rows[selected]!.label}
            locale={locale}
            propertyLabel={visit.propertyLabel}
            signedIn={signedIn}
            onClose={() => setSelected(undefined)}
            isCurrent={() => live.current}
            search={async () => []}
            transport={
              mode === 'unavailable'
                ? { ...fixture.transport, read: async () => ({ ok: false, reason: 'unavailable' }) }
                : fixture.transport
            }
            metadata={async () => {
              setRevisionAttempts((count) => count + 1);
              if (mode === 'late' || mode === 'replaced') {
                live.current = false;
                setSelected(undefined);
                setRetired(true);
                if (mode === 'late') await new Promise((resolve) => setTimeout(resolve, 0));
              }
              return revisionAttempts > 0 && mode !== 'partial'
                ? { kind: 'ready', detail: { id: fixture.id, revision: 1, summary: { kind: 'limited' } } }
                : { kind: 'unavailable' };
            }}
          />
        )}
      </main>
    </ConnectedStory>
  );
}
export const PersonQualifiedVoice: Story = { render: () => <PersonCreditVisit signedIn /> };
export const SameWorkTwoCredits: Story = { render: () => <PersonCreditVisit mode="two" /> };
export const HumanQualifierLabels: Story = { render: () => <PersonCreditVisit />, globals: { locale: 'zh-Hant' } };
export const JapanesePartialDate: Story = { render: () => <PersonCreditVisit />, globals: { locale: 'ja' } };
export const SourceUnavailable: Story = { render: () => <PersonCreditVisit mode="partial" /> };
export const SpoilerConcealed: Story = { render: () => <PersonCreditVisit mode="concealed" /> };
export const ContextTargetReturn: Story = {
  render: () => <PersonCreditVisit mode="context" />,
  play: async ({ canvasElement }) => {
    const dialog = within(canvasElement.ownerDocument.body).getByRole('dialog');
    const source = within(dialog).getByRole('link', { name: m.subject_sources() });
    await expect(source.getAttribute('href')).toContain('via=');
    await expect(source.getAttribute('href')).toContain('realm=');
  },
};
export const CurrentCandidateReplaced: Story = {
  render: () => <PersonCreditVisit mode="replaced" />,
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    await userEvent.click(page.getByRole('button', { name: m.credit_read_revision() }));
    await expect(page.queryByRole('dialog')).toBeNull();
    await expect(page.getByRole('status')).toHaveTextContent(m.credit_return_unavailable());
  },
};
export const CorrectionRefused: Story = { render: () => <PersonCreditVisit mode="refused" signedIn /> };
export const CorrectionUnavailable: Story = { render: () => <PersonCreditVisit mode="unavailable" signedIn /> };
export const CurrentRetry: Story = {
  render: () => <PersonCreditVisit />,
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    await userEvent.click(page.getByRole('button', { name: m.credit_read_revision() }));
    await userEvent.click(await page.findByRole('button', { name: m.credit_retry_revision() }));
    await expect(page.queryByText(m.credit_revision_unavailable())).toBeNull();
  },
};
export const LateReplyRetired: Story = { ...CurrentCandidateReplaced, render: () => <PersonCreditVisit mode="late" /> };
export const PhoneLight: Story = {
  ...PersonQualifiedVoice,
  globals: { viewport: { value: 'phone390' }, theme: 'light' },
};
export const PhoneDark: Story = {
  ...PersonQualifiedVoice,
  globals: { viewport: { value: 'phone390' }, theme: 'dark' },
};
export const DesktopLight: Story = {
  ...ContextTargetReturn,
  globals: { viewport: { value: 'desktop1440' }, theme: 'light' },
};
export const DesktopDark: Story = {
  ...ContextTargetReturn,
  globals: { viewport: { value: 'desktop1440' }, theme: 'dark' },
};
