import { checkedComponentState, checkedStoredState, type ComponentInput } from '../semantic/change.ts';
import { checkedMetadataState, metadataComponent, type MetadataState } from '../work/metadata-schema.ts';
import { canonicalCandidate, checkedHeads, EditorialBlocked, EditorialInvalid, headsEqual,
  type ApplyInput, type ApplyOutcome, type BaseHead, type EditorialAdapter, type EditorialAdapterModule,
  revisionOperationKey, type EditorialTarget, type Json, type OwnerReceipt, type ValidatedCandidate } from './contract.ts';
import { assertOwnerReceipt } from './lifecycle.ts';

type Candidate = { command: 'work-metadata'; state: MetadataState }
  | { command: 'semantic-change'; state: ComponentInput };
interface Snapshot { state: unknown; heads: BaseHead[] }

/** These ports bind the existing work/metadata-command and semantic/admitted
 * commands. A production bridge must add proposal-qualified owner admission:
 * checking a permit outside the effect transaction is insufficient. Deliberately
 * no default bridge to ordinary edit authority while that binding is unavailable. */
export interface ComponentCorrectionOwners {
  readMetadata(target: EditorialTarget): Promise<Snapshot>;
  readSemantic(target: EditorialTarget): Promise<Snapshot>;
  commitMetadata(input: ApplyInput, state: MetadataState): Promise<ApplyOutcome>;
  commitSemantic(input: ApplyInput, state: ComponentInput): Promise<ApplyOutcome>;
}

function checkedCandidate(raw: unknown): Candidate {
  const value = canonicalCandidate(raw).candidate;
  if (!value || Array.isArray(value) || typeof value !== 'object'
    || Object.keys(value).sort().join(',') !== 'command,state') throw new EditorialInvalid('Invalid component correction');
  if (value.command === 'work-metadata') return { command: value.command, state: checkedMetadataState(value.state) };
  if (value.command === 'semantic-change') return { command: value.command, state: checkedComponentState(value.state) };
  throw new EditorialInvalid('Unknown component correction command');
}

function componentOf(target: EditorialTarget, candidate: Candidate): string {
  if (candidate.command === 'work-metadata') {
    if (target.work !== target.resource) throw new EditorialInvalid('Work metadata must name its owning Work');
    return metadataComponent(target.resource, candidate.state);
  }
  return target.resource;
}

function checkedSnapshot(target: EditorialTarget, candidate: Candidate, snapshot: Snapshot) {
  const component = componentOf(target, candidate), heads = checkedHeads(snapshot.heads);
  if (heads.length !== 1 || heads[0]!.component !== component) {
    throw new EditorialInvalid('Owner snapshot names another component');
  }
  let ownerState = snapshot.state;
  if (candidate.command === 'semantic-change') {
    const stored = checkedStoredState(ownerState as Record<string, unknown>);
    ownerState = stored.component === 'resource' ? { ...stored,
      properties: stored.properties.map(({ predicate, value }) => ({ predicate, value })) } : stored;
  }
  const before = checkedCandidate({ command: candidate.command, state: ownerState });
  if (before.command === 'semantic-change' && candidate.command === 'semantic-change'
    && (before.state.component !== candidate.state.component
      || before.state.component === 'definition' && candidate.state.component === 'definition'
        && before.state.kind !== candidate.state.kind)) {
    throw new EditorialInvalid('Correction changes the component kind');
  }
  if (componentOf(target, before) !== component) throw new EditorialInvalid('Correction changes the component identity');
  return { before, heads };
}

export function componentCorrectionAdapter(owners: ComponentCorrectionOwners): EditorialAdapter {
  const snapshot = (target: EditorialTarget, candidate: Candidate) => candidate.command === 'work-metadata'
    ? owners.readMetadata(target) : owners.readSemantic(target);
  const validate = async (target: EditorialTarget, raw: unknown, expected: BaseHead[]): Promise<ValidatedCandidate> => {
    const candidate = checkedCandidate(raw);
    const { before, heads } = checkedSnapshot(target, candidate, await snapshot(target, candidate));
    if (!headsEqual(expected, heads)) throw new EditorialBlocked({ code: 'stale_base',
      expectedHeads: expected, actualHeads: heads });
    return { candidate: canonicalCandidate(candidate).candidate, before: canonicalCandidate(before).candidate, baseHeads: heads };
  };
  return {
    kind: 'component-correction', requiredApprovals: 1, validate,
    async preview(revision) {
      const candidate = checkedCandidate(revision.candidate), before = checkedCandidate(revision.before);
      if (candidate.command !== before.command) throw new EditorialInvalid('Preview crosses component owners');
      const old = canonicalCandidate(before.state).candidate as Record<string, Json>;
      const next = canonicalCandidate(candidate.state).candidate as Record<string, Json>;
      return [...new Set([...Object.keys(old), ...Object.keys(next)])].sort()
        .filter(key => JSON.stringify(old[key]) !== JSON.stringify(next[key]))
        .map(path => ({ path, before: old[path] ?? null, after: next[path] ?? null }));
    },
    async apply(input) {
      const candidate = checkedCandidate(input.revision.candidate);
      if (input.expectedHeads.length !== 1 || input.expectedHeads[0]!.component !== componentOf(input.target, candidate)
        || !headsEqual(input.expectedHeads, input.revision.baseHeads)
        || canonicalCandidate(candidate).digest !== input.revision.candidateDigest) {
        throw new EditorialInvalid('Application names another component');
      }
      // No preflight read replaces the owner's atomic CAS/permit/receipt checks.
      return candidate.command === 'work-metadata'
        ? owners.commitMetadata(input, candidate.state) : owners.commitSemantic(input, candidate.state);
    },
    async compensate(receipt: OwnerReceipt) {
      const original = checkedCandidate(receipt.candidate);
      const prior = checkedCandidate(receipt.before);
      if (original.command !== prior.command) throw new EditorialInvalid('Compensation crosses component owners');
      // Receipt and retained prestate are tied by the Access revision/decision rows;
      // compensation never accepts replacement bytes or a client-supplied prestate.
      assertOwnerReceipt(receipt, { revision: { proposal: receipt.proposal, n: receipt.revision,
        candidate: receipt.candidate, before: receipt.before, candidateDigest: receipt.candidateDigest,
        baseHeads: receipt.beforeHeads, evidence: [] }, expectedHeads: receipt.beforeHeads,
        operationKey: revisionOperationKey(receipt.proposal, receipt.revision) });
      return { candidate: canonicalCandidate(prior).candidate,
        before: canonicalCandidate(original).candidate, baseHeads: checkedHeads(receipt.afterHeads) };
    },
  };
}

export const adapterModule = { kind: 'component-correction', create: componentCorrectionAdapter } satisfies
  EditorialAdapterModule<ComponentCorrectionOwners>;
