import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createKernelClient } from '@rezics/client';
import { bundledRelease } from '@rezics/definitions/bundled';
import { createKernel } from '../../src/http/kernel.ts';
import { ensureAccountAgent } from '../../src/semantic/account-agents.ts';
import { createSemanticDriver } from './outcome-driver.ts';
import {
  readStatementConsent,
  changeStatementConsent,
  consentAfterChange,
  consentAssertion,
} from '../../../../apps/web/src/features/catalogue/statement-consent.ts';

const property = 'rezics:penNameOf';
const key = () => ({ 'idempotency-key': `"${randomUUID()}"` });

test('The real mounted candidate read gives the authorized target account readable subject and target identities before private assertion consent while concealed labels and private assertions remain withheld from other readers', async () => {
  let kernel!: ReturnType<typeof createKernel>;
  const driver = await createSemanticDriver((config) => (kernel = createKernel(config)));
  try {
    const f = driver.fixtures;
    const owner = await f.person('consent_identity_owner');
    const other = await f.person('consent_identity_other');
    const moderator = await f.person('consent_identity_moderator');
    await f.grantAccount(owner, ['subject:create', 'statement:propose']);
    await f.grantAccount(other, ['subject:create', 'statement:propose']);
    await f.grantAccount(moderator, ['moderation:hide', 'statement:propose']);
    const target = (
      await ensureAccountAgent(f.pool, {
        account: owner.accountId,
        kind: 'person',
        name: 'The person behind the name',
        language: 'en',
      })
    ).subject.id;
    const source = await f.send(
      owner,
      'POST',
      '/v1/subjects',
      {
        type: 'schema:Person',
        labels: { en: 'River Ink' },
      },
      key(),
    );
    expect(source.status, JSON.stringify(source.body)).toBe(201);
    const id = (source.body.subject as { id: string }).id;
    const proposal = await f.send(
      owner,
      'POST',
      `/v1/subjects/${id}/candidates`,
      {
        statement: {
          property: { id: property },
          value: { type: 'value', content: target },
          references: [],
          qualifiers: [],
        },
      },
      key(),
    );
    expect(proposal.status, JSON.stringify(proposal.body)).toBe(201);
    const candidate = proposal.body.candidate as string;
    const address = { id, property, candidate, slot: { target } };
    const path = `/v1/subjects/${id}/candidates?property=${encodeURIComponent(property)}&target=${target}`;
    const client = createKernelClient('http://kernel.test', {
      fetch: ((input, init) => kernel.handle(new Request(input, init))) as typeof fetch,
    });
    const authorization = `Bearer ${owner.bearer}`;
    const read = await readStatementConsent(client, authorization, address);
    expect(read.ok, JSON.stringify(read)).toBe(true);
    if (!read.ok) throw new Error('Native consent candidate unavailable');
    expect(read.candidate?.consentIdentity).toEqual({
      subject: { id, labels: { en: 'River Ink' } },
      target: { id: target, labels: { en: 'The person behind the name' } },
    });
    expect(read.field).toEqual(bundledRelease.properties[property]!.labels);
    expect(read.actions).toEqual({
      state: 'available',
      disclosed: false,
      operations: ['statement.disclose', 'statement.retract'],
    });
    const changedTarget = await client.statements({ id: candidate }).consent.get({
      query: { subject: id, property, target: randomUUID() },
      headers: { authorization },
    });
    expect(changedTarget.status).toBe(200);
    expect(changedTarget.data).toEqual({ state: 'refused' });
    expect(consentAssertion(read, address, 'en').identified).toBe(true);
    expect(read.public.state).toBe('absent');
    const privatePage = await f.send(owner, 'GET', path);
    expect(privatePage.headers.get('cache-control')).toBe('private, no-store');
    for (const reader of [null, other]) {
      const page = await f.send(reader, 'GET', path);
      expect(page.status, JSON.stringify(page.body)).toBe(200);
      expect(page.body.candidates).toEqual([]);
      expect(JSON.stringify(page.body)).not.toContain('River Ink');
      expect(JSON.stringify(page.body)).not.toContain('The person behind the name');
      if (!reader) expect(page.headers.get('cache-control')).toBe('no-cache');
    }
    const readableOther = await readStatementConsent(client, `Bearer ${moderator.bearer}`, address);
    expect(readableOther.ok && readableOther.candidate?.id).toBe(candidate);
    expect(readableOther.ok && readableOther.actions).toEqual({ state: 'refused' });
    expect(JSON.stringify(readableOther.ok ? readableOther.actions : readableOther)).not.toContain(target);
    const denied = await changeStatementConsent(client, `Bearer ${other.bearer}`, {
      ...address,
      operation: 'disclose',
      key: randomUUID(),
    });
    expect(denied).toEqual({ ok: false, reason: 'denied' });

    const hidden = await f.send(
      moderator,
      'POST',
      `/v1/subjects/${target}:hide`,
      { reason: 'Withhold target identity.' },
      key(),
    );
    expect(hidden.status, JSON.stringify(hidden.body)).toBe(200);
    const withheld = await readStatementConsent(client, authorization, address);
    expect(withheld.ok, JSON.stringify(withheld)).toBe(true);
    if (!withheld.ok) throw new Error('Source candidate must remain readable');
    expect(withheld.candidate?.consentIdentity?.subject?.labels).toEqual({ en: 'River Ink' });
    expect(withheld.candidate?.consentIdentity?.target).toBeNull();
    expect(JSON.stringify(withheld)).not.toContain('The person behind the name');
    expect(consentAssertion(withheld, address, 'en').identified).toBe(false);

    // Missing display identity does not invent a native retraction restriction.
    const retracted = await changeStatementConsent(client, authorization, {
      ...address,
      operation: 'retract',
      key: randomUUID(),
    });
    expect(retracted.ok, JSON.stringify(retracted)).toBe(true);
    if (!retracted.ok) throw new Error('Native owner retraction failed');
    expect(consentAfterChange(read, retracted).candidate).toBeNull();
    const terminal = await readStatementConsent(client, authorization, address);
    expect(terminal.ok && terminal.terminal).toBe(true);
    expect(terminal.ok && terminal.actions).toEqual({ state: 'terminal' });
    if (terminal.ok) expect(terminal.candidate).toBeNull();
    const terminalPage = await f.send(owner, 'GET', path);
    expect(terminalPage.status).toBe(200);
    expect(JSON.stringify(terminalPage.body)).not.toContain('consentIdentity');
  } finally {
    await driver.close();
  }
});
