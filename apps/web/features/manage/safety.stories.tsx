import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ComponentProps } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { acting, iri, now, people } from './fixtures.ts';
import { messages } from './messages.ts';
import ko from './messages/ko.ts';
import zhHans from './messages/zh-Hans.ts';
import type { SafetyApi } from './safety-api.ts';
import { ManageHome } from './manage-home.tsx';
import { SafetyQueue } from './safety-queue.tsx';
import type { SafetyView } from './safety-state.ts';
import { SiteFrame } from './site-frame.tsx';
import type { GovernanceRule, ReportEvidence, SafetyCase, SafetyDecisionInput, SafetyDecisionResult, SafetyItem,
  SafetyPage } from './safety-types.ts';
import type { Loaded } from './types.ts';

// Platform safety stories: the queue's states (empty, urgent, overdue, claimed by another, restricted evidence) and
// the decision dialog. The stand-in API records every call, so the stories check what would reach Main.

const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const hours = (h: number) => new Date(now + h * 3_600_000).toISOString();
const position = { dataEpoch: 'safety-queue-v1', sequence: '7' };
const digest = (c: string) => c.repeat(64);

const item = (n: number, over: Partial<SafetyItem>): SafetyItem => ({ caseId: id(n), kind: 'content_report', urgent: false,
  generation: '1', decisionHead: null, openedAt: hours(-n), target: { owner: 'content', resource: iri(900 + n), component: 'body' },
  category: 'harassment', contentLanguage: 'en', dueAt: null, claimedBy: null, ...over });

const urgentNcii = item(1, { urgent: true, category: 'ncii', dueAt: hours(20), openedAt: hours(-28) });
const overdueDmca = item(2, { category: 'copyright', decisionHead: id(92), dueAt: hours(-3), openedAt: hours(-400) });
const claimedElsewhere = item(3, { category: 'hateful_abuse', claimedBy: people.sophie, contentLanguage: 'ko' });
const routine = item(4, { category: 'harassment' });
const cases: SafetyItem[] = [routine, claimedElsewhere, overdueDmca, urgentNcii];

const page = (items: SafetyItem[], nextCursor: string | null = null): SafetyPage => ({ items, nextCursor, sourcePosition: position });

const operation = (status: 'completed' | 'accepted') => ({ operationId: 'op1', status, continuation: null,
  items: [{ ordinal: 1, target: 'content:body', state: status === 'completed' ? 'confirmed' as const : 'pending' as const,
    receipt: status === 'completed' ? 'receipt' : null, continuation: null, error: null }] });

const detailOf = (entry: SafetyItem): SafetyCase => ({ caseId: entry.caseId, kind: entry.kind, urgent: entry.urgent,
  generation: entry.generation, state: 'open', reports: [{ reportId: id(500 + Number(entry.caseId.slice(-2))),
    evidenceDigest: digest('e'), category: entry.category ?? 'harassment' }], reportsNextCursor: null,
  decision: entry.decisionHead ? { profile: 'moderation-decision-v1', decisionId: entry.decisionHead, caseId: entry.caseId,
    caseGeneration: '1', outcome: 'restrict', replayed: false, operation: operation('completed'),
    enforcement: [{ owner: 'content', resource: entry.target.resource, component: 'body', revision: 'r1',
      effect: 'disclosure', state: 'confirmed', fenceEpoch: '1' }] } : null,
  targets: entry.decisionHead ? [{ owner: 'content', resource: entry.target.resource, component: 'body', locator: null,
    scopeKind: 'exact_revision', revision: 'r1', expectedHead: 'r1', effect: 'disclosure', expiresAt: null }] : [] });

const evidenceOf = (entry: SafetyItem): ReportEvidence => ({ profile: 'governance-report-v1', reportId: id(500), caseId: entry.caseId,
  caseGeneration: '1', evidenceDigest: digest('e'), replayed: false, evidence: [{ ordinal: 1, owner: 'content',
    resource: entry.target.resource, component: 'body', revision: 'r1', revisionDigest: digest('d'), state: 'available' }] });

const rule: GovernanceRule = { profile: 'governance-rule-v1', ref: 'urn:rezics:rule:harassment', scopeId: 'governance:platform',
  revision: '3', digest: digest('a'), document: {}, replayed: false };

interface Recorded { claims: Array<{ caseId: string; key: string }>; decisions: SafetyDecisionInput[]; pages: number }
const recorder = (): Recorded => ({ claims: [], decisions: [], pages: 0 });

/** A stand-in for Main's safety-case routes. `denied` lists cases whose read it refuses, as for evidence staff may not see. */
function safetyApi(recorded: Recorded, options: { items?: SafetyItem[]; denied?: string[]; status?: 'completed' | 'accepted';
  claimFails?: boolean } = {}): SafetyApi {
  const items = options.items ?? cases;
  const find = (caseId: string) => items.find(entry => entry.caseId === caseId)!;
  return {
    async page() { recorded.pages += 1; return { ok: true, data: page(items) }; },
    async detail(caseId): Promise<Loaded<SafetyCase>> {
      return options.denied?.includes(caseId) ? { ok: false, failure: 'denied' } : { ok: true, data: detailOf(find(caseId)) };
    },
    async evidence(reportId) { return { ok: true, data: evidenceOf(find(id(Number(reportId.slice(-2))))) }; },
    async due() { return { ok: true, data: [] }; },
    async claim(caseId, key) {
      recorded.claims.push({ caseId, key });
      return options.claimFails ? { ok: false, failure: 'conflict' }
        : { ok: true, data: { caseId, claimedBy: acting.iri } };
    },
    async rule(ref) { return ref === rule.ref ? { ok: true, data: rule } : { ok: false, failure: 'missing' }; },
    async decide(input) {
      recorded.decisions.push(input);
      const result: SafetyDecisionResult = { profile: 'moderation-decision-v1', decisionId: id(77), caseId: input.caseId,
        caseGeneration: '2', outcome: input.outcome, replayed: false, operation: operation(options.status ?? 'completed'),
        enforcement: [] };
      return { ok: true, data: result };
    },
  };
}

const view: SafetyView = { urgent: null, category: null, language: null, due: null };
const recorded = recorder();
const reset = () => {
  recorded.claims.length = 0; recorded.decisions.length = 0; recorded.pages = 0;
  try { localStorage.removeItem('rezics:manage:safety-advanced'); localStorage.removeItem('rezics:manage:safety-rule'); } catch { /* */ }
};
const chinese = { ...messages, ...zhHans };

const meta = {
  title: 'Manage/Platform safety',
  component: SafetyQueue,
  parameters: { route: { pathname: '/en/manage/site' } },
  args: { actingSubject: acting.iri, initial: page(cases), view, now, clock: () => now, locale: 'en', messages, api: safetyApi(recorded),
    names: { [people.sophie]: 'Sophie Li 李素菲' } },
  render: (args: ComponentProps<typeof SafetyQueue>) => <SiteFrame agent={acting} locale={args.locale} messages={args.messages}>
    <SafetyQueue {...args} /></SiteFrame>,
} satisfies Meta<typeof SafetyQueue>;
export default meta;
type Story = StoryObj<typeof meta>;

/** A controlled field can keep only a prefix when another render lands between keystrokes. */
async function typeValue(field: () => HTMLElement, text: string) {
  await waitFor(async () => {
    const input = field() as HTMLInputElement | HTMLTextAreaElement;
    if (input.value !== text) {
      await userEvent.click(input);
      await userEvent.clear(input);
      await userEvent.type(input, text);
    }
    await expect(field()).toHaveValue(text);
  }, { timeout: 5000 });
}

const rows = (canvas: ReturnType<typeof within>, name = 'Safety cases') =>
  within(canvas.getByRole('list', { name })).getAllByRole('button');

/** Urgent first, then overdue, then the rest; each row says its deadline and who holds it. */
export const Queue: Story = {
  async play({ canvasElement }) {
    reset();
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { level: 1, name: 'Platform safety' })).toBeVisible();
    await expect(canvas.getByRole('region', { name: 'Acting as' })).toHaveTextContent('Daniel Chen');
    await expect(canvas.getByText('4 cases waiting')).toBeVisible();
    const listed = rows(canvas);
    await expect(listed[0]).toHaveTextContent('20h');
    await expect(listed[0]!.getAttribute('aria-label')).toMatch(/Urgent/);
    await expect(listed[1]).toHaveTextContent('Overdue by 3h');
    await expect(listed[1]).toHaveTextContent('Back for review');
    await expect(listed[3]).toHaveTextContent('Claimed by Sophie Li 李素菲');
    await expect(canvas.getByRole('form', { name: 'Filter safety cases' })).toBeVisible();
  },
};

export const Empty: Story = {
  args: { initial: page([]) },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { name: 'No cases are waiting' })).toBeVisible();
    await expect(canvas.getByText('0 cases waiting')).toBeVisible();
  },
};

/** Filters live in the address: a filtered view with nothing says so and offers the way back. */
export const FilteredEmpty: Story = {
  args: { initial: page([]), view: { ...view, category: 'privacy', due: 'overdue' } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { name: 'No case matches these filters' })).toBeVisible();
    await expect(canvas.getAllByRole('link', { name: 'Clear filters' })[0]).toHaveAttribute('href', '/en/manage/site');
    await expect(canvas.getByRole('combobox', { name: 'Category' })).toHaveValue('privacy');
    await expect(canvas.getByRole('combobox', { name: 'Due' })).toHaveValue('overdue');
  },
};

/** An NCII case shows its receipt time and its time left; claiming sends one key, in the body and the header's place. */
export const ClaimNcii: Story = {
  async play({ canvasElement }) {
    reset();
    const canvas = within(canvasElement);
    await userEvent.click(rows(canvas)[0]!);
    const deadline = await canvas.findByRole('region', { name: 'Deadline' });
    await expect(deadline).toHaveTextContent('removal is due 48 hours after receipt');
    await expect(deadline).toHaveTextContent('20h');
    await expect(deadline).toHaveTextContent('Received');
    await expect(await canvas.findByText('https://rezics.com/id/' + urgentNcii.target.resource.slice(-36))).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Claim this case' }));
    await waitFor(() => expect(canvas.getByText('Claimed by you')).toBeVisible());
    await expect(recorded.claims).toHaveLength(1);
    await expect(recorded.claims[0]!.key).toMatch(/^[0-9a-f-]{36}$/);
    await expect(canvas.getByRole('button', { name: /^Restrict/ })).toBeVisible();
    await expect(canvas.queryByRole('button', { name: /^Reverse/ })).toBeNull();
  },
};

/** Claimed by someone else: the case reads, but there is nothing to decide with. */
export const ClaimedByAnother: Story = {
  async play({ canvasElement }) {
    reset();
    const canvas = within(canvasElement);
    await userEvent.click(rows(canvas)[3]!);
    await expect(await canvas.findByText('Claimed by someone else. You can read it, not decide it.')).toBeVisible();
    await expect(canvas.queryByRole('button', { name: 'Claim this case' })).toBeNull();
    await expect(canvas.queryByRole('button', { name: /^Restrict/ })).toBeNull();
  },
};

/** A claim lost to a race says so and refreshes the queue. */
export const ClaimRace: Story = {
  args: { api: safetyApi(recorded, { claimFails: true }) },
  async play({ canvasElement }) {
    reset();
    const canvas = within(canvasElement);
    await userEvent.click(rows(canvas)[2]!);
    await userEvent.click(await canvas.findByRole('button', { name: 'Claim this case' }));
    await expect(await canvas.findByRole('alert')).toHaveTextContent('Someone else claimed this case first');
    await waitFor(() => expect(recorded.pages).toBeGreaterThan(0));
  },
};

/** Staff without the specialist role see that the evidence is restricted, and nothing to claim or decide. */
export const RestrictedEvidence: Story = {
  args: { api: safetyApi(recorded, { denied: [urgentNcii.caseId] }) },
  async play({ canvasElement }) {
    reset();
    const canvas = within(canvasElement);
    await userEvent.click(rows(canvas)[0]!);
    await expect(await canvas.findByText('Restricted evidence')).toBeVisible();
    await expect(canvas.getByText(/visible only to the safety specialist role/)).toBeVisible();
    await expect(canvas.queryByRole('button', { name: 'Claim this case' })).toBeNull();
  },
};

/** Opened from its address, a case staff may not see says only that its evidence is restricted. */
export const RestrictedFromAddress: Story = {
  args: { openCase: id(88), api: safetyApi(recorded, { items: [{ ...urgentNcii, caseId: id(88) }], denied: [id(88)] }) },
  async play({ canvasElement }) {
    reset();
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('Restricted evidence')).toBeVisible();
    await expect(canvas.queryByRole('button', { name: 'Claim this case' })).toBeNull();
  },
};

/** A decided case that came back: its decision, effects and restoration date, and Reverse instead of a first decision. */
export const RevisitDecision: Story = {
  args: { initial: page([{ ...overdueDmca, claimedBy: acting.iri }]), api: safetyApi(recorded, { items: [{ ...overdueDmca, claimedBy: acting.iri }] }) },
  async play({ canvasElement }) {
    reset();
    const canvas = within(canvasElement);
    await userEvent.click(rows(canvas)[0]!);
    await expect(await canvas.findByText('Restricted · generation 1')).toBeVisible();
    await expect(canvas.getByText('Every effect is confirmed.')).toBeVisible();
    await expect(canvas.getByText(/Earliest restoration:/)).toBeVisible();
    await expect(canvas.getByText(/Latest restoration: Main lists this step once it is due/)).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Reverse' })).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Restore' })).toBeVisible();
    await expect(canvas.queryByRole('button', { name: 'Dismiss' })).toBeNull();
  },
};

const mine = { ...routine, claimedBy: acting.iri };
const decideArgs = { initial: page([mine]), api: safetyApi(recorded, { items: [mine] }) } as const;

/** The reasons dialog: rule looked up from Main, facts, scope, duration and automation, previewed as the party reads them. */
export const DecisionDialog: Story = {
  args: { ...decideArgs },
  async play({ canvasElement }) {
    reset();
    const canvas = within(canvasElement);
    await userEvent.click(rows(canvas)[0]!);
    await userEvent.click(await canvas.findByRole('button', { name: 'Restrict' }));
    const dialog = within(await within(document.body).findByRole('dialog'));
    await userEvent.click(dialog.getByRole('button', { name: 'Record decision' }));
    await waitFor(() => expect(dialog.getByText('Look up the rule before deciding.')).toBeVisible());
    await typeValue(() => dialog.getByRole('textbox', { name: /^Rule/ }), 'urn:rezics:rule:harassment');
    await userEvent.click(dialog.getByRole('button', { name: 'Look up' }));
    await expect(await dialog.findByText(/Revision 3 · digest aaaaaaaaaaaa/)).toBeVisible();
    await typeValue(() => dialog.getByRole('textbox', { name: /^Facts/ }), 'The post threatens a private person.');
    await typeValue(() => dialog.getByRole('textbox', { name: /^Scope/ }), 'The post only.');
    await typeValue(() => dialog.getByRole('textbox', { name: /^Duration/ }), 'Until restored.');
    await userEvent.click(dialog.getByRole('checkbox', { name: /Automation was involved/ }));
    const preview = within(dialog.getByRole('region', { name: 'As the affected person will read it' }));
    await expect(preview.getByText('The post threatens a private person.')).toBeVisible();
    await expect(preview.getByText('Automation was involved')).toBeVisible();
    await expect(preview.getByText('Rule urn:rezics:rule:harassment, revision 3')).toBeVisible();
    await userEvent.click(dialog.getByRole('button', { name: 'Record decision' }));
    await waitFor(() => expect(recorded.decisions).toHaveLength(1));
    const sent = recorded.decisions[0]!;
    await expect(sent).toMatchObject({ caseId: mine.caseId, outcome: 'restrict', expectedGeneration: '1',
      rule: { ref: rule.ref, revision: '3', digest: digest('a') }, evidenceDigest: digest('e'), reversesDecisionId: null,
      reasons: { facts: 'The post threatens a private person.', scope: 'The post only.', duration: 'Until restored.',
        automation: true, appealRoute: '/v1/public-reports/{caseId}/correspondence', contentLanguage: 'en' } });
    await expect(sent.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    await expect(sent.targets[0]).toMatchObject({ owner: 'content', component: 'body', scopeKind: 'exact_revision',
      revision: 'r1', expectedHead: 'r1', effect: 'disclosure' });
    await waitFor(() => expect(within(document.body).queryByRole('dialog')).toBeNull());
  },
};

/** A decision Main only accepted keeps the dialog open; resuming replays the same key and body. */
export const ResumeAcceptedDecision: Story = {
  args: { initial: page([mine]), api: safetyApi(recorded, { items: [mine], status: 'accepted' }) },
  async play({ canvasElement }) {
    reset();
    const canvas = within(canvasElement);
    await userEvent.click(rows(canvas)[0]!);
    await userEvent.click(await canvas.findByRole('button', { name: 'Dismiss' }));
    const dialog = within(await within(document.body).findByRole('dialog'));
    await typeValue(() => dialog.getByRole('textbox', { name: /^Rule/ }), 'urn:rezics:rule:harassment');
    await userEvent.click(dialog.getByRole('button', { name: 'Look up' }));
    await dialog.findByText(/Revision 3/);
    for (const [label, text] of [[/^Facts/, 'No violation found.'], [/^Scope/, 'The post.'], [/^Duration/, 'None.']] as const) {
      await typeValue(() => dialog.getByRole('textbox', { name: label }), text);
    }
    await userEvent.click(dialog.getByRole('button', { name: 'Record decision' }));
    await expect(await dialog.findByText(/Main accepted the decision and is applying its effects/)).toBeVisible();
    await userEvent.click(dialog.getByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(recorded.decisions).toHaveLength(2));
    await expect(recorded.decisions[1]!.idempotencyKey).toBe(recorded.decisions[0]!.idempotencyKey);
    await expect(recorded.decisions[0]!.targets).toEqual([]);
  },
};

/** Keyboard triage: J and K move through the queue, C claims, R opens the decision. */
export const KeyboardTriage: Story = {
  args: { advanced: true },
  async play({ canvasElement }) {
    reset();
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('switch', { name: 'Keyboard triage' })).toBeChecked();
    await userEvent.keyboard('j');
    await waitFor(() => expect(rows(canvas)[0]).toHaveAttribute('aria-current', 'true'));
    await userEvent.keyboard('j');
    await waitFor(() => expect(rows(canvas)[1]).toHaveAttribute('aria-current', 'true'));
    await userEvent.keyboard('k');
    await waitFor(() => expect(rows(canvas)[0]).toHaveAttribute('aria-current', 'true'));
    await canvas.findByRole('button', { name: /Claim this case/ });
    await userEvent.keyboard('c');
    await waitFor(() => expect(recorded.claims).toHaveLength(1));
    await userEvent.keyboard('r');
    await waitFor(async () => expect(await within(document.body).findByRole('dialog')).toBeVisible());
  },
};

/** On a phone one case fills the screen, with no sideways scrolling, and its decisions are reachable. */
export const Phone: Story = {
  ...{ args: { ...decideArgs } },
  globals: { viewport: { value: 'phone' } },
  async play({ canvasElement }) {
    reset();
    const canvas = within(canvasElement);
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
    await userEvent.click(rows(canvas)[0]!);
    await userEvent.click(await canvas.findByRole('button', { name: 'Restrict' }));
    const dialog = within(await within(document.body).findByRole('dialog'));
    await waitFor(() => expect(dialog.getByRole('button', { name: 'Record decision' })).toBeVisible());
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
};

export const SimplifiedChinese: Story = {
  args: { locale: 'zh-Hans', messages: chinese },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { level: 1, name: '平台安全' })).toBeVisible();
    await expect(canvas.getByText('4 个案件待处理')).toBeVisible();
    await expect(rows(canvas, '安全案件')[1]).toHaveTextContent('已逾期 3小时');
  },
};

export const Korean: Story = {
  args: { locale: 'ko', messages: ko },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { level: 1, name: '플랫폼 안전' })).toBeVisible();
    await expect(canvas.getByText('4건 대기 중')).toBeVisible();
    await expect(rows(canvas, '안전 사안')[0]).toHaveTextContent('긴급');
  },
};

/** Manage's home offers Platform safety only when Main lets the acting Agent read the queue. */
export const HomeEntry: Story = {
  render: args => <>
    <ManageHome agent={acting} realms={{ ok: true, data: { items: [], nextCursor: null } }} moreHref={null} now={now}
      locale={args.locale} messages={args.messages} platformSafety />
  </>,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { level: 2, name: 'Platform safety' })).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'Open platform safety' })).toHaveAttribute('href', '/en/manage/site');
  },
};

export const WithoutHomeEntry: Story = {
  render: args => <ManageHome agent={acting} realms={{ ok: true, data: { items: [], nextCursor: null } }} moreHref={null}
    now={now} locale={args.locale} messages={args.messages} />,
  async play({ canvasElement }) {
    await expect(within(canvasElement).queryByRole('link', { name: 'Open platform safety' })).toBeNull();
  },
};
