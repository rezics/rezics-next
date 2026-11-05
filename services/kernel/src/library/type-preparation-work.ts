import { DBOS } from '@dbos-inc/dbos-sdk';
import { routeOf } from '../route/route.ts';
import { GrantDeniedError } from '../access/grant-commands.ts';
import { withConnection } from '../database/pool.ts';
import type { WorkContext } from '../work/registry.ts';
import { COMMAND_STEP_RETRIES } from '../work/retries.ts';
import { createLibraryCommandRunner } from './command-support.ts';
import {
  createShelfTypeKeys,
  createTypePreparationContinuation,
  shelfTypeDigestFromEnvironment,
} from './shelf-type-keys.ts';
import { observePreparationIdentity } from './preparation-source.ts';
import type { TypePreparationEvidence, TypePreparationIntent } from './type-preparation-contract.ts';
import recover from './type-preparation-recover.sql';
import enqueued from './type-preparation-enqueued.sql';

const WORKFLOW = 'library.typePreparationPage';
const SWEEP = 'library.typePreparationRecovery';
const NIL = '00000000-0000-0000-0000-000000000000';
type After = readonly [number, string, string];

/** Existing WorkModule composition only. Jobs contain native metadata locators, never source Type text. */
export async function registerTypePreparationWork(context: WorkContext) {
  const { pool, client, clock } = context;
  const shelfTypeDigest = shelfTypeDigestFromEnvironment(context.env);
  const ports = createTypePreparationContinuation({
    pool,
    clock,
    keys: createShelfTypeKeys(shelfTypeDigest === undefined ? undefined : { digest: shelfTypeDigest }),
    observeIdentity: (id) => observePreparationIdentity({ pool }, id),
  });
  const runner = createLibraryCommandRunner({ pool, clock });
  async function enqueue(intent: TypePreparationIntent) {
    const id = intent.evidence.preparationId;
    await client.enqueue(
      {
        workflowName: WORKFLOW,
        queueName: 'maintenance',
        workflowID: `library.typePreparation:${id}:${intent.chunk}:${intent.offset}`,
        workflowIDReusePolicy: 'return-existing',
      },
      intent,
    );
    const accountId = intent.evidence.binding.accountId;
    const route = routeOf(accountId);
    if (route === null) throw new TypeError('Invalid preparation enqueue owner');
    // ACK only after durable enqueue. A progressed successor can never be cleared by this ACK.
    try {
      await runner.trustedAccount(
        accountId,
        {
          kind: 'library.type-preparation.enqueued',
          stepKey: `enqueued:${id}:${intent.chunk}:${intent.offset}`,
          input: { preparationId: id, chunk: intent.chunk, offset: intent.offset },
        },
        async (tx) => {
          await enqueued.run(tx, {
            route,
            account_id: accountId,
            preparation_id: id,
            chunk: String(intent.chunk),
            offset: String(intent.offset),
          });
          return {
            value: true,
            events: [
              {
                type: 'com.rezics.library.type-preparation.changed.v1',
                subject: accountId,
                data: { preparationId: id },
              },
            ],
          };
        },
      );
    } catch (error) {
      // A terminal owner cannot publish; its existing erasure inventory owns the remaining intent row.
      if (!(error instanceof GrantDeniedError)) throw error;
    }
  }
  const page = DBOS.registerStep(async (intent: TypePreparationIntent) => ports.continue(intent), {
    name: 'library.typePreparationNativePage',
    ...COMMAND_STEP_RETRIES,
  });
  const dispatch = DBOS.registerStep(enqueue, { name: 'library.typePreparationDispatch', ...COMMAND_STEP_RETRIES });
  DBOS.registerWorkflow(
    async (intent: TypePreparationIntent) => {
      const result = await page(intent);
      if (result.status === 'advanced') await dispatch(result.next);
    },
    { name: WORKFLOW },
  );
  const recovery = DBOS.registerStep(
    async (after: After) => {
      const rows = await withConnection(pool, (connection) =>
        recover.run(connection, { after_route: after[0], after_account: after[1], after_preparation: after[2] }),
      );
      for (const row of rows) {
        const evidence: TypePreparationEvidence = {
          preparationId: row.preparationId,
          binding: row.binding as TypePreparationEvidence['binding'],
          origin: row.origin as TypePreparationEvidence['origin'],
          sourceIdentity: row.sourceIdentity as TypePreparationEvidence['sourceIdentity'],
          originIdentity: row.originIdentity as TypePreparationEvidence['originIdentity'],
          reservationId: row.reservationId,
        };
        const chunk = Number(row.chunk),
          offset = Number(row.offset);
        if (!Number.isSafeInteger(chunk) || !Number.isSafeInteger(offset))
          throw new Error('Invalid preparation recovery checkpoint');
        await enqueue({ evidence, chunk, offset });
      }
      const last = rows.at(-1);
      return rows.length === 100 && last ? ([last.route, last.accountId, last.preparationId] as const) : null;
    },
    { name: 'library.typePreparationRecoverPage', ...COMMAND_STEP_RETRIES },
  );
  const continueRecovery = DBOS.registerStep(
    async (after: After, root: string) => {
      await client.enqueue(
        {
          workflowName: `${SWEEP}Segment`,
          queueName: 'maintenance',
          workflowID: `${root}:${after.join(':')}`,
          workflowIDReusePolicy: 'return-existing',
        },
        after,
        root,
      );
    },
    { name: 'library.typePreparationRecoverContinue', ...COMMAND_STEP_RETRIES },
  );
  const segment = async (after: After, root: string) => {
    const next = await recovery(after);
    if (next) await continueRecovery(next, root);
  };
  DBOS.registerWorkflow(segment, { name: `${SWEEP}Segment` });
  DBOS.registerWorkflow(() => segment([-1, NIL, NIL], DBOS.workflowID!), { name: SWEEP });
  await client.applySchedules([
    {
      scheduleName: 'library.typePreparation.every-minute',
      workflowName: SWEEP,
      schedule: '* * * * *',
      cronTimezone: 'UTC',
      automaticBackfill: false,
      queueName: 'maintenance',
    },
  ]);
}
