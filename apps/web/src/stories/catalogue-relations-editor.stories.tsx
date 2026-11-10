import type { Meta, StoryObj } from '@storybook/react-vite';
import { useMemo, useState } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { pickText } from '@rezics/composition';
import { RelationEditor } from '../features/catalogue/relation-editor';
import { relationFixture, relationProperty, type RelationScenario } from '../kernel/fake/catalogue-relations';
import { pagePaths, PatternStory } from './page';
import { AppShell } from '../shell/shell';
import { SubjectFrame } from '../features/pages/subject-frame';
import { subjectPageMessages, viewTabLabels } from '../features/pages/route-support';
import { SubjectPage, type SubjectPageData } from '../features/pages/subject';
import { getLocale } from '../paraglide/runtime';
import { m } from '../paraglide/messages.js';
import recording from '../kernel/recorded/subject-page.json';

function RelationStory({ scenario = 'ready' }: { scenario?: RelationScenario }) {
  const locale = getLocale();
  const fixture = useMemo(() => relationFixture(scenario, locale), [scenario, locale]);
  const [reader, setReader] = useState<SubjectPageData>();
  const labels = fixture.publicRead.subject.labels;
  const title = pickText(labels, locale);
  return (
    <PatternStory visitor="Signed In" path={pagePaths.subject}>
      <AppShell>
        <article className="mx-auto w-full max-w-4xl space-y-8 p-4 sm:p-8">
          <SubjectFrame
            frame={{
              id: fixture.id,
              type: fixture.publicRead.subject.type,
              title: { text: title.text, ...(title.lang ? { lang: title.lang } : {}) },
              summary: null,
            }}
            locale={locale}
            unlabelled={m.subject_value_unlabelled()}
            tabs={[]}
            tabLabels={viewTabLabels()}
            view="overview"
          />
          <RelationEditor
            key={`${scenario}:${locale}`}
            id={fixture.id}
            locale={locale}
            transport={fixture.transport}
            search={async (text) =>
              Object.entries(fixture.publicRead.related).flatMap(([id, related]) => {
                const title = pickText(related.labels, locale).text;
                return title.toLocaleLowerCase().includes(text.toLocaleLowerCase())
                  ? [{ id, title, types: related.type ? [related.type] : [], typeLabel: '', cover: null }]
                  : [];
              })
            }
            onSelected={async () => {
              const read = await fixture.client.subjects({ id: fixture.id }).get();
              if (!read.data || read.status !== 200) return;
              const page = structuredClone(recording) as unknown as SubjectPageData;
              for (const value of Object.values(page.reads)) {
                if (value.body && typeof value.body === 'object' && 'subject' in value.body) value.body = read.data;
              }
              setReader(page);
            }}
          />
          {reader && (
            <section aria-label={m.candidate_view_public()} className="space-y-4 border-t border-border pt-6">
              <SubjectPage page={reader} locale={locale} messages={subjectPageMessages()} renderJsonLd={false} />
            </section>
          )}
        </article>
      </AppShell>
    </PatternStory>
  );
}
const meta = {
  title: 'Catalogue/Relation contribution',
  id: 'pages-catalogue-relation-contribution',
  component: RelationStory,
  tags: ['autodocs'],
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof RelationStory>;
export default meta;
type Story = StoryObj<typeof meta>;
async function draft(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  const view = within(await canvas.findByRole('region', { name: m.relation_title() }));
  await userEvent.click(view.getByRole('button', { name: m.relation_open() }));
  await userEvent.selectOptions(await view.findByRole('combobox', { name: m.relation_property() }), relationProperty);
  return view;
}
async function review(canvasElement: HTMLElement) {
  const view = await draft(canvasElement);
  await userEvent.click(view.getAllByRole('button', { name: m.relation_edit_existing() })[0]!);
  await userEvent.click(view.getByRole('button', { name: m.relation_review_slot() }));
  return view;
}
async function confirm(canvasElement: HTMLElement) {
  const view = await review(canvasElement);
  await userEvent.click(await view.findByRole('button', { name: m.candidate_review() }));
  await userEvent.click(view.getByRole('button', { name: m.candidate_accept() }));
  await userEvent.click(view.getByRole('button', { name: m.candidate_accept() }));
  return view;
}
async function confirmAction(view: ReturnType<typeof within>, action: string) {
  await userEvent.click(view.getByRole('button', { name: action }));
  const confirmation = within(view.getByRole('group', { name: m.candidate_confirm_title({ action }) }));
  await userEvent.click(confirmation.getByRole('button', { name: action }));
}
async function adopt(canvasElement: HTMLElement) {
  const view = await confirm(canvasElement);
  await view.findByText(m.candidate_accepted());
  await userEvent.click(view.getByRole('button', { name: m.candidate_reload() }));
  await userEvent.click(await view.findByRole('button', { name: m.candidate_review() }));
  await userEvent.selectOptions(view.getByRole('combobox', { name: m.relation_rank() }), 'preferred');
  await userEvent.click(view.getByRole('button', { name: m.candidate_adopt() }));
  await userEvent.click(view.getByRole('button', { name: m.candidate_adopt() }));
  return view;
}
export const Journey: Story = {
  play: async ({ canvasElement }) => {
    const view = await draft(canvasElement);
    // Select a real target and a declared character key using the shared subject pickers.
    const target = view.getByRole('combobox', { name: m.relation_target() });
    await userEvent.type(target, 'Aoi');
    await userEvent.click(await within(document.body).findByRole('option', { name: /Aoi Yuki/ }));
    await userEvent.selectOptions(view.getByRole('combobox', { name: m.relation_qualifier() }), 'wdt:P453');
    const role = fixtureRoleLabel();
    await userEvent.type(view.getByRole('combobox', { name: role }), 'traveler');
    await userEvent.click(await within(document.body).findByRole('option', { name: /The traveler/ }));
    await userEvent.type(view.getByRole('textbox', { name: m.relation_citation() }), 'https://example.org/new-credit');
    await userEvent.click(view.getByRole('button', { name: m.relation_add_citation() }));
    await confirmAction(view, m.relation_propose());
    await view.findByText(m.relation_proposed());
    await userEvent.click(view.getByRole('button', { name: m.candidate_accept() }));
    await userEvent.click(view.getByRole('button', { name: m.candidate_accept() }));
    await view.findByText(m.candidate_accepted());
    await userEvent.click(view.getByRole('button', { name: m.candidate_reload() }));
    const buttons = await view.findAllByRole('button', { name: m.candidate_review() });
    await userEvent.click(buttons.at(-1)!);
    await userEvent.click(view.getByRole('button', { name: m.candidate_adopt() }));
    await userEvent.click(view.getByRole('button', { name: m.candidate_adopt() }));
    await view.findByText(m.candidate_selected());
    await expect(
      within(canvasElement).findByRole('region', { name: m.candidate_view_public() }),
    ).resolves.toBeVisible();
  },
};
function fixtureRoleLabel() {
  const fixture = relationFixture();
  return pickText(fixture.release.properties['wdt:P453']!.labels, getLocale()).text;
}
export const Ready: Story = {
  play: async ({ canvasElement }) => {
    await draft(canvasElement);
  },
};
export const Empty: Story = {
  args: { scenario: 'empty' },
  play: async ({ canvasElement }) => {
    const view = await draft(canvasElement);
    await userEvent.type(view.getByRole('combobox', { name: m.relation_target() }), 'Aoi');
    await userEvent.click(await within(document.body).findByRole('option', { name: /Aoi Yuki/ }));
    await userEvent.click(view.getByRole('button', { name: m.relation_review_slot() }));
    await view.findByText(m.candidate_empty());
  },
};
export const Loading: Story = {
  args: { scenario: 'loading' },
  play: async ({ canvasElement }) => {
    const view = await draft(canvasElement);
    await userEvent.click(view.getAllByRole('button', { name: m.relation_edit_existing() })[0]!);
    await userEvent.click(view.getByRole('button', { name: m.relation_review_slot() }));
    await view.findByText(m.candidate_loading());
  },
};
export const Denied: Story = {
  args: { scenario: 'denied' },
  play: async ({ canvasElement }) => {
    const view = await draft(canvasElement);
    await userEvent.click(view.getAllByRole('button', { name: m.relation_edit_existing() })[0]!);
    await userEvent.click(view.getByRole('button', { name: m.relation_review_slot() }));
    await view.findByText(m.candidate_denied());
  },
};
export const StaleConflict: Story = {
  args: { scenario: 'stale' },
  play: async ({ canvasElement }) => {
    const view = await confirm(canvasElement);
    await view.findByText(m.relation_stale());
    await expect(view.getByRole('button', { name: m.candidate_accept() })).toBeDisabled();
  },
};
export const Invalid: Story = {
  args: { scenario: 'invalid' },
  play: async ({ canvasElement }) => {
    const view = await confirm(canvasElement);
    await view.findByText(m.candidate_invalid());
  },
};
export const UnavailableRetry: Story = {
  args: { scenario: 'unavailable' },
  play: async ({ canvasElement }) => {
    const view = await review(canvasElement);
    await view.findByText(m.candidate_unavailable());
    await userEvent.click(view.getByRole('button', { name: m.candidate_reload() }));
    await view.findByRole('button', { name: m.candidate_review() });
  },
};
export const Pending: Story = {
  args: { scenario: 'pending' },
  play: async ({ canvasElement }) => {
    const view = await adopt(canvasElement);
    await view.findByText(m.candidate_pending());
    expect(view.queryByRole('link', { name: m.candidate_view_public() })).toBeNull();
  },
};
export const Selected: Story = {
  play: async ({ canvasElement }) => {
    const view = await adopt(canvasElement);
    await view.findByText(m.candidate_selected());
  },
};
export const Retracted: Story = {
  args: { scenario: 'retracted' },
  play: async ({ canvasElement }) => {
    const view = await review(canvasElement);
    await expect(view.findByRole('button', { name: m.candidate_retracted() })).resolves.toBeDisabled();
  },
};
export const Unresolved: Story = {
  args: { scenario: 'unresolved' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const view = within(await canvas.findByRole('region', { name: m.relation_title() }));
    await userEvent.click(view.getByRole('button', { name: m.relation_open() }));
    await userEvent.selectOptions(await view.findByRole('combobox', { name: m.relation_property() }), 'schema:author');
    await userEvent.click(view.getByRole('button', { name: m.relation_edit_existing() }));
    await view.findByText(m.relation_unresolved());
    await userEvent.click(view.getByRole('button', { name: m.relation_review_slot() }));
    await view.findByRole('button', { name: m.candidate_review() });
  },
};

// Authored UNRUN additions. Reuse the same connected native-shaped fixture and real component.
// Review each at phone390/desktop1280, both themes and every launch-locale global.
// These are interface evidence; they do not establish native authorization or physical geometry.
const relationFamilyParameters = {
  viewport: {
    options: {
      phone390: { name: 'Phone 390', styles: { width: '390px', height: '844px' } },
      desktop1280: { name: 'Desktop 1280', styles: { width: '1280px', height: '900px' } },
    },
  },
  docs: {
    description: {
      story:
        'Authored UNRUN: actual connected editors, full supplied evidence and independent native controls. Review at phone390/desktop1280, enlarged text, light/dark and locale globals. Browser geometry, native acceptance and private SSR remain deferred.',
    },
  },
};
const completeCredit = 'Original credit — 旅人 العربية Édition complète '.repeat(8);
const completeReference = `https://example.org/${'exact-reference-'.repeat(24)}?credit=original%2Brole#source`;

function IndependentRelationStory({
  consent = false,
  rtl = false,
  accepted = false,
}: {
  consent?: boolean;
  rtl?: boolean;
  accepted?: boolean;
}) {
  const locale = getLocale();
  const fixtures = useMemo(
    () =>
      [0, 1, 2].map(() => {
        const fixture = relationFixture('ready', locale);
        if (accepted) fixture.candidate.decision = 'accepted';
        if (consent) fixture.publicRead.subject.type = 'schema:Person';
        else
          for (const statement of [fixture.original, fixture.candidate.statement, fixture.draft]) {
            statement.qualifiers[1] = {
              property: { id: 'wdt:P1932', data_type: 'string' },
              value: { type: 'value', content: completeCredit },
            };
            statement.qualifiers.push({
              property: { id: 'schema:position', data_type: 'string' },
              value: { type: 'value', content: '2' },
            });
            statement.references[0]!.parts[0]!.value = { type: 'value', content: completeReference };
          }
        return fixture;
      }),
    [locale, consent, accepted],
  );
  return (
    <PatternStory visitor="Signed In" path={pagePaths.subject}>
      <AppShell>
        <article dir={rtl ? 'rtl' : 'ltr'} className="mx-auto w-full max-w-4xl space-y-10 p-4 sm:p-8">
          {fixtures.slice(0, consent ? 2 : 3).map((fixture, index) => (
            <RelationEditor
              key={`${locale}:${consent}:${index}`}
              id={fixture.id}
              locale={locale}
              embedded={index === 1}
              transport={fixture.transport}
              search={async (text) =>
                Object.entries(fixture.publicRead.related).flatMap(([id, related]) => {
                  const title = pickText(related.labels, locale).text;
                  return title.toLocaleLowerCase().includes(text.toLocaleLowerCase())
                    ? [{ id, title, types: related.type ? [related.type] : [], typeLabel: '', cover: null }]
                    : [];
                })
              }
              {...(index === 2
                ? { composition: { statement: fixture.draft, slot: fixture.slot, positionEditable: true } }
                : {})}
            />
          ))}
        </article>
      </AppShell>
    </PatternStory>
  );
}

function assertOwnNativeAssociations(region: HTMLElement) {
  for (const label of region.querySelectorAll<HTMLLabelElement>('label[for]')) {
    const control = region.ownerDocument.getElementById(label.htmlFor);
    expect(control).not.toBeNull();
    expect(region.contains(control)).toBe(true);
    expect([...region.ownerDocument.querySelectorAll('[id]')].filter((node) => node.id === label.htmlFor)).toHaveLength(
      1,
    );
    expect(control!.matches('input,select,[role="checkbox"]')).toBe(true);
  }
  expect(region.querySelector('[data-slot="list-row-link"]')).toBeNull();
}

async function independentDrafts(canvasElement: HTMLElement) {
  const regions = within(canvasElement).getAllByRole('region', { name: m.relation_title() });
  for (const [index, region] of regions.entries()) {
    const view = within(region);
    await userEvent.click(view.getByRole('button', { name: m.relation_open() }));
    const property = await view.findByRole('combobox', { name: m.relation_property() });
    expect(property.tagName).toBe('SELECT');
    if (index !== 2) {
      await userEvent.selectOptions(property, relationProperty);
      await userEvent.click(view.getAllByRole('button', { name: m.relation_edit_existing() })[0]!);
    }
    assertOwnNativeAssociations(region);
    expect(view.getByRole('heading', { level: 2, name: m.relation_draft() })).toBeVisible();
    const scalar = region.querySelector<HTMLInputElement>('input[id$="qualifier-1"]')!;
    expect(scalar.value).toBe(completeCredit);
    const label = [...region.querySelectorAll<HTMLLabelElement>('label')].find((node) => node.htmlFor === scalar.id)!;
    if (index === 2) expect(scalar).toBeDisabled();
    else {
      await userEvent.click(label);
      expect(scalar).toHaveFocus();
      for (const other of regions.filter((node) => node !== region))
        expect(other.contains(document.activeElement)).toBe(false);
    }
    // Native citation and qualifier controls have independent tab stops and full values.
    const citation = view.getByRole('textbox', { name: m.relation_citation() });
    const citationLabel = [...region.querySelectorAll<HTMLLabelElement>('label')].find(
      (node) => node.htmlFor === citation.id,
    )!;
    await userEvent.click(citationLabel);
    expect(citation).toHaveFocus();
    for (const other of regions.filter((node) => node !== region))
      expect(other.contains(document.activeElement)).toBe(false);
    await userEvent.tab();
    expect(document.activeElement).not.toBe(citation);
    expect(region.contains(document.activeElement)).toBe(true);
  }
  return regions;
}

export const IndependentEditors: Story = {
  parameters: relationFamilyParameters,
  render: () => <IndependentRelationStory />,
  play: async ({ canvasElement }) => {
    const regions = await independentDrafts(canvasElement);
    const first = regions[0]!.querySelector<HTMLInputElement>('input[id$="qualifier-1"]')!;
    await userEvent.clear(first);
    await userEvent.type(first, 'Only this standalone credit');
    expect(regions[1]!.querySelector<HTMLInputElement>('input[id$="qualifier-1"]')!.value).toBe(completeCredit);
    expect(regions[2]!.querySelector<HTMLInputElement>('input[id$="qualifier-1"]')!.value).toBe(completeCredit);
  },
};

export const CompleteExactSlotReview: Story = {
  parameters: relationFamilyParameters,
  render: () => <IndependentRelationStory rtl />,
  play: async ({ canvasElement }) => {
    const regions = await independentDrafts(canvasElement);
    for (const region of regions) {
      const view = within(region);
      await userEvent.click(view.getByRole('button', { name: m.relation_review_slot() }));
      await userEvent.click(await view.findByRole('button', { name: m.candidate_review() }));
      expect(view.getByRole('heading', { level: 2, name: m.relation_review_slot() })).toBeVisible();
      expect(view.getByRole('heading', { level: 3, name: m.candidate_current() })).toBeVisible();
      expect(view.getByRole('heading', { level: 3, name: m.candidate_proposed() })).toBeVisible();
      for (const statement of region.querySelectorAll<HTMLElement>('[data-relation-statement]')) {
        expect(statement.textContent).toContain(completeCredit);
        expect(statement.textContent).toContain(completeReference);
        expect(statement.textContent).toContain('Aoi Yuki');
        expect(statement.textContent).toContain('The traveler');
        expect(statement.querySelector(`a[href="${completeReference}"]`)).toBeVisible();
        expect(statement.querySelector('.truncate,.line-clamp-1,.line-clamp-2')).toBeNull();
      }
      assertOwnNativeAssociations(region);
      // Real geometry assertions are authored for later browser execution; DOM creation is not their result.
      expect(region.scrollWidth).toBeLessThanOrEqual(region.clientWidth + 1);
      for (const button of within(region).getAllByRole('button')) {
        if (!(button as HTMLButtonElement).disabled) {
          const rect = button.getBoundingClientRect();
          expect(rect.height).toBeGreaterThanOrEqual(44);
          expect(rect.width).toBeGreaterThanOrEqual(44);
        }
      }
    }
  },
};

export const CompleteProposalConfirmation: Story = {
  parameters: relationFamilyParameters,
  render: () => <IndependentRelationStory />,
  play: async ({ canvasElement }) => {
    const regions = await independentDrafts(canvasElement);
    for (const region of regions) {
      const view = within(region);
      await userEvent.click(view.getByRole('button', { name: m.relation_propose() }));
      const group = view.getByRole('group', { name: m.candidate_confirm_title({ action: m.relation_propose() }) });
      expect(
        within(group).getByRole('heading', {
          level: 2,
          name: m.candidate_confirm_title({ action: m.relation_propose() }),
        }),
      ).toBeVisible();
      expect(within(group).getByText(m.relation_confirm_propose())).toBeVisible();
      expect(group.textContent).toContain(completeCredit);
      expect(group.textContent).toContain(completeReference);
      const submit = within(group).getByRole('button', { name: m.relation_propose() });
      submit.focus();
      await userEvent.tab();
      const cancel = within(group).getByRole('button', { name: m.candidate_cancel() });
      expect(cancel).toHaveFocus();
      const focus = getComputedStyle(cancel);
      expect(focus.outlineStyle).not.toBe('none');
      expect(Number.parseFloat(focus.outlineWidth)).toBeGreaterThanOrEqual(2);
      // Cancellation never proposes. The adjacent editor's controls and draft remain separate.
      await userEvent.keyboard('{Enter}');
      expect(
        view.queryByRole('group', { name: m.candidate_confirm_title({ action: m.relation_propose() }) }),
      ).toBeNull();
      expect(view.queryByText(m.relation_proposed())).toBeNull();
      assertOwnNativeAssociations(region);
    }
  },
};

export const IndependentOwnConsent: Story = {
  parameters: relationFamilyParameters,
  render: () => <IndependentRelationStory consent />,
  play: async ({ canvasElement }) => {
    const regions = within(canvasElement).getAllByRole('region', { name: m.relation_title() });
    for (const region of regions) {
      const view = within(region);
      await userEvent.click(view.getByRole('button', { name: m.relation_open() }));
      await userEvent.selectOptions(
        await view.findByRole('combobox', { name: m.relation_property() }),
        'rezics:penNameOf',
      );
      assertOwnNativeAssociations(region);
      expect(view.getByText(m.statement_consent_unsourced())).toBeVisible();
    }
    const first = within(regions[0]!).getByRole('checkbox', { name: m.statement_consent_own() });
    const second = within(regions[1]!).getByRole('checkbox', { name: m.statement_consent_own() });
    const label = [...regions[1]!.querySelectorAll<HTMLLabelElement>('label')].find(
      (node) => node.htmlFor === second.id,
    )!;
    await userEvent.click(label);
    expect(second).toBeChecked();
    expect(second.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    expect(second.getBoundingClientRect().width).toBeGreaterThanOrEqual(44);
    expect(first).not.toBeChecked();
    second.focus();
    await userEvent.keyboard(' ');
    expect(second).not.toBeChecked();
  },
};

export const ImmutableUncertainRecovery: Story = {
  parameters: relationFamilyParameters,
  args: { scenario: 'lost-response' },
  play: async ({ canvasElement }) => {
    const view = await adopt(canvasElement);
    await view.findByText(m.candidate_unavailable());
    const group = view.getByRole('group', { name: m.candidate_confirm_title({ action: m.candidate_adopt() }) });
    expect(within(group).getByText(m.relation_confirm_adopt())).toBeVisible();
    expect(within(group).getByRole('button', { name: m.candidate_cancel() })).toBeDisabled();
    expect(view.queryByRole('button', { name: m.candidate_reload() })).toBeNull();
    const retry = within(group).getByRole('button', { name: m.candidate_adopt() });
    retry.focus();
    await userEvent.keyboard('{Enter}');
    await view.findByText(m.candidate_selected());
  },
};

export const IndependentAdoptionControls: Story = {
  parameters: relationFamilyParameters,
  render: () => <IndependentRelationStory accepted />,
  play: async ({ canvasElement }) => {
    const regions = await independentDrafts(canvasElement);
    for (const region of regions) {
      const view = within(region);
      await userEvent.click(view.getByRole('button', { name: m.relation_review_slot() }));
      await userEvent.click(await view.findByRole('button', { name: m.candidate_review() }));
      assertOwnNativeAssociations(region);
      const rank = view.getByRole('combobox', { name: m.relation_rank() });
      const label = [...region.querySelectorAll<HTMLLabelElement>('label')].find((node) => node.htmlFor === rank.id)!;
      await userEvent.click(label);
      expect(rank).toHaveFocus();
      for (const other of regions.filter((node) => node !== region))
        expect(other.contains(document.activeElement)).toBe(false);
      expect(view.queryByRole('link', { name: m.candidate_view_public() })).toBeNull();
    }
    await userEvent.selectOptions(within(regions[0]!).getByRole('combobox', { name: m.relation_rank() }), 'preferred');
    for (const region of regions.slice(1))
      expect(within(region).getByRole('combobox', { name: m.relation_rank() })).toHaveValue('normal');
  },
};
