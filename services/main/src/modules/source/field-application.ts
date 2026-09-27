import type { Pool } from 'pg';
import type { AccountAssertionVerifier } from '../account/verify-assertion.ts';
import type { AccessAdmissionRegistry, VerifiedPrincipal } from '../access/admission.ts';
import type { WorkActivationEnvironment } from '../work/activate.ts';
import { hash } from '../work/activate.ts';
import { RightsDenied, type RightsStore } from '../rights/store.ts';
import type { OpenLibraryConversionStore } from './open-library-conversion.ts';
import type { SourceNativeWorkAdoptionStore } from './native-work-adoption.ts';
import { changeNativeFieldControl, nativeFieldDigest, readNativeFieldReceipt,
  NativeFieldConflict, NativeFieldUnavailable, type NativeFieldControlIntent,
  type NativeFieldControlReceipt } from './field-control-native.ts';
import { SourceFieldWithdrawalStore, type FieldSupportResult } from './withdrawal.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KEY = /^[A-Za-z0-9:_./-]{1,128}$/;
const short = (iri: string) => iri.split('/').at(-1)!;
const SLOT = 'work-editorial-field-v1#synopsis';

interface StepRow { id: string; support_id: string; request_digest: string;
  native_idempotency_key: string; }
interface OutcomeRow { outcome: 'applied' | 'not-applied'; graph_receipt: string;
  admission_id: string; native_revision: string | null; }

/** Source intent precedes graph dispatch; a lost response resumes from that exact intent. */
export class SourceFieldApplicationStore {
  constructor(private readonly pool: Pool,
    private readonly env: WorkActivationEnvironment,
    private readonly account: Pick<AccountAssertionVerifier, 'verify'>,
    private readonly access: Pick<AccessAdmissionRegistry,
      'withWorkEditAuthority' | 'register' | 'claim' | 'recordGraphOutcome' | 'issueTitleAdmission'>,
    private readonly conversions: OpenLibraryConversionStore,
    private readonly adoptions: SourceNativeWorkAdoptionStore,
    private readonly withdrawals: SourceFieldWithdrawalStore,
    private readonly rights: Pick<RightsStore, 'sourceSynopsisRestricted'>) {}

  async apply(principal: VerifiedPrincipal, principalId: string, request: Request,
    key: string, intent: NativeFieldControlIntent & { actingSubject: string }):
    Promise<{ receipt: NativeFieldControlReceipt; support: FieldSupportResult; replayed: boolean }> {
    if (!UUID.test(principalId) || !KEY.test(key) || intent.origin !== 'source' || !intent.source) {
      throw new NativeFieldConflict('invalid source field application');
    }
    const source = intent.source;
    const evidence = await this.conversions.verifiedRead(principalId, short(source.conversion));
    const binding = await this.adoptions.readSupport(principalId, intent.work);
    if (!evidence || !binding) throw new NativeFieldUnavailable('Source evidence is unavailable');
    if (binding.state !== 'recorded' || binding.sourceRecord !== source.record
      || evidence.observation.record !== source.record
      || evidence.observation.observation !== source.observation
      || evidence.conversion.conversion !== source.conversion
      || evidence.conversion.projection.description !== intent.value
      || evidence.conversion.mappingRevision !== source.mapping) {
      throw new NativeFieldConflict('Source description or binding changed');
    }
    if (await this.rights.sourceSynopsisRestricted(source.record,
      source.observation, ['source_apply'])) {
      throw new RightsDenied('Source synopsis is restricted from native application');
    }
    const valueDigest = hash(JSON.stringify(intent.value));
    const requestDigest = hash(JSON.stringify([principalId, nativeFieldDigest(intent),
      source.record, source.conversion, valueDigest]));
    const client = await this.pool.connect();
    let step: StepRow;
    let inserted = false;
    try {
      step = await this.access.withWorkEditAuthority(principal, intent.actingSubject,
        intent.work, async proof => {
          if (proof.principalId !== principalId) throw new NativeFieldConflict('Source principal changed');
          try {
            await client.query('BEGIN');
            await client.query("SET LOCAL lock_timeout = '2s'");
            await client.query("SET LOCAL statement_timeout = '5s'");
            const prior = (await client.query<StepRow>(`SELECT id,support_id,request_digest,native_idempotency_key
              FROM source.field_support_step WHERE principal_id = $1 AND idempotency_key = $2`,
            [principalId, key])).rows[0];
            if (prior) {
              if (prior.request_digest !== requestDigest) throw new NativeFieldConflict('Source field key changed');
              await client.query('COMMIT');
              return prior;
            }
            const supportId = Bun.randomUUIDv7();
            await client.query(`INSERT INTO source.field_support
              (id,principal_id,target,slot,occurrence,context,record_id)
              VALUES ($1,$2,$3,$4,NULL,'global',$5) ON CONFLICT DO NOTHING`,
            [supportId, principalId, intent.work, SLOT, short(source.record)]);
            const support = (await client.query<{ id: string; step_count: number;
              pending_step_id: string | null }>(`SELECT s.id,h.step_count,h.pending_step_id
              FROM source.field_support s JOIN source.field_support_head h ON h.support_id = s.id
              WHERE s.principal_id = $1 AND s.target = $2 AND s.slot = $3
                AND s.occurrence IS NULL AND s.context = 'global' AND s.record_id = $4 FOR UPDATE OF h`,
            [principalId, intent.work, SLOT, short(source.record)])).rows[0];
            if (!support || support.pending_step_id) throw new NativeFieldConflict('Source support needs reconciliation');
            const raced = (await client.query<StepRow>(`SELECT id,support_id,request_digest,native_idempotency_key
              FROM source.field_support_step WHERE principal_id = $1 AND idempotency_key = $2`,
            [principalId, key])).rows[0];
            if (raced) {
              if (raced.request_digest !== requestDigest || raced.support_id !== support.id) {
                throw new NativeFieldConflict('Source field key changed');
              }
              await client.query('COMMIT');
              return raced;
            }
            const stepId = Bun.randomUUIDv7(), nativeKey = `source-field-${stepId}`;
            const controlIntent = { contentHead: intent.expectedWorkHead,
              fieldContentHead: intent.basis.contentHead,
              controlHead: intent.basis.head, controlEpoch: intent.basis.epoch,
              protectionHead: intent.basis.protection };
            await client.query(`INSERT INTO source.field_support_step
              (id,support_id,ordinal,principal_id,action,conversion_id,mapping_revision,
               grain,source_field,source_occurrence,value_digest,expected_head,control_intent,
               acting_subject,authority_proof,native_idempotency_key,idempotency_key,request_digest)
              VALUES ($1,$2,$3,$4,'apply',$5,$6,'work','description',NULL,$7,$8,$9,$10,$11,$12,$13,$14)`,
            [stepId, support.id, support.step_count + 1, principalId, short(source.conversion),
              source.mapping, valueDigest, intent.expectedWorkHead,
              JSON.stringify(controlIntent), intent.actingSubject, JSON.stringify(proof),
              nativeKey, key, requestDigest]);
            await client.query('COMMIT');
            inserted = true;
            return { id: stepId, support_id: support.id, request_digest: requestDigest,
              native_idempotency_key: nativeKey };
          } catch (error) {
            await client.query('ROLLBACK').catch(() => undefined);
            if (['23505', '23514', '55P03', '57014'].includes((error as { code?: string }).code ?? '')) {
              throw new NativeFieldConflict('Source support changed concurrently');
            }
            throw error;
          }
        });
    } finally { client.release(); }
    let terminal: NativeFieldControlReceipt;
    try {
      terminal = await changeNativeFieldControl(this.env, this.account, this.access, request,
        { ...intent, idempotencyKey: step.native_idempotency_key });
    } catch (error) {
      if (!(error instanceof NativeFieldConflict)) throw error;
      const admission = await this.access.register({ principal, actingSubject: intent.actingSubject,
        scope: `work:edit:${intent.work}`, action: 'work.edit',
        idempotencyKey: step.native_idempotency_key, requestDigest: nativeFieldDigest(intent) });
      const cancelled = await readNativeFieldReceipt(this.env, admission.id);
      if (!cancelled || cancelled.outcome !== 'cancelled') throw error;
      terminal = cancelled;
    }
    const expectedOutcome = terminal.outcome === 'succeeded' ? 'applied' : 'not-applied';
    const readOutcome = async () => (await this.pool.query<OutcomeRow>(`SELECT outcome,graph_receipt,admission_id,
      native_revision FROM source.field_support_outcome WHERE step_id = $1`, [step.id])).rows[0];
    let outcome = await readOutcome();
    if (!outcome) {
      try {
        await this.pool.query(`INSERT INTO source.field_support_outcome
          (step_id,outcome,native_revision,graph_receipt,admission_id,data_epoch,sequence,
           head_guarantee,receipt)
          VALUES ($1,$2,$3,$4,$5,$6,$7,'transaction-guarded',$8)`,
        [step.id, expectedOutcome, terminal.content ?? null, terminal.receipt,
          terminal.admissionId, terminal.dataEpoch, terminal.sequence,
          JSON.stringify({ profile: 'source-field-native-certificate-v1',
            valueDigest, field: 'synopsis', control: terminal.control ?? null })]);
      } catch (error) {
        if (!['23505', '23514'].includes((error as { code?: string }).code ?? '')) throw error;
      }
      outcome = await readOutcome();
    }
    if (!outcome || outcome.outcome !== expectedOutcome || outcome.graph_receipt !== terminal.receipt
      || outcome.admission_id !== terminal.admissionId
      || outcome.native_revision !== (terminal.content ?? null)) {
      throw new NativeFieldUnavailable('Source field certificate differs from native receipt');
    }
    if (terminal.outcome === 'cancelled') throw new NativeFieldConflict('Source field control changed');
    const support = await this.withdrawals.read(principalId, step.support_id);
    if (!support || support.nativeRevision !== terminal.content) {
      throw new NativeFieldUnavailable('Source field support is unavailable');
    }
    return { receipt: terminal, support, replayed: !inserted };
  }
}
