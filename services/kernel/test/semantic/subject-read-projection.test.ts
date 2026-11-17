import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { Subject } from '../../../../specs/semantic-driver.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { ensureAccountAgent } from '../../src/semantic/account-agents.ts';
import { createSemanticDriver } from './outcome-driver.ts';

test('ordinary public Subject reads prepare until the disclosed or retracted relation projection catches up', async () => {
  const driver = await createSemanticDriver(({ requestDeadlineMs: _fixtureDeadline, ...config }) =>
    createKernel(config),
  );
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (request) => driver.fixtures.handle(request),
  });
  const key = () => ({ 'idempotency-key': JSON.stringify(randomUUID()) });
  const read = async (id: string) => {
    const response = await fetch(new URL('/v1/subjects/' + id, server.url), {
      headers: { 'accept-language': 'en' },
    });
    return { response, body: (await response.json()) as { subject?: Subject } };
  };
  const candidates = (body: { subject?: Subject }) =>
    (body.subject!.statements['rezics:penNameOf'] ?? []).map((statement: { id: string }) => statement.id);
  const preparing = (result: Awaited<ReturnType<typeof read>>) => {
    expect(result.response.status, JSON.stringify(result.body)).toBe(503);
    expect(result.body).toMatchObject({ code: 'semantic_not_ready', retryable: true, effect_status: 'not_applicable' });
    expect(result.response.headers.get('retry-after')).toBe('1');
    expect(result.response.headers.get('cache-control')).toBe('private, no-store');
    expect(result.body).not.toHaveProperty('subject');
  };
  try {
    const owner = await driver.fixtures.person('editor');
    const target = await ensureAccountAgent(driver.fixtures.pool, {
      account: owner,
      kind: 'person',
      name: 'Consent owner',
    });
    const created = await driver.request(
      'editor',
      'POST',
      '/v1/subjects',
      {
        type: 'schema:Person',
        labels: { en: 'Consent holder' },
      },
      key(),
    );
    expect(created.status).toBe(201);
    const id = (created.body.subject as { id: string }).id;
    const proposed = await driver.request(
      'editor',
      'POST',
      `/v1/subjects/${id}/candidates`,
      {
        statement: {
          property: { id: 'rezics:penNameOf' },
          value: { type: 'value', content: target.subject.id },
          qualifiers: [],
          references: [],
        },
      },
      key(),
    );
    expect(proposed.status).toBe(201);
    const candidate = proposed.body.candidate as string;
    const before = await read(id);
    expect(before.response.status).toBe(200);
    expect(candidates(before.body)).toEqual([]);

    await driver.projection('paused');
    const disclosed = await driver.request('editor', 'POST', `/v1/statements/${candidate}/disclose`, undefined, key());
    expect(disclosed.status).toBe(200);
    expect(disclosed.body).toEqual({ candidate, disclosed: true });
    preparing(await read(id));
    expect((await read('00000000-0000-4000-8000-000000000000')).response.status).toBe(404);
    await driver.projection('running');
    const visible = await read(id);
    expect(visible.response.status).toBe(200);
    expect(candidates(visible.body)).toEqual([candidate]);

    await driver.projection('paused');
    const retracted = await driver.request('editor', 'POST', `/v1/statements/${candidate}/retract`, undefined, key());
    expect(retracted.status).toBe(200);
    expect(retracted.body).toEqual({ candidate, retracted: true });
    preparing(await read(id));
    await driver.projection('running');
    const hidden = await read(id);
    expect(hidden.response.status).toBe(200);
    expect(candidates(hidden.body)).toEqual([]);
    expect(
      (await driver.request('editor', 'POST', `/v1/statements/${candidate}/disclose`, undefined, key())).status,
    ).toBe(409);
  } finally {
    await server.stop(true);
    await driver.close();
  }
}, 120_000);
