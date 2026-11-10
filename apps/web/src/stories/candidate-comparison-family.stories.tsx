import { useEffect, useMemo, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, mocked, userEvent, waitFor, within } from 'storybook/test';
import { CandidateReview, type CandidateTransport } from '../subject/candidate-review';
import { CandidateReaderBoundary } from '../subject/candidate-lifetime';
import { Button } from '@rezics/ui/shadcn/button';
import { CandidateStory } from '../subject/candidate-story';
import { candidateFixture } from '../kernel/fake/subject-candidates';
import { contextFixture } from '../kernel/fake/context-curation';
import { ContextCurationStory } from '../features/catalogue/context-curation-story';
import { getLocale } from '../paraglide/runtime';
import { m } from '../paraglide/messages.js';
import { pagePaths, PatternStory } from './page';
import * as original from './subject-candidate-review.stories';

// Authored UNRUN. These are actual reviewers on the existing native-shaped fixture seam.
// Width/RTL intent and DOM assertions are not measured browser, native or growth proof.
const meta = {
  title: 'Catalogue/Candidate Comparison Family',
  id: 'patterns-candidate-comparison-family',
  component: CandidateStory,
  decorators: [
    (Story) => (
      <PatternStory visitor="Signed In" path={pagePaths.subject}>
        <Story />
      </PatternStory>
    ),
  ],
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof CandidateStory>;
export default meta;
type Story = StoryObj<typeof meta>;

// Keep the connected canonical journeys and their original plays verbatim.
export const BrowseCompareConfirmCancel: Story = { ...original.Confirmation };
export const CommittedResultAndReload: Story = { ...original.AcceptedUnselected };
export const AdoptAndPublicResult: Story = { ...original.Selected };
export const RejectAndReload: Story = { ...original.RejectSuggestion };
export const RankedAcrossBoundedPages: Story = { ...original.RankedSelection };
export const StaleRankedDraftAndReload: Story = { ...original.StaleRankedSelection };
export const DenialWithdrawsPrivateComparison: Story = { ...original.Denied };
export const UnavailableAndReload: Story = { ...original.Unavailable };
export const Empty: Story = { ...original.Empty };
export const Loading: Story = { ...original.Loading };
export const Invalid: Story = { ...original.Invalid };
export const PublicStillPending: Story = { ...original.Pending };

const longValue = '旅人の物語 — les récits partagés et les chemins de lecture '.repeat(8).trim();
const evidence = '原文の書誌情報と独立した出典 — Édition originale et droits des contributeurs '.repeat(5).trim();
const rights = 'Wikidata contributors · 再利用時の権利と出典を保持してください · attribution conservée '
  .repeat(4)
  .trim();
const sourceUrl = 'https://www.wikidata.org/wiki/Q25338';
const licenceUrl = 'https://creativecommons.org/publicdomain/zero/1.0/';
const exactRecord = `Q25338/${'exact-record-'.repeat(8)}`;
const exactRevision = `revision/${'a'.repeat(64)}`;
const exactConverter = `wikidata/${'b'.repeat(64)}`;
const viewports = {
  options: {
    phone390: { name: 'Phone 390', styles: { width: '390px', height: '844px' } },
    desktop1280: { name: 'Desktop 1280', styles: { width: '1280px', height: '900px' } },
  },
};
function LongReview({ rtl = false }: { rtl?: boolean }) {
  const locale = getLocale();
  const fixture = useMemo(() => {
    const value = candidateFixture('ready', locale, 'schema:alternateName');
    value.candidate.statement.value = { type: 'value', content: { text: longValue, language: 'ja' } };
    value.candidate.statement.qualifiers = [
      { property: { id: 'wdt:P1932', data_type: 'string' }, value: { type: 'value', content: evidence } },
    ];
    value.candidate.statement.references[0]!.parts.push({
      property: { id: 'schema:name', data_type: 'monolingualtext' },
      value: { type: 'value', content: { text: evidence, language: 'fr' } },
    });
    if (value.candidate.source && 'source' in value.candidate.source) {
      value.candidate.source.external_id = exactRecord;
      value.candidate.source.record_revision = exactRevision;
      value.candidate.source.converter_revision = exactConverter;
    }
    Object.assign(value.publicRead.subject, {
      sourceRecords: [
        { name: evidence, url: sourceUrl, attribution: rights, licence: { id: 'CC0-1.0', url: licenceUrl } },
      ],
    });
    return value;
  }, [locale]);
  return (
    <div dir={rtl ? 'rtl' : 'ltr'} className="mx-auto max-w-5xl p-4 sm:p-8">
      <CandidateReview id={fixture.id} locale={locale} transport={fixture.transport} />
    </div>
  );
}
async function inspectLong(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  await userEvent.click(canvas.getByRole('button', { name: m.candidate_entry() }));
  await userEvent.selectOptions(
    await canvas.findByRole('combobox', { name: m.candidate_field() }),
    'schema:alternateName',
  );
  await userEvent.click(await canvas.findByRole('button', { name: m.candidate_review() }));
  await expect(canvas.getByRole('heading', { level: 4, name: m.candidate_proposed() })).toBeVisible();
  const proposed = canvasElement.querySelector<HTMLElement>('[data-candidate-panel="proposed"]')!;
  await expect(within(proposed).getByText(longValue)).toHaveAttribute('lang', 'ja');
  await expect(within(proposed).getByRole('link', { name: evidence })).toHaveAttribute('href', sourceUrl);
  await expect(within(proposed).getByRole('link', { name: 'CC0-1.0' })).toHaveAttribute('href', licenceUrl);
  await expect(within(proposed).getByText(rights)).toBeVisible();
  const summary = within(proposed).getByText(m.candidate_provenance());
  summary.focus();
  await userEvent.keyboard('{Enter}');
  for (const value of [exactRecord, exactRevision, exactConverter])
    await expect(within(proposed).getByText(value)).toBeVisible();
  await expect(parseFloat(getComputedStyle(summary).outlineWidth)).toBeGreaterThanOrEqual(2);
  await expect(proposed.querySelector('a a, a button, a summary, a input')).toBeNull();
  await userEvent.tab();
  await expect(within(proposed).getByRole('link', { name: sourceUrl })).toHaveFocus();
  await userEvent.tab();
  await expect(within(proposed).getByRole('link', { name: evidence })).toHaveFocus();
  await userEvent.tab();
  await expect(within(proposed).getByRole('link', { name: 'CC0-1.0' })).toHaveFocus();
  // Authored physical assertions; no browser is run by this source delivery.
  for (const panel of canvasElement.querySelectorAll<HTMLElement>('[data-candidate-panel]')) {
    await expect(panel.scrollWidth).toBeLessThanOrEqual(panel.clientWidth + 1);
    for (const link of panel.querySelectorAll<HTMLAnchorElement>('a')) {
      await expect(link.scrollWidth).toBeLessThanOrEqual(link.clientWidth + 1);
      if (window.innerWidth <= 390 || matchMedia('(pointer: coarse)').matches) {
        await expect(link.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
        await expect(link.getBoundingClientRect().width).toBeGreaterThanOrEqual(44);
      }
    }
  }
  if (window.innerWidth <= 390 || matchMedia('(pointer: coarse)').matches)
    await expect(summary.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
  if (window.innerWidth <= 390 || matchMedia('(pointer: coarse)').matches) {
    for (const control of canvasElement.querySelectorAll<HTMLElement>(
      '#candidate-review button, #candidate-review select',
    ))
      await expect(control.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
  }
}
export const LongLocalizedPhone: Story = {
  render: () => <LongReview />,
  parameters: { viewport: viewports },
  globals: {},
  play: async ({ canvasElement }) => inspectLong(canvasElement),
};
export const LongLocalizedDesktopRtl: Story = {
  ...LongLocalizedPhone,
  render: () => <LongReview rtl />,
  globals: {},
};

export const IndependentReviewsAndActions: Story = {
  args: { scenario: 'multiple', onRequests: fn() },
  render: (args) => (
    <div className="mx-auto grid max-w-6xl gap-6 p-4 lg:grid-cols-2">
      <div data-review-instance="first">
        <CandidateStory {...args} />
      </div>
      <div data-review-instance="second">
        <CandidateStory {...args} />
      </div>
    </div>
  ),
  play: async ({ canvasElement, args }) => {
    const scopes = [...canvasElement.querySelectorAll<HTMLElement>('[data-review-instance]')];
    const [first, second] = scopes.map((scope) => within(scope));
    for (const canvas of [first!, second!]) {
      await userEvent.click(canvas.getByRole('button', { name: m.candidate_entry() }));
      await userEvent.selectOptions(
        await canvas.findByRole('combobox', { name: m.candidate_field() }),
        'schema:inLanguage',
      );
      await canvas.findAllByRole('checkbox');
    }
    // Fixed candidate-field/include-/rank- identities are intentionally retained. Scope
    // direct controls to each instance; this example makes no global ID-uniqueness claim.
    await userEvent.click(first!.getAllByRole('checkbox').at(-1)!);
    await expect(second!.getAllByRole('checkbox').at(-1)!).not.toBeChecked();
    await userEvent.click(first!.getAllByRole('button', { name: m.candidate_review() })[0]!);
    await userEvent.click(first!.getByRole('button', { name: m.candidate_reject() }));
    const title = m.candidate_confirm_title({ action: m.candidate_reject() });
    const confirmation = first!.getByRole('region', { name: title });
    await expect(confirmation).toHaveFocus();
    await expect(second!.queryByRole('region', { name: title })).toBeNull();
    const calls = mocked(args.onRequests!).mock.calls.map(([value]) => value);
    await expect(calls.every((value) => value.every((call) => call.method === 'GET'))).toBe(true);
    await userEvent.click(within(confirmation).getByRole('button', { name: m.candidate_cancel() }));
    await expect(first!.getByRole('button', { name: m.candidate_reject() })).toHaveFocus();
    await userEvent.click(second!.getAllByRole('button', { name: m.candidate_review() })[0]!);
    await userEvent.click(second!.getByRole('button', { name: m.candidate_reject() }));
    await userEvent.click(
      within(second!.getByRole('region', { name: title })).getByRole('button', { name: m.candidate_reject() }),
    );
    await second!.findByText(m.candidate_rejected());
    await expect(first!.queryByText(m.candidate_rejected())).toBeNull();
  },
};

function ExactReview({ missing = false, retracted = false }: { missing?: boolean; retracted?: boolean }) {
  const locale = getLocale();
  const fixture = useMemo(() => {
    const value = candidateFixture('ready', locale);
    if (retracted) value.candidate.retracted = 4;
    return value;
  }, [locale, retracted]);
  return (
    <CandidateReview
      id={fixture.id}
      locale={locale}
      transport={fixture.transport}
      initialProperty={fixture.property}
      exactCandidate={missing ? '00000000-0000-8000-8000-000000000999' : fixture.candidate.id}
    />
  );
}
export const ExactCandidateMissing: Story = {
  render: () => <ExactReview missing />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText(m.correction_exact_missing());
    await expect(canvas.queryByRole('button', { name: m.candidate_accept() })).toBeNull();
  },
};
export const RetractedCandidate: Story = {
  render: () => <ExactReview retracted />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText(m.candidate_retracted());
    await expect(canvas.getByRole('button', { name: m.candidate_review() })).toBeDisabled();
  },
};

// The existing Context fixture owns the modes and native-shaped uncertain receipt.
export const ContextInherit: Story = {
  render: () => <ContextCurationStory />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: m.candidate_entry() }));
    await canvas.findByText(m.context_inherited());
    await expect(canvas.getByRole('combobox', { name: m.context_mode() })).toHaveValue('inherit');
  },
};
export const ContextReplaceAndReload: Story = {
  render: () => <ContextCurationStory />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: m.candidate_entry() }));
    await userEvent.selectOptions(await canvas.findByRole('combobox', { name: m.context_mode() }), 'replace');
    for (const choice of canvas.getAllByRole('checkbox'))
      if (choice.getAttribute('aria-checked') === 'true') await userEvent.click(choice);
    await userEvent.click(canvas.getAllByRole('checkbox').at(-1)!);
    await userEvent.click(canvas.getByRole('button', { name: m.context_adopt() }));
    const title = m.candidate_confirm_title({ action: m.context_adopt() });
    await userEvent.click(
      within(canvas.getByRole('region', { name: title })).getByRole('button', { name: m.context_adopt() }),
    );
    await canvas.findByText(m.context_saved());
    await userEvent.click(canvas.getByRole('button', { name: m.candidate_reload() }));
    await canvas.findByText(m.context_replaced());
  },
};
export const ContextSuppress: Story = {
  render: () => <ContextCurationStory scenario="suppressed" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: m.candidate_entry() }));
    await canvas.findByText(m.context_suppressed());
    await expect(canvas.getByRole('combobox', { name: m.context_mode() })).toHaveValue('suppress');
  },
};
export const ContextUnresolved: Story = {
  render: () => <ContextCurationStory scenario="unresolved" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: m.candidate_entry() }));
    await canvas.findByText(m.context_unresolved());
    await expect(canvas.getByRole('link', { name: m.candidate_view_public() })).toHaveAttribute(
      'href',
      expect.stringContaining('/subjects/'),
    );
  },
};
function UncertainContext() {
  const locale = getLocale();
  const fixture = useMemo(() => contextFixture('uncertain', locale), [locale]);
  return (
    <CandidateReview
      id={fixture.id}
      locale={locale}
      context={fixture.context.id}
      initialProperty={fixture.property}
      transport={fixture.transport}
    />
  );
}
export const ImmutableUncertainContextReplay: Story = {
  render: () => <UncertainContext />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: m.candidate_entry() }));
    await userEvent.selectOptions(await canvas.findByRole('combobox', { name: m.context_mode() }), 'suppress');
    await userEvent.click(canvas.getByRole('button', { name: m.context_adopt() }));
    const title = m.candidate_confirm_title({ action: m.context_adopt() });
    await userEvent.click(
      within(canvas.getByRole('region', { name: title })).getByRole('button', { name: m.context_adopt() }),
    );
    await canvas.findByText(m.candidate_unavailable());
    await expect(canvas.getByRole('combobox', { name: m.context_mode() })).toBeDisabled();
    await userEvent.click(canvas.getByRole('button', { name: m.candidate_retry() }));
    await canvas.findByText(m.context_saved());
  },
};

const languages = [
  'en',
  'fr',
  'de',
  'ja',
  'ko',
  'es',
  'it',
  'pt',
  'nl',
  'sv',
  'da',
  'fi',
  'no',
  'is',
  'pl',
  'cs',
  'sk',
  'sl',
  'hr',
  'sr',
  'bg',
  'ro',
  'hu',
  'el',
  'tr',
  'ar',
  'he',
  'fa',
  'hi',
  'bn',
  'th',
  'vi',
];
function SuppliedSelection({ size }: { size: number }) {
  const locale = getLocale();
  const fixture = useMemo(() => {
    const value = candidateFixture('multiple', locale);
    value.publicRead.subject.statements[value.property] = languages.slice(0, size).map((language, index) => ({
      ...structuredClone(value.candidate.statement),
      id: `00000000-0000-8000-8000-${String(index + 1000).padStart(12, '0')}`,
      value: { type: 'value' as const, content: language },
    }));
    return value;
  }, [locale, size]);
  return <CandidateReview id={fixture.id} locale={locale} transport={fixture.transport} />;
}
export const SuppliedSelectionGrowth: Story = {
  render: () => (
    <div className="mx-auto max-w-5xl space-y-8 p-4">
      {[1, 8, 32].map((size) => (
        <div key={size} data-supplied-size={size}>
          <SuppliedSelection size={size} />
        </div>
      ))}
    </div>
  ),
  play: async ({ canvasElement }) => {
    for (const region of canvasElement.querySelectorAll<HTMLElement>('[data-supplied-size]')) {
      const canvas = within(region);
      const size = Number(region.dataset.suppliedSize);
      await userEvent.click(canvas.getByRole('button', { name: m.candidate_entry() }));
      await userEvent.selectOptions(
        await canvas.findByRole('combobox', { name: m.candidate_field() }),
        'schema:inLanguage',
      );
      await canvas.findAllByRole('checkbox');
      await expect(region.querySelectorAll('[data-candidate-item]')).toHaveLength(2);
      await expect(canvas.getAllByRole('checkbox')).toHaveLength(size + 2);
      await expect(
        canvas.getAllByRole('checkbox').filter((node) => node.getAttribute('aria-checked') === 'true'),
      ).toHaveLength(size);
      if (size === 32) await expect(canvas.getAllByRole('checkbox').at(-1)!).toBeDisabled();
    }
  },
};

function RetainedChoice() {
  const locale = getLocale();
  const fixture = useMemo(() => {
    const value = candidateFixture('multiple', locale);
    let boundedReads = 0;
    const transport: CandidateTransport = {
      ...value.transport,
      read: async (...args) => {
        if (args[0] && ++boundedReads === 2) value.candidates.splice(0, 1);
        return value.transport.read(...args);
      },
    };
    return { ...value, transport };
  }, [locale]);
  return <CandidateReview id={fixture.id} locale={locale} transport={fixture.transport} />;
}
export const RetainedUnresolvedChoice: Story = {
  render: () => <RetainedChoice />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const open = async () => {
      await userEvent.click(canvas.getByRole('button', { name: m.candidate_entry() }));
      await userEvent.selectOptions(
        await canvas.findByRole('combobox', { name: m.candidate_field() }),
        'schema:inLanguage',
      );
      await canvas.findAllByRole('checkbox');
    };
    await open();
    const choiceId = canvas.getAllByRole('checkbox').at(-1)!.id;
    await userEvent.click(canvas.getAllByRole('checkbox').at(-1)!);
    await userEvent.click(canvas.getByRole('button', { name: m.candidate_close() }));
    await open();
    await canvas.findByText(m.candidate_choice_unresolved());
    await expect(canvas.getByRole('button', { name: m.candidate_adopt() })).toBeDisabled();
    const retained = canvasElement.querySelector<HTMLElement>(`[id="${choiceId}"]`)!;
    await expect(retained).toBeChecked();
    await userEvent.click(retained);
    await expect(canvas.getByRole('button', { name: m.candidate_adopt() })).toBeEnabled();
  },
};

// The harness changes the supplied observation only; it never signs out a real account.
// The gate releases after the retiring boundary has committed, without a timer or request.
function RetiredReader() {
  const locale = getLocale();
  const [signedIn, setSignedIn] = useState(true);
  const fixture = useMemo(() => {
    const value = candidateFixture('ready', locale);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const transport: CandidateTransport = {
      ...value.transport,
      read: async (...args) => {
        const result = await value.transport.read(...args);
        if (args[0]) await gate;
        return result;
      },
    };
    return { ...value, release, transport };
  }, [locale]);
  useEffect(() => {
    if (!signedIn) fixture.release();
  }, [signedIn, fixture]);
  return (
    <div className="mx-auto max-w-4xl space-y-4 p-4">
      <Button className="min-h-11" onClick={() => setSignedIn(false)}>
        {m.account_sign_out()}
      </Button>
      <CandidateReaderBoundary
        address="candidate-comparison-example"
        observed={
          signedIn
            ? { state: 'signed-in', subject: fixture.transport.reader!, csrfToken: 'AAAAAAAAAAAAAAAAAAAAAA' }
            : { state: 'signed-out', subject: null, csrfToken: null }
        }
      >
        <CandidateReview id={fixture.id} locale={locale} transport={fixture.transport} />
      </CandidateReaderBoundary>
    </div>
  );
}
export const RetiredReaderCompletion: Story = {
  render: () => <RetiredReader />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: m.candidate_entry() }));
    await userEvent.selectOptions(
      await canvas.findByRole('combobox', { name: m.candidate_field() }),
      'schema:datePublished',
    );
    await canvas.findByText(m.candidate_loading());
    const trigger = canvas.getByRole('button', { name: m.account_sign_out() });
    await userEvent.click(trigger);
    await waitFor(() => expect(canvas.queryByRole('region', { name: m.candidate_title() })).toBeNull());
    await expect(trigger).toHaveFocus();
    await expect(canvas.queryByRole('button', { name: m.candidate_retry() })).toBeNull();
  },
};

function UnconfirmedReview({ context = false }: { context?: boolean }) {
  const locale = getLocale();
  const fixture = useMemo(() => {
    const contextual = contextFixture('inherited', locale);
    const value = context ? contextual : candidateFixture('ready', locale);
    const transport: CandidateTransport = {
      ...value.transport,
      confirm: async (...args) => {
        const result = await value.transport.confirm(...args);
        if (!result.ok) return result;
        const committed = { ...result, public: null };
        if (context) {
          delete committed.contextReview;
          committed.contextRefreshFailed = true;
        }
        return committed;
      },
    };
    return { ...value, transport, contextId: context ? contextual.context.id : undefined };
  }, [locale, context]);
  return (
    <CandidateReview
      id={fixture.id}
      locale={locale}
      initialProperty={fixture.property}
      {...(fixture.contextId ? { context: fixture.contextId } : {})}
      transport={fixture.transport}
    />
  );
}
async function unconfirmedJourney(canvasElement: HTMLElement, context = false) {
  const canvas = within(canvasElement);
  await userEvent.click(canvas.getByRole('button', { name: m.candidate_entry() }));
  await userEvent.click(await canvas.findByRole('button', { name: m.candidate_review() }));
  await userEvent.click(canvas.getByRole('button', { name: m.candidate_reject() }));
  const title = m.candidate_confirm_title({ action: m.candidate_reject() });
  await userEvent.click(
    within(canvas.getByRole('region', { name: title })).getByRole('button', { name: m.candidate_reject() }),
  );
  await canvas.findByText(context ? m.context_read_unavailable() : m.candidate_public_unconfirmed());
  await expect(canvas.queryByRole('link', { name: m.candidate_view_public() })).toBeNull();
  if (context) await expect(canvasElement.querySelector('[data-candidate-panel]')).toBeNull();
}
export const PublicReadUnconfirmed: Story = {
  render: () => <UnconfirmedReview />,
  play: async ({ canvasElement }) => unconfirmedJourney(canvasElement),
};
export const CommittedContextRefreshFailed: Story = {
  render: () => <UnconfirmedReview context />,
  play: async ({ canvasElement }) => unconfirmedJourney(canvasElement, true),
};
