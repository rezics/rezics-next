import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { realizations as fixtureRealizations, releases as fixtureReleases, names as fixtureNames, summary } from '../work-levels/fixtures.ts';
import { copyOf as editionCopy } from '../work-levels/messages.ts';
import { ReleaseView } from '../work-levels/release-page.tsx';
import { EditionsSection, RealizationRow } from '../work-levels/editions.tsx';
import type { SelectedRealizationRead } from '../work-levels/read.ts';
import { messages as workMessages } from '../work-page/messages.ts';
import type { Loaded, Realization, Release } from '../work-levels/types.ts';
import { copyOf } from './messages.ts';
import { citationNames, citedStatements, predicateLabels } from './fixtures.ts';
import { StatementSourcesView } from './sources.tsx';
import { standaloneHrefFor } from './route.ts';
import { resourceHref } from '../address/path.ts';

// Contract-built states, not evidence of native revision history. The prove phase creates R1/release/R2 through commands.
const iri = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
if (!fixtureRealizations.ok || !fixtureReleases.ok) throw new Error('Expected edition fixtures');
const realizationPage = fixtureRealizations.data;
const releasePage = fixtureReleases.data;
const selected: Realization = { ...fixtureRealizations.data.items[0]!, id: iri(1), work: iri(2), revision: iri(11),
  source: { kind: 'unresolved', work: iri(2) } };
const release: Release = { ...fixtureReleases.data.items[0]!, id: iri(3), revision: iri(30),
  coverage: [{ ...fixtureReleases.data.items[0]!.coverage[0]!, work: selected.work, realization: selected.id,
    revision: selected.revision, mainVersion: iri(7), language: selected.language }] };
const names = new Map([...fixtureNames, [selected.work, summary(selected.work, 'The selected Work')],
  [iri(7), summary(iri(7), 'First publication', 'en', 'main-version')]]);
const evidenceId = iri(220);

function Provenance({ evidence = 'native', failure }: {
  evidence?: 'native' | 'absent' | 'external'; failure?: 'identity' | 'unavailable';
}) {
  const read: Loaded<Realization> = failure ? { ok: false, failure } : { ok: true,
    data: { ...selected, evidence: evidence === 'absent' ? null
      : evidence === 'native' ? evidenceId : 'https://example.test/source/revision/1' } };
  return <div className="mx-auto max-w-4xl px-4 py-6"><ReleaseView release={release}
    realizations={new Map([[selected.id, read]])} sources={[]} names={names} locale="en" t={editionCopy('en')} /></div>;
}
const meta = { title: 'Catalogue/Release provenance', component: Provenance } satisfies Meta<typeof Provenance>;
export default meta;
type Story = StoryObj<typeof meta>;

export const NativeEvidence: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const sources = canvas.getByRole('region', { name: 'Sources, licences and evidence' });
    const footer = within(sources);
    await expect(footer.getByText(`${copyOf('en').releaseRevision}: ${release.revision}`)).toBeVisible();
    await expect(footer.getByText(`${copyOf('en').realizationRevision}: ${selected.revision}`)).toBeVisible();
    await expect(footer.getByText(evidenceId, { exact: true })).toBeVisible();
    await expect(sources.querySelector(`a[href="${evidenceId}"]`)).toBeNull();
    await expect(canvasElement.querySelectorAll('[data-realization-record]')).toHaveLength(1);
    const coverage = canvasElement.querySelector('[data-coverage]')!;
    await expect(sources.compareDocumentPosition(coverage) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
  },
};

export const NullEvidence: Story = {
  args: { evidence: 'absent' },
  async play({ canvasElement }) {
    const footer = within(within(canvasElement).getByRole('region', { name: 'Sources, licences and evidence' }));
    await expect(footer.getByText(`${copyOf('en').realizationRevision}: ${selected.revision}`)).toBeVisible();
    await expect(footer.getByText(copyOf('en').noEvidence)).toBeVisible();
    await expect(footer.queryByText(evidenceId)).toBeNull();
  },
};

export const ExternalEvidence: Story = {
  args: { evidence: 'external' },
  async play({ canvasElement }) {
    const footer = within(within(canvasElement).getByRole('region', { name: 'Sources, licences and evidence' }));
    await expect(footer.getByRole('link', { name: 'https://example.test/source/revision/1' })).toHaveAttribute('href',
      'https://example.test/source/revision/1');
  },
};

export const UnavailableRevision: Story = {
  args: { failure: 'unavailable' },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(workMessages.en.regionUnavailable)).toBeVisible();
    await expect(canvas.queryByText(workMessages.en.regionDenied)).toBeNull();
    await expect(canvas.getByText(`${copyOf('en').realizationRevision}: ${selected.revision}`)).toBeVisible();
    await expect(canvasElement.querySelectorAll('[data-coverage]')).toHaveLength(1);
  },
};

export const DeniedRevision: Story = {
  args: { failure: 'identity' },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(workMessages.en.regionDenied)).toBeVisible();
    await expect(canvas.queryByText(workMessages.en.regionUnavailable)).toBeNull();
    await expect(canvas.getByText(`${copyOf('en').realizationRevision}: ${selected.revision}`)).toBeVisible();
  },
};

export const NativeEvidencePhone: Story = { ...NativeEvidence, globals: { viewport: { value: 'phone' } } };

const safeCfi = 'epubcfi(/6/2!/4,/1:0,/1:8)';
const withheldClaims = citedStatements(true);
const claim = withheldClaims.groups[1]!.items[0]!;
if (claim.kind !== 'statement' || !claim.evidence?.[0]) throw new Error('Expected structured claim evidence');
claim.evidence[0].locator = { version: 'rezics-locator-v1', source: { type: 'external',
  representationSha256: claim.evidence[0].representationSha256, mediaType: 'application/epub+zip' },
  selector: { type: 'EpubCfiSelector', cfi: safeCfi } };

export const WithheldCompoundLocator: Story = {
  render: () => <div className="mx-auto max-w-4xl px-4 py-6"><StatementSourcesView
    page={{ ok: true, data: withheldClaims }} labels={predicateLabels} names={citationNames} locale="en" t={copyOf('en')}
    hrefFor={standaloneHrefFor({}, resourceHref('/e/', selected.work))} /></div>,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const sources = canvas.getByRole('region', { name: 'Sources, licences and evidence' });
    await expect(within(sources).getByText(safeCfi, { exact: true })).toBeVisible();
    await expect(within(sources).getByText(copyOf('en').quotationWithheld)).toBeVisible();
    await expect(sources.textContent).not.toContain('WITHHELD');
    await expect(sources.querySelector('blockquote')).toBeNull();
    await expect(sources.querySelector('[data-claim-evidence]')).not.toBeNull();
  },
};

export const WithheldCompoundLocatorPhone: Story = { ...WithheldCompoundLocator, globals: { viewport: { value: 'phone' } } };

const refusedSources: SelectedRealizationRead[] = (['missing', 'identity', 'unavailable'] as const).map((failure, index) => ({
  id: iri(300 + index), work: selected.work, revision: iri(310 + index), read: { ok: false, failure },
}));
const translations: Realization[] = refusedSources.map((source, index) => ({ ...selected,
  id: iri(320 + index), evidence: null, source: { kind: 'realization', work: source.work,
    realization: source.id, revision: source.revision },
}));

export const EditionsSourceRefusals: Story = {
  render: () => <div className="mx-auto max-w-4xl px-4 py-6"><EditionsSection
    realizations={{ ok: true, data: { ...realizationPage, items: translations, nextCursor: 'opaque-text-next' } }}
    sources={[]} sourceReads={refusedSources} releases={{ ok: true, data: { ...releasePage, items: [], nextCursor: null } }}
    names={names} workRef={selected.work.slice(-36)} query={{}} locale="en" t={editionCopy('en')} pageMessages={workMessages.en} /></div>,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    for (const message of [workMessages.en.regionMissing, workMessages.en.regionDenied, workMessages.en.regionUnavailable])
      await expect(canvas.getByText(message)).toBeVisible();
    for (const source of refusedSources) {
      await expect(canvas.getByText(source.id, { exact: true })).toBeVisible();
      await expect(canvas.getByText(`${copyOf('en').realizationRevision}: ${source.revision}`)).toBeVisible();
    }
    await expect(canvas.queryByText(editionCopy('en').continuityOther)).toBeNull();
    await expect(canvasElement.querySelectorAll('[data-source-refusal]')).toHaveLength(3);
    await expect(canvas.getByRole('link', { name: editionCopy('en').showMore })).toHaveAttribute('href',
      expect.stringContaining('realizationsAfter=opaque-text-next'));
  },
};

export const EditionsSourceRefusalsPhone: Story = { ...EditionsSourceRefusals, globals: { viewport: { value: 'phone' } } };

export const EditionsEvidenceReferences: Story = {
  render: () => <div className="mx-auto max-w-4xl px-4 py-6"><ul className="grid gap-5">
    <RealizationRow realization={{ ...selected, evidence: evidenceId }} all={[]} releases={[]} names={names} locale="en" t={editionCopy('en')} />
    <RealizationRow realization={{ ...selected, id: iri(401), evidence: 'https://example.test/source/revision/1' }}
      all={[]} releases={[]} names={names} locale="en" t={editionCopy('en')} />
  </ul></div>,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(evidenceId, { exact: true })).toBeVisible();
    await expect(canvasElement.querySelector(`a[href="${evidenceId}"]`)).toBeNull();
    await expect(canvas.getByRole('link', { name: 'https://example.test/source/revision/1' })).toHaveAttribute('href',
      'https://example.test/source/revision/1');
  },
};
