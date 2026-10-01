import {
  canonicalCandidate,
  EditorialBlocked,
  EditorialInvalid,
  type ApplyInput,
  type BaseHead,
  type CommandOutcome,
  type EditorialCommand,
  type EditorialTarget,
  type OwnerReceipt,
} from '../editorial-review/contract.ts';
import type { EditorialRuntime } from '../editorial-review/runtime.ts';
import { checkWikiDelta, isWikiDelta } from './delta.ts';
import { assertWikiBase, wikiHistory, wikiReceipts, type WikiHistoryClaim } from './history.ts';
import { wikiSnapshot, type WikiSnapshot } from './apply-snapshot.ts';
import { wikiCommands, wikiItemKey } from './apply.ts';
import { wikiRetractionCommands } from './apply-compensation.ts';
import { isWikiRetraction } from './apply-compensation.ts';
import { commandResult, wikiGraphCommand } from './apply-runtime.ts';
import { recordStatement, recordStatementRequest, STATEMENT_FAMILIES } from '../statement/graph.ts';
import { readCommandReceipt, sealCommandTerminal } from '../context/command.ts';
import {
  canonicalRelation,
  changeRelationOccurrence,
  relationChangeDigest,
  readRelationChangeTerminal,
} from '../relation/change.ts';
import { cancelSemanticAdmission, familyReceiptIri } from '../semantic/command.ts';
import { GRAPHS, RV, iri } from '../work/activate.ts';

type Runtime = EditorialRuntime & { actingSubject: string };
export const isDeltaRevert = (
  value: unknown,
): value is { profile: 'wiki-delta-revert-v1'; proposal: string } =>
  !!value &&
  typeof value === 'object' &&
  'profile' in value &&
  value.profile === 'wiki-delta-revert-v1';
async function receipts(runtime: EditorialRuntime, work: string) {
  if (!runtime.work.editorialReview) throw new EditorialBlocked({ code: 'owner_unavailable' });
  return wikiReceipts(runtime.work.editorialReview.pool, work);
}
const normalized = (receipt: OwnerReceipt): OwnerReceipt =>
  isWikiDelta(receipt.candidate)
    ? { ...receipt, candidate: canonicalCandidate(receipt.candidate.bundle).candidate }
    : receipt;
export async function validateWikiDelta(
  runtime: Runtime,
  target: EditorialTarget,
  raw: unknown,
  expected: BaseHead[],
) {
  const delta = checkWikiDelta(raw),
    originals = await receipts(runtime, target.resource);
  assertWikiBase(delta.base, originals);
  const accepted = wikiHistory(target.resource, originals);
  const removed = delta.changes.map((change) => {
    const claim = accepted.claims.find(
      (item) => item.claim === change.claim && item.revision === change.revision,
    );
    if (!claim)
      throw new EditorialBlocked({
        code: 'stale_base',
        expectedHeads: [{ component: change.claim, head: change.revision }],
        actualHeads: [{ component: change.claim, head: null }],
      });
    return claim;
  });
  await assertClaimHeads(runtime, removed);
  const validated = await wikiSnapshot(runtime, target, delta.bundle, expected);
  return {
    ...validated,
    candidate: canonicalCandidate(delta).candidate,
    before: canonicalCandidate({ ...(validated.before as object), removed }).candidate,
  };
}
async function assertClaimHeads(runtime: EditorialRuntime, claims: WikiHistoryClaim[]) {
  for (const claim of claims) {
    const rows =
      (
        await runtime.work.environment.fuseki.query(
          `PREFIX rv: <${RV}> SELECT ?head WHERE {
      GRAPH ${iri(GRAPHS.current)} { ${iri(claim.claim)} rv:head ?head } } LIMIT 2`,
          4096,
        )
      ).results?.bindings ?? [];
    if (rows.length !== 1 || rows[0]?.head?.value !== claim.revision)
      throw new EditorialBlocked({
        code: 'stale_base',
        expectedHeads: [{ component: claim.claim, head: claim.revision }],
        actualHeads: [{ component: claim.claim, head: rows[0]?.head?.value ?? null }],
      });
  }
}
/** The kernel's durable applications already fence an unresolved Work. Under
 * a short advisory lock, concurrent intents fail closed before owner delivery;
 * no second lifecycle or mutable wiki-head table is needed. */
export async function wikiDeliveryFence(
  runtime: EditorialRuntime,
  input: ApplyInput,
): Promise<void> {
  const work = input.target.resource;
  const exclusive =
    isWikiDelta(input.revision.candidate) ||
    isDeltaRevert(input.revision.candidate) ||
    isWikiRetraction(input.revision.candidate);
  const pool = runtime.work.editorialReview?.pool;
  if (!pool) throw new EditorialBlocked({ code: 'owner_unavailable' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL statement_timeout = '1000ms'");
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      `wiki-delta:${work}`,
    ]);
    // A retained owner admission/outcome wins over a prospective rival.
    // Never mark a partially delivered application stale during recovery.
    const started = (
      await client.query(
        `SELECT 1 FROM access.editorial_command_outcome WHERE application = $1
            UNION ALL SELECT 1 FROM access.editorial_command_admission WHERE application = $1 LIMIT 1`,
        [input.permit.proof],
      )
    ).rowCount;
    if (started) {
      await client.query('COMMIT');
      return;
    }
    const occupied = (
      await client.query(
        `SELECT 1 FROM access.editorial_proposal p
            JOIN access.editorial_application a ON a.proposal = p.id
            JOIN access.editorial_revision r ON r.proposal = a.proposal AND r.n = a.revision
            WHERE p.resource = $1 AND p.kind = 'wiki-bundle' AND (a.proposal <> $2 OR a.revision <> $3)
              AND ($4::boolean OR r.candidate::jsonb->>'profile' IN ('wiki-delta-v1','wiki-delta-revert-v1','wiki-retraction-v1'))
              AND NOT EXISTS (SELECT 1 FROM access.editorial_application_outcome o WHERE o.application = a.id)
            LIMIT 1`,
        [work, input.revision.proposal, input.revision.n, exclusive],
      )
    ).rowCount;
    if (occupied)
      throw new EditorialBlocked({
        code: 'stale_base',
        expectedHeads: input.expectedHeads,
        actualHeads: [{ component: work, head: null }],
      });
    if (isWikiDelta(input.revision.candidate))
      assertWikiBase(input.revision.candidate.base, await wikiReceipts(client, work));
    if (isDeltaRevert(input.revision.candidate))
      assertWikiBase(
        (input.revision.before as unknown as { base: import('./delta.ts').WikiRevisionSet }).base,
        await wikiReceipts(client, work),
      );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
async function endingCommands(
  runtime: EditorialRuntime,
  input: ApplyInput,
  claims: WikiHistoryClaim[],
) {
  const commands: EditorialCommand[] = [];
  for (const [index, claim] of claims.entries()) {
    const original = await runtime.work.editorialReview?.appliedReceipt(claim.proposal);
    if (!original) throw new EditorialInvalid('Original wiki claim receipt is unavailable');
    let owner = normalized(original);
    if (claim.endingReceipt && claim.endingKey) {
      const restored = await runtime.work.editorialReview?.appliedReceipt(claim.endingReceipt);
      const result = restored?.commands?.find((row) => row.key.endsWith(`:${claim.endingKey}`));
      if (!result || result.outcome !== 'applied')
        throw new EditorialInvalid('Restored claim owner receipt is unavailable');
      owner = {
        ...owner,
        commands: owner.commands?.map((row) =>
          row.key.endsWith(`:claim:${claim.index}`) ? { ...result, key: row.key } : row,
        ),
      };
    }
    const review = new Proxy(runtime.work.editorialReview!, {
      get(target, property) {
        if (property === 'appliedReceipt') return async () => owner;
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const key = wikiItemKey(input, `delta-end:${index}`);
    const all = await wikiRetractionCommands(
      { ...runtime, work: { ...runtime.work, editorialReview: review } },
      {
        ...input,
        revision: {
          ...input.revision,
          candidate: { profile: 'wiki-retraction-v1', proposal: original.proposal },
        },
      },
      (originalIndex) =>
        originalIndex === claim.index ? key : wikiItemKey(input, `retract-claim:${originalIndex}`),
    );
    const command = all.find((item) => item.key === key);
    if (!command) throw new EditorialInvalid('Accepted claim lacks its owner ending command');
    commands.push(command);
  }
  return commands;
}
export async function wikiDeltaCommands(runtime: EditorialRuntime, input: ApplyInput) {
  const delta = checkWikiDelta(input.revision.candidate);
  const removed = (input.revision.before as unknown as { removed: WikiHistoryClaim[] }).removed;
  const extraction = {
    ...input,
    revision: { ...input.revision, candidate: canonicalCandidate(delta.bundle).candidate },
  };
  const additions = (await wikiCommands(runtime, extraction)).filter(
    (command) =>
      !delta.changes.some(
        (change) =>
          change.operation === 'retract' &&
          command.key === wikiItemKey(input, `claim:${change.evidenceClaim}`),
      ),
  );
  // Publish citations first. A failed replacement cannot withdraw its old support.
  const endings = await endingCommands(runtime, input, removed);
  return [
    ...additions,
    ...endings.map((command, index): EditorialCommand => {
      const change = delta.changes[index]!;
      if (change.operation !== 'amend') return command;
      const permitted = (settled: readonly CommandOutcome[]) =>
        !!commandResult(
          settled.find((row) => row.key === wikiItemKey(input, `claim:${change.evidenceClaim}`)),
        );
      const denied = (): CommandOutcome => ({
        key: command.key,
        outcome: 'dependency_rejected',
        receipt: null,
        result: {},
      });
      return {
        ...command,
        resolve: (delivery, settled) =>
          permitted(settled) ? command.resolve(delivery, settled) : Promise.resolve(denied()),
        execute: (delivery, settled) =>
          permitted(settled) ? command.execute(delivery, settled) : Promise.resolve(denied()),
      };
    }),
  ];
}
export async function validateDeltaRevert(
  runtime: Runtime,
  target: EditorialTarget,
  proposal: string,
  expected: BaseHead[],
) {
  const original = await runtime.work.editorialReview?.appliedReceipt(proposal);
  if (!original || !isWikiDelta(original.candidate))
    throw new EditorialInvalid('Revert requires an applied delta');
  const delta = checkWikiDelta(original.candidate);
  const validated = await wikiSnapshot(runtime, target, delta.bundle, expected);
  const current = await receipts(runtime, target.resource);
  if (current.at(-1)?.proposal !== proposal)
    throw new EditorialBlocked({
      code: 'stale_base',
      expectedHeads: expected,
      actualHeads: [{ component: target.resource, head: null }],
    });
  return {
    ...validated,
    candidate: canonicalCandidate({ profile: 'wiki-delta-revert-v1', proposal }).candidate,
    before: canonicalCandidate({
      base: current.map((row) => ({
        proposal: row.proposal,
        revision: row.revision,
        digest: row.candidateDigest,
      })),
    }).candidate,
  };
}
export async function wikiDeltaRevertCommands(runtime: EditorialRuntime, input: ApplyInput) {
  if (!isDeltaRevert(input.revision.candidate)) throw new EditorialInvalid('Invalid delta revert');
  const original = await runtime.work.editorialReview?.appliedReceipt(
    input.revision.candidate.proposal,
  );
  if (!original || !isWikiDelta(original.candidate))
    throw new EditorialInvalid('Original delta is unavailable');
  const ended = (original.before as unknown as { removed: WikiHistoryClaim[] }).removed.filter(
    (_claim, index) =>
      commandResult(original.commands?.find((row) => row.key.endsWith(`:delta-end:${index}`))),
  );
  const added = wikiHistory(input.target.resource, [
    ...(await receipts(runtime, input.target.resource)),
  ]).claims.filter((claim) => claim.proposal === original.proposal);
  const commands = await endingCommands(runtime, input, added);
  for (const [index, claim] of ended.entries()) {
    const prior = await runtime.work.editorialReview?.appliedReceipt(claim.proposal);
    if (!prior) throw new EditorialInvalid('Restored claim receipt is unavailable');
    const snapshot = prior.before as unknown as WikiSnapshot,
      predicate = snapshot.predicates[claim.value.predicate]!;
    const value = claim.value;
    commands.push(
      wikiGraphCommand(runtime, wikiItemKey(input, `delta-restore:${index}`), async () => {
        const env = runtime.work.environment;
        if (predicate.kind === 'property') {
          const statement = {
            speaker: { kind: 'personal' as const },
            subject: value.subject,
            predicate: value.predicate,
            relationDefinition: predicate.head,
            value:
              value.object.kind === 'entity'
                ? { kind: 'resource' as const, iri: value.object.ref }
                : {
                    kind: 'literal' as const,
                    lexical: value.object.value,
                    language: value.object.language ?? null,
                    datatype: 'http://www.w3.org/2001/XMLSchema#string',
                  },
            applicability: [value.continuity],
            interpretation: { kind: 'selected' as const },
            evidence: claim.evidence,
            actingSubject: input.permit.decidingAgent,
          };
          const request = recordStatementRequest(statement);
          return {
            binding: { action: request.action, scope: request.scope, digest: request.digest },
            read: (id) => readCommandReceipt(env, id, STATEMENT_FAMILIES.record),
            dispatch: (admission) =>
              recordStatement(
                env,
                admission,
                statement,
                { kind: 'personal', canReadPrivate: async () => false },
                reveal,
              ),
            cancel: (admission) =>
              sealCommandTerminal(env, admission, STATEMENT_FAMILIES.record, 'unavailable'),
          };
        }
        if (value.object.kind !== 'entity') throw new EditorialInvalid('Invalid restored relation');
        const relation = {
          definition: predicate.head,
          applicability: [value.continuity],
          evidence: claim.evidence[0],
          participations: [
            { role: 'subject', participant: { kind: 'resource' as const, ref: value.subject } },
            { role: 'object', participant: { kind: 'resource' as const, ref: value.object.ref } },
          ],
        };
        return {
          binding: {
            action: 'relation.change',
            scope: 'relation:create:root',
            digest: relationChangeDigest(
              undefined,
              null,
              canonicalRelation(predicate.definition!, relation),
            ),
          },
          read: (id) => readRelationChangeTerminal(env, id),
          dispatch: (admission) =>
            changeRelationOccurrence(env, {
              admission,
              expectedHead: null,
              input: relation,
              beforeCommit: reveal,
            }),
          cancel: (admission) =>
            cancelSemanticAdmission(
              env,
              familyReceiptIri(admission.id, 'relation-change'),
              admission,
            ),
        };
      }),
    );
    async function reveal(component: string, receipt: string) {
      const priorBundle = normalized(prior!)
        .candidate as unknown as import('./protocol.ts').WikiExtraction;
      const occurrence = priorBundle.units.find(
        (unit) => unit.id === value.revealedAt || unit.occurrence === value.revealedAt,
      )?.occurrence;
      if (!occurrence || !runtime.work.wikiEvidence)
        throw new EditorialBlocked({ code: 'owner_unavailable' });
      await runtime.work.wikiEvidence.reveal(
        input.target.resource,
        [
          {
            record: component,
            recordKind: predicate.kind === 'property' ? 'statement' : 'relation',
            continuityWork: input.target.resource,
            occurrence,
            receipt,
          },
        ],
        [],
      );
    }
  }
  return commands;
}
