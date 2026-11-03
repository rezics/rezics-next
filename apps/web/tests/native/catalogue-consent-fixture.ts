import { accountAgentId } from '../../../../services/kernel/src/semantic/agents.ts';
import { GLOBAL_CONTEXT } from '../../../../services/kernel/src/semantic/definitions.ts';
import { subjectHref } from '../../src/subject/subject-href.ts';
import { startAuthStack, type NativeAuthStack } from './auth-stack.ts';
import { startNativeWebStack, type NativeWebStack } from './stack.ts';

const property = 'rezics:penNameOf';

export type CatalogueConsentAddress = {
  id: string;
  property: string;
  candidate: string;
  slot: { target: string };
  href: string;
};

export type CatalogueConsentFixture = {
  stack: NativeWebStack;
  auth: NativeAuthStack;
  alice: { accountId: string; agent: { id: string; label: string } };
  bob: { accountId: string };
  own: CatalogueConsentAddress;
  uncertain: CatalogueConsentAddress;
  sourced: CatalogueConsentAddress;
  close(): Promise<void>;
};

async function requireStatus(response: Response, status: number, label: string): Promise<unknown> {
  const text = await response.text();
  if (response.status !== status) throw new Error(`${label} returned ${response.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

async function write(
  stack: NativeWebStack,
  persona: string,
  path: string,
  body: unknown,
  status = 201,
): Promise<Record<string, unknown>> {
  return (await requireStatus(
    await stack.kernel(
      path,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': JSON.stringify(crypto.randomUUID()),
        },
        body: JSON.stringify(body),
      },
      persona,
    ),
    status,
    `POST ${path} as ${persona}`,
  )) as Record<string, unknown>;
}

const snak = (content: string, sourced: boolean) => ({
  property: { id: property },
  value: { type: 'value' as const, content },
  qualifiers: [],
  references: sourced
    ? [
        {
          parts: [
            {
              property: { id: 'schema:url' },
              value: { type: 'value', content: 'https://example.org/catalogue-consent-biography' },
            },
          ],
        },
      ]
    : [],
});

async function grant(stack: NativeWebStack, accountId: string, actions: string[]): Promise<void> {
  await write(stack, 'governor', '/v1/grants', {
    resource: { route: 0, id: GLOBAL_CONTEXT },
    subject: { kind: 'account', id: accountId },
    actions,
    valid: '(,)',
  });
}

async function waitForAgent(
  stack: NativeWebStack,
  accountId: string,
): Promise<{ id: string; label: string; type: string }> {
  const derived = accountAgentId(accountId);
  for (let attempt = 0; attempt < 120; attempt++) {
    const listed = await stack.kernel(`/v1/accounts?ids=${encodeURIComponent(accountId)}`, {}, 'editor');
    const accounts = listed.ok
      ? ((await listed.json()) as { accounts?: { id: string; subject?: { id: string; label: string; type: string } }[] })
          .accounts
      : undefined;
    const fromAccount = accounts?.find((account) => account.id === accountId)?.subject;
    if (fromAccount?.id) return fromAccount;
    const direct = await stack.kernel(`/v1/subjects/${derived}`);
    if (direct.status === 200) {
      const body = (await direct.json()) as { subject?: { id: string; labels?: Record<string, string>; type: string } };
      const label = Object.values(body.subject?.labels ?? {}).find((text) => text.trim());
      if (body.subject?.id === derived && label) return { id: derived, label, type: body.subject.type };
    }
    await Bun.sleep(250);
  }
  throw new Error(`Account-linked agent for ${accountId} was not ready`);
}

function consentHref(id: string, label: string, candidate: string, target: string): string {
  const query = new URLSearchParams({ property, candidate, target });
  return `${subjectHref({ id, label }, 'en').href}/statement-consent?${query}`;
}

async function proposeUnsourced(
  stack: NativeWebStack,
  label: string,
  target: string,
  creator: string,
): Promise<CatalogueConsentAddress> {
  const created = await write(stack, creator, '/v1/subjects', {
    type: 'schema:Person',
    labels: { en: label },
  });
  const id = (created.subject as { id: string }).id;
  const proposal = await write(stack, 'alice', `/v1/subjects/${id}/candidates`, { statement: snak(target, false) });
  const candidate = proposal.candidate as string;
  if (typeof candidate !== 'string') throw new Error(`Unsourced proposal for ${label} returned no candidate`);
  return { id, property, candidate, slot: { target }, href: consentHref(id, label, candidate, target) };
}

export async function startCatalogueConsentFixture(): Promise<CatalogueConsentFixture> {
  const stack = await startNativeWebStack();
  let auth: NativeAuthStack | undefined;
  try {
    const [aliceIdentity, bobIdentity] = await Promise.all([
      stack.authPersona('alice'),
      stack.authPersona('bob'),
      stack.authPersona('editor'),
    ]);
    await grant(stack, aliceIdentity.accountId, ['subject:create', 'statement:propose']);
    const agent = await waitForAgent(stack, aliceIdentity.accountId);
    const [own, uncertain, sourcedSubject] = await Promise.all([
      proposeUnsourced(stack, 'River Ink', agent.id, 'editor'),
      proposeUnsourced(stack, 'Ink River Uncertain', agent.id, 'alice'),
      write(stack, 'editor', '/v1/subjects', {
        type: 'schema:Person',
        labels: { en: 'Cited River' },
        statements: { [property]: [snak(agent.id, true)] },
      }),
    ]);
    const sourcedId = (sourcedSubject.subject as { id: string }).id;
    const sourcedRead = (await requireStatus(
      await stack.kernel(`/v1/subjects/${sourcedId}`),
      200,
      `GET /v1/subjects/${sourcedId}`,
    )) as { subject: { statements?: Record<string, { id: string }[]> } };
    const sourcedCandidate = sourcedRead.subject.statements?.[property]?.[0]?.id;
    if (!sourcedCandidate) throw new Error('Sourced pen-name assertion was not admitted');
    auth = await startAuthStack(stack);
    return {
      stack,
      auth,
      alice: { accountId: aliceIdentity.accountId, agent },
      bob: { accountId: bobIdentity.accountId },
      own,
      uncertain,
      sourced: {
        id: sourcedId,
        property,
        candidate: sourcedCandidate,
        slot: { target: agent.id },
        href: consentHref(sourcedId, 'Cited River', sourcedCandidate, agent.id),
      },
      async close() {
        await auth?.stop();
        await stack.stop();
      },
    };
  } catch (error) {
    await auth?.stop().catch(() => {});
    await stack.stop().catch(() => {});
    throw error;
  }
}
