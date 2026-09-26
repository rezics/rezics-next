import type { AccountAssertionVerifier } from '../account/verify-assertion.ts';
import { AdmissionDenied, AdmissionExpired, type AccessAdmissionRegistry } from '../access/admission.ts';
import type { ContentCore } from '../../../../content/src/core.ts';
import { IdempotencyConflict, type WorkActivationEnvironment } from '../work/activate.ts';
import { PendingAdmittedWork } from '../work/create-admitted.ts';
import { assertGraphAdmissionOpen } from '../work/restore-lineage.ts';
import { checkedEventObservation, InvalidEventObservationInput, UnsupportedEventTime,
  type EventObservationIntent } from './time.ts';
import { eventObservationDigest, EventObservationUnavailable, InvalidEventObservation, readEventObservationReceipt,
  sealEventObservationAdmission, setEventObservation, StaleEventObservation,
  type EventObservationReceipt } from './observation.ts';

export async function setAdmittedEventObservation(env: WorkActivationEnvironment,
  account: Pick<AccountAssertionVerifier, 'verify'>,
  access: Pick<AccessAdmissionRegistry, 'register' | 'claim' | 'recordGraphOutcome' | 'canReadWork'>,
  content: Pick<ContentCore, 'owningResourceForRevision' | 'readExactBatch'> | undefined,
  request: Request, rawInput: EventObservationIntent & { idempotencyKey: string }): Promise<EventObservationReceipt & { replayed: boolean }> {
  const { idempotencyKey, ...body } = rawInput;
  const input = checkedEventObservation(body);
  await assertGraphAdmissionOpen(env.fuseki, env.lineage);
  const principal = await account.verify(request, ['event:submit']);
  if (input.timeEvidence) {
    if (!content) throw new EventObservationUnavailable('Content evidence owner is unavailable');
    const resource = await content.owningResourceForRevision(input.timeEvidence);
    if (!resource) throw new InvalidEventObservation('Content evidence revision is unavailable');
    if (!await access.canReadWork(principal, input.actingSubject, resource)) {
      throw new AdmissionDenied('event reporter cannot read the Content evidence Work');
    }
    const [exact] = await content.readExactBatch([input.timeEvidence], async ids => new Set(ids));
    if (exact?.status !== 'available' || exact.reference.resourceId !== resource) {
      throw new EventObservationUnavailable('exact Content evidence revision is unavailable');
    }
  }
  const digest = eventObservationDigest(input);
  const registered = await access.register({ principal, actingSubject: input.actingSubject,
    scope: `event:observe:${input.event}`, action: 'event.observation.set',
    idempotencyKey, requestDigest: digest });
  try {
    let admission = registered;
    if (registered.state !== 'sealed' && registered.dispatchEligible) {
      try { admission = await access.claim(registered.id, digest); }
      catch (error) {
        if (!(error instanceof AdmissionDenied || error instanceof AdmissionExpired)) throw error;
      }
    }
    if (admission.state !== 'sealed') {
      if (!admission.dispatchEligible || admission.state === 'registered') {
        await sealEventObservationAdmission(env, admission);
      } else {
        try { await setEventObservation(env, admission, input); }
        catch (error) {
          if (error instanceof IdempotencyConflict) throw error;
          if (error instanceof EventObservationUnavailable) await sealEventObservationAdmission(env, admission);
        }
      }
    }
    const terminal = await readEventObservationReceipt(env, registered.id);
    if (!terminal) throw new PendingAdmittedWork(registered.id);
    await access.recordGraphOutcome(registered.id, terminal);
    if (terminal.outcome === 'cancelled' && terminal.reason === 'stale-head') {
      throw new StaleEventObservation('event time head changed');
    }
    if (terminal.outcome === 'cancelled') throw new EventObservationUnavailable('event observation was cancelled');
    return { ...terminal, replayed: registered.replayed };
  } catch (error) {
    if (error instanceof IdempotencyConflict || error instanceof StaleEventObservation
      || error instanceof EventObservationUnavailable || error instanceof InvalidEventObservation
      || error instanceof InvalidEventObservationInput || error instanceof UnsupportedEventTime) throw error;
    if (error instanceof PendingAdmittedWork) throw error;
    throw new PendingAdmittedWork(registered.id);
  }
}
