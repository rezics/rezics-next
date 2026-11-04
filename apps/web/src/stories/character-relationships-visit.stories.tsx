import type { Meta, StoryObj } from '@storybook/react-vite';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from '@tanstack/react-router';
import { expect, userEvent, within } from 'storybook/test';
import { Button } from '@rezics/ui/shadcn/button';
import { RelationEditor } from '../features/catalogue/relation-editor';
import { CharacterRelationshipsView } from '../features/catalogue/character-relationships/view';
import {
  createCharacterRelationshipsVisit,
  type CharacterRelationshipsOrigin,
  type CharacterRelationshipsVisit as Visit,
} from '../features/catalogue/character-relationships/navigation';
import type { CharacterRelationshipsRead } from '../features/catalogue/character-relationships/reading';
import {
  appearanceWorkA,
  characterRelationshipsFixture,
  characterRelationshipsId,
  relatedCharacterId,
  voicePersonId,
} from '../kernel/fake/character-relationships';
import { relationFixture } from '../kernel/fake/catalogue-relations';
import { characterType } from '../features/catalogue/character-profile';
import { candidateContext } from '../subject/candidates';
import { getLocale } from '../paraglide/runtime';
import { m } from '../paraglide/messages.js';
import { AppShell } from '../shell/shell';
import { characterRelationshipsHref } from '../features/catalogue/character-relationships/navigation';
import { PatternStory } from './page';

type Scenario =
  | 'appearance'
  | 'voice'
  | 'spoiler'
  | 'withheld'
  | 'unreadable'
  | 'unavailable'
  | 'denied'
  | 'changed'
  | 'late';

function makeVoiceRead(read: CharacterRelationshipsRead): CharacterRelationshipsRead {
  if (!read.ok || !read.rows[0]?.statement) return read;
  const voice = read.streams.find((stream) => stream.kind === 'voice');
  if (!voice) return read;
  const row = read.rows[0];
  return {
    ...read,
    stream: voice,
    rows: [
      {
        ...row,
        statement: {
          ...row.statement,
          property: { id: 'wdt:P725', data_type: 'wikibase-item' },
          value: { type: 'value', content: voicePersonId },
          qualifiers: [
            {
              property: { id: 'wdt:P453', data_type: 'wikibase-item' },
              value: { type: 'value', content: characterRelationshipsId },
            },
          ],
        },
        related: {
          ...row.related,
          [voicePersonId]: { type: 'schema:Person', labels: { en: 'Mika Voice' } },
          [characterRelationshipsId]: { type: characterType, labels: { en: 'The traveler' } },
        },
      },
    ],
    labels: {
      ...read.labels,
      'wdt:P725': { text: 'Voice actor', lang: 'en' },
      'wdt:P453': { text: 'Character', lang: 'en' },
    },
  };
}

function VisitExample({ scenario = 'appearance' }: { scenario?: Scenario }) {
  const locale = getLocale();
  const nativeScenario =
    scenario === 'spoiler' || scenario === 'withheld' || scenario === 'unreadable' || scenario === 'unavailable' || scenario === 'denied'
      ? scenario
      : 'appearances';
  const fixture = useMemo(() => characterRelationshipsFixture(nativeScenario, locale), [nativeScenario, locale]);
  const [reading, setReading] = useState<CharacterRelationshipsRead>();
  const [retired, setRetired] = useState(false);
  const [lateReady, setLateReady] = useState(false);
  const [savedVisit, setSavedVisit] = useState<Visit>();
  const [restoringVisit, setRestoringVisit] = useState<Visit>();
  const releaseLate = useRef<(() => void) | undefined>(undefined);
  const origin: CharacterRelationshipsOrigin = {
    id: fixture.id,
    locale,
    context: candidateContext,
  };
  useEffect(() => {
    let active = true;
    const stream = scenario === 'withheld' ? `forward:${fixture.identityProperty}` : undefined;
    void fixture.transport.read(stream).then((result) => {
      if (!active) return;
      let current = scenario === 'voice' ? makeVoiceRead(result) : result;
      if (current.ok && scenario === 'changed') current = { ...current, rows: current.rows.filter((row) => row.holder !== appearanceWorkA) };
      if (current.ok && (scenario === 'appearance' || scenario === 'late'))
        current = { ...current, next: scenario === 'late' ? 'late-cursor' : 'visit-cursor' };
      setReading(current);
    });
    return () => {
      active = false;
    };
  }, [fixture, scenario]);

  const transport = useMemo(
    () => ({
      ...fixture.transport,
      read: async (stream?: string, cursor?: string, session?: string) => {
        if (scenario === 'late' && cursor === 'late-cursor') {
          const result = await fixture.transport.read(stream, undefined, session);
          return new Promise<CharacterRelationshipsRead>((resolve) => {
            releaseLate.current = () => resolve(result);
            setLateReady(true);
          });
        }
        const result = await fixture.transport.read(stream, cursor, session);
        if (!result.ok) return result;
        if (cursor) return { ...result, rows: result.rows.slice(1), next: null };
        return scenario === 'appearance' || scenario === 'late'
          ? { ...result, next: scenario === 'late' ? 'late-cursor' : 'visit-cursor' }
          : result;
      },
    }),
    [fixture, scenario],
  );
  const visit: Visit | undefined = useMemo(() => {
    if (scenario !== 'changed' || !reading?.ok || !reading.stream) return undefined;
    return createCharacterRelationshipsVisit(origin, {
      stream: reading.stream.key,
      work: appearanceWorkA,
      cursors: [null, 'visit-cursor'],
      index: 1,
      focus: { holder: appearanceWorkA, statement: '00000000-0000-4000-8000-000000000c99' },
    });
  }, [origin.id, origin.locale, reading, scenario]);
  const activeVisit = restoringVisit ?? visit;

  if (!reading)
    return (
      <PatternStory visitor="Signed In" path={characterRelationshipsHref({ id: fixture.id, label: 'The traveler', locale })}>
        <AppShell><main className="p-8">{m.candidate_loading()}</main></AppShell>
      </PatternStory>
    );

  return (
    <PatternStory visitor="Signed In" path={characterRelationshipsHref({ id: fixture.id, label: 'The traveler', locale })}>
      <AppShell>
        <main className="mx-auto w-full max-w-5xl space-y-6 p-4 sm:p-8">
          {scenario === 'late' && (
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={() => setRetired(true)}>Retire current reader</Button>
              <Button variant="outline" disabled={!lateReady} onClick={() => releaseLate.current?.()}>
                Release retired response
              </Button>
            </div>
          )}
          {savedVisit && (
            <Button variant="outline" onClick={() => setRestoringVisit(savedVisit)}>
              Return to relationship
            </Button>
          )}
          {!retired && (
            <CharacterRelationshipsView
              key={`${scenario}:${locale}:${activeVisit?.focus?.statement ?? ''}`}
              id={fixture.id}
              locale={locale}
              transport={transport}
              search={fixture.search}
              initial={reading}
              origin={origin}
              {...(scenario === 'appearance' ? { work: appearanceWorkA } : {})}
              {...(activeVisit ? {
                visit: activeVisit,
                work: activeVisit.work ?? undefined,
                stream: activeVisit.stream ?? undefined,
                cursor: activeVisit.cursors[activeVisit.index] ?? undefined,
              } : {})}
              saveVisit={setSavedVisit}
            />
          )}
        </main>
      </AppShell>
    </PatternStory>
  );
}

function NavigateAway() {
  const router = useRouter({ warn: false });
  return <Button variant="outline" onClick={() => void router?.navigate({ to: '/subjects/after-character-visit' as never })}>Try to leave</Button>;
}

function DirtyDepartureExample() {
  const locale = getLocale();
  const fixture = useMemo(() => relationFixture('ready', locale), [locale]);
  return (
    <PatternStory visitor="Signed In" path="/subjects/character-relationship-editor">
      <AppShell>
        <main className="mx-auto w-full max-w-5xl space-y-6 p-4 sm:p-8">
          <NavigateAway />
          <RelationEditor
            id={fixture.id}
            locale={locale}
            transport={fixture.transport}
            search={async (text) =>
              Object.entries(fixture.publicRead.related).flatMap(([id, related]) => {
                const title = Object.values(related.labels)[0] ?? id;
                return title.toLocaleLowerCase().includes(text.toLocaleLowerCase())
                  ? [{ id, title, types: related.type ? [related.type] : [], typeLabel: '', cover: null }]
                  : [];
              })
            }
            composition={{ statement: fixture.draft, slot: fixture.slot, positionEditable: true }}
          />
        </main>
      </AppShell>
    </PatternStory>
  );
}

function UnknownCommandExample() {
  const locale = getLocale();
  const fixture = useMemo(() => relationFixture('lost-proposal-response', locale), [locale]);
  return (
    <PatternStory visitor="Signed In" path="/subjects/character-relationship-editor">
      <AppShell>
        <main className="mx-auto w-full max-w-5xl p-4 sm:p-8">
          <RelationEditor
            id={fixture.id}
            locale={locale}
            transport={fixture.transport}
            search={async () => []}
            composition={{ statement: fixture.draft, slot: fixture.slot, positionEditable: true }}
          />
        </main>
      </AppShell>
    </PatternStory>
  );
}

function DenialExample({ nonGlobal = false }: { nonGlobal?: boolean }) {
  const locale = getLocale();
  return (
    <PatternStory visitor={nonGlobal ? 'Signed In' : 'Signed Out'} path={characterRelationshipsHref({ id: characterRelationshipsId, label: 'The traveler', locale })}>
      <AppShell>
        <main className="mx-auto w-full max-w-5xl space-y-4 p-4 sm:p-8">
          <h1 className="font-sans text-3xl font-semibold">{m.character_relationships_title()}</h1>
          <p role="status">{nonGlobal ? m.relation_context() : m.character_relationships_signed_out()}</p>
        </main>
      </AppShell>
    </PatternStory>
  );
}

const meta = {
  title: 'Pages/Catalogue/Character relationship visit',
  component: VisitExample,
  parameters: {
    layout: 'fullscreen',
    viewport: {
      options: {
        phone390: { name: 'Phone 390', styles: { width: '390px', height: '844px' } },
        desktop1440: { name: 'Desktop 1440', styles: { width: '1440px', height: '960px' } },
      },
    },
    docs: {
      description: {
        component:
          'Synthetic native-shaped reads exercise the existing private editor and bounded return state. Review all eight locales, both themes and phone390/desktop1440; no story establishes native authorization or browser acceptance.',
      },
    },
  },
} satisfies Meta<typeof VisitExample>;
export default meta;
type Story = StoryObj<typeof meta>;

export const CurrentAppearanceAndWork: Story = {};
export const VoiceKeepsItsCharacterQualifier: Story = { args: { scenario: 'voice' } };
export const ConcealedAssociation: Story = {
  args: { scenario: 'spoiler' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('button', { name: m.character_relationships_spoiler_show() });
    expect(canvas.queryByRole('link', { name: 'Spring work' })).toBeNull();
    await userEvent.click(canvas.getByRole('button', { name: m.character_relationships_spoiler_show() }));
    await canvas.findByRole('link', { name: 'Spring work' });
  },
};
export const WithheldTarget: Story = { args: { scenario: 'withheld' } };
export const IndependentStreamRetry: Story = {
  args: { scenario: 'unreadable' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('status');
    await userEvent.click(await canvas.findByRole('button', { name: m.candidate_reload() }));
    await canvas.findByRole('button', { name: m.candidate_reload() });
  },
};
export const UnavailableAndDenied: Story = { args: { scenario: 'unavailable' } };
export const ReadDenied: Story = { args: { scenario: 'denied' } };
export const AnonymousDenied: Story = { render: () => <DenialExample /> };
export const NonGlobalUnsupported: Story = { render: () => <DenialExample nonGlobal /> };
export const PreviousPage: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('button', { name: m.character_relationships_more() });
    await userEvent.click(canvas.getByRole('button', { name: m.character_relationships_more() }));
    await userEvent.click(await canvas.findByRole('button', { name: m.character_relationships_previous() }));
    await canvas.findByRole('button', { name: m.character_relationships_more() });
  },
};
export const TargetVisitAndReturn: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('link', { name: 'Spring work' }));
    await userEvent.click(await canvas.findByRole('button', { name: 'Return to relationship' }));
    await canvas.findByRole('link', { name: 'Spring work' });
  },
};
export const ChangedRowOnReturn: Story = {
  args: { scenario: 'changed' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText(m.character_relationships_return_changed());
    await canvas.findByRole('button', { name: m.character_relationships_return_current() });
  },
};
export const RetiredReaderIgnoresLateResponse: Story = {
  args: { scenario: 'late' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: m.character_relationships_more() }));
    await userEvent.click(canvas.getByRole('button', { name: 'Retire current reader' }));
    await userEvent.click(await canvas.findByRole('button', { name: 'Release retired response' }));
    await expect(canvas.queryByRole('button', { name: m.character_relationships_previous() })).toBeNull();
  },
};
export const DirtyStayAndLeave: Story = {
  render: () => <DirtyDepartureExample />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const citation = await canvas.findByRole('textbox', { name: m.relation_citation() });
    await userEvent.type(citation, 'https://example.org/visit-source');
    await userEvent.click(canvas.getByRole('button', { name: m.relation_add_citation() }));
    await userEvent.click(canvas.getByRole('button', { name: 'Try to leave' }));
    await canvas.findByRole('alertdialog');
    await userEvent.click(canvas.getByRole('button', { name: m.thread_authoring_stay() }));
    await userEvent.click(canvas.getByRole('button', { name: 'Try to leave' }));
    await userEvent.click(await canvas.findByRole('button', { name: m.thread_authoring_leave() }));
  },
};
export const UnknownCommandKeepsTheOriginalDescriptor: Story = {
  render: () => <UnknownCommandExample />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const editor = within(await canvas.findByRole('region', { name: m.relation_title() }));
    await userEvent.click(await editor.findByRole('button', { name: m.relation_propose() }));
    const confirmation = within(await editor.findByRole('group', {
      name: m.candidate_confirm_title({ action: m.relation_propose() }),
    }));
    await userEvent.click(confirmation.getByRole('button', { name: m.relation_propose() }));
    await editor.findByText(m.candidate_unavailable());
    await userEvent.click(confirmation.getByRole('button', { name: m.relation_propose() }));
    await editor.findByText(m.relation_proposed());
  },
};
