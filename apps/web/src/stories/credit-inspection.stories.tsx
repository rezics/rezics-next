import { useMemo, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { CreditInspection } from '../features/catalogue/credit-inspection/view';
import { creditAssertion, type CreditVisit } from '../features/catalogue/credit-inspection/model';
import { relationFixture, relationActor, relationProperty } from '../kernel/fake/catalogue-relations';
import { getLocale } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';
import { ConnectedStory } from './connected-story';

const meta = { title: 'Pages/Subjects/Credit inspection', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

function Inspection({ denied = false, plain = false }: { denied?: boolean; plain?: boolean }) {
  const locale = getLocale();
  const fixture = useMemo(() => {
    const fixture = relationFixture('ready', locale);
    fixture.candidate.id = fixture.original.id;
    fixture.candidate.statement = structuredClone(fixture.original);
    if (denied) fixture.setActions([]);
    return fixture;
  }, [locale, denied]);
  const [open, setOpen] = useState(true);
  const credit = useMemo(() => creditAssertion({ subject: fixture.id, property: relationProperty,
    statement: fixture.original.id, assertion: { ...fixture.original, ...(plain ? { qualifiers: [], references: [] } : {}) },
    creditSlot: fixture.slot, related: Object.fromEntries(Object.entries(fixture.publicRead.related).map(([id, entry]) =>
      [id, { id, type: entry.type, label: { value: entry.labels.en, language: 'en' } }])) })!, [fixture, plain]);
  const visit: CreditVisit = { person: relationActor, node: 'voice', reader: null,
    context: fixture.publicRead.subject.context, release: fixture.publicRead.subject.release, propertyLabel: 'Voice actor',
    stream: { kind: 'links', id: relationActor, property: relationProperty, limit: 20 } };
  return <ConnectedStory storyId="credit-inspection">
    <button onClick={() => setOpen(true)}>{m.credit_inspect()}</button>
    {open && <CreditInspection credit={credit} visit={visit} title="A long original work heading with several credited roles and original names"
      locale={locale} propertyLabel="Voice actor" onClose={() => setOpen(false)} metadata={async () => ({ kind: 'unavailable' })}
      transport={fixture.transport} signedIn={!plain} search={async () => ({ items: [], next: null })} isCurrent={() => true} />}
  </ConnectedStory>;
}
export const Original: Story = { render: () => <Inspection /> };
export const PlainAnonymous: Story = { render: () => <Inspection plain /> };
export const Refused: Story = { render: () => <Inspection denied /> };
export const UnavailableMetadata: Story = {
  render: () => <Inspection />,
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    await userEvent.click(await page.findByRole('button', { name: m.credit_read_revision() }));
    await expect(page.getByText(m.credit_revision_unavailable())).toBeVisible();
  },
};
