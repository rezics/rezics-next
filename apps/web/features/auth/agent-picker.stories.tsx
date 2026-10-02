import type { Meta, StoryObj } from '@storybook/react-vite';
import { Card, CardContent } from '@rezics/ui/card';
import { expect, userEvent, within } from 'storybook/test';
import { AgentPicker } from './agent-picker.tsx';
import { PageContainer } from '../shell/page.tsx';
import { messages } from './messages.ts';

const ada = 'https://rezics.com/id/b8df6385-cec9-4fa0-8b89-71def5fa82b5';
const pen = 'https://rezics.com/id/1e1489d5-6994-402c-99f2-50547eeaef4d';
const gone = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';
const org = 'https://rezics.com/id/0d9c6a52-6bd3-4f3a-a2a6-6a8e8f2f1c11';
const service = 'https://rezics.com/id/7a2f0c3e-5f0a-4d8e-9d55-3c1c2b7a9e42';
const person = 'https://rezics.com/id/3f6c1a9e-0b1d-4c7e-8a55-9d2e4b6f1a70';

// Every Agent Main lists: none of them needs to be able to publish, and none has an authority path.
const everyKind = [
  { iri: person, label: '林梅', labelText: { language: 'zh-Hant', direction: 'ltr' as const },
    handle: 'meilin', kind: 'person' as const, path: null },
  { iri: pen, label: 'Aster', labelText: { language: 'en', direction: 'ltr' as const },
    handle: 'aster', kind: 'pen-name' as const, path: null },
  { iri: org, label: 'مؤسسة النور', labelText: { language: 'ar', direction: 'rtl' as const },
    handle: null, kind: 'organization' as const, path: null },
  { iri: service, label: 'Nightly importer', labelText: { language: 'en', direction: 'ltr' as const },
    handle: null, kind: 'service' as const, path: null }];

const meta = { title: 'Auth/Agent picker', component: AgentPicker,
  args: { options: [{ iri: pen, label: 'Aster', handle: 'aster', kind: 'pen-name',
    path: 'represented-agent' },
    { iri: ada, label: 'Ada Lovelace', handle: 'ada', kind: 'person',
      path: 'direct-principal' }], current: null, preferred: null,
  preferenceRevision: null, sessionRevision: null, next: '/en/studio', locale: 'en', notice: null,
  messages: messages.en },
  decorators: [Story => <PageContainer className="max-w-xl sm:py-12"><Card><CardContent><Story /></CardContent></Card></PageContainer>],
} satisfies Meta<typeof AgentPicker>;
export default meta;
type Story = StoryObj<typeof meta>;

export const ChooseAnAgent: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const radios = canvas.getAllByRole('radio');
    await expect(radios).toHaveLength(2);
    for (const radio of radios) await expect(radio).not.toBeChecked();
    await expect(canvas.getByRole('radio', { name: /Aster @aster/ })).toBeInTheDocument();
    await expect(canvas.getByRole('button', { name: 'Use this Agent' })).toBeInTheDocument();
    await userEvent.click(canvas.getByRole('radio', { name: /Aster @aster/ }));
    const form = canvasElement.querySelector('form')!;
    await expect(new FormData(form).get('agent')).toBe(pen);
    await userEvent.click(canvas.getByText('Make this my default'));
    await expect(new FormData(form).get('saveDefault')).toBe('on');
    await userEvent.keyboard(' ');
    await expect(new FormData(form).get('saveDefault')).toBeNull();
  },
};

export const EveryKind: Story = {
  args: { options: everyKind },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getAllByRole('radio')).toHaveLength(4);
    await expect(canvas.getByRole('radio', { name: /林梅 @meilin Person/ })).toBeInTheDocument();
    await expect(canvas.getByRole('radio', { name: /Aster @aster Pen name/ })).toBeInTheDocument();
    await expect(canvas.getByRole('radio', { name: /مؤسسة النور Organization/ })).toBeInTheDocument();
    await expect(canvas.getByRole('radio', { name: /Nightly importer Service/ })).toBeInTheDocument();
    // A label carries its own language and direction, whatever the page's.
    await expect(canvas.getByText('مؤسسة النور')).toHaveAttribute('dir', 'rtl');
    await expect(canvas.getByText('مؤسسة النور')).toHaveAttribute('lang', 'ar');
    await expect(canvas.getByText('林梅')).toHaveAttribute('lang', 'zh-Hant');
  },
};

export const OrganizationHeldByControlJapanese: Story = {
  args: { options: [everyKind[2]!], messages: messages.ja, locale: 'ja', next: '/ja' },
  globals: { locale: 'ja' },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('radio', { name: /مؤسسة النور 組織/ })).toBeInTheDocument();
    await expect(canvas.getByRole('button', { name: 'このエージェントを使う' })).toBeInTheDocument();
  },
};

export const OrganizationHeldByControlGerman: Story = {
  args: { options: [everyKind[2]!], messages: messages.de, locale: 'de', next: '/de' },
  globals: { locale: 'de' },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('radio', { name: /مؤسسة النور Organisation/ })).toBeInTheDocument();
  },
};

export const EveryKindPhone: Story = {
  args: { options: everyKind, messages: messages['zh-Hant'], locale: 'zh-Hant', next: '/zh-Hant' },
  globals: { locale: 'zh-Hant', viewport: { value: 'phone' } },
  async play() {
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
};

export const CurrentAndDefault: Story = {
  args: { current: pen, preferred: ada, preferenceRevision: 'b1e8a1d0-1c1e-4b8a-9f3e-2a1b3c4d5e6f' },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('radio', { name: /Aster @aster/ })).toBeChecked();
    await expect(canvas.getByRole('radio', { name: /Aster @aster/ })).toHaveAccessibleName(/Current/);
    await expect(canvas.getByRole('radio', { name: /Ada Lovelace @ada/ })).toHaveAccessibleName(/Default/);
  },
};

export const AgentNoLongerAvailable: Story = {
  args: { notice: { kind: 'ineligible', previous: gone } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('alert')).toHaveTextContent('Agent 00000000');
    for (const radio of canvas.getAllByRole('radio')) await expect(radio).not.toBeChecked();
  },
};

export const StaleDefault: Story = {
  args: { current: ada, notice: { kind: 'stale-default' } },
};

export const OtherTabChangedAgent: Story = {
  args: { current: ada, notice: { kind: 'stale-session' } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('alert')).toHaveTextContent('another tab');
    await expect(canvas.getByRole('radio', { name: /Ada Lovelace/ })).toBeChecked();
  },
};

export const IneligibleDefault: Story = {
  args: { notice: { kind: 'ineligible-default', previous: gone } },
};

export const ExplicitlyCleared: Story = {
  args: { sessionRevision: 'b1e8a1d0-1c1e-4b8a-9f3e-2a1b3c4d5e6f', preferred: ada },
  async play({ canvasElement }) {
    for (const radio of within(canvasElement).getAllByRole('radio')) await expect(radio).not.toBeChecked();
  },
};

export const MissingPublicLabel: Story = {
  args: { options: [{ iri: pen, label: null, handle: null, kind: null,
    path: 'represented-agent' }] },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('radio', { name: /Agent 1e1489d5/ })).toBeInTheDocument();
  },
};

export const NoAgents: Story = {
  args: { options: [] },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('status')).toHaveTextContent('do not have a profile');
    await expect(canvas.getByRole('link', { name: 'Set up your profile' }))
      .toHaveAttribute('href', '/en/onboarding?next=%2Fen%2Fstudio');
    await expect(canvas.queryByRole('button')).toBeNull();
  },
};

export const Unavailable: Story = {
  args: { options: null, notice: { kind: 'unavailable' } },
};

export const Chinese: Story = {
  args: { messages: messages['zh-Hans'], current: ada },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { name: '选择您的操作身份' })).toBeInTheDocument();
    await expect(canvas.getByRole('button', { name: '使用此身份' })).toBeInTheDocument();
  },
};

export const Phone: Story = {
  args: { current: pen },
  globals: { viewport: { value: 'phone' } },
  async play() {
    // Agent IRIs are long; they truncate instead of widening the page.
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
};
