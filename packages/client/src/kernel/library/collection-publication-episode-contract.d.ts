/** Whole-query publication domain data. No declaration here admits work or authorizes a command. */
import type { captureDurableInitiator, durableInitiatorCommitment } from '../access/durable-initiator-capture.ts';
import type { DurableInitiatorReader, DurableInitiatorRecord } from '../access/durable-initiator.ts';
import type { CommandAuthorization, CommandOutcome, CommandTransaction, PrincipalCommandOptions } from '../command/command.ts';
import type { WorkContext } from '../work/registry.ts';
import type { BuiltinCollectionKey } from './builtin-identity.ts';
import type { CollectionRow, CollectionVisibility } from './collection-model.ts';
import type { CollectionPublicationLocator } from './collection-publication-work-admission.ts';
import type { SavedCollectionRule } from './collection-rules.ts';
import type { CollectionSourceObservation } from './collection-source.ts';
import type { CollectionOutputPublication, CollectionOutputRef } from './collection-source-output.ts';
import type { NativeSourceIdentity } from './native-source-custody.ts';
import type { NativeCollectionWork } from './collection-source-work.ts';
/** Same actual Collection as the target; this reference selects its PRIVATE working population.
 * Native bodies must validate the relationship, owner, incarnation and generation explicitly.
 * Neither active_explicit_output nor public_output can supply this input, even with equal IDs.
 */
export type CollectionPublicationInputRef = Readonly<{
    kind: 'private_working_source';
    identity: NativeSourceIdentity & Readonly<{
        scope: 'private_builtin';
    }>;
}>;
export type CollectionPublicationTargetRef = Readonly<{
    kind: 'collection_output';
    route: CollectionOutputRef['route'];
    collectionId: CollectionOutputRef['collectionId'];
    visibility: Exclude<CollectionVisibility, 'private'>;
}>;
/** Immutable reference to meaning, NEVER another stored query/profile AST.
 * digest commits the expanded pinned definition returned by the native getter. Each use
 * validates the current Collection bytes and accepted pins against this immutable reference.
 * Built-ins keep their actual deterministic ID/materialization and accepted meaning; Liked refuses.
 */
export type CollectionPublicationRuleRef = Readonly<{
    incarnation: CollectionSourceObservation['incarnation'];
    collectionRevision: SavedCollectionRule['collectionRevision'];
    sourceGeneration: SavedCollectionRule['sourceGeneration'];
    releaseDigest: SavedCollectionRule['releaseDigest'];
    digest: string;
}> & (Readonly<{
    kind: 'saved';
    revision: SavedCollectionRule['revision'];
}> | Readonly<{
    kind: 'builtin';
    key: Exclude<BuiltinCollectionKey, {
        kind: 'liked';
    }>;
}>);
/** Reference to B's actual native allocation. A building generation has no complete receipt. */
export type CollectionPublicationStagingOutput = Readonly<{
    state: 'building';
    ref: CollectionOutputRef;
    publication?: never;
}>;
/** A reference plus actual native publication provenance; still requires native rereading on use. */
export type CollectionPublicationCompleteOutput = Readonly<{
    state: 'complete';
    ref: CollectionOutputRef;
    publication: CollectionOutputPublication;
}>;
/** A remains selected while B stages, awaits final command admission, or refuses.
 * awaiting_activation records scheduling phase only: it grants no exhaustion/readiness authority.
 * Only native full-query exhaustion and current Source/identity/fence checks permit final activation.
 */
export type CollectionPublicationPhase = Readonly<{
    phase: 'staging' | 'awaiting_activation';
    output: CollectionPublicationStagingOutput;
    selected: CollectionPublicationCompleteOutput | null;
}> | Readonly<{
    phase: 'refused';
    output: CollectionPublicationStagingOutput | Readonly<{
        state: 'cancelled';
        ref: CollectionOutputRef;
    }>;
    selected: CollectionPublicationCompleteOutput | null;
}> | Readonly<{
    phase: 'complete';
    output: CollectionPublicationCompleteOutput;
    selected: CollectionPublicationCompleteOutput;
}>;
/** Internal begin input to the ordinary owner collection:update CAS/idempotency command.
 * No caller supplies publication/source/output IDs or evidence: native bodies allocate them.
 * Admission also checks every expanded private-family dependency before any write or replay.
 */
export type CollectionPublicationBeginInput = Readonly<{
    collectionId: CollectionRow['collectionId'];
    revision: CollectionRow['revision'];
    visibility: CollectionPublicationTargetRef['visibility'];
}>;
/** Exact immutable source/target payload committed with the ORIGINAL admitted command.
 * initiator.sourceDigest binds these bytes, including locator, rule and actual output allocation.
 * The Collection row retains the sole private query AST. Never rebuild this snapshot from current state.
 */
export type CollectionPublicationSource = Readonly<{
    locator: CollectionPublicationLocator;
    input: CollectionPublicationInputRef;
    target: CollectionPublicationTargetRef;
    rule: CollectionPublicationRuleRef;
    output: CollectionOutputRef;
}>;
/** Native creation must capture after original admission with commandAccessContext at attempt T,
 * commit the immutable operation/source in that command's actual transaction, and return this
 * exact durableInitiator commitment in its real creation receipt. These are provenance, not grants.
 */
export type CollectionPublicationCreation = Readonly<{
    source: CollectionPublicationSource;
    initiator: DurableInitiatorRecord;
    durableInitiator: ReturnType<typeof durableInitiatorCommitment>;
}>;
export type CollectionPublicationInitiatorCapture = Awaited<ReturnType<typeof captureDurableInitiator>>;
export type CollectionPublicationEpisode = CollectionPublicationCreation & CollectionPublicationPhase;
/** Library's native reader must independently verify the exact committed operation/source/receipt,
 * returning ONLY the original allowlisted record. No Map, policy JSON or reconstructed Actor reader.
 * Missing/collected creation evidence is unavailable; it cannot be reconstructed from current rows.
 */
export type CollectionPublicationInitiatorReader = DurableInitiatorReader;
export type CollectionPublicationWorkerDependencies = Readonly<{
    workContext: Pick<WorkContext, 'pool' | 'clock' | 'getAuthorization'>;
}>;
/** Body handoff: use workContext.getAuthorization()'s SAME mounted Access/current readConsent
 * and pool with createInitiatorRestorer. Restore INSIDE prepare at EACH attempt.time, then delegate
 * ordinary resourceAuthorization/accessCommandAuthorization prepare/authorize at that SAME T.
 * The actual runCommand receipt/principal/basis and native output hooks commit atomically.
 * Never restore a person for mechanical Source staging or cast an OperationalTransaction.
 */
export type CollectionPublicationFinalAuthorization = CommandAuthorization & Readonly<{
    action: 'collection:update';
}>;
/** Actual runCommand admission options from collection-publication-final.ts. The final activation
 * body is separately exported; these options carry neither a receipt nor native exhaustion proof.
 */
export type CollectionPublicationFinalCommand = Readonly<Pick<PrincipalCommandOptions, 'principal' | 'basis' | 'partition' | 'deadline' | 'clock'> & {
    authorization: CollectionPublicationFinalAuthorization;
}>;
export type CollectionPublicationActivationInput = Readonly<{
    tx: CommandTransaction;
    episode: CollectionPublicationEpisode;
    version: string;
    work: NativeCollectionWork;
}>;
/** Safe result read from the committed native episode after output provenance is present. */
export type CollectionPublicationFinalResult = Readonly<{
    locator: CollectionPublicationLocator;
    phase: 'complete';
    output: CollectionOutputRef;
}>;
export type CollectionPublicationFinalActivation = Readonly<{
    activate(locator: CollectionPublicationLocator, requestKey: string): Promise<CommandOutcome<CollectionPublicationFinalResult>>;
}>;
/** Native creation/reader and local owner cleanup are in collection-publication-episodes.ts.
 * Bounded staging and final activation are independent bodies. No type here proves native custody,
 * public/frozen support or terminal cleanup.
 */
