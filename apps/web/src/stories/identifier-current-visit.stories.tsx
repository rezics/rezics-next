import type { Meta, StoryObj } from '@storybook/react-vite';
import { useMemo, useRef } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { IdentifierCurrentVisit } from '../features/catalogue/identifier-current-visit-view';
import {
  identifierVisitExample,
  identifierExampleAddress,
} from '../features/catalogue/identifier-current-visit-examples';
import { identifierRouteHref } from '../features/catalogue/identifier-current-visit';
import type { IdentifierEvidenceRead } from '../features/catalogue/identifier-current-visit-evidence';
import { IdentifiersProfile } from '../features/catalogue/identifiers-profile-view';
import { identifiersProfileFixture } from '../kernel/fake/catalogue-identifiers-profile';
import { getLocale } from '../paraglide/runtime';
import { m } from '../paraglide/messages.js';
import { AppShell } from '../shell/shell';
import { PatternStory } from './page';

function Example({ scenario = 'duplicates' }: { scenario?: 'duplicates' | 'recovery' | 'cancelled' }) {
  const locale = getLocale();
  const releaseRead = useRef<(() => void) | undefined>(undefined);
  const fixture = useMemo(() => identifierVisitExample(), [locale, scenario]);
  const correction = useMemo(() => identifiersProfileFixture('uncertain', locale), [locale]);
  const transport = useMemo(() => {
    let reads = 0;
    return {
      read: async (): Promise<IdentifierEvidenceRead> => {
        reads++;
        if (scenario === 'recovery' && reads === 1) return { kind: 'unavailable' };
        if (scenario === 'cancelled' && reads > 1)
          await new Promise<void>((resolve) => {
            releaseRead.current = resolve;
          });
        return fixture.result;
      },
    };
  }, [fixture, scenario]);
  return (
    <PatternStory visitor="Signed In">
      <AppShell>
        <IdentifierCurrentVisit
          id={fixture.read.subject.id}
          locale={locale}
          origin={fixture.origin}
          initialInspection={identifierExampleAddress}
          editorHref={identifierRouteHref(locale, fixture.read.subject.id, 'edition', { origin: fixture.origin })}
          transport={transport}
        />
        {scenario === 'cancelled' && (
          <button className="min-h-11 underline" type="button" onClick={() => releaseRead.current?.()}>
            {m.identifiers_inspect_continue({}, { locale: locale as never })}
          </button>
        )}
        {scenario === 'recovery' && (
          <IdentifiersProfile
            id={fixture.read.subject.id}
            locale={locale}
            session="signed-in"
            transport={correction.transport}
            review={correction.review}
          />
        )}
      </AppShell>
    </PatternStory>
  );
}

const meta = {
  title: 'Pages/Catalogue/Identifier current visit',
  component: Example,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof Example>;
export default meta;
type Story = StoryObj<typeof meta>;

export const DuplicateValues: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.findByText('ISBN-13')).resolves.toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: m.identifiers_inspect_return() }));
    await waitFor(() =>
      expect(canvas.getAllByRole('button', { name: m.identifiers_inspect_exact() }).length).toBeGreaterThan(1),
    );
    await userEvent.click(canvas.getAllByRole('button', { name: m.identifiers_inspect_exact() })[1]!);
    await expect(canvas.findByRole('link', { name: 'https://catalogue.example/second' })).resolves.toBeVisible();
  },
};
export const UncertainResultReadRecovery: Story = {
  args: { scenario: 'recovery' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const visit = within(canvasElement.querySelector('[data-slot="identifier-current-visit"]') as HTMLElement);
    await expect(visit.findByText(m.identifiers_origin_unavailable())).resolves.toBeVisible();
    await userEvent.click(visit.getByRole('button', { name: m.identifiers_public_reload() }));
    await expect(visit.findByText('ISBN-13')).resolves.toBeVisible();
    const field = within(await canvas.findByRole('region', { name: 'ISBN-13' }));
    await userEvent.click(field.getByRole('button', { name: m.facts_edit_field() }));
    const value = field.getAllByRole('textbox', { name: m.correction_value() })[0]!;
    await userEvent.clear(value);
    await userEvent.type(value, '978-4-00-000001-7');
    await userEvent.click(canvas.getByRole('button', { name: m.facts_submit() }));
    await expect(field.findByText(m.facts_uncertain())).resolves.toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: m.facts_submit() }));
    await expect(field.findByText(m.correction_proposed())).resolves.toBeVisible();
  },
};
export const CancelledReturn: Story = {
  args: { scenario: 'cancelled' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.findByText('ISBN-13')).resolves.toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: m.identifiers_inspect_return() }));
    const continueReading = canvas.getByRole('button', { name: m.identifiers_inspect_continue() });
    await userEvent.click(continueReading);
    await waitFor(() =>
      expect(canvas.getAllByRole('button', { name: m.identifiers_inspect_exact() }).length).toBeGreaterThan(1),
    );
    expect(continueReading).toHaveFocus();
  },
};
