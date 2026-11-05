import { expect, spyOn, test } from 'bun:test';
import { nativeSignInProof } from './sign-in-fixture';
import {
  creationFixture,
  automatedOperatorPage,
  approval,
  button,
  fill,
  flush,
  leave,
  open,
  send,
} from './creation-page-fixture';
import {
  automatedAccountOperationRequestByteBudgets,
  automatedAccountOperationResponseByteBudgets,
} from '@rezics/auth-contract';
creationFixture();
const { AutomatedAccountCreatePage } = await import('../src/routes/automated.new');
const {
  AUTOMATED_PROFILE,
  AUTOMATED_ATTEMPT_MAX_SERIALIZED_UTF16,
  createAutomatedAttempt,
  restoreAutomatedAttempt,
  saveAutomatedAttempt,
} = await import('../src/automated-account-create');
const human = '11111111-1111-4111-8111-111111111111';
const operator = {
  id: '22222222-2222-4222-8222-222222222222',
  kind: 'organization' as const,
  handle: 'operator',
  displayName: null,
};
const body = {
  account_id: human,
  client_id: AUTOMATED_PROFILE.client_id,
  scope: AUTOMATED_PROFILE.scope,
  auth_time: Math.floor(Date.now() / 1000),
  authn_epoch: 1,
  amr: ['pwd'],
};
const confirm = async (host: HTMLElement) => {
  await flush(() => host.querySelector<HTMLInputElement>('#automated-confirm')!.click());
  await flush(() => send(host));
};
async function authenticate(host: HTMLElement) {
  await flush(() => {
    fill(host.querySelector('#automated-email')!, 'human@example.com');
    fill(host.querySelector('#automated-password')!, 'secret');
  });
  await flush(() => send(host));
}
test('retry restores exact parties and key without creating until explicit confirmation', async () => {
  const attempt = createAutomatedAttempt(human, operator, 'robot-one')!;
  expect(saveAutomatedAttempt(attempt)).toBe(true);
  const page = await open(<AutomatedAccountCreatePage initial={{ kind: 'unavailable' }} />, { ...body });
  await flush(() => button(page.host, 'Retry')!.click());
  expect(page.host.textContent).toContain('robot-one');
  expect(page.host.textContent).toContain(operator.id);
  expect(page.calls).toHaveLength(0);
  await confirm(page.host);
  await flush(() => page.calls[0]!.resolve(approval()));
  await flush(() => page.calls[1]!.resolve(Response.json({ accountId: operator.id })));
  for (const call of page.calls.filter((call) => call.path.startsWith('/account-operations/'))) {
    expect(call.body).toMatchObject({ operationKey: attempt.operationKey, operation: attempt.operation });
  }
  expect(page.host.textContent).toContain('The native creation workflow returned account');
  expect(page.host.querySelector<HTMLAnchorElement>('a[href="/security"]')).not.toBeNull();
});
for (const stage of ['review', 'approval', 'signin'] as const)
  test(`departure retires pending ${stage} without changing a replacement attempt`, async () => {
    const page = await open(<AutomatedAccountCreatePage />, { ...body });
    if (stage === 'review') {
      await flush(() => {
        fill(page.host.querySelector('#automated-operator')!, operator.id);
        fill(page.host.querySelector('#automated-handle')!, 'old-robot');
      });
      await flush(() => send(page.host));
    } else {
      expect(saveAutomatedAttempt(createAutomatedAttempt(human, operator, 'old-robot')!)).toBe(true);
      await page.render(<AutomatedAccountCreatePage key="resume" />);
      await confirm(page.host);
      if (stage === 'signin') {
        await flush(() =>
          page.calls[0]!.resolve(
            Response.json({ error: 'step_up_required', effect_status: 'not_applied' }, { status: 401 }),
          ),
        );
        await authenticate(page.host);
      }
    }
    await flush(leave);
    window.sessionStorage.clear();
    const replacement = createAutomatedAttempt(human, operator, 'new-robot')!;
    expect(saveAutomatedAttempt(replacement)).toBe(true);
    await page.render(<AutomatedAccountCreatePage key="replacement" />);
    await flush(() =>
      page.calls
        .at(-1)!
        .resolve(
          stage === 'review'
            ? automatedOperatorPage(human, operator)
            : stage === 'approval'
              ? approval()
              : Response.json(nativeSignInProof(page.calls.at(-1)!.body, 'pwd', human)),
        ),
    );
    expect(restoreAutomatedAttempt()).toEqual(replacement);
    expect(page.host.textContent).toContain('new-robot');
    expect(page.host.querySelector<HTMLInputElement>('#automated-confirm')!.checked).toBe(false);
    expect(page.calls).toHaveLength(stage === 'signin' ? 2 : 1);
  });

test('ordinary advice authenticates the exact normalized draft, rereads native review and waits for explicit confirmation', async () => {
  const session = { ...body, client_id: 'login', scope: [] as string[] };
  const page = await open(<AutomatedAccountCreatePage />, session);
  expect(page.host.textContent).toContain('Verify the same human');
  await flush(() => {
    fill(page.host.querySelector('#automated-operator')!, operator.id);
    fill(page.host.querySelector('#automated-handle')!, 'Robot-One');
  });
  await flush(() => send(page.host));
  expect(page.calls).toHaveLength(0);
  expect(page.host.querySelector('#automated-email')).not.toBeNull();
  await authenticate(page.host);
  expect(page.host.querySelector<HTMLInputElement>('#automated-password')!.value).toBe('');
  Object.assign(session, body);
  await flush(() => page.calls[0]!.resolve(Response.json(nativeSignInProof(page.calls[0]!.body, 'pwd', human))));
  expect(page.calls[1]!.body).toEqual({ operatorAccountId: operator.id });
  await flush(() => page.calls[1]!.resolve(automatedOperatorPage(human, { ...operator, handle: null })));
  expect(page.host.textContent).toContain('Operator without a public name');
  expect(page.host.textContent).toContain('robot-one');
  expect(page.host.querySelector<HTMLInputElement>('#automated-confirm')!.checked).toBe(false);
  expect(page.calls).toHaveLength(2);
  expect(JSON.stringify(restoreAutomatedAttempt())).not.toContain('secret');
  await confirm(page.host);
  expect(page.calls[2]!.path).toBe('/account-operations/approve');
});
test('invalid fields attach advice without reading the operator; native refusal and unavailable remain distinct', async () => {
  for (const status of [403, 503]) {
    const page = await open(<AutomatedAccountCreatePage />, { ...body });
    await flush(() => send(page.host));
    expect(page.host.querySelector('#automated-operator')!.getAttribute('aria-invalid')).toBe('true');
    expect(page.host.querySelector('#automated-handle')!.getAttribute('aria-describedby')).toContain(
      'automated-handle-error',
    );
    expect(page.calls).toHaveLength(0);
    await flush(() => {
      fill(page.host.querySelector('#automated-operator')!, operator.id);
      fill(page.host.querySelector('#automated-handle')!, 'robot-one');
    });
    await flush(() => send(page.host));
    expect(page.host.querySelector('[role="status"]')!.textContent).toContain('Checking');
    await flush(() => page.calls[0]!.resolve(Response.json({}, { status })));
    expect(page.host.textContent).toContain(status === 403 ? 'Creation was refused' : 'service is unavailable');
    await page.render(<></>);
  }
});

test('oversized retained attempt stays untouched and cannot allocate a new key or issue a command', async () => {
  const raw = `${' '.repeat(AUTOMATED_ATTEMPT_MAX_SERIALIZED_UTF16 + 1)}null`;
  window.sessionStorage.setItem('rezics.automated-create.attempt', raw);
  const randomUUID = spyOn(crypto, 'randomUUID');
  try {
    const page = await open(<AutomatedAccountCreatePage />, { ...body });
    expect(restoreAutomatedAttempt()).toBe('invalid');
    expect(window.sessionStorage.getItem('rezics.automated-create.attempt')).toBe(raw);
    expect(randomUUID).not.toHaveBeenCalled();
    expect(page.calls).toHaveLength(0);
    expect(page.host.querySelector('#automated-confirm')).toBeNull();
  } finally {
    randomUUID.mockRestore();
  }
});

test('approval and execute preserve the maximum escaped opaque reference within the producer-derived request ceiling', async () => {
  const handle = `a${'b'.repeat(62)}c`;
  const base = createAutomatedAttempt(human, operator, handle)!;
  const operationKey = '\u0002'.repeat(128);
  const attempt = {
    ...base,
    operationKey,
    operation: { ...base.operation, operationKey },
  };
  expect(saveAutomatedAttempt(attempt)).toBe(true);
  const page = await open(<AutomatedAccountCreatePage />, { ...body });
  await confirm(page.host);
  const reference = '\u0001'.repeat(4096);
  const raw = JSON.stringify({ reference, expiresAt: new Date(Date.now() + 60000).toISOString() });
  expect(new TextEncoder().encode(raw).byteLength).toBe(automatedAccountOperationResponseByteBudgets.approval);
  await flush(() => page.calls[0]!.resolve(new Response(raw, { status: 200, headers: { 'content-length': '1' } })));
  const execute = page.calls.at(-1)!;
  expect(execute.path).toBe('/account-operations/execute');
  expect(execute.body).toEqual({
    operation: attempt.operation,
    operationKey,
    accountId: human,
    reference,
  });
  expect(new TextEncoder().encode(JSON.stringify(execute.body)).byteLength).toBe(
    automatedAccountOperationRequestByteBudgets.execute,
  );
  await flush(() => execute.resolve(Response.json({ accountId: operator.id })));
  expect(page.host.textContent).toContain(`The native creation workflow returned account ${operator.id}`);
});

test('approval overflow is rejected before JSON parsing even with a lying small Content-Length', async () => {
  saveAutomatedAttempt(createAutomatedAttempt(human, operator, 'robot-one')!);
  const page = await open(<AutomatedAccountCreatePage />, { ...body });
  await confirm(page.host);
  const raw = JSON.stringify({
    reference: '\u0001'.repeat(4097),
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  });
  const parse = spyOn(JSON, 'parse');
  try {
    await flush(() => page.calls[0]!.resolve(new Response(raw, { status: 200, headers: { 'content-length': '1' } })));
    expect(parse.mock.calls.some(([input]) => input === raw)).toBe(false);
    expect(page.calls.map((call) => call.path)).toEqual(['/account-operations/approve']);
    expect(page.host.textContent).toContain('result remains unresolved');
  } finally {
    parse.mockRestore();
  }
});

test('split UTF-8 approval bytes without Content-Length remain opaque and exact success completes this attempt', async () => {
  const attempt = createAutomatedAttempt(human, operator, 'robot-one')!;
  saveAutomatedAttempt(attempt);
  const page = await open(<AutomatedAccountCreatePage />, { ...body });
  await confirm(page.host);
  const raw = JSON.stringify({ reference: 'opaque/é', expiresAt: new Date(Date.now() + 60000).toISOString() });
  const bytes = new TextEncoder().encode(raw);
  const split = bytes.indexOf(0xc3) + 1;
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(bytes.slice(0, split));
        controller.enqueue(bytes.slice(split));
        controller.close();
      },
    }),
    { status: 200 },
  );
  await flush(() => page.calls[0]!.resolve(response));
  const execute = page.calls.at(-1)!;
  expect(execute.path).toBe('/account-operations/execute');
  expect(execute.body).toEqual({
    operation: attempt.operation,
    operationKey: attempt.operationKey,
    accountId: attempt.accountId,
    reference: 'opaque/é',
  });
  await flush(() => execute.resolve(Response.json({ accountId: operator.id })));
  expect(page.host.textContent).toContain(`The native creation workflow returned account ${operator.id}`);
});

test('an expired approval and malformed execution replies keep the original unknown command', async () => {
  const original = createAutomatedAttempt(human, operator, 'robot-one')!;
  saveAutomatedAttempt({ ...original, reference: 'previous-reference', submitted: true });
  const page = await open(<AutomatedAccountCreatePage />, { ...body });
  await flush(() => page.host.querySelector<HTMLInputElement>('#automated-confirm')!.click());
  await flush(() => send(page.host));
  const firstApproval = page.calls.at(-1)!;
  await flush(() =>
    firstApproval.resolve(
      Response.json({ reference: 'expired-reference', expiresAt: new Date(Date.now() - 1000).toISOString() }),
    ),
  );
  expect(page.calls.filter((call) => call.path === '/account-operations/execute')).toHaveLength(0);
  expect(restoreAutomatedAttempt()).toMatchObject({
    accountId: original.accountId,
    operationKey: original.operationKey,
    operation: original.operation,
    operator: original.operator,
    reference: 'previous-reference',
    submitted: true,
  });

  await confirm(page.host);
  const secondApproval = page.calls.filter((call) => call.path === '/account-operations/approve').at(-1)!;
  await flush(() => secondApproval.resolve(approval()));
  const execute = page.calls.at(-1)!;
  await flush(() => execute.resolve(Response.json({ accountId: operator.id, extra: 'unbound' })));
  expect(page.host.textContent).toContain('result remains unresolved');
  expect(page.host.textContent).not.toContain(`The native creation workflow returned account ${operator.id}`);
  expect(restoreAutomatedAttempt()).toMatchObject({
    accountId: original.accountId,
    operationKey: original.operationKey,
    operation: original.operation,
    operator: original.operator,
    reference: 'native-approval',
    submitted: true,
  });

  await confirm(page.host);
  const thirdApproval = page.calls.filter((call) => call.path === '/account-operations/approve').at(-1)!;
  await flush(() => thirdApproval.resolve(approval()));
  const malformedRefusal = page.calls.at(-1)!;
  await flush(() =>
    malformedRefusal.resolve(
      Response.json(
        { error: 'account_operation_denied', effect_status: 'not_applied', extra: 'unsupported' },
        { status: 403 },
      ),
    ),
  );
  expect(page.host.textContent).toContain('result remains unresolved');
  expect(page.host.textContent).not.toContain(`The native creation workflow returned account ${operator.id}`);
  expect(restoreAutomatedAttempt()).toMatchObject({
    accountId: original.accountId,
    operationKey: original.operationKey,
    operation: original.operation,
    operator: original.operator,
    reference: 'native-approval',
    submitted: true,
  });
});

test('newer exact native approval and execution refusals cannot clear an earlier uncertain creation', async () => {
  const original = createAutomatedAttempt(human, operator, 'robot-one')!;
  saveAutomatedAttempt({ ...original, reference: 'previous-reference', submitted: true });
  const page = await open(<AutomatedAccountCreatePage />, { ...body });
  await flush(() => page.host.querySelector<HTMLInputElement>('#automated-confirm')!.click());
  await flush(() => send(page.host));
  await flush(() =>
    page.calls
      .at(-1)!
      .resolve(Response.json({ error: 'account_operation_denied', effect_status: 'not_applied' }, { status: 403 })),
  );
  expect(page.calls.filter((call) => call.path === '/account-operations/execute')).toHaveLength(0);
  expect(page.host.textContent).toContain('result remains unresolved');
  expect(restoreAutomatedAttempt()).toMatchObject({
    accountId: original.accountId,
    operationKey: original.operationKey,
    operation: original.operation,
    reference: 'previous-reference',
    submitted: true,
  });

  await confirm(page.host);
  const secondApproval = page.calls.filter((call) => call.path === '/account-operations/approve').at(-1)!;
  await flush(() => secondApproval.resolve(approval()));
  const execute = page.calls.at(-1)!;
  expect(execute.path).toBe('/account-operations/execute');
  await flush(() =>
    execute.resolve(
      Response.json({ error: 'account_operation_denied', effect_status: 'not_applied' }, { status: 403 }),
    ),
  );
  expect(page.host.textContent).toContain('result remains unresolved');
  expect(restoreAutomatedAttempt()).toMatchObject({
    accountId: original.accountId,
    operationKey: original.operationKey,
    operation: original.operation,
    reference: 'native-approval',
    submitted: true,
  });
});

test('approval classifies exact platform closure and step-up envelopes only', async () => {
  saveAutomatedAttempt(createAutomatedAttempt(human, operator, 'closed-robot')!);
  const closed = await open(<AutomatedAccountCreatePage />, { ...body });
  await confirm(closed.host);
  await flush(() =>
    closed.calls[0]!.resolve(
      Response.json({ error: 'platform_closed', effect_status: 'not_applied' }, { status: 403 }),
    ),
  );
  expect(closed.calls.map((call) => call.path)).toEqual(['/account-operations/approve']);
  expect(closed.host.textContent).toContain('Creation was refused');
  await closed.render(<></>);

  saveAutomatedAttempt(createAutomatedAttempt(human, operator, 'stepup-robot')!);
  const stepUp = await open(<AutomatedAccountCreatePage />, { ...body });
  await confirm(stepUp.host);
  await flush(() =>
    stepUp.calls[0]!.resolve(
      Response.json({ error: 'step_up_required', effect_status: 'not_applied' }, { status: 401 }),
    ),
  );
  expect(stepUp.calls.map((call) => call.path)).toEqual(['/account-operations/approve']);
  expect(stepUp.host.querySelector('#automated-password')).not.toBeNull();
  expect(restoreAutomatedAttempt()).toMatchObject({ submitted: true });
});
test('native acknowledgement survives authority replacement without publishing private result details', async () => {
  saveAutomatedAttempt(createAutomatedAttempt(human, operator, 'robot-one')!);
  const session = { ...body };
  const page = await open(<AutomatedAccountCreatePage />, session);
  await confirm(page.host);
  await flush(() => page.calls[0]!.resolve(approval()));
  session.authn_epoch++;
  await flush(() => page.calls[1]!.resolve(Response.json({ accountId: operator.id })));
  expect(page.host.textContent).not.toContain('The native creation workflow returned account');
  expect(page.host.textContent).toContain('The native creation workflow acknowledged completion.');
  expect(page.host.textContent).not.toContain('The result is uncertain');
  expect(restoreAutomatedAttempt()).toMatchObject({ submitted: true });
  expect(page.host.querySelector('#automated-confirm')).toBeNull();
});
