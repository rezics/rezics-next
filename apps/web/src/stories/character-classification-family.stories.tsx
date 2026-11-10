import type { Meta, StoryObj } from '@storybook/react-vite';
import { useMemo } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { CharacterClassification } from '../features/catalogue/character-profile-classification';
import { CharacterProfile } from '../features/catalogue/character-profile-view';
import type { FactsCurrent } from '../features/catalogue/subject-facts';
import {
  characterProfileFixture,
  characterProfileId,
  type CharacterScenario,
} from '../kernel/fake/catalogue-character-profile';
import { getLocale } from '../paraglide/runtime';
import { m } from '../paraglide/messages.js';
import { AppShell } from '../shell/shell';
import { PatternStory } from './page';

const concept = '00000000-0000-4000-8000-00000000d101';
const otherConcept = '00000000-0000-4000-8000-00000000d102';
const citation = 'https://archive.example/character/' + 'original-source-'.repeat(12) + '?record=A%2Fb#evidence';

function Example({
  count = 1,
  property = 'schema:keywords',
  scenario = 'ready',
  long = false,
  rtl = false,
  independent = false,
  parent = false,
}: {
  count?: number;
  property?: string;
  scenario?: CharacterScenario;
  long?: boolean;
  rtl?: boolean;
  independent?: boolean;
  parent?: boolean;
}) {
  const locale = getLocale();
  const { fixture, read, search, review } = useMemo(() => {
    const fixture = characterProfileFixture(scenario, locale);
    const release = structuredClone(fixture.release);
    if (long)
      release.properties[property]!.labels = { ja: '物語で明示された分類と根拠をすべて保持する長い名前 — '.repeat(8) };
    fixture.character.related[concept] = {
      type: 'skos:Concept',
      labels: long
        ? { ja: '出典で明示された分類の完全な名前 — '.repeat(12) }
        : { en: 'Supplied classification', ja: '明示された分類' },
    };
    fixture.character.related[otherConcept] = {
      type: 'skos:Concept',
      labels: { en: long ? 'Complete supplied classification name — '.repeat(12) : 'Another classification' },
    };
    const seed = fixture.character.subject.statements['schema:height']![0]!;
    fixture.character.subject.statements[property] = Array.from({ length: count }, (_, index) => ({
      ...structuredClone(seed),
      id: `00000000-0000-4000-8000-${String(index + 800).padStart(12, '0')}`,
      property: { id: property, data_type: 'wikibase-item' },
      value: { type: 'value' as const, content: index % 2 ? otherConcept : concept },
      references: [
        {
          hash: 'supplied-evidence',
          parts: [
            { property: { id: 'schema:url', data_type: 'url' }, value: { type: 'value' as const, content: citation } },
          ],
        },
      ],
    }));
    const read: FactsCurrent = { ok: true, release, public: fixture.character, source: null };
    return {
      fixture,
      read,
      search: async () => [
        {
          id: otherConcept,
          title: fixture.character.related[otherConcept]!.labels.en!,
          types: ['skos:Concept'],
          typeLabel: '',
          cover: null,
        },
        {
          id: fixture.work.id,
          title: 'An ineligible work',
          types: [fixture.work.publicRead.subject.type],
          typeLabel: '',
          cover: null,
        },
      ],
      review: (field: string, session?: string) => {
        const transport = fixture.props.review(characterProfileId, field, session);
        return {
          ...transport,
          read: (property?: string, cursor?: string, continuity = session) =>
            transport.read(property, cursor, continuity),
        };
      },
    };
  }, [scenario, locale, property, count, long]);
  return (
    <PatternStory visitor={scenario === 'signed-out' ? 'Signed Out' : 'Signed In'}>
      <AppShell>
        {parent ? (
          <CharacterProfile locale={locale} id={characterProfileId} {...fixture.props} />
        ) : (
          <div className="mx-auto grid w-full max-w-4xl gap-6 px-4 py-8" dir={rtl ? 'rtl' : undefined}>
            {Array.from({ length: independent ? 2 : 1 }, (_, index) => (
              <CharacterClassification
                key={index}
                property={property}
                read={read}
                locale={locale}
                search={search}
                transport={fixture.props.facts(characterProfileId)}
                review={review}
              />
            ))}
          </div>
        )}
      </AppShell>
    </PatternStory>
  );
}

const meta = {
  title: 'Catalogue/Character classification family',
  id: 'pages-catalogue-character-classification-family',
  component: Example,
  parameters: {
    layout: 'fullscreen',
    viewport: {
      options: {
        phone390: { name: 'Phone 390', styles: { width: '390px', height: '844px' } },
        desktop1280: { name: 'Desktop 1280', styles: { width: '1280px', height: '900px' } },
      },
    },
    docs: {
      description: {
        component:
          'Authored UNRUN. Actual CharacterClassification and unchanged connected CharacterProfile with the canonical character adapter fixture and supplied Concept statements. Use locale/theme globals and 390/1280 viewports. Drafts remain private; Review deliberately opens the exact candidate. Mounted assertions are not measured geometry, browser or native proof. Supplied selected rows grow at 1/8/32 with zero mount requests; no hidden population traversal or new transport is introduced. Physical/native growth remains UNRUN.',
      },
    },
  },
} satisfies Meta<typeof Example>;
export default meta;
type Story = StoryObj<typeof meta>;

async function edit(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  await userEvent.click(canvas.getByRole('button', { name: m.facts_edit_field() }));
  await expect(canvas.getByText(m.facts_private())).toBeVisible();
  await expect(canvas.getByRole('heading', { level: 4, name: m.correction_replacement() })).toBeVisible();
  return canvas;
}
async function change(canvasElement: HTMLElement) {
  const canvas = await edit(canvasElement);
  const input = canvas.getByRole('textbox', { name: m.correction_value() });
  await userEvent.clear(input);
  await userEvent.type(input, otherConcept);
  await userEvent.click(canvas.getByRole('button', { name: m.correction_submit() }));
  return canvas;
}

// Authored browser assertions; these are deliberately not claimed as measured evidence until the plays run.
async function readable(canvasElement: HTMLElement, width: number) {
  const document = canvasElement.ownerDocument;
  const section = canvasElement.querySelector('h3[data-content-item-slot="title"]')!.closest('section')!;
  await expect(document.documentElement.clientWidth).toBe(width);
  const bounds = section.getBoundingClientRect();
  await expect(bounds.left).toBeGreaterThanOrEqual(0);
  await expect(bounds.right).toBeLessThanOrEqual(width);
  await expect(section.scrollWidth).toBeLessThanOrEqual(section.clientWidth + 1);
  const actions: string[] = [
    m.facts_edit_field(),
    m.facts_add_value(),
    m.correction_submit(),
    m.correction_retry(),
    m.correction_review(),
  ];
  for (const control of section.querySelectorAll<HTMLElement>('button, select')) {
    if (control.tagName !== 'SELECT' && !actions.includes(control.textContent ?? '')) continue;
    const rect = control.getBoundingClientRect();
    const coarse = document.defaultView!.matchMedia('(pointer: coarse)').matches;
    await expect(rect.height).toBeGreaterThanOrEqual(width < 768 || coarse ? 44 : 32);
    await expect(rect.width).toBeGreaterThanOrEqual(44);
    await expect(rect.left).toBeGreaterThanOrEqual(bounds.left);
    await expect(rect.right).toBeLessThanOrEqual(bounds.right);
  }
  for (const text of section.querySelectorAll<HTMLElement>('h3, label, button, p')) {
    await expect(text.scrollWidth).toBeLessThanOrEqual(text.clientWidth + 1);
    const rect = text.getBoundingClientRect();
    const walker = document.createTreeWalker(text, 4 /* SHOW_TEXT */);
    while (walker.nextNode()) {
      if (!walker.currentNode.textContent?.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(walker.currentNode);
      for (const line of range.getClientRects()) {
        await expect(line.left).toBeGreaterThanOrEqual(rect.left - 1);
        await expect(line.right).toBeLessThanOrEqual(rect.right + 1);
        await expect(line.top).toBeGreaterThanOrEqual(rect.top - 1);
        await expect(line.bottom).toBeLessThanOrEqual(rect.bottom + 1);
      }
    }
  }
}

export const NoSelectedValue: Story = {
  args: { count: 0 },
  play: async ({ canvasElement }) => {
    await edit(canvasElement);
  },
};
export const OneSelectedValue: Story = {
  args: { property: 'schema:gender' },
  play: async ({ canvasElement }) => {
    const canvas = await edit(canvasElement);
    await expect(canvas.getByRole('button', { name: m.correction_submit() })).toBeDisabled();
  },
};
export const MultipleSelectedValues: Story = {
  args: { count: 2 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const select = canvas.getByRole('combobox', { name: m.facts_choose_value() });
    await expect(canvas.getByRole('button', { name: m.facts_edit_field() })).toBeDisabled();
    await userEvent.click(canvas.getByText(m.facts_choose_value(), { selector: 'label' }));
    await expect(select).toHaveFocus();
    await userEvent.selectOptions(select, '00000000-0000-4000-8000-000000000800');
    await userEvent.tab();
    await expect(canvas.getByRole('button', { name: m.facts_edit_field() })).toHaveFocus();
  },
};
export const AddValue: Story = {
  args: { count: 2 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: m.facts_add_value() }));
    await expect(canvas.getByRole('textbox', { name: m.correction_value() })).toHaveValue('');
  },
};
export const ExactReview: Story = {
  play: async ({ canvasElement }) => {
    const canvas = await change(canvasElement);
    await expect(await canvas.findByText(m.correction_proposed())).toBeVisible();
    await expect(canvas.queryByRole('heading', { name: m.candidate_title() })).toBeNull();
    await userEvent.click(canvas.getByRole('button', { name: m.correction_review() }));
    await expect(await canvas.findByRole('heading', { name: m.candidate_proposed() })).toBeVisible();
  },
};
export const UncertainRetry: Story = {
  args: { scenario: 'uncertain' },
  globals: { viewport: { value: 'phone390', isRotated: false } },
  play: async ({ canvasElement }) => {
    const canvas = await change(canvasElement);
    const retry = await canvas.findByRole('button', { name: m.correction_retry() });
    await expect(canvas.getByRole('textbox', { name: m.correction_value() })).toBeDisabled();
    await readable(canvasElement, 390);
    await userEvent.click(retry);
    await expect(await canvas.findByText(m.correction_proposed())).toBeVisible();
    await readable(canvasElement, 390);
  },
};
export const IndependentInstances: Story = {
  args: { independent: true, count: 2 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const choices = canvas.getAllByRole('combobox', { name: m.facts_choose_value() });
    await expect(choices[0]!.id).not.toBe(choices[1]!.id);
    await userEvent.selectOptions(choices[1]!, '00000000-0000-4000-8000-000000000801');
    await userEvent.click(canvas.getAllByRole('button', { name: m.facts_edit_field() })[1]!);
    await expect(canvas.getByRole('textbox', { name: m.correction_value() })).toHaveValue(otherConcept);
    await expect(canvas.getByRole('combobox', { name: m.facts_choose_value() })).toHaveValue('');
  },
};
export const ValidTargetFiltering: Story = {
  args: { count: 0, long: true },
  play: async ({ canvasElement }) => {
    await edit(canvasElement);
    const input = canvasElement.querySelector<HTMLInputElement>('[data-slot="entity-picker"] input')!;
    await userEvent.type(input, 'classification');
    const document = within(canvasElement.ownerDocument.body);
    await document.findByRole('option');
    await expect(document.queryByRole('option', { name: /An ineligible work/ })).toBeNull();
    await userEvent.keyboard('{ArrowDown}{Enter}');
    await expect(within(canvasElement).getByRole('textbox', { name: m.correction_value() })).toHaveValue(otherConcept);
  },
};
export const LongNamesAndEvidence: Story = {
  args: { long: true },
  globals: { viewport: { value: 'phone390', isRotated: false } },
  play: async ({ canvasElement }) => {
    await readable(canvasElement, 390);
    const canvas = await edit(canvasElement);
    await expect(canvas.getByRole('textbox', { name: m.correction_url() })).toHaveValue(citation);
    await readable(canvasElement, 390);
  },
};
export const RightToLeft: Story = {
  args: { long: true, rtl: true },
  globals: { viewport: { value: 'desktop1280', isRotated: false } },
  play: async ({ canvasElement }) => {
    await readable(canvasElement, 1280);
    await edit(canvasElement);
    await readable(canvasElement, 1280);
  },
};
export const EightSelectedValues: Story = { args: { count: 8 } };
export const ThirtyTwoSelectedValues: Story = { args: { count: 32 } };
export const DeniedProposal: Story = {
  args: { scenario: 'denied' },
  play: async ({ canvasElement }) => {
    const canvas = await change(canvasElement);
    await expect(await canvas.findByRole('alert')).toHaveTextContent(m.correction_denied());
  },
};
// Parent/session states remain examples of the unchanged connected parent, never invented field states.
export const SignedOutParent: Story = { args: { parent: true, scenario: 'signed-out' } };
export const UnavailableParent: Story = { args: { parent: true, scenario: 'unavailable' } };
export const StaleMetadataParent: Story = { args: { parent: true, scenario: 'stale' } };
