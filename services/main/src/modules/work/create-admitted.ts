import type { AccountAssertionVerifier } from '../account/verify-assertion.ts';
import type { AccessAdmissionRegistry } from '../access/admission.ts';
import { AdmissionDenied, AdmissionExpired, type RegisteredAdmission } from '../access/admission.ts';
import { createHash } from 'node:crypto';
import {
  activateMetadataWork, AuthorAgentUnavailable, CancelledActivation, IdempotencyConflict, metadataWorkRequestDigest,
  PendingActivation, normalizeWorkSemanticTypes, type WorkActivationEnvironment, type WorkActivationReceipt,
} from './activate.ts';
import { readWorkTerminalReceipt } from './receipt.ts';
import { sealMetadataWorkAdmission } from './seal.ts';
import { assertGraphAdmissionOpen } from './restore-lineage.ts';
import type { CatalogueIntakeStore } from '../catalogue-intake/store.ts';

export interface AdmittedMetadataWorkInput {
  actingSubject: string;
  /** Set only by the direct authoring route; source adoption has its own authors. */
  authorAgent?: string;
  authorityPath?: 'represented-agent' | 'direct-principal';
  idempotencyKey: string;
  title: string;
  language: string;
  localizedTitle?: { value: string; language: string };
  description?: { value: string; language: string };
  semanticTypes?: readonly string[];
  catalogue?: import('./activate.ts').CreateMetadataWorkIntent['catalogue'];
}

type PendingPhase = 'work-activation' | 'work-edit' | 'work-address' | 'work-address-rename'
  | 'work-address-disposition' | 'translation-link'
  | 'work-derivation' | 'fixed-release' | 'contribution-draft' | 'contribution-edit'
  | 'contribution-publication' | 'publication-selection' | 'space-create'
  | 'realm-adoption' | 'realm-rejection' | 'classification-context'
  | 'classification-proposition' | 'classification-decision' | 'rating-context'
  | 'rating-policy' | 'semantic-change-bulk'
  | 'rating-observation';

export class PendingAdmittedWork extends PendingActivation {
  readonly operationId: string;
  readonly phase: PendingPhase;

  constructor(admissionId: string, phase: PendingPhase = 'work-activation') {
    super('Work outcome requires reconciliation');
    this.operationId = `urn:rezics:operation:${createHash('sha256').update(admissionId).digest('hex')}`;
    this.phase = phase;
  }
}

async function reconcileExisting(
  env: WorkActivationEnvironment,
  access: Pick<AccessAdmissionRegistry, 'recordGraphOutcome'>,
  registered: RegisteredAdmission,
  digest: string,
): Promise<WorkActivationReceipt> {
  const terminal = registered.state === 'sealed'
    ? await readWorkTerminalReceipt(env.fuseki, registered.id)
    : await sealMetadataWorkAdmission(env, registered);
  if (!terminal) throw new PendingActivation('sealed Access admission has no graph receipt');
  if (terminal.requestDigest !== digest || terminal.admissionId !== registered.id
    || terminal.authorityEpoch !== registered.authorityEpoch || terminal.scope !== registered.scope) {
    throw new IdempotencyConflict('Access admission differs from graph receipt');
  }
  await access.recordGraphOutcome(registered.id, terminal);
  if (terminal.outcome === 'cancelled') throw new CancelledActivation('Work admission was cancelled');
  return { work: terminal.work!, mainVersion: terminal.mainVersion!,
    workRevision: terminal.workRevision!, mainRevision: terminal.mainRevision!, receipt: terminal.receipt,
    admissionId: registered.id, dataEpoch: terminal.dataEpoch, sequence: terminal.sequence,
    replayed: true };
}

/** Verifies Account and Access before the guarded graph command. */
export async function createAdmittedMetadataWork(
  env: WorkActivationEnvironment,
  account: Pick<AccountAssertionVerifier, 'verify'>,
  access: Pick<AccessAdmissionRegistry, 'register' | 'claim' | 'recordGraphOutcome'>,
  request: Request,
  input: AdmittedMetadataWorkInput,
  catalogue?: Pick<CatalogueIntakeStore, 'reserve'>,
): Promise<WorkActivationReceipt> {
  const digest = metadataWorkRequestDigest(input.title, input.semanticTypes, input.language,
    input, true);
  await assertGraphAdmissionOpen(env.fuseki, env.lineage);
  const principal = await account.verify(request, ['work:create']);
  const registered = await access.register({
    principal,
    actingSubject: input.actingSubject,
    authorityPath: input.authorityPath,
    scope: 'work:create:root',
    action: 'work.create',
    idempotencyKey: input.idempotencyKey,
    requestDigest: digest,
    workSemanticTypes: input.semanticTypes,
  });
  // Access decides same-key replay first. Inactive types never reserve catalogue
  // slots or dispatch unless this admission already has a terminal graph receipt.
  if (registered.state !== 'sealed' && (!registered.replayed
    || !await readWorkTerminalReceipt(env.fuseki, registered.id))) {
    normalizeWorkSemanticTypes(input.semanticTypes);
  }
  // Reserve before claim/dispatch. A 429 may leave an undispatched Access
  // admission; its normal expiry/sealer supplies the cancellation proof.
  if (input.catalogue) {
    if (!catalogue) throw new Error('Catalogue intake is unavailable');
    await catalogue.reserve(registered, input.catalogue.candidateReceipt, input.title, input.language,
      [...(input.catalogue.aliases ?? []), ...(input.catalogue.romanizations ?? []),
        ...(input.localizedTitle ? [input.localizedTitle] : [])]);
  }
  try {
    if (registered.state === 'sealed' || !registered.dispatchEligible) {
      return await reconcileExisting(env, access, registered, digest);
    }
    let admission;
    try {
      admission = await access.claim(registered.id, digest, principal);
    } catch (error) {
      if (error instanceof AdmissionDenied || error instanceof AdmissionExpired) {
        return await reconcileExisting(env, access, registered, digest);
      }
      throw error;
    }
    const result = await activateMetadataWork(env, { admission, title: input.title,
      language: input.language,
      localizedTitle: input.localizedTitle, description: input.description,
      semanticTypes: input.semanticTypes, authorAgent: input.authorAgent, catalogue: input.catalogue });
    const terminal = await readWorkTerminalReceipt(env.fuseki, admission.id);
    if (!terminal || terminal.outcome !== 'succeeded') {
      throw new PendingActivation('Work receipt needs Access reconciliation');
    }
    await access.recordGraphOutcome(admission.id, terminal);
    return result;
  } catch (error) {
    if (error instanceof IdempotencyConflict || error instanceof CancelledActivation
      || error instanceof AuthorAgentUnavailable) throw error;
    // The admission is durable. The graph may have committed even when a response
    // or Access outcome write failed, so the caller must use the same key again.
    throw new PendingAdmittedWork(registered.id);
  }
}
