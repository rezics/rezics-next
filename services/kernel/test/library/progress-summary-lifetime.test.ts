import { expect, spyOn, test } from 'bun:test';
import { createKernel } from '../../src/http/kernel.ts';
import { Admission } from '../../src/http/admission.ts';
import { createPool } from '../../src/database/pool.ts';
import { newId } from '../../src/route/route.ts';
import type { Access } from '../../src/request/access.ts';
import * as sessionCommands from '../../src/library/sessions.ts';
import * as discoveryPresentation from '../../src/library/progress-discovery-presentation.ts';
import * as subjectSummaries from '../../src/semantic/current-subject-summaries.ts';
import { testReceiptKeys } from '../support/receipt-keys.ts';

test('progress discovery retains request Access and deadline after the session command completes', async () => {
  const tokens = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(19)]]) };
  const actor = {
    kind: 'account' as const,
    accountId: newId(0x2600),
    clientId: 'web',
    scopes: ['progress_session:list'],
    requestedBy: null,
    authnEpoch: 1,
  };
  const access: Access = { authenticate: async () => actor, authorize: async () => true };
  const admission = new Admission();
  const job = { deadline: Date.now() + 30_000 };
  const pool = createPool('postgres://kernel.invalid/progress-summary-lifetime');
  let listed = false;
  const original = sessionCommands.createSessionCommands;
  const commands = spyOn(sessionCommands, 'createSessionCommands').mockImplementation((dependencies) => ({
    ...original(dependencies),
    async listOwnerSessions() {
      await Promise.resolve();
      listed = true;
      return { sessions: [], generation: 'original-generation', partitionEpoch: null, next: null };
    },
    async verifyOwnerDiscoveryCurrent() {},
  }));
  const summaries = spyOn(subjectSummaries, 'readCurrentSubjectSummaries').mockImplementation(
    async (dependencies, ids) => {
      expect(listed).toBe(true);
      expect(admission.running.normal).toBe(1);
      expect(dependencies.access).toBe(access);
      expect(dependencies.actor).toBe(actor);
      expect(dependencies.deadline).toBe(job.deadline);
      expect(ids).toEqual([]);
      return { summaries: new Map(), async verify() {} };
    },
  );
  const presentation = spyOn(discoveryPresentation, 'presentProgressDiscovery').mockResolvedValue(new Map());
  try {
    const kernel = createKernel({
      pool,
      routeKey: new Uint8Array(32).fill(23),
      tokens,
      receiptKeys: testReceiptKeys(),
      access,
    });
    const route = kernel.routes.find(
      (route) => route.method === 'GET' && route.path === '/v1/progressSessionDiscovery',
    )!;
    const handle = route.handler as (context: Record<string, unknown>) => Promise<unknown>;
    expect(
      await handle({
        actor,
        admission,
        job,
        query: {},
        set: { headers: {} },
        request: new Request('https://kernel.test/v1/progressSessionDiscovery'),
      }),
    ).toEqual({ viewerState: 'signed_in', progressSessions: [], next: null });
    expect(summaries).toHaveBeenCalledTimes(1);
    expect(admission.running.normal).toBe(0);
  } finally {
    commands.mockRestore();
    summaries.mockRestore();
    presentation.mockRestore();
    await pool.end();
  }
});
