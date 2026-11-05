import type { Meta, StoryObj } from '@storybook/react-vite';
import { useMemo, useState } from 'react';
import { pickText } from '@rezics/composition';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { IdentifiersProfile } from '../features/catalogue/identifiers-profile-view';
import { EditorialEntry } from '../features/catalogue/editorial-entry';
import { IdentifierOriginChoice } from '../features/catalogue/identifier-current-visit-view';
import {
  identifierOriginHref,
  identifierRouteHref,
  type IdentifierVisitOrigin,
} from '../features/catalogue/identifier-current-visit';
import {
  identifiersProfileFixture,
  identifiersSubject,
  identifiersCandidate,
  identifiersCitation,
  type IdentifiersScenario,
} from '../kernel/fake/catalogue-identifiers-profile';
import recording from '../kernel/recorded/subject.json';
import { getLocale } from '../paraglide/runtime';
import { m } from '../paraglide/messages.js';
import { AppShell } from '../shell/shell';
import { PageStory, PatternStory } from './page';

function Example({ scenario = 'ready' }: { scenario?: IdentifiersScenario }) {
  const locale = getLocale();
  const fixture = useMemo(() => identifiersProfileFixture(scenario, locale), [scenario, locale]);
  return (
    <PatternStory visitor={scenario === 'signed-out' ? 'Signed Out' : 'Signed In'}>
      <AppShell>
        <IdentifiersProfile
          key={`${scenario}:${locale}`}
          id={identifiersSubject}
          locale={locale}
          session={scenario === 'signed-out' ? 'signed-out' : 'signed-in'}
          transport={fixture.transport}
          review={fixture.review}
        />
      </AppShell>
    </PatternStory>
  );
}

function OriginVisitExample({ unsupported = false }: { unsupported?: boolean }) {
  const locale = getLocale();
  const [global, setGlobal] = useState(false);
  const fixture = useMemo(() => identifiersProfileFixture('ready', locale), [locale]);
  const origin: IdentifierVisitOrigin = unsupported
    ? { context: '9f4c6b04-7496-4e14-89bc-41abf931e662', kind: 'unsupported' }
    : {
        context: '0ac7c5d7-1f67-4d02-8a72-0676044ecb19',
        realm: 'b7d92525-081e-42e1-9cb8-ef72b1492a25',
        realmTitle: 'Example Realm',
        state: 'current',
        kind: 'realm',
      };
  const subject = { id: identifiersSubject, label: 'A book' };
  return (
    <PatternStory visitor="Signed In">
      <AppShell>
        {global ? (
          <IdentifiersProfile
            key={`${locale}:${unsupported}`}
            id={identifiersSubject}
            locale={locale}
            session="signed-in"
            transport={fixture.transport}
            review={fixture.review}
            origin={origin}
            editorHref={identifierRouteHref(locale, identifiersSubject, 'a-book', { origin })}
            originHref={unsupported ? undefined : identifierOriginHref(subject, locale, origin)}
            globalHref={identifierOriginHref(subject, locale)}
          />
        ) : (
          <IdentifierOriginChoice
            locale={locale}
            origin={origin}
            originHref={unsupported ? undefined : identifierOriginHref(subject, locale, origin)}
            globalHref={identifierOriginHref(subject, locale)}
            onChooseGlobal={() => setGlobal(true)}
          />
        )}
      </AppShell>
    </PatternStory>
  );
}

function OriginEntryExample() {
  const locale = getLocale();
  return (
    <PatternStory visitor="Signed In">
      <AppShell>
        <EditorialEntry
          id={identifiersSubject}
          label="A book"
          locale={locale}
          context="0ac7c5d7-1f67-4d02-8a72-0676044ecb19"
          realm="b7d92525-081e-42e1-9cb8-ef72b1492a25"
        >
          {null}
        </EditorialEntry>
      </AppShell>
    </PatternStory>
  );
}
const meta = {
  title: 'Pages/Catalogue/Ordinary identifier evidence editor',
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
          'Synthetic native-shaped payloads through production fact and candidate adapters. Locale, theme and viewport use globals. Web owns normal captures; native execution and visual acceptance are pending integration.',
      },
    },
  },
} satisfies Meta<typeof Example>;
export default meta;
type Story = StoryObj<typeof meta>;

export const RouteEntry: Story = {
  render: () => (
    <PageStory visitor="Signed In" path={`/subjects/${recording.subject.id}/le-petit-prince/identifiers`} />
  ),
};
export const CurrentEvidence: Story = {};
export const SelectedRealmOrigin: Story = { render: () => <OriginVisitExample /> };
export const UnsupportedSelectedContext: Story = { render: () => <OriginVisitExample unsupported /> };
export const EntryCarriesSelectedOrigin: Story = {
  render: () => <OriginEntryExample />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: m.contribute_title() }));
    await userEvent.click(await canvas.findByRole('menuitem', { name: m.contribute_edit() }));
    const entry = await canvas.findByRole('menuitem', { name: m.identifiers_title() });
    expect(entry.getAttribute('href')).toContain('originContext=0ac7c5d7-1f67-4d02-8a72-0676044ecb19');
    expect(entry.getAttribute('href')).toContain('originRealm=b7d92525-081e-42e1-9cb8-ef72b1492a25');
  },
};
export const DeliberateGlobalCorrection: Story = {
  render: () => <OriginVisitExample />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: m.identifiers_global_choice() }));
    await expect(canvas.findByRole('region', { name: /ISBN-13/u })).resolves.toBeVisible();
  },
};
export const ExactCurrentValue: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const fixture = identifiersProfileFixture();
    const label = pickText(fixture.release.properties['schema:sameAs']!.labels, getLocale()).text;
    const field = within(await canvas.findByRole('region', { name: label }));
    await userEvent.selectOptions(
      field.getByRole('combobox', { name: m.facts_choose_value() }),
      field.getByRole('option', { name: m.facts_selected_value({ number: 1 }) }),
    );
    await userEvent.click(field.getByRole('button', { name: m.facts_edit_field() }));
    const values = field.getAllByRole('textbox', { name: m.correction_value() });
    await expect(values[0]!).toHaveValue(identifiersCitation);
    await expect(values[1]!).toHaveValue(identifiersCitation);
  },
};
export const Empty: Story = { args: { scenario: 'empty' } };
export const Loading: Story = { args: { scenario: 'loading' } };
export const SignedOut: Story = { args: { scenario: 'signed-out' } };
export const Denied: Story = { args: { scenario: 'denied' } };
export const Unavailable: Story = { args: { scenario: 'unavailable' } };
export const StaleMetadata: Story = { args: { scenario: 'stale' } };

const correctedIsbn = '978-4-00-000001-7';
async function stageIsbn(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  const field = within(await canvas.findByRole('region', { name: 'ISBN-13' }));
  await userEvent.click(field.getByRole('button', { name: m.facts_edit_field() }));
  const value = field.getAllByRole('textbox', { name: m.correction_value() })[0]!;
  await userEvent.clear(value);
  await userEvent.type(value, correctedIsbn);
  return { canvas, field, value };
}
async function propose(canvasElement: HTMLElement) {
  const result = await stageIsbn(canvasElement);
  await userEvent.click(result.canvas.getByRole('button', { name: m.facts_submit() }));
  return result;
}
export const Proposed: Story = {
  play: async ({ canvasElement }) => {
    const { field } = await propose(canvasElement);
    await expect(field.findByText(m.correction_proposed())).resolves.toBeVisible();
    expect(field.getByRole('link', { name: m.correction_review() }).getAttribute('href')).toContain(
      `/identifiers?reviewProperty=schema%3Aisbn&candidate=${identifiersCandidate}`,
    );
  },
};
export const Invalid: Story = {
  args: { scenario: 'invalid' },
  play: async ({ canvasElement }) => {
    const { field, value } = await propose(canvasElement);
    await expect(field.findByText(m.correction_invalid())).resolves.toBeVisible();
    expect(value).toHaveValue(correctedIsbn);
  },
};
export const UncertainRetry: Story = {
  args: { scenario: 'uncertain' },
  play: async ({ canvasElement }) => {
    const { canvas, field, value } = await propose(canvasElement);
    await expect(field.findByText(m.facts_uncertain())).resolves.toBeVisible();
    expect(value).toBeDisabled();
    await userEvent.click(canvas.getByRole('button', { name: m.facts_submit() }));
    await expect(field.findByText(m.correction_proposed())).resolves.toBeVisible();
  },
};
export const PartialResults: Story = {
  args: { scenario: 'partial' },
  play: async ({ canvasElement }) => {
    const { canvas, field } = await stageIsbn(canvasElement);
    const fixture = identifiersProfileFixture();
    const label = pickText(fixture.release.properties['schema:url']!.labels, getLocale()).text;
    const url = within(canvas.getByRole('region', { name: label }));
    await userEvent.click(url.getByRole('button', { name: m.facts_edit_field() }));
    await userEvent.type(url.getByRole('textbox', { name: m.correction_value() }), identifiersCitation);
    await userEvent.click(canvas.getByRole('button', { name: m.facts_submit() }));
    await expect(field.findByText(m.correction_proposed())).resolves.toBeVisible();
    await expect(url.findByText(m.correction_denied())).resolves.toBeVisible();
    expect(url.getByRole('textbox', { name: m.correction_value() })).toHaveValue(identifiersCitation);
  },
};
export const ExactCandidateContinuation: Story = {
  args: { scenario: 'continued' },
  play: async ({ canvasElement }) => {
    const { canvas, field } = await propose(canvasElement);
    await userEvent.click(await field.findByRole('link', { name: m.correction_review() }));
    await userEvent.click(canvas.getByRole('button', { name: m.candidate_entry() }));
    await expect(canvas.findByText(m.correction_exact_missing())).resolves.toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: m.candidate_more() }));
    await expect(canvas.findByRole('button', { name: m.candidate_accept() })).resolves.toBeVisible();
  },
};
async function accept(canvasElement: HTMLElement) {
  const { canvas, field } = await propose(canvasElement);
  await userEvent.click(await field.findByRole('link', { name: m.correction_review() }));
  await userEvent.click(canvas.getByRole('button', { name: m.candidate_entry() }));
  await userEvent.click(await canvas.findByRole('button', { name: m.candidate_accept() }));
  await waitFor(() => expect(canvas.getAllByRole('button', { name: m.candidate_accept() })).toHaveLength(2));
  await userEvent.click(canvas.getAllByRole('button', { name: m.candidate_accept() })[1]!);
  await expect(canvas.findByText(m.candidate_accepted())).resolves.toBeVisible();
  return canvas;
}
export const AcceptedAwaitingSelection: Story = {
  play: async ({ canvasElement }) => {
    await accept(canvasElement);
  },
};
async function adopt(canvasElement: HTMLElement, pending: boolean) {
  const canvas = await accept(canvasElement);
  await userEvent.click(canvas.getByRole('button', { name: m.candidate_reload() }));
  const old = await canvas.findByRole('checkbox', { name: /978-4-00-000000-0/ });
  await userEvent.click(old);
  await userEvent.click(canvas.getByRole('checkbox', { name: /978-4-00-000001-7/ }));
  await userEvent.click(canvas.getByRole('button', { name: m.candidate_adopt() }));
  await waitFor(() => expect(canvas.getAllByRole('button', { name: m.candidate_adopt() })).toHaveLength(2));
  await userEvent.click(canvas.getAllByRole('button', { name: m.candidate_adopt() })[1]!);
  await expect(
    canvas.findByText(pending ? m.candidate_pending() : m.candidate_selection_confirmed()),
  ).resolves.toBeVisible();
}
export const Selected: Story = {
  play: async ({ canvasElement }) => {
    await adopt(canvasElement, false);
  },
};
export const PendingReading: Story = {
  args: { scenario: 'pending' },
  play: async ({ canvasElement }) => {
    await adopt(canvasElement, true);
  },
};
export const ReaderUnavailable: Story = {
  args: { scenario: 'reader-unavailable' },
  play: async ({ canvasElement }) => {
    await adopt(canvasElement, true);
  },
};
