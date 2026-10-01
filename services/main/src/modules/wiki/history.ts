import type { EditorialReviewStore } from '../editorial-review/store.ts';
import {
  EditorialBlocked,
  EditorialInvalid,
  canonicalCandidate,
  type OwnerReceipt,
} from '../editorial-review/contract.ts';
import { commandResult } from './apply-runtime.ts';
import { extractionCandidate } from './apply-snapshot.ts';
import { isWikiRetraction } from './apply-compensation.ts';
import { checkWikiDelta, isWikiDelta, revisionSetDigest, type WikiRevisionSet } from './delta.ts';
import { evidenceId, withholdPassage, type WikiEvidenceStore } from './evidence.ts';
import type { RightsStore } from '../rights/store.ts';
import type { WikiExtraction } from './protocol.ts';

/** Inventory uses 64-receipt keyset queries, never a product-size cap.
 * Replay is O(journal commands + evidence); graph disclosure has a per-read budget. */
export const WIKI_HISTORY_COST = {
  receipts: 64,
  pageItems: 64,
  statementMs: 1000,
  graphCalls: 2048,
  graphBytes: 8_388_608,
  deadlineMs: 10_000,
} as const;
export interface WikiHistoryClaim {
  claim: string;
  revision: string;
  proposal: string;
  index: number;
  endingReceipt?: string;
  endingKey?: string;
  value: WikiExtraction['claims'][number];
  evidence: string[];
}
export interface WikiHistory {
  profile: 'wiki-history-v1';
  work: string;
  revisions: WikiRevisionSet;
  claims: WikiHistoryClaim[];
  entities: {
    entity: string;
    revision: string;
    type: string;
    names: WikiExtraction['entities'][number]['names'];
  }[];
  units: WikiExtraction['units'];
}
/** Follow every keyset page within one pinned cut, including for delta bases. */
export async function wikiReceipts(
  store: Pick<EditorialReviewStore, 'appliedReceipts'>,
  work: string,
  selection?: WikiRevisionSet,
): Promise<OwnerReceipt[]> {
  const receipts: OwnerReceipt[] = [];
  let through = selection
    ? Array.isArray(selection)
      ? (selection.at(-1)?.proposal ?? null)
      : selection.through
    : undefined;
  let cursor: string | undefined;
  do {
    const page = await store.appliedReceipts(work, 'wiki-bundle', WIKI_HISTORY_COST.receipts, {
      through,
      cursor,
    });
    through = page.through;
    receipts.push(...page.receipts);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  if (
    selection &&
    ((through !== receipts.at(-1)?.proposal && through !== null) ||
      revisionSetDigest(selection) !== revisionSetDigest(wikiRevisionSet(receipts)))
  )
    throw new EditorialInvalid('Revision set is not a complete applied wiki prefix');
  return receipts;
}
export const wikiRevisionSet = (receipts: readonly OwnerReceipt[]): WikiRevisionSet => ({
  profile: 'wiki-revision-set-v1',
  through: receipts.at(-1)?.proposal ?? null,
  digest: revisionSetDigest(
    receipts.map((receipt) => ({
      proposal: receipt.proposal,
      revision: receipt.revision,
      digest: receipt.candidateDigest,
    })),
  ),
});
export function assertWikiBase(expected: WikiRevisionSet, receipts: readonly OwnerReceipt[]) {
  if (
    (!Array.isArray(expected) && expected.through !== (receipts.at(-1)?.proposal ?? null)) ||
    revisionSetDigest(expected) !== revisionSetDigest(wikiRevisionSet(receipts))
  ) {
    throw new EditorialBlocked({
      code: 'stale_base',
      expectedHeads: [
        { component: 'urn:rezics:wiki:revision-set', head: revisionSetDigest(expected) },
      ],
      actualHeads: [
        {
          component: 'urn:rezics:wiki:revision-set',
          head: revisionSetDigest(wikiRevisionSet(receipts)),
        },
      ],
    });
  }
}
/** Only successful, reviewed owner commands can end an accepted occurrence.
 * Omission has no operation, and therefore cannot remove a claim. */
export function wikiHistory(work: string, receipts: readonly OwnerReceipt[]): WikiHistory {
  const claims = new Map<string, WikiHistoryClaim>(),
    entities = new Map<string, WikiHistory['entities'][number]>();
  const units = new Map<string, WikiExtraction['units'][number]>();
  const previous: OwnerReceipt[] = [];
  let previousDigest = revisionSetDigest([]);
  const byProposal = new Map(receipts.map((receipt) => [receipt.proposal, receipt]));
  for (const receipt of receipts) {
    const base = {
      profile: 'wiki-revision-set-v1' as const,
      through: previous.at(-1)?.proposal ?? null,
      digest: previousDigest,
    };
    previousDigest = canonicalCandidate({
      previous: previousDigest,
      pin: {
        proposal: receipt.proposal,
        revision: receipt.revision,
        digest: receipt.candidateDigest,
      },
    }).digest;
    previous.push(receipt);
    if (
      receipt.candidate &&
      typeof receipt.candidate === 'object' &&
      !Array.isArray(receipt.candidate) &&
      receipt.candidate.profile === 'wiki-delta-revert-v1'
    ) {
      // Resolve the exact retained source; a revert never reads the current name.
      const proposal = receipt.candidate.proposal;
      const source = byProposal.get(String(proposal));
      if (!source || !isWikiDelta(source.candidate))
        throw new EditorialInvalid('Delta revert source is missing');
      const added = [...claims.values()].filter((claim) => claim.proposal === source.proposal);
      for (const [index, claim] of added.entries())
        if (
          commandResult(receipt.commands?.find((row) => row.key.endsWith(`:delta-end:${index}`)))
        ) {
          claims.delete(claim.claim);
        }
      const removed = (source.before as unknown as { removed: WikiHistoryClaim[] }).removed.filter(
        (_claim, index) =>
          commandResult(source.commands?.find((row) => row.key.endsWith(`:delta-end:${index}`))),
      );
      for (const [index, claim] of removed.entries()) {
        const restored = commandResult(
          receipt.commands?.find((row) => row.key.endsWith(`:delta-restore:${index}`)),
        );
        if (typeof restored?.component === 'string' && typeof restored.revision === 'string')
          claims.set(restored.component, {
            ...claim,
            claim: restored.component,
            revision: restored.revision,
            endingReceipt: receipt.proposal,
            endingKey: `delta-restore:${index}`,
          });
      }
      continue;
    }
    if (isWikiRetraction(receipt.candidate)) {
      for (const outcome of receipt.commands ?? [])
        if (outcome.key.includes(':retract-claim:')) {
          const result = commandResult(outcome);
          if (typeof result?.component === 'string') claims.delete(result.component);
        }
      continue;
    }
    const delta = isWikiDelta(receipt.candidate) ? checkWikiDelta(receipt.candidate) : null;
    const bundle = delta?.bundle ?? extractionCandidate(receipt.candidate);
    if (bundle.target !== work) throw new EditorialInvalid('Revision set crosses wiki Works');
    if (
      delta &&
      (revisionSetDigest(delta.base) !== base.digest ||
        (!Array.isArray(delta.base) && delta.base.through !== base.through))
    )
      throw new EditorialInvalid('Applied delta has an inconsistent journal base');
    const result = (key: string) =>
      commandResult(
        receipt.commands?.find(
          (row) => row.key === `wiki:${receipt.proposal}:${receipt.revision}:${key}`,
        ),
      );
    for (const [index, change] of (delta?.changes ?? []).entries()) {
      if (result(`delta-end:${index}`)?.component === change.claim) claims.delete(change.claim);
    }
    const resolve = (ref: string): string =>
      bundle.entities.some((entity) => entity.id === ref)
        ? String(result(`entity:${ref}`)?.component ?? '')
        : ref;
    // Wire unit IDs are bundle-local. Resolve them before combining chapters
    // so two extractions both called "chapter1" cannot retarget old citations.
    const unitRef = (id: string) =>
      bundle.units.find((unit) => unit.id === id)?.occurrence ??
      `${receipt.proposal}:${receipt.revision}:${id}`;
    for (const entity of bundle.entities) {
      const applied = result(`entity:${entity.id}`);
      const names = [
        ...(entities.get(String(applied?.component))?.names ?? []),
        ...entity.names.map((name) => ({ ...name, revealedAt: unitRef(name.revealedAt) })),
      ];
      const unique = new Map<string, (typeof names)[number]>();
      for (const name of names) {
        const key = JSON.stringify([name.value, name.language, name.kind]);
        if (!unique.has(key)) unique.set(key, name);
      }
      if (typeof applied?.component === 'string' && typeof applied.revision === 'string')
        entities.set(applied.component, {
          entity: applied.component,
          revision: applied.revision,
          type: entity.type,
          names: [...unique.values()],
        });
    }
    for (const unit of bundle.units) units.set(unitRef(unit.id), { ...unit, id: unitRef(unit.id) });
    for (const [index, value] of bundle.claims.entries()) {
      if (
        delta?.changes.some(
          (change) => change.operation === 'retract' && change.evidenceClaim === index,
        )
      )
        continue;
      const applied = result(`claim:${index}`);
      if (typeof applied?.component !== 'string' || typeof applied.revision !== 'string') continue;
      claims.set(applied.component, {
        claim: applied.component,
        revision: applied.revision,
        proposal: receipt.proposal,
        index,
        value: {
          ...value,
          subject: resolve(value.subject),
          revealedAt: unitRef(value.revealedAt),
          object:
            value.object.kind === 'entity'
              ? { ...value.object, ref: resolve(value.object.ref) }
              : value.object,
        },
        evidence: value.evidence.map((_item, e) =>
          evidenceId(receipt.proposal, receipt.revision, index, e),
        ),
      });
    }
  }
  return {
    profile: 'wiki-history-v1',
    work,
    revisions: wikiRevisionSet(receipts),
    claims: [...claims.values()],
    entities: [...entities.values()],
    units: [...units.values()],
  };
}
/** Rights is the sole mutable content dependency of a pinned rendering. */
export async function discloseWikiHistory(
  history: WikiHistory,
  evidence: Pick<WikiEvidenceStore, 'withheld'>,
  rights: Pick<RightsStore, 'exportScope'> | undefined,
) {
  const withheld = await evidence.withheld(
    history.claims.flatMap((claim) => claim.evidence),
    rights,
  );
  return {
    ...history,
    claims: history.claims.map((claim) => ({
      ...claim,
      value: {
        ...claim.value,
        evidence: claim.value.evidence.map((item, index) =>
          withheld.has(claim.evidence[index]!)
            ? { ...(withholdPassage(item) as object), quoteWithheld: true }
            : { ...item, quoteWithheld: false },
        ),
      },
    })),
  };
}
