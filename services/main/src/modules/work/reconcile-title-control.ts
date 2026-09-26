import type { Pool } from 'pg';
import type { RegisteredAdmission } from '../access/admission.ts';
import { signTitleAdmission } from '../access/title-admission.ts';
import { hash, type WorkActivationEnvironment } from './activate.ts';
import { readWorkComponentState, readWorkPayloadForRevision } from './history.ts';
import { relayRetainedEventAt, type MainCloudEvent, type RelayCoverage } from '../outbox/relay.ts';
import { reconciledCursor, RetainedEffectConflict } from './reconcile-restored.ts';
import { readTitleControlReceipt, titleControlCommand, titleControlDigest, titleControlReceiptIri,
  TitleControlUnavailable, TITLE_PROFILE, type TitleControlIntent } from './title-control.ts';

/** Reconstruct the exact title/control effect while both owners remain held.
 * Source records are restored first. Current withdrawal is never undone by replay. */
export async function reconcileRetainedTitleControl(env: WorkActivationEnvironment, accessPool: Pool,
  relayPool: Pool, coverage: RelayCoverage, sequence: string) {
  const retained = await relayRetainedEventAt(relayPool, coverage, sequence);
  const envelope = retained.envelope as MainCloudEvent;
  const receipt = envelope.data?.receipt;
  const effect = receipt?.titleControl;
  if (envelope.type !== 'com.rezics.work.title-control.v1' || envelope.id !== retained.eventId
    || envelope.specversion !== '1.0' || envelope.source !== 'https://rezics.com/services/main'
    || envelope.datacontenttype !== 'application/json' || envelope.data.ordinal !== 0
    || envelope.data.sourcePosition.dataEpoch !== coverage.dataEpoch || envelope.data.sourcePosition.sequence !== sequence
    || envelope.data.sourcePosition.datasetId !== 'product' || !effect || effect.outcome !== 'succeeded'
    || !effect.work || !effect.control || !effect.revision || !effect.operation || !effect.intent
    || !effect.controlManifest || !effect.workManifest || effect.requestDigest !== titleControlDigest(effect.intent)
    || effect.receipt !== titleControlReceiptIri(effect.admissionId) || effect.receipt !== receipt.id
    || effect.dataEpoch !== coverage.dataEpoch || effect.sequence !== sequence
    || effect.requestDigest !== receipt.requestDigest || effect.action !== receipt.action
    || effect.admissionId !== receipt.admissionId || effect.authorityEpoch !== receipt.authorityEpoch || effect.scope !== receipt.scope
    || retained.eventId !== `urn:rezics:event:${hash(effect.receipt)}`
    || envelope.data.batchId !== `urn:rezics:outbox:${hash(effect.receipt)}`
    || retained.batch.batchId !== envelope.data.batchId || retained.batch.eventCount !== 1
    || retained.batch.routingEpoch !== envelope.data.routingEpoch) throw new RetainedEffectConflict('retained title effect differs');
  const state = await readWorkComponentState(env, effect.controlManifest, effect.work, TITLE_PROFILE);
  if (state.control !== effect.control || state.revision !== effect.revision || state.operation !== effect.operation
    || titleControlDigest(state.intent as TitleControlIntent) !== titleControlDigest(effect.intent)) {
    throw new RetainedEffectConflict('immutable title envelope differs');
  }
  const content = await readWorkPayloadForRevision(env, effect.workManifest, effect.work);
  if (content.title !== effect.intent.title) throw new RetainedEffectConflict('immutable title content differs');
  const client = await accessPool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    const fence = (await client.query<{ open: boolean }>('SELECT open FROM access.recovery_fence WHERE id = true FOR SHARE')).rows[0];
    if (fence?.open !== false) throw new RetainedEffectConflict('Access recovery fence is not held');
    const row = (await client.query<{ action: string; scope_id: string; request_digest: string; authority_epoch: string;
      state: string; graph_receipt: string; graph_outcome: string; graph_data_epoch: string; graph_sequence: string;
      principal_id: string; acting_subject: string; idempotency_key: string }>('SELECT * FROM access.admission WHERE id = $1', [effect.admissionId])).rows[0];
    if (!row || row.state !== 'sealed' || row.action !== effect.action || row.scope_id !== effect.scope
      || row.request_digest !== effect.requestDigest || row.authority_epoch !== effect.authorityEpoch
      || row.graph_receipt !== effect.receipt || row.graph_outcome !== effect.outcome
      || row.graph_data_epoch !== effect.dataEpoch || row.graph_sequence !== effect.sequence) {
      throw new RetainedEffectConflict('Access does not prove retained title outcome');
    }
    const prior = await readTitleControlReceipt(env, effect.admissionId);
    if (!prior) {
      const admission: RegisteredAdmission = { id: effect.admissionId, principalId: row.principal_id,
        actingSubject: row.acting_subject, action: row.action, scope: row.scope_id, requestDigest: row.request_digest,
        authorityEpoch: row.authority_epoch, idempotencyKey: row.idempotency_key, state: 'sealed',
        expiresAt: new Date(Date.now() + 10_000).toISOString(), dispatchEligible: false, replayed: true };
      let command;
      try { command = await titleControlCommand(env, admission, effect.intent, effect); }
      catch (error) {
        if (error instanceof TitleControlUnavailable) throw new RetainedEffectConflict(error.message);
        throw error;
      }
      command.titleAdmission = signTitleAdmission(admission, command, admission.expiresAt, env.titleAdmissionKey);
      const result = await env.fuseki.commandWithReceipt(command);
      if (result.status !== 'committed') throw new RetainedEffectConflict(`retained title command ${result.status}`);
    }
    const actual = await readTitleControlReceipt(env, effect.admissionId);
    const cursor = await reconciledCursor(env, `urn:rezics:restore:${env.lineage.dataEpoch}`);
    if (!actual || Object.keys(actual).length !== Object.keys(effect).length
      || Object.entries(effect).some(([key, value]) => JSON.stringify(actual[key as keyof typeof actual]) !== JSON.stringify(value))
      || BigInt(cursor ?? '-1') < BigInt(sequence)) {
      throw new RetainedEffectConflict('title recovery receipt or frontier differs');
    }
    await client.query('COMMIT');
    return { receipt: effect.receipt, revision: effect.revision, control: effect.control, replayed: !!prior };
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
