import type { Meta, StoryObj } from '@storybook/react-vite';
import { pickText } from '@rezics/composition';
import { useMemo, useState } from 'react';
import { CandidateReaderBoundary } from '../subject/candidate-lifetime';
import { Button } from '@rezics/ui/shadcn/button';
import { expect, screen, userEvent, waitFor, within } from 'storybook/test';
import { CharacterProfile } from '../features/catalogue/character-profile-view';
import {
  characterProfileFixture,
  characterProfileId,
  characterCreatedId,
  type CharacterScenario,
} from '../kernel/fake/catalogue-character-profile';
import { getLocale } from '../paraglide/runtime';
import { m } from '../paraglide/messages.js';
import { AppShell } from '../shell/shell';
import { PageStory, PatternStory } from './page';
import {
  createObserver,
  recoverLanguageRow,
  retryLanguageRecovery,
  type ObserveCreate,
} from './catalogue-language-row-recovery';

function Example({
  scenario = 'ready',
  existing = false,
  work = false,
  workLabel = 'supplied',
  retirement = false,
  onCreate,
}: {
  scenario?: CharacterScenario;
  existing?: boolean;
  work?: boolean;
  workLabel?: 'supplied' | 'long' | 'absent';
  retirement?: boolean;
  onCreate?: ObserveCreate;
}) {
  const locale = getLocale();
  const [retired, setRetired] = useState(false);
  const fixture = useMemo(() => {
    const current = characterProfileFixture(scenario, locale);
    if (workLabel === 'long')
      current.work.publicRead.subject.labels = {
        ja: '星を渡る旅人たちの物語 — Die Reise durch die Sternenstadt — '.repeat(8),
      };
    if (workLabel === 'absent') current.work.publicRead.subject.labels = {};
    return current;
  }, [scenario, locale, workLabel]);
  const transport = useMemo(
    () => ({
      ...fixture.transport,
      load: retired ? async () => ({ ok: false as const, reason: 'denied' as const }) : fixture.transport.load,
      create: async (command: Parameters<typeof fixture.transport.create>[0]) => {
        const result = await fixture.transport.create(command);
        onCreate?.(structuredClone(fixture.calls));
        return result;
      },
    }),
    [fixture, onCreate, retired],
  );
  const profile = (
    <CharacterProfile
      key={`${scenario}:${existing}:${work}:${locale}`}
      locale={locale}
      {...fixture.props}
      transport={transport}
      {...(retired ? { session: 'signed-out' as const } : {})}
      {...(existing ? { id: characterProfileId } : {})}
      {...(work ? { work: fixture.work.id } : {})}
    />
  );
  return (
    <PatternStory visitor={scenario === 'signed-out' ? 'Signed Out' : 'Signed In'}>
      <AppShell>
        {retirement ? (
          <>
            <Button data-fixture-retire onClick={() => setRetired(true)} disabled={retired}>
              Retire the illustrative current reader
            </Button>
            <CandidateReaderBoundary
              address="fictional-work-story"
              observed={{
                state: retired ? 'signed-out' : 'signed-in',
                subject: retired ? null : 'story-reader',
                csrfToken: retired ? null : 'story-csrf',
              }}
            >
              {profile}
            </CandidateReaderBoundary>
          </>
        ) : (
          profile
        )}
      </AppShell>
    </PatternStory>
  );
}
const meta = {
  title: 'Pages/Catalogue/Character identity and credit editor',
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
          'Native-shaped synthetic responses through the production adapters. Use locale, theme and viewport globals. Visual review and native binding evidence are still owned by Web and integration.',
      },
    },
  },
} satisfies Meta<typeof Example>;
export default meta;
type Story = StoryObj<typeof meta>;

export const RouteEntry: Story = { render: () => <PageStory visitor="Signed In" path="/catalogue/character" /> };
export const Create: Story = {};
export const LanguageRowRecovery: Story = {
  args: { scenario: 'uncertain', onCreate: createObserver() },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.type(await canvas.findByRole('textbox', { name: m.catalogue_create_label() }), 'A new traveler');
    await userEvent.selectOptions(canvas.getByRole('combobox', { name: m.character_initial_fact() }), 'schema:url');
    await userEvent.click(canvas.getByRole('button', { name: m.character_add_fact() }));
    await userEvent.type(canvas.getByRole('textbox', { name: m.correction_value() }), 'https://example.org/traveler');
    const observed = args.onCreate as ReturnType<typeof createObserver>;
    const terms = await recoverLanguageRow(
      canvasElement,
      m.character_create(),
      observed,
      'A new traveler',
      '新しい旅人',
    );
    await retryLanguageRecovery(canvasElement, m.character_create(), m.correction_retry(), observed, {
      type: 'wd:Q95074',
      ...terms,
      statements: {
        'schema:url': [
          {
            property: { id: 'schema:url' },
            value: { type: 'value', content: 'https://example.org/traveler' },
            qualifiers: [],
            references: [],
            rank: 'normal',
          },
        ],
      },
    });
    await expect(await canvas.findByRole('link', { name: m.character_correct() })).toBeVisible();
  },
};
export const CurrentIdentity: Story = { args: { existing: true } };
export const WorkCredits: Story = {
  args: { existing: true, work: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: m.relation_open() }));
    await userEvent.selectOptions(await canvas.findByRole('combobox', { name: m.relation_property() }), 'wdt:P725');
    await userEvent.click(canvas.getAllByRole('button', { name: m.relation_edit_existing() })[0]!);
    await userEvent.click(canvas.getByRole('button', { name: m.relation_review_slot() }));
    await expect(canvas.findByRole('button', { name: m.candidate_review() })).resolves.toBeVisible();
  },
};
async function create(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  await userEvent.type(await canvas.findByRole('textbox', { name: m.catalogue_create_label() }), 'A new traveler');
  await userEvent.click(canvas.getByRole('button', { name: m.character_create() }));
  return canvas;
}
export const Created: Story = {
  play: async ({ canvasElement }) => {
    const canvas = await create(canvasElement);
    const link = await canvas.findByRole('link', { name: m.candidate_view_public() });
    expect(link.getAttribute('href')).toContain(`/subjects/${characterCreatedId}/a-new-traveler`);
    await expect(canvas.findByRole('link', { name: m.character_correct() })).resolves.toBeVisible();
  },
};
export const UncertainRetry: Story = {
  args: { scenario: 'uncertain', onCreate: createObserver() },
  globals: { viewport: { value: 'phone390', isRotated: false } },
  parameters: {
    docs: {
      description: {
        story:
          'UNRUN: the default creation journey at 390px checks rendered targets and label/action wrapping, language and fact removal, disabled uncertain drafts, exact body/key retry and saved-reader recovery. Browser, native and visual verification are deferred.',
      },
    },
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const label = await canvas.findByRole('textbox', { name: m.catalogue_create_label() });
    const form = label.closest('form')!;
    const document = canvasElement.ownerDocument;
    await expect(document.documentElement.clientWidth).toBe(390);
    const phoneControls = async () => {
      const bounds = form.getBoundingClientRect();
      await expect(bounds.left).toBeGreaterThanOrEqual(0);
      await expect(bounds.right).toBeLessThanOrEqual(390);
      await expect(form.scrollWidth).toBeLessThanOrEqual(form.clientWidth + 1);
      for (const target of form.querySelectorAll<HTMLElement>('input, textarea, select, button, a')) {
        const rect = target.getBoundingClientRect();
        const parent = target.parentElement!.getBoundingClientRect();
        await expect(rect.height).toBeGreaterThanOrEqual(44);
        await expect(rect.width).toBeGreaterThanOrEqual(44);
        await expect(rect.left).toBeGreaterThanOrEqual(Math.max(bounds.left, parent.left) - 1);
        await expect(rect.right).toBeLessThanOrEqual(Math.min(bounds.right, parent.right) + 1);
      }
      // Text must fit each rendered label/action, including every line of a wrapped translation.
      for (const text of form.querySelectorAll<HTMLElement>('label, button, a')) {
        const rect = text.getBoundingClientRect();
        await expect(text.scrollWidth).toBeLessThanOrEqual(text.clientWidth + 1);
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
    };
    await phoneControls();
    await userEvent.type(label, 'A new traveler');
    const language = canvas.getByRole('textbox', { name: m.catalogue_create_language() });
    await userEvent.clear(language);
    await userEvent.type(language, 'en');
    await userEvent.type(
      canvas.getByRole('textbox', { name: m.catalogue_create_description() }),
      'A fictional traveler',
    );
    await userEvent.type(
      canvas.getByRole('textbox', { name: m.catalogue_create_aliases() }),
      'First alias\nSecond alias',
    );
    await userEvent.click(within(form).getByText(m.catalogue_create_label(), { exact: true }));
    await expect(label).toHaveFocus();
    await userEvent.click(canvas.getByRole('button', { name: m.catalogue_create_add_language() }));
    await phoneControls();
    await userEvent.click(canvas.getByRole('button', { name: m.catalogue_create_remove_language() }));
    await expect(canvas.getAllByRole('textbox', { name: m.catalogue_create_language() })).toHaveLength(1);

    const initial = canvas.getByRole('combobox', { name: m.character_initial_fact() });
    const addFact = canvas.getByRole('button', { name: m.character_add_fact() });
    await expect(addFact).toBeDisabled();
    await userEvent.selectOptions(initial, 'schema:url');
    await userEvent.click(addFact);
    await userEvent.type(canvas.getByRole('textbox', { name: m.correction_value() }), 'https://example.org/removed');
    await phoneControls();
    await userEvent.click(canvas.getByRole('button', { name: m.recipe_remove_field() }));
    await userEvent.click(canvas.getByRole('button', { name: m.recipe_remove_field() }));
    await expect(canvas.queryByRole('textbox', { name: m.correction_value() })).toBeNull();
    await userEvent.selectOptions(initial, 'schema:url');
    await userEvent.click(addFact);
    await userEvent.type(canvas.getByRole('textbox', { name: m.correction_value() }), 'https://example.org/traveler');
    await expect(initial).toHaveValue('');
    await expect(addFact).toBeDisabled();
    await phoneControls();
    const observed = args.onCreate as ReturnType<typeof createObserver>;
    await expect(observed).not.toHaveBeenCalled();
    await userEvent.click(canvas.getByRole('button', { name: m.character_create() }));
    const retry = await canvas.findByRole('button', { name: m.correction_retry() });
    expect(canvas.getByRole('textbox', { name: m.catalogue_create_label() })).toBeDisabled();
    for (const control of form.querySelectorAll(
      'fieldset input, fieldset textarea, fieldset select, fieldset button',
    )) {
      await expect(control).toBeDisabled();
    }
    await waitFor(() => expect(observed).toHaveBeenCalledTimes(1));
    await expect(retry).toBeEnabled();
    await phoneControls();
    await userEvent.click(retry);
    await expect(canvas.findByRole('link', { name: m.character_correct() })).resolves.toBeVisible();
    await waitFor(() => expect(observed).toHaveBeenCalledTimes(2));
    const writes = observed.mock.calls[1]![0].filter((call) => call.method === 'POST' && call.path === '/v1/subjects');
    await expect(writes).toHaveLength(2);
    await expect(writes[0]!.body).toEqual({
      type: 'wd:Q95074',
      labels: { en: 'A new traveler' },
      descriptions: { en: 'A fictional traveler' },
      aliases: { en: ['First alias', 'Second alias'] },
      statements: {
        'schema:url': [
          {
            property: { id: 'schema:url' },
            value: { type: 'value', content: 'https://example.org/traveler' },
            qualifiers: [],
            references: [],
            rank: 'normal',
          },
        ],
      },
    });
    await expect(writes[1]!.body).toEqual(writes[0]!.body);
    await expect(writes[0]!.key).toBeTruthy();
    await expect(writes[1]!.key).toBe(writes[0]!.key);
    const reader = canvas.getByRole('link', { name: m.candidate_view_public() });
    await expect(reader.getAttribute('href')).toContain(`/subjects/${characterCreatedId}/a-new-traveler`);
    await expect(canvas.getByRole('link', { name: m.character_correct() })).toHaveAttribute(
      'href',
      `${reader.getAttribute('href')}/character`,
    );
  },
};
export const Proposed: Story = {
  args: { existing: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const quantity = await canvas.findByRole('region', {
      name: pickText(characterProfileFixture().release.properties['schema:height']!.labels, getLocale()).text,
    });
    const field = within(quantity);
    await userEvent.click(field.getByRole('button', { name: m.facts_edit_field() }));
    const amount = field.getByRole('textbox', { name: m.correction_amount() });
    await userEvent.clear(amount);
    await userEvent.type(amount, '+171');
    await userEvent.click(canvas.getByRole('button', { name: m.facts_submit() }));
    await expect(field.findByText(m.correction_proposed())).resolves.toBeVisible();
    expect(field.getByRole('link', { name: m.correction_review() }).getAttribute('href')).toContain('candidate=');
  },
};
export const Invalid: Story = {
  args: { scenario: 'invalid' },
  play: async ({ canvasElement }) => {
    await create(canvasElement);
  },
};
export const Loading: Story = { args: { scenario: 'loading' } };
export const SignedOut: Story = { args: { scenario: 'signed-out', existing: true } };
export const Denied: Story = { args: { scenario: 'denied', existing: true } };
export const Unavailable: Story = { args: { scenario: 'unavailable' } };
export const StaleMetadata: Story = { args: { scenario: 'stale' } };
export const ReaderUnavailable: Story = {
  args: { scenario: 'reader-unavailable' },
  play: async ({ canvasElement }) => {
    await create(canvasElement);
  },
};
export const ConcealedReader: Story = {
  args: { scenario: 'concealed' },
  play: async ({ canvasElement }) => {
    await create(canvasElement);
  },
};
export const PendingSelection: Story = { args: { scenario: 'pending', existing: true, work: true } };

// Illustrative production compositions only. All added play assertions are authored UNRUN.
export const LongWorkReference: Story = {
  args: { existing: true, work: true, workLabel: 'long' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('button', { name: m.fictional_work_choose_another() });
    const reference = canvasElement.querySelector<HTMLElement>('[data-slot="fictional-work-reference"]')!;
    const title = within(reference).getByRole('link');
    await expect(title.getAttribute('lang')).toBe(getLocale() === 'ja' ? null : 'ja');
    title.focus();
    await userEvent.tab();
    const summary = reference.querySelector('summary')!;
    await expect(summary).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await expect(reference.querySelector('details')).toHaveAttribute('open');
    for (const text of reference.querySelectorAll<HTMLElement>('a, code')) {
      await expect(text.scrollWidth).toBeLessThanOrEqual(text.clientWidth + 1);
    }
    await expect(canvasElement.scrollWidth).toBeLessThanOrEqual(canvasElement.clientWidth + 1);
  },
};
export const UnlabelledWork: Story = { args: { existing: true, work: true, workLabel: 'absent' } };
export const AnonymousWork: Story = { args: { scenario: 'signed-out', existing: true, work: true } };
export const UnavailableWork: Story = { args: { scenario: 'unavailable', existing: true, work: true } };
export const WorkSelection: Story = {
  args: { existing: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const input = await canvas.findByRole('textbox', { name: m.character_choose_work() });
    await userEvent.type(input, characterProfileFixture().work.publicRead.subject.labels.en!);
    await screen.findByRole('option');
    await userEvent.keyboard('{ArrowDown}{Enter}');
    await expect(canvas.findByRole('button', { name: m.fictional_work_choose_another() })).resolves.toBeVisible();
  },
};
export const ClearedWork: Story = {
  args: { existing: true, work: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: m.fictional_work_choose_another() }));
    await expect(canvas.findByRole('textbox', { name: m.character_choose_work() })).resolves.toBeVisible();
    await expect(canvas.queryByRole('button', { name: m.fictional_work_choose_another() })).toBeNull();
  },
};
export const RetiredWork: Story = {
  args: { existing: true, work: true, retirement: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('button', { name: m.fictional_work_choose_another() });
    await userEvent.click(canvasElement.querySelector<HTMLButtonElement>('[data-fixture-retire]')!);
    await waitFor(() => expect(canvasElement.querySelector('[data-slot="fictional-work-reference"]')).toBeNull());
    await expect(canvasElement.textContent).not.toContain(characterProfileFixture().work.id);
  },
};
