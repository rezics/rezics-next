import type { Meta, StoryObj } from '@storybook/react-vite';
import { useEffect, useState } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import collectionsRecording from '../kernel/recorded/library-collections.json';
import { demoAgentSubjects } from '../kernel/agent-fixtures';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { useSession } from '../session/query';
import { VerificationCard } from '../settings/verification';
import {
  VerificationReadError,
  type AgentVerificationRequest,
  type VerificationInput,
} from '../settings/verification-core';
import { VerificationRecovery } from '../settings/verification-recovery';
import { PageStory, PatternStory } from './page';

type Scenario = 'empty' | 'failure' | 'recovery';

function CurrentStatusCard({
  accountId,
  csrfToken,
  scenario,
}: {
  accountId: string;
  csrfToken: string | null;
  scenario: Scenario;
}) {
  const [controller] = useState(() => {
    let reads = 0;
    return new VerificationRecovery(accountId, {
      read: async (currentAccountId) => {
        const attempt = ++reads;
        // Illustrative read IO only, consumed by the actual controller and card.
        await new Promise<void>((resolve) => setTimeout(resolve, 250));
        if (scenario === 'failure' || (scenario === 'recovery' && attempt === 1))
          throw new VerificationReadError({
            status: 503,
            code: 'dependency_unavailable',
            message: m.settings_unavailable_text(),
            requestId: 'illustrative-status-read',
          });
        return { accountId: currentAccountId, verificationRequest: null, subjectTitle: null };
      },
      request: async () => {
        throw new Error('This status-read story does not send commands');
      },
      withdraw: async () => {
        throw new Error('This status-read story does not send commands');
      },
    });
  });
  useEffect(() => {
    controller.activate();
    void controller.reload();
    return () => controller.deactivate();
  }, [controller]);
  return <VerificationCard controller={controller} csrfToken={csrfToken} />;
}

function CurrentViewer({ scenario }: { scenario: Scenario }) {
  const session = useSession();
  if (session.state !== 'signed-in' || !session.subject) return <p role="status">{m.settings_sections_loading()}</p>;
  return (
    <CurrentStatusCard
      key={JSON.stringify([session.subject, session.csrfToken])}
      accountId={session.subject}
      csrfToken={session.csrfToken}
      scenario={scenario}
    />
  );
}

function Example({ scenario }: { scenario: Scenario }) {
  return (
    <PatternStory visitor="Signed In" path="/settings#verification">
      <div className="mx-auto max-w-2xl">
        <CurrentViewer scenario={scenario} />
      </div>
    </PatternStory>
  );
}

const meta = {
  title: 'Patterns/Account/Verification current status',
  component: Example,
  parameters: {
    layout: 'padded',
    docs: {
      description: {
        component:
          'The current Settings verification controller and card with illustrative empty, failed and explicitly recovered read IO. Uses the shared story viewer, locale, theme and phone390/desktop1280 globals. No verification command is sent or granted. Stories are unrun; native, runtime, browser and visual proof remain with integration.',
      },
    },
  },
} satisfies Meta<typeof Example>;
export default meta;
type Story = StoryObj<typeof meta>;

async function expectEmpty(view: ReturnType<typeof within>) {
  await waitFor(() => expect(view.getByRole('status')).toHaveTextContent(m.settings_verification_read_empty()));
  await expect(view.getByRole('status')).toHaveAttribute('aria-live', 'polite');
  await expect(view.getByRole('button', { name: m.settings_verification_submit() })).toBeDisabled();
  await expect(view.queryByText(m.settings_verification_sent())).toBeNull();
  await expect(view.queryByText(m.settings_verification_verified())).toBeNull();
}

async function readAgain(view: ReturnType<typeof within>) {
  const read = view.getByRole('button', { name: m.settings_verification_read_current() });
  await userEvent.click(read);
  await expect(read).toBeDisabled();
  await expect(view.getByRole('status')).toHaveTextContent(m.settings_verification_loading());
}

export const CurrentStatusEmpty: Story = {
  args: { scenario: 'empty' },
  globals: { viewport: { value: 'desktop1280' } },
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await view.findByText(m.settings_verification_read_empty());
    await expectEmpty(view);
    const statement = view.getByRole('textbox', { name: m.settings_verification_statement() });
    await userEvent.type(statement, 'Unsent draft');
    await readAgain(view);
    await expectEmpty(view);
    await expect(statement).toHaveValue('Unsent draft');
  },
};

export const CurrentStatusEmptyPhone: Story = {
  ...CurrentStatusEmpty,
  globals: { viewport: { value: 'phone390' } },
};

export const CurrentStatusFailure: Story = {
  args: { scenario: 'failure' },
  globals: { viewport: { value: 'desktop1280' } },
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    const failure = await view.findByRole('alert');
    await expect(failure).toHaveTextContent(m.settings_verification_load_failed());
    await expect(failure).toHaveAttribute('data-response-status', '503');
    await readAgain(view);
    await waitFor(() => expect(view.getByRole('alert')).toHaveTextContent(m.settings_verification_load_failed()));
    await expect(view.getByRole('button', { name: m.settings_verification_read_current() })).toBeEnabled();
    await expect(view.queryByText(m.settings_verification_read_empty())).toBeNull();
    await expect(view.queryByRole('button', { name: m.settings_verification_submit() })).toBeNull();
  },
};

export const CurrentStatusFailurePhone: Story = {
  ...CurrentStatusFailure,
  globals: { viewport: { value: 'phone390' } },
};

export const CurrentStatusRecovered: Story = {
  args: { scenario: 'recovery' },
  globals: { viewport: { value: 'desktop1280' } },
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await view.findByRole('alert');
    await readAgain(view);
    await expectEmpty(view);
    await expect(view.queryByRole('alert')).toBeNull();
  },
};

export const CurrentStatusRecoveredPhone: Story = {
  ...CurrentStatusRecovered,
  globals: { viewport: { value: 'phone390' } },
};

const readRecoveryFixtures = new WeakMap<Element, ReturnType<typeof readRecoveryTransport>>();
const transportedReadMessage = 'The settings service could not return your preferences.';
const continuation = 'read-recovery+/page-2==';

/** Native-shaped responses at fetch, with the default Settings route, actions, queries and controllers intact. */
function readRecoveryTransport(fallback: typeof fetch) {
  const collections = collectionsRecording.collections;
  const subject = demoAgentSubjects[0]!;
  const reads = { collections: [] as (string | null)[], verification: 0 };
  const commands: { method: string; path: string; key: string | null }[] = [];
  let current: AgentVerificationRequest | null = null;
  const fetcher = (async (input, init) => {
    const request = new Request(input instanceof Request ? input : new URL(String(input), window.location.href), init);
    const url = new URL(request.url);
    if (url.origin !== 'http://kernel.local') return fallback(input, init);
    if (request.method !== 'GET' && request.method !== 'HEAD')
      commands.push({ method: request.method, path: url.pathname, key: request.headers.get('idempotency-key') });
    if (request.method === 'GET' && url.pathname === '/v1/accounts/story-viewer/collections') {
      reads.collections.push(url.searchParams.get('cursor'));
      if (reads.collections.length === 2)
        return Response.json(
          { code: 'dependency_unavailable', detail: 'Collection page unavailable', request_id: 'collection-page' },
          { status: 503, headers: { 'retry-after': '2' } },
        );
      return Response.json({
        collections: [collections[reads.collections.length === 1 ? 0 : 1]],
        next: reads.collections.length === 1 ? continuation : null,
      });
    }
    if (request.method === 'GET' && url.pathname === '/v1/accounts/story-viewer/verification') {
      if (++reads.verification === 2)
        return Response.json(
          {
            code: 'dependency_unavailable',
            detail: transportedReadMessage,
            request_id: 'verification-status',
            retryable: true,
          },
          { status: 503, headers: { 'retry-after': '2' } },
        );
      return Response.json({ verificationRequest: current });
    }
    if (request.method === 'POST' && url.pathname === '/v1/accounts/story-viewer:requestVerification') {
      const draft = (await request.json()) as Omit<VerificationInput, 'idempotencyKey'>;
      current = {
        ...draft,
        id: 'read-recovery-request',
        accountId: 'story-viewer',
        accountKind: 'actor',
        requestedBy: 'story-viewer',
        catalogueSubjectId: draft.subject,
        state: 'pending',
        reason: null,
        problem: null,
        decisionReceiptId: null,
        decidedBy: null,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      };
      // The server accepted the setup request, but its receipt did not reach the client.
      return Response.json({ code: 'dependency_unavailable', detail: 'Request response lost' }, { status: 503 });
    }
    if (request.method === 'GET' && url.pathname === '/v1/subjects:suggest')
      return Response.json({ subjects: [subject] });
    if (request.method === 'GET' && url.pathname === `/v1/subjects/${subject.id}`) return Response.json({ subject });
    return fallback(input, init);
  }) as typeof fetch;
  return { fetcher, reads, commands };
}

function DefaultReadRecoveryPage() {
  const [fixture, setFixture] = useState<ReturnType<typeof readRecoveryTransport> | null>(null);
  useEffect(() => {
    const fallback = globalThis.fetch;
    const transport = readRecoveryTransport(fallback);
    globalThis.fetch = transport.fetcher;
    setFixture(transport);
    return () => {
      if (globalThis.fetch === transport.fetcher) globalThis.fetch = fallback;
    };
  }, []);
  return (
    <div
      ref={(element) => {
        if (element && fixture) readRecoveryFixtures.set(element, fixture);
      }}
    >
      {fixture ? <PageStory visitor="Signed In" path="/settings#privacy" /> : null}
    </div>
  );
}

export const DefaultReadRecovery: StoryObj = {
  name: 'Default Collection and verification read recovery describes the failed read and preserves retained data and command identity',
  tags: ['!dev'],
  render: () => <DefaultReadRecoveryPage />,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await view.findByText(m.settings_verification_read_empty());
    const retained = await view.findByRole('link', { name: collectionsRecording.collections[0]!.title });
    const fixture = readRecoveryFixtures.get(canvasElement.firstElementChild!)!;
    // Establish one unresolved command through the actual form before testing read-only recovery.
    await userEvent.type(view.getByRole('combobox', { name: m.settings_verification_subject() }), 'Haruka');
    await within(document.body).findByRole('option');
    await userEvent.keyboard('{ArrowDown}{Enter}');
    const statement = view.getByRole('textbox', { name: m.settings_verification_statement() });
    await userEvent.type(statement, 'Original evidence');
    await userEvent.click(view.getByRole('button', { name: m.settings_verification_submit() }));
    await view.findByText(m.settings_verification_uncertain_request());
    await expect(fixture.commands).toHaveLength(1);
    const originalCommands = fixture.commands.map((command) => ({ ...command }));
    await expect(originalCommands[0]).toMatchObject({
      method: 'POST',
      path: '/v1/accounts/story-viewer:requestVerification',
    });
    const originalKey = JSON.parse(fixture.commands[0]!.key!);
    await userEvent.click(view.getByText(m.settings_verification_original()));
    await view.findByText(originalKey);
    await userEvent.clear(statement);
    await userEvent.type(statement, 'Later draft');

    const reload = view.getByRole('button', { name: m.settings_verification_read_current() });
    await userEvent.click(reload);
    const failure = (await view.findByText(m.settings_verification_load_failed(), { exact: false })).closest(
      '[role="alert"]',
    )!;
    await expect(failure).toHaveTextContent(m.settings_verification_read_unavailable());
    await expect(failure).toHaveAttribute('data-response-status', '503');
    await expect(failure).toHaveAttribute('data-response-code', 'dependency_unavailable');
    await expect(failure).toHaveAttribute('data-request-id', 'verification-status');
    await expect(failure).toHaveAttribute('data-retry-after', '2');
    const details = within(failure as HTMLElement)
      .getByText(m.settings_verification_read_details())
      .closest('details')!;
    await expect(details).not.toHaveAttribute('open');
    await userEvent.click(within(failure as HTMLElement).getByText(m.settings_verification_read_details()));
    await expect(within(details).getByText(m.settings_verification_read_error({ status: 503 }))).toBeVisible();
    await expect(view.queryByText(transportedReadMessage, { exact: false })).toBeNull();
    await userEvent.click(view.getByRole('button', { name: m.settings_privacy_load_more() }));
    await view.findByText(m.settings_privacy_page_load_failed());
    await view.findByText(m.settings_privacy_unavailable());
    await expect(view.queryByText(m.settings_failed_title())).toBeNull();
    await expect(view.queryByText(m.settings_privacy_empty())).toBeNull();
    await expect(retained).toBeInTheDocument();
    const retry = view.getByRole('button', { name: m.settings_retry() });
    const refresh = view.getByRole('button', { name: m.settings_privacy_refresh_list() });
    const replay = view.getByRole('button', { name: m.settings_verification_retry_original() });
    for (const button of [retry, refresh, reload, replay]) {
      await expect(button).toBeDisabled();
      await userEvent.click(button);
    }
    await expect(fixture.reads).toEqual({ collections: [null, continuation], verification: 2 });
    await waitFor(
      async () => {
        for (const button of [retry, refresh, reload, replay]) await expect(button).toBeEnabled();
      },
      { timeout: 5000 },
    );
    // Retry-After expiry only enables controls; it sends no read or command.
    await expect(fixture.reads).toEqual({ collections: [null, continuation], verification: 2 });
    await expect(fixture.commands).toEqual(originalCommands);
    await userEvent.click(retry);
    await view.findByRole('link', { name: collectionsRecording.collections[1]!.title });
    await expect(view.getByRole('link', { name: collectionsRecording.collections[0]!.title })).toBe(retained);
    await userEvent.click(reload);
    await view.findByText(
      m.settings_verification_pending({
        subject: getLocale() === 'ja' ? demoAgentSubjects[0]!.labels.ja! : demoAgentSubjects[0]!.labels.en!,
      }),
    );
    await expect(statement).toHaveValue('Later draft');
    await userEvent.click(view.getByText(m.settings_verification_original()));
    await expect(view.getByText(originalKey)).toBeVisible();
    await expect(view.getByRole('button', { name: m.settings_verification_retry_original() })).toBeEnabled();
    await expect(fixture.reads).toEqual({ collections: [null, continuation, continuation], verification: 3 });
    // All recovery was GET: no visibility write, request replay, withdrawal or replacement command key.
    await expect(fixture.commands).toEqual(originalCommands);
    await expect(view.queryByRole('button', { name: m.settings_verification_withdraw() })).toBeNull();
  },
};
