import type { VerifiedPrincipal } from '../access/admission.ts';
import type { MainWorkDependencies } from '../../routes/dependencies.ts';
import { DATASET, GRAPHS, RV, iri, lit } from '../work/activate.ts';
import { WorkReadSession, WorkReadMoved, WorkReadUnavailable, withWorkReadSession } from '../work/read-session.ts';
import { ReadingBoundary } from './boundary.ts';
import { setTimeout as delay } from 'node:timers/promises';
import { fusekiReadBudget, FusekiReadBudgetExceeded, FusekiQueryResponseTooLarge } from '../../infrastructure/fuseki.ts';
import { WORK_READ_COST } from '../work/read-contract.ts';
import { withTelemetrySpan } from '@rezics/observability/runtime';

/** Only read operations may use this retry envelope. Every attempt shares one
 * deadline and graph budget; changed selected inputs eventually report unavailable. */
export async function boundedReadingPositionRead<T>(
  deps: MainWorkDependencies,
  request: Request,
  principal: VerifiedPrincipal | null,
  actingSubject: string | undefined,
  operation: (boundary: ReadingBoundary) => Promise<T>,
): Promise<T> {
  const outer = fusekiReadBudget.getStore();
  const signal = AbortSignal.any([
    request.signal,
    AbortSignal.timeout(WORK_READ_COST.deadlineMs),
    ...(outer ? [outer.signal] : []),
  ]);
  let calls: number = WORK_READ_COST.graphCalls,
    bytes: number = WORK_READ_COST.graphBytes;
  const budget = {
    signal,
    attempt: 1,
    diagnostics: outer?.diagnostics,
    deadline: outer?.deadline,
    get callsLeft() {
      return Math.min(calls, outer?.callsLeft ?? calls);
    },
    set callsLeft(value: number) {
      const used = this.callsLeft - value;
      calls -= used;
      if (outer) outer.callsLeft -= used;
    },
    get bytesLeft() {
      return Math.min(bytes, outer?.bytesLeft ?? bytes);
    },
    set bytesLeft(value: number) {
      const used = this.bytesLeft - value;
      bytes -= used;
      if (outer) outer.bytesLeft -= used;
    },
  };
  try {
    return await fusekiReadBudget.run(budget, async () => {
      for (let attempt = 0; ; attempt++) {
        const callsBefore = budget.callsLeft, bytesBefore = budget.bytesLeft;
        budget.attempt = attempt + 1;
        try {
          signal.throwIfAborted();
          const result = await readingPositionRead(
            deps,
            request,
            principal,
            actingSubject,
            operation,
          );
          signal.throwIfAborted();
          return result;
        } catch (error) {
          if (!(error instanceof WorkReadMoved)) throw error;
          const callsUsed = callsBefore - budget.callsLeft, bytesUsed = bytesBefore - budget.bytesLeft;
          if (attempt + 1 === WORK_READ_COST.attempts
            || budget.callsLeft < callsUsed || budget.bytesLeft < bytesUsed)
            throw new WorkReadUnavailable(
              'A consistent reading-position read could not be obtained within its budget',
              { cause: error },
            );
          await delay(
            Math.min(
              WORK_READ_COST.retryDelayMs * 2 ** attempt,
              WORK_READ_COST.maximumRetryDelayMs,
            ),
            undefined,
            { signal },
          );
        }
      }
    });
  } catch (error) {
    if (error instanceof FusekiReadBudgetExceeded || error instanceof FusekiQueryResponseTooLarge)
      throw new WorkReadUnavailable('Reading-position read budget exceeded', { cause: error });
    if (signal.aborted)
      throw new WorkReadUnavailable('Reading-position read deadline exceeded', { cause: error });
    throw error;
  }
}

/** Add position filtering after the transport's existing authentication and
 * disclosure gates. This helper neither admits a reader nor changes scopes.
 * The owner's selected dependencies and current authority close each attempt. */
export async function readingPositionRead<T>(deps: MainWorkDependencies, request: Request,
  principal: VerifiedPrincipal | null, actingSubject: string | undefined,
  operation: (boundary: ReadingBoundary) => Promise<T>): Promise<T> {
  const position = async () => {
    const rows = (await deps.environment.fuseki.query(`PREFIX rv: <${RV}> SELECT ?epoch ?sequence WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ?epoch ; rv:sequence ?sequence ;
        rv:routingEpoch ${lit(deps.environment.lineage.routingEpoch)} .
        FILTER NOT EXISTS { ${iri(DATASET)} rv:restoreHold true } }
    } LIMIT 2`, 4096)).results?.bindings ?? [];
    if (rows.length !== 1 || rows[0]?.epoch?.value !== deps.environment.lineage.dataEpoch
      || !/^\d+$/.test(rows[0].sequence?.value ?? '')) throw new WorkReadUnavailable('Reading position is unavailable');
    return { dataEpoch: rows[0].epoch.value, sequence: rows[0].sequence.value };
  };
  return withTelemetrySpan('main.work_read.attempt', async () => {
    const start = await position();
    const session = new WorkReadSession(deps, request, { actingSubject }, start, false,
      fusekiReadBudget.getStore()?.attempt ?? 1);
    session.principal = principal;
    return withWorkReadSession(session, async () => {
      const boundary = new ReadingBoundary(session);
      try {
        const result = await operation(boundary);
        await boundary.fence();
        const end = await position();
        if (start.dataEpoch !== end.dataEpoch) throw new WorkReadMoved('Reading position changed during the read');
        await session.fenceDependencies();
        return result;
      } finally { await session.fenceAuthority(); }
    });
  });
}
