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
  title: 'Pages/Catalogue/Relation contribution',
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
