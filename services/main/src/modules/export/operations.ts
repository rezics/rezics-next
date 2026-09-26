import { createHash } from 'node:crypto';
import { AdmissionDenied, AdmissionExpired, type AccessAdmissionRegistry }
  from '../access/admission.ts';
import type { AccountAssertionVerifier } from '../account/verify-assertion.ts';
import { assertGraphAdmissionOpen } from '../work/restore-lineage.ts';
import { RevisionNotFound } from '../work/history.ts';
import { canonicalExport, InvalidExportPlan, type ExportPlan } from './planner.ts';
import { ExportSourceNotFound, ExportSourceUnavailable, ExportStale, readExportPlan, type ExportReaderDependencies,
  type ExportSelection } from './readers.ts';
import { ExportDenied, ExportStore, exportTerminal, type SealedExport } from './store.ts';

export class ExportPending extends Error {
  constructor(readonly operationId: string) { super('export needs owner reconciliation'); }
}

type ExportAccess = Pick<AccessAdmissionRegistry,
  'register' | 'claim' | 'recordGraphOutcome' | 'activePrincipalId'>;

export interface ExportDependencies {
  account: Pick<AccountAssertionVerifier, 'verify'>;
  access: ExportAccess;
  readers: ExportReaderDependencies;
  store: ExportStore;
}

export interface CreateExportInput {
  selection: ExportSelection;
  actingSubject: string;
  useScope: ExportPlan['useScope'];
  idempotencyKey: string;
}

const sha = (value: unknown) => createHash('sha256').update(canonicalExport(value)).digest('hex');
const scope = (selection: ExportSelection) => `export:${selection.reference}`;

/** Exact immutable selection, one Access admission and one Content receipt. */
export async function createAdmittedExport(deps: ExportDependencies, request: Request,
  input: CreateExportInput): Promise<SealedExport> {
  const principal = await deps.account.verify(request, ['export:create']);
  await assertGraphAdmissionOpen(deps.readers.env.fuseki, deps.readers.env.lineage);
  const requestDigest = sha({ profile: 'export-create-v1', ...input });
  const admission = await deps.access.register({ principal, actingSubject: input.actingSubject,
    scope: scope(input.selection), action: 'export.create', idempotencyKey: input.idempotencyKey,
    requestDigest });
  const previous = await deps.store.readByAdmission(admission.principalId, admission.id);
  if (previous) {
    const current = await readExportPlan(deps.readers, principal, input.actingSubject,
      input.selection, input.useScope);
    if (current.manifestDigest !== previous.manifestDigest) throw new ExportStale('export basis changed');
    await deps.access.recordGraphOutcome(admission.id, exportTerminal(admission, previous.position, 'succeeded'));
    return { ...previous, replayed: true };
  }
  if (admission.state === 'sealed') throw new ExportDenied('export request was cancelled');
  let claimed = admission;
  if (admission.state !== 'claimed' && admission.dispatchEligible) {
    try { claimed = await deps.access.claim(admission.id, requestDigest); }
    catch (error) {
      if (!(error instanceof AdmissionDenied || error instanceof AdmissionExpired)) throw error;
    }
  }
  if (claimed.state !== 'claimed' || !claimed.dispatchEligible) {
    const terminal = await deps.store.cancel(admission);
    await deps.access.recordGraphOutcome(admission.id, terminal);
    throw new ExportDenied('export authority is not current');
  }
  let plan: ExportPlan;
  try {
    plan = await readExportPlan(deps.readers, principal, input.actingSubject,
      input.selection, input.useScope);
  } catch (error) {
    if (error instanceof ExportStale || error instanceof ExportSourceUnavailable
      || error instanceof ExportSourceNotFound
      || error instanceof RevisionNotFound
      || error instanceof InvalidExportPlan) {
      const terminal = await deps.store.cancel(admission);
      await deps.access.recordGraphOutcome(admission.id, terminal);
    }
    throw error;
  }
  if (plan.licenseScope === 'blocked') {
    const terminal = await deps.store.cancel(admission);
    await deps.access.recordGraphOutcome(admission.id, terminal);
    throw new ExportDenied('export rights prohibit the requested use');
  }
  try {
    const saved = await deps.store.seal(claimed, plan);
    await deps.access.recordGraphOutcome(admission.id, exportTerminal(admission, saved.position, 'succeeded'));
    return saved;
  } catch (error) {
    if (error instanceof ExportDenied || error instanceof ExportStale) throw error;
    throw new ExportPending(admission.id);
  }
}

/** Revalidate disclosure and owner evidence before serving an immutable private export. */
export async function readAuthorizedExport(deps: ExportDependencies, request: Request,
  manifestId: string): Promise<SealedExport> {
  const principal = await deps.account.verify(request, ['export:read']);
  const principalId = await deps.access.activePrincipalId(principal);
  if (!principalId) throw new ExportDenied('export principal is inactive');
  await assertGraphAdmissionOpen(deps.readers.env.fuseki, deps.readers.env.lineage);
  const saved = await deps.store.read(principalId, manifestId);
  const first = saved.plan.members[0];
  const profile = saved.plan.targetProfile;
  const assessment = saved.plan.members[1];
  const selected = profile === 'rezics-verification-v1' ? assessment : first;
  const data = selected?.data;
  const reference = profile === 'rezics-main-version-v1' ? data?.release
    : profile === 'rezics-verification-v1' ? assessment?.exactRef
      : profile === 'rezics-composition-v1' ? data?.seal
        : profile === 'rezics-semantic-values-v1' ? data?.revision : null;
  const actor = data?.exportActor;
  if (typeof reference !== 'string' || typeof actor !== 'string' || !selected) {
    throw new ExportSourceUnavailable('export source locator is unavailable');
  }
  const expectedPosition = { dataEpoch: selected.ownerDataEpoch, sequence: selected.ownerSequence };
  let selection: ExportSelection;
  if (profile === 'rezics-main-version-v1') selection = { kind: 'fixed-release', reference,
    expectedPosition };
  else if (profile === 'rezics-verification-v1') selection = { kind: 'assessment', reference,
    expectedPosition };
  else if (profile === 'rezics-composition-v1' && typeof data?.structure === 'string') {
    selection = { kind: 'composition-seal', reference, structure: data.structure, expectedPosition };
  } else if (profile === 'rezics-semantic-values-v1' && typeof data?.resource === 'string') {
    selection = { kind: 'semantic-revision', reference, resource: data.resource, expectedPosition };
  } else throw new ExportSourceUnavailable('export source locator is unavailable');
  const current = await readExportPlan(deps.readers, principal, actor, selection, saved.plan.useScope);
  if (current.manifestDigest !== saved.manifestDigest) throw new ExportStale('export disclosure changed');
  return saved;
}
