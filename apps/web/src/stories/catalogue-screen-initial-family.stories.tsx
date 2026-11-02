import { useMemo, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import type { Release } from '@rezics/definitions';
import { Button } from '@rezics/ui/shadcn/button';
import { ScreenInitialFields, type ScreenRow } from '../features/catalogue/screen-profile-fields';
import { ScreenProfile } from '../features/catalogue/screen-profile-view';
import { screenFactId, screenName, type ScreenCommand } from '../features/catalogue/screen-profile';
import { CandidateReaderBoundary } from '../subject/candidate-lifetime';
import { screenProfileFixture, type ScreenScenario } from '../kernel/fake/catalogue-screen-profile';
import definitions from '../kernel/recorded/definitions-release.json';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime';
import { AppShell } from '../shell/shell';
import { PatternStory } from './page';

// Authored UNRUN. Complete creation, recovery and long examples mount AppShell plus ScreenProfile.
// Independent field examples stay supplementary. Run the same IDs at phone390/desktop1280 with locale and theme globals.
const person = '00000000-0000-4000-8000-000000000302';
const parent = '00000000-0000-4000-8000-000000000301';
const citation = `https://example.org/credits/${'complete-original-source-'.repeat(12)}?page=24#director`;
const scalar = '0.5000000000000000000000000000000000000000000000000000000000000000000001';
const longName = (property: string) => `${property} — ${'Full released name 完整名稱 اسم الحقل '.repeat(5)}`.trimEnd();
const search = async () => [
  { id: parent, title: 'Observatory season', types: ['schema:TVSeason'], typeLabel: 'Season', cover: null },
  { id: person, title: 'A. Observer', types: ['schema:Person'], typeLabel: 'Person', cover: null },
  {
    id: '00000000-0000-4000-8000-000000000303',
    title: 'Wrong target',
    types: ['schema:Book'],
    typeLabel: 'Book',
    cover: null,
  },
];
const row = (property: string, content: ScreenRow['statement']['value']): ScreenRow => ({
  key: crypto.randomUUID(),
  statement: { property: { id: property }, value: content, qualifiers: [], references: [], rank: 'normal' },
});
function suppliedRows(): ScreenRow[] {
  const director = row('schema:director', { type: 'value', content: person });
  director.statement.qualifiers = [{ property: { id: 'schema:position' }, value: { type: 'value', content: '2' } }];
  director.statement.references = [
    { parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: citation } }] },
  ];
  return [
    director,
    row('schema:duration', {
      type: 'value',
      content: { amount: '+1440', unit: 'http://www.wikidata.org/entity/Q11574' },
    }),
    row('schema:episodeNumber', { type: 'value', content: scalar }),
    row('schema:isPartOf', { type: 'value', content: parent }),
  ];
}
function Fields({
  populated = false,
  missing = false,
  disabled = false,
}: {
  populated?: boolean;
  missing?: boolean;
  disabled?: boolean;
}) {
  const locale = getLocale();
  const [rows, change] = useState(() => (populated ? suppliedRows() : []));
  const release = useMemo(() => {
    const release = structuredClone(definitions.release) as Release;
    if (populated)
      for (const id of [
        'schema:director',
        'schema:duration',
        'schema:episodeNumber',
        'schema:isPartOf',
        'schema:position',
      ])
        release.properties[id]!.labels = { [locale]: longName(id) };
    if (missing) delete release.properties['schema:director'];
    return release;
  }, [locale, populated, missing]);
  return (
    <ScreenInitialFields
      type="schema:Episode"
      rows={rows}
      change={change}
      release={release}
      locale={locale}
      search={search}
      disabled={disabled}
    />
  );
}
type Run = {
  fixture: ReturnType<typeof screenProfileFixture>;
  commands: ScreenCommand[];
  loads: number;
  navigations: string[];
  deliver?: () => void;
};
const runs = new WeakMap<HTMLElement, Run>();
function Journey({
  scenario = 'ready',
  retirement = false,
  stale = false,
  long = false,
}: {
  scenario?: ScreenScenario;
  retirement?: boolean;
  stale?: boolean;
  long?: boolean;
}) {
  const locale = getLocale();
  const [reader, setReader] = useState('original-reader');
  const run = useMemo<Run>(
    () => ({ fixture: screenProfileFixture(scenario, locale), commands: [], loads: 0, navigations: [] }),
    [scenario, locale],
  );
  const transport = useMemo(
    () => ({
      ...run.fixture.transport,
      load: async () => {
        run.loads++;
        const read = await run.fixture.transport.load();
        if (long && read.ok) {
          const release = structuredClone(read.release);
          for (const id of [
            'schema:director',
            'schema:duration',
            'schema:episodeNumber',
            'schema:isPartOf',
            'schema:position',
          ])
            release.properties[id]!.labels = { [locale]: longName(id) };
          return { ...read, release };
        }
        if (stale && run.loads > 1 && read.ok) {
          const release = structuredClone(read.release);
          delete release.properties['schema:episodeNumber'];
          for (const type of Object.values(release.types))
            type.properties = type.properties.filter((id) => id !== 'schema:episodeNumber');
          return { ...read, release };
        }
        return read;
      },
      create: async (command: ScreenCommand) => {
        run.commands.push(structuredClone(command));
        const result = await run.fixture.transport.create(command);
        if (retirement)
          return new Promise<typeof result>((resolve) => {
            run.deliver = () => resolve(result);
          });
        return result;
      },
    }),
    [run, retirement, stale, long, locale],
  );
  return (
    <div
      data-screen-family
      ref={(node) => {
        if (node) runs.set(node, run);
      }}
    >
      {retirement && (
        <Button type="button" onClick={() => setReader('replacement-reader')}>
          Change current reader
        </Button>
      )}
      <CandidateReaderBoundary
        observed={{ state: 'signed-in', subject: reader, csrfToken: reader }}
        address="screen-initial-family"
      >
        <ScreenProfile
          locale={locale}
          session={scenario === 'signed-out' ? 'signed-out' : 'signed-in'}
          transport={transport}
          search={search}
          onNavigate={(href) => run.navigations.push(href)}
        />
      </CandidateReaderBoundary>
    </div>
  );
}
function Family({
  mode = 'journey',
  scenario = 'ready',
  rtl = false,
}: {
  mode?: 'journey' | 'independent' | 'long' | 'missing' | 'disabled' | 'retirement' | 'stale';
  scenario?: ScreenScenario;
  rtl?: boolean;
}) {
  const supplementary = mode === 'independent' || mode === 'missing' || mode === 'disabled';
  const body = (
    <div
      dir={rtl ? 'rtl' : undefined}
      className={supplementary ? 'mx-auto w-full max-w-4xl min-w-0 space-y-6 p-4 sm:p-6' : 'min-w-0'}
    >
      {mode === 'independent' ? (
        <>
          <div data-independent="first">
            <Fields />
          </div>
          <div data-independent="second">
            <Fields />
          </div>
        </>
      ) : mode === 'missing' || mode === 'disabled' ? (
        <Fields populated missing={mode === 'missing'} disabled={mode === 'disabled'} />
      ) : (
        <Journey
          scenario={scenario}
          retirement={mode === 'retirement'}
          stale={mode === 'stale'}
          long={mode === 'long'}
        />
      )}
    </div>
  );
  return (
    <PatternStory path="/catalogue/screen" visitor={scenario === 'signed-out' ? 'Signed Out' : 'Signed In'}>
      {supplementary ? body : <AppShell>{body}</AppShell>}
    </PatternStory>
  );
}
const meta = {
  title: 'Pages/Catalogue/Screen initial facts and credits',
  component: Family,
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
          'Complete creation, recovery and long examples render AppShell plus the production Screen editor. Independent field examples stay supplementary. Assertions are authored UNRUN. Native, SSR, backend growth and geometry proof remain separate integration obligations.',
      },
    },
  },
} satisfies Meta<typeof Family>;
export default meta;
type Story = StoryObj<typeof meta>;
const field = (property: string) => screenName(definitions.release as Release, property, getLocale()).text;
const factSection = (scope: ReturnType<typeof within>, name: string) =>
  scope.getByRole('heading', { name, level: 3 }).closest('section')!;
function runFor(canvasElement: HTMLElement) {
  return runs.get(canvasElement.querySelector<HTMLElement>('[data-screen-family]')!)!;
}
async function target(control: HTMLElement, region: HTMLElement) {
  const document = control.ownerDocument;
  const fineDesktop =
    document.documentElement.clientWidth >= 768 && !document.defaultView!.matchMedia('(pointer: coarse)').matches;
  const rect = control.getBoundingClientRect();
  const bounds = region.getBoundingClientRect();
  await expect(control).toBeVisible();
  await expect(rect.height).toBeGreaterThanOrEqual(fineDesktop ? 32 : 44);
  if (fineDesktop) await expect(rect.height).toBeLessThan(44);
  await expect(rect.left).toBeGreaterThanOrEqual(bounds.left - 1);
  await expect(rect.right).toBeLessThanOrEqual(bounds.right + 1);
}
async function focused(control: HTMLElement) {
  await expect(control).toHaveFocus();
  await expect(control.matches(':focus-visible')).toBe(true);
  const style = control.ownerDocument.defaultView!.getComputedStyle(control);
  await expect(
    style.boxShadow !== 'none' || (style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0),
  ).toBe(true);
}
async function page(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  await expect(await canvas.findByRole('heading', { level: 1, name: m.screen_title() })).toBeVisible();
  await expect(canvasElement.querySelectorAll('main#main-content')).toHaveLength(1);
  await expect(canvasElement.querySelectorAll('[data-screen-family]')).toHaveLength(1);
  return canvas;
}
async function fill(canvasElement: HTMLElement, long = false) {
  const canvas = within(canvasElement);
  const name = (property: string) => (long ? longName(property) : field(property));
  await userEvent.selectOptions(
    await canvas.findByRole('combobox', { name: m.catalogue_create_type() }),
    'schema:Episode',
  );
  await userEvent.type(canvas.getByRole('textbox', { name: m.catalogue_create_label() }), 'The observatory');
  const add = canvas.getByRole('button', { name: m.correction_add() });
  for (const property of ['schema:director', 'schema:duration', 'schema:episodeNumber', 'schema:isPartOf']) {
    const select = canvas.getByRole('combobox', { name: m.character_add_fact() });
    await userEvent.selectOptions(select, property);
    await target(select, select.closest('fieldset')!);
    await target(add, select.closest('fieldset')!);
    select.focus();
    await userEvent.tab();
    await focused(add);
    await userEvent.keyboard('{Enter}');
    const region = factSection(canvas, name(property));
    const section = within(region);
    await expect(region.id).toBe(screenFactId(property));
    await expect(region.closest('fieldset')?.querySelector('legend')).toHaveTextContent(m.screen_initial_facts());
    if (property === 'schema:duration') {
      await userEvent.type(section.getByRole('textbox', { name: m.correction_amount() }), '+1440');
      await userEvent.selectOptions(
        section.getByRole('combobox', { name: m.correction_unit() }),
        'http://www.wikidata.org/entity/Q11574',
      );
    } else if (property === 'schema:episodeNumber') {
      await userEvent.type(section.getByRole('textbox', { name: m.correction_value() }), long ? scalar : '0.5');
    } else {
      await userEvent.type(
        section.getByRole('combobox', { name: name(property) }),
        property === 'schema:director' ? 'Observer' : 'Observatory',
      );
      const body = within(canvasElement.ownerDocument.body);
      await expect(body.queryByRole('option', { name: /Wrong target/ })).not.toBeInTheDocument();
      await userEvent.click(
        await body.findByRole('option', {
          name: property === 'schema:director' ? /A\. Observer/ : /Observatory season/,
        }),
      );
      if (property === 'schema:director') {
        await userEvent.selectOptions(
          section.getByRole('combobox', { name: m.correction_add_qualifier() }),
          'schema:position',
        );
        await userEvent.click(section.getByRole('button', { name: m.relation_add_qualifier() }));
        await userEvent.type(section.getByRole('textbox', { name: m.correction_value() }), '2');
        await userEvent.type(section.getByRole('textbox', { name: m.relation_citation() }), citation);
        for (const action of section.getAllByRole('button', { name: m.relation_remove() }))
          await target(action, region);
        await target(section.getByRole('combobox', { name: m.correction_add_qualifier() }), region);
        await target(section.getByRole('textbox', { name: m.relation_citation() }), region);
      }
    }
  }
  const duration = within(factSection(canvas, name('schema:duration')));
  await expect(duration.getByRole('textbox', { name: m.correction_amount() })).toHaveValue('+1440');
  await expect(duration.getByRole('combobox', { name: m.correction_unit() })).toHaveValue(
    'http://www.wikidata.org/entity/Q11574',
  );
  await expect(canvas.getByText(m.screen_authored_after())).toBeVisible();
  return canvas;
}
export const IndependentSelectors: Story = {
  args: { mode: 'independent' },
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelector('main#main-content')).toBeNull();
    const [first, second] = ['first', 'second'].map((id) =>
      within(canvasElement.querySelector<HTMLElement>(`[data-independent="${id}"]`)!),
    );
    const a = first!.getByRole('combobox', { name: m.character_add_fact() });
    const b = second!.getByRole('combobox', { name: m.character_add_fact() });
    await expect(a.id).not.toBe(b.id);
    for (const [scope, control] of [
      [first!, a],
      [second!, b],
    ] as const) {
      await expect(scope.getByText(m.character_add_fact(), { selector: 'label' })).toHaveAttribute('for', control.id);
      await target(control, control.closest('fieldset')!);
    }
    await userEvent.selectOptions(b, 'schema:director');
    b.focus();
    await userEvent.tab();
    await focused(second!.getByRole('button', { name: m.correction_add() }));
    await userEvent.keyboard('{Enter}');
    await expect(first!.queryByRole('heading', { name: field('schema:director') })).not.toBeInTheDocument();
    const region = factSection(second!, field('schema:director'));
    const remove = within(region).getByRole('button', { name: m.relation_remove() });
    await userEvent.tab({ shift: true });
    remove.focus();
    await userEvent.keyboard('{Enter}');
    await expect(second!.queryByRole('heading', { name: field('schema:director') })).not.toBeInTheDocument();
    await expect(a).toHaveValue('');
  },
};
const longPlay: NonNullable<Story['play']> = async ({ canvasElement }) => {
  await page(canvasElement);
  const canvas = await fill(canvasElement, true);
  for (const property of ['schema:director', 'schema:duration', 'schema:episodeNumber', 'schema:isPartOf']) {
    const heading = canvas.getByRole('heading', { name: longName(property), level: 3 });
    const section = heading.closest('section')!;
    await expect(heading).toHaveAttribute('data-content-item-slot', 'title');
    await expect(section.parentElement).toHaveClass('isolate');
    await expect(heading.scrollWidth).toBeLessThanOrEqual(heading.clientWidth + 1);
    await expect(section.scrollWidth).toBeLessThanOrEqual(section.clientWidth + 1);
  }
  for (const text of [citation, scalar, longName('schema:position')]) {
    const element = canvas.getByText(text, { selector: 'p' });
    await expect(element).toBeVisible();
    await expect(element.scrollWidth).toBeLessThanOrEqual(element.clientWidth + 1);
  }
  const director = within(factSection(canvas, longName('schema:director')));
  const qualifier = director.getByRole('combobox', { name: m.correction_add_qualifier() });
  qualifier.focus();
  await userEvent.tab();
  await focused(director.getByRole('textbox', { name: m.relation_citation() }));
};
export const LongLocalizedFactsAndCredits: Story = { args: { mode: 'long' }, play: longPlay };
export const LongLocalizedRtl: Story = { args: { mode: 'long', rtl: true }, play: longPlay };
export const MissingDefinition: Story = {
  args: { mode: 'missing' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(m.correction_preserved())).toBeVisible();
    await expect(canvas.getByRole('heading', { name: 'schema:director', level: 3 })).toBeVisible();
  },
};
export const Disabled: Story = {
  args: { mode: 'disabled' },
  play: async ({ canvasElement }) => {
    for (const control of canvasElement.querySelectorAll('input, select, button')) await expect(control).toBeDisabled();
  },
};
export const CompleteCreation: Story = {
  play: async ({ canvasElement }) => {
    await page(canvasElement);
    const canvas = await fill(canvasElement);
    const run = runFor(canvasElement);
    await expect(run.commands).toHaveLength(0);
    await expect(run.loads).toBe(1);
    await userEvent.click(canvas.getByRole('button', { name: m.catalogue_create_submit() }));
    await expect(await canvas.findByText(m.catalogue_create_created())).toBeVisible();
    await expect(run.commands).toHaveLength(1);
    await expect(run.commands[0]!.item.statements['schema:duration']![0]!.value).toEqual({
      type: 'value',
      content: { amount: '+1440', unit: 'http://www.wikidata.org/entity/Q11574' },
    });
    await expect(run.navigations).toHaveLength(1);
  },
};
export const ExactUncertainReplay: Story = {
  args: { scenario: 'uncertain' },
  play: async ({ canvasElement }) => {
    await page(canvasElement);
    const canvas = await fill(canvasElement);
    const run = runFor(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: m.catalogue_create_submit() }));
    await expect(await canvas.findByText(m.catalogue_create_uncertain())).toBeVisible();
    const frozen = structuredClone(run.commands[0]!);
    const family = canvasElement.querySelector<HTMLElement>('[data-screen-family]')!;
    for (const control of family.querySelectorAll('fieldset input, fieldset select, fieldset button'))
      await expect(control).toBeDisabled();
    await userEvent.click(canvas.getByRole('button', { name: m.catalogue_create_retry() }));
    await expect(await canvas.findByText(m.catalogue_create_created())).toBeVisible();
    await expect(run.commands).toEqual([frozen, frozen]);
    const writes = run.fixture.creation.calls.filter((call) => call.method === 'POST');
    await expect(writes).toHaveLength(2);
    await expect(writes[1]).toEqual(writes[0]);
    await expect(run.loads).toBe(1);
  },
};
export const DeniedCreation: Story = {
  args: { scenario: 'denied' },
  play: async ({ canvasElement }) => {
    await page(canvasElement);
    const canvas = await fill(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: m.catalogue_create_submit() }));
    await expect(await canvas.findByText(m.catalogue_create_denied())).toBeVisible();
    await expect(canvas.getByRole('textbox', { name: m.catalogue_create_label() })).toHaveValue('The observatory');
    await expect(runFor(canvasElement).navigations).toHaveLength(0);
  },
};
export const CurrentReaderRetirement: Story = {
  args: { mode: 'retirement' },
  play: async ({ canvasElement }) => {
    await page(canvasElement);
    const canvas = await fill(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: m.catalogue_create_submit() }));
    const run = runFor(canvasElement);
    await waitFor(() => expect(run.deliver).toBeDefined());
    await userEvent.click(canvas.getByRole('button', { name: 'Change current reader' }));
    await waitFor(() => expect(canvas.getByRole('textbox', { name: m.catalogue_create_label() })).toHaveValue(''));
    run.deliver!();
    await waitFor(() => expect(run.navigations).toHaveLength(0));
    await expect(canvas.queryByText(m.catalogue_create_created())).not.toBeInTheDocument();
    await expect(runFor(canvasElement).navigations).toHaveLength(0);
  },
};
export const StaleDefinitionRefresh: Story = {
  args: { mode: 'stale', scenario: 'invalid' },
  play: async ({ canvasElement }) => {
    await page(canvasElement);
    const canvas = await fill(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: m.catalogue_create_submit() }));
    await expect(await canvas.findByText(m.correction_preserved())).toBeVisible();
    await expect(canvas.getByRole('heading', { name: 'schema:episodeNumber', level: 3 })).toBeVisible();
    const duration = within(factSection(canvas, field('schema:duration')));
    await expect(duration.getByRole('textbox', { name: m.correction_amount() })).toHaveValue('+1440');
    await expect(runFor(canvasElement).commands).toHaveLength(1);
    await userEvent.click(canvas.getByRole('button', { name: m.catalogue_create_submit() }));
    await expect(runFor(canvasElement).commands).toHaveLength(1);
  },
};
export const MultiplicityAndExplicitRemoval: Story = {
  args: { mode: 'independent' },
  play: async ({ canvasElement }) => {
    const region = canvasElement.querySelector<HTMLElement>('[data-independent="first"]')!;
    const scope = within(region);
    const select = scope.getByRole('combobox', { name: m.character_add_fact() });
    for (const property of ['schema:duration', 'schema:director', 'schema:director']) {
      await userEvent.selectOptions(select, property);
      await userEvent.click(scope.getByRole('button', { name: m.correction_add() }));
    }
    await expect(within(select).queryByRole('option', { name: field('schema:duration') })).not.toBeInTheDocument();
    const credits = scope.getAllByRole('heading', { name: field('schema:director'), level: 3 });
    await expect(credits).toHaveLength(2);
    const retained = credits[1]!.closest('section')!;
    const citationControl = within(retained).getByRole('textbox', { name: m.relation_citation() });
    const retainedId = citationControl.id;
    const remove = within(credits[0]!.closest('section')!).getByRole('button', { name: m.relation_remove() });
    remove.focus();
    await userEvent.keyboard('{Enter}');
    await expect(retained).toHaveAttribute('id', screenFactId('schema:director'));
    await expect(citationControl).toHaveAttribute('id', retainedId);
    await expect(scope.getAllByRole('heading', { name: field('schema:director'), level: 3 })).toHaveLength(1);
  },
};
export const CreatedReaderRecovery: Story = {
  args: { scenario: 'reader-unavailable' },
  play: async ({ canvasElement }) => {
    await page(canvasElement);
    const canvas = await fill(canvasElement);
    const run = runFor(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: m.catalogue_create_submit() }));
    await expect(await canvas.findByText(m.catalogue_create_reader_unavailable())).toBeVisible();
    await expect(canvas.queryByRole('link', { name: m.catalogue_create_open() })).toBeNull();
    run.fixture.creation.setScenario('concealed');
    await userEvent.click(canvas.getByRole('button', { name: m.catalogue_create_retry() }));
    await expect(await canvas.findByText(m.catalogue_create_concealed())).toBeVisible();
    run.fixture.creation.setScenario('ready');
    await userEvent.click(canvas.getByRole('button', { name: m.catalogue_create_retry() }));
    await expect(await canvas.findByRole('link', { name: m.catalogue_create_open() })).toHaveAttribute(
      'href',
      expect.stringContaining('00000000-0000-4000-8000-00000000c001'),
    );
    await expect(run.fixture.creation.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
  },
};
const pagePlay: NonNullable<Story['play']> = async ({ canvasElement }) => {
  await page(canvasElement);
};
export const EmptyDefinitions: Story = { args: { scenario: 'empty' }, play: pagePlay };
export const UnavailableDefinitions: Story = { args: { scenario: 'definitions-unavailable' }, play: pagePlay };
export const SignedOut: Story = { args: { scenario: 'signed-out' }, play: pagePlay };
