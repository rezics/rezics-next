import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { Capture } from '../support/growth.ts';
import { capture, catalogStatementBound } from '../support/growth.ts';
import { identitySupport } from './identity-fixture.ts';
import { openApiRuntime } from './api-runtime.ts';

const options = { batchRecords: 8, maxFields: 64, maxRecordBytes: 65536 } as const;
// The importer keeps at most this many public HTTP requests in flight.
const concurrency = 8;

/** The catalogue freshness probes of a capture, by the shared classifier that bounds them. */
function probes(raw: Capture): string[] {
  const { catalogTexts } = catalogStatementBound(raw);
  return raw.statements.filter((statement) => catalogTexts.has(statement));
}

test('concurrent importer fence reads use warmed native query objects', async () => {
  const runtime = await openApiRuntime(options);
  try {
    const auth = identitySupport(runtime.identity).authDatabase;
    const tuple = () => ({ source: 'bangumi', externalId: String(2_000_000 + Math.floor(Math.random() * 1e6)) });
    const check = (bearer: string | undefined, { source, externalId } = tuple()) =>
      runtime.replay(
        new Request(
          `https://kernel.import.test/v1/sourceFences:check?${new URLSearchParams({ source, externalId, fieldGroup: 'facts' })}`,
          { headers: bearer ? { authorization: `Bearer ${bearer}` } : {} },
        ),
      );

    // Setup is complete; the measured requests are the first public fence reads of the tuples they name.
    const measured = await capture(runtime.database, () =>
      capture(auth, () =>
        Promise.all(
          Array.from({ length: concurrency }, async () => {
            const response = await check(runtime.bulk.bearer);
            return { status: response.status, body: await response.json() };
          }),
        ),
      ),
    );

    for (const response of measured.value.value) {
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ fenced: false, securityRevision: null });
    }
    // No query object may probe the catalogue again: each was warmed to completion by setup.
    expect(probes(measured.capture)).toEqual([]);
    expect(probes(measured.value.capture)).toEqual([]);
    expect(measured.capture.statements.length).toBeGreaterThan(0);

    // Grants still hold: the importer's reduced scopes are not widened by warming.
    expect((await check(runtime.identity.ordinary.bearer)).status).toBe(403);
    expect((await check(undefined)).status).toBe(401);
    const unknown = { source: `warm-${randomUUID().slice(0, 8)}`, externalId: '1' };
    expect((await (await check(runtime.bulk.bearer, unknown)).json()).fenced).toBe(false);
  } finally {
    await runtime.close();
  }
}, 600_000);
