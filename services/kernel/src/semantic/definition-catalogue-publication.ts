import { catalogueCheckpoint } from './definition-catalogue-checkpoint.ts';
import type { Pool } from 'pg';
import {
  cataloguePublisherInvocation,
  cataloguePublisherQuery,
  cataloguePublisherControl,
} from './definition-catalogue-publication-work.ts';
import {
  registerCatalogueRoot,
  lockCatalogueEnrollment,
  requestCatalogueActivation,
  advanceCatalogueActivation,
  finishCatalogueActivation,
  advanceCatalogueRetirement,
} from './definition-catalogue-lifecycle.ts';
import {
  CATALOGUE_LIMITS,
  RELEASE_LIMITS,
  CatalogueArtifactError,
  catalogueBytes,
  catalogueDigest,
  catalogueFail,
  catalogueNodeRange,
  declarationKey,
  parseCatalogueNode,
  parseCataloguePin,
  parseCatalogueRoot,
  parseKindDeclaration,
  readCatalogueArtifact,
  requireConstructibleKind,
  releaseDigest,
  validateRelease,
  releaseAdmission,
  publicationLimits,
  type CatalogueArtifactReader,
  type KindCataloguePin,
  type Release,
  type TypeDefinition,
} from '@rezics/definitions';
import { runCommand, type CommandTransaction, type CommandEvent } from '../command/command.ts';
import {
  commandOptions,
  DefinitionNotFoundError,
  DefinitionInputError,
  GLOBAL_CONTEXT,
  readRelease,
  type WriteOptions,
} from './definitions.ts';
import {
  CATALOGUE_BUILD_REQUESTED,
  CATALOGUE_PROGRESS,
  CATALOGUE_ACTIVATED,
  CATALOGUE_ARTIFACT,
  CATALOGUE_ACTIVATION_REQUESTED,
} from './events.ts';

export type CatalogueArtifactKind = 'root' | 'node' | 'release' | 'declaration';
export type CatalogueBuildStatus = {
  pin: KindCataloguePin;
  state: 'building' | 'incomplete' | 'refused' | 'ready';
  phase: 'node' | 'release' | 'declaration';
  steps: string;
  nodes: string;
  releases: string;
  declarations: string;
  indexed_rows: string;
  examined_bytes: string;
  missing_digest: string | null;
  error: string | null;
};
type Build = CatalogueBuildStatus & { next_node: string | null };
type Task = {
  task_id: string;
  kind: 'node' | 'release' | 'declaration';
  digest: string;
  entry_key: Buffer | null;
  first_key: Buffer | null;
  last_key: Buffer | null;
  next_node: string | null;
  offset_rows: number;
};
export const catalogueKey = (value: string) => catalogueDigest(catalogueBytes(value));
/** UTF-16 BE preserves the package's exact JS string ordering, including supplementary characters. */
export function catalogueSort(value: string): Buffer {
  const bytes = Buffer.from(value, 'utf16le');
  return bytes.swap16();
}
function event(type: string, data: unknown): CommandEvent {
  return { type, subject: GLOBAL_CONTEXT, data };
}
function result<T>(command: Awaited<ReturnType<typeof runCommand<T>>>) {
  return {
    ...command.value,
    component: { partition: command.partition, epoch: command.epoch, position: command.position },
    replayed: command.replayed,
  };
}
export function catalogueArtifactReader(tx: CommandTransaction): CatalogueArtifactReader {
  return {
    async read(digest) {
      const row = await cataloguePublisherQuery<{ bytes: Buffer }>(tx, 'artifactRead', [digest]);
      return row.rows[0]?.bytes;
    },
  };
}
function release(value: unknown): Release {
  const errors = validateRelease(value);
  if (errors.length) catalogueFail('invalid', `Invalid bounded Release1: ${JSON.stringify(errors)}`);
  return value as Release; // Original package validator owns Release admission and historical compatibility.
}
function admit(kind: CatalogueArtifactKind, value: unknown) {
  switch (kind) {
    case 'root':
      return parseCatalogueRoot(value);
    case 'node':
      return parseCatalogueNode(value);
    case 'declaration': {
      const declaration = parseKindDeclaration(value);
      requireConstructibleKind(declaration);
      return declaration;
    }
    case 'release':
      return release(value);
  }
}
/** One bounded addressed artifact. Identity is computed here; submitted digests never certify bytes. */
export async function publishCatalogueArtifact(
  pool: Pool,
  options: WriteOptions & { kind: CatalogueArtifactKind; artifact: unknown },
) {
  const invocation = cataloguePublisherInvocation(pool, 'artifact', options.deadline);
  // Snapshot inert input before any await. All durable writes and receipts follow fresh command authorization.
  const bytes = catalogueBytes(options.artifact);
  const maximum =
    options.kind === 'release'
      ? RELEASE_LIMITS.bytes
      : options.kind === 'declaration'
        ? CATALOGUE_LIMITS.declarationBytes
        : CATALOGUE_LIMITS.nodeBytes;
  if (bytes.length > maximum) catalogueFail('invalid', 'Artifact exceeds its original byte bound');
  const digest = catalogueDigest(bytes);
  return result(
    await invocation.run(
      digest,
      commandOptions(options, 'definition_catalogues.publish_artifact', 'definitions:publish'),
      async (tx, { transactionId }) => {
        // Decode/check inside authorized command, preserving denial-before-receipt semantics.
        const value = await cataloguePublisherControl(tx, 'artifactDecode', () =>
          readCatalogueArtifact({ read: async () => bytes }, digest, maximum),
        );
        if (options.kind === 'release') {
          const admission = releaseAdmission(value);
          if (admission.length) throw new DefinitionInputError(admission);
          const caps = publicationLimits(value);
          // Same native exemption as small Release publication: an indexed existing original Release, never a flag.
          if (caps.length && !(await readRelease(tx, digest, { composed: false })))
            throw new DefinitionInputError(caps);
        }
        await cataloguePublisherControl(tx, 'artifactValidate', async () => admit(options.kind, value));
        const inserted = await cataloguePublisherQuery(tx, 'artifactInsert', [
          digest,
          options.kind,
          Buffer.from(bytes),
          transactionId,
        ]);
        if (!inserted.rowCount) {
          const existing = await cataloguePublisherQuery<{ kind: string; bytes: Buffer }>(tx, 'artifactConflict', [
            digest,
          ]);
          if (existing.rows[0]?.kind !== options.kind || !existing.rows[0].bytes.equals(Buffer.from(bytes)))
            catalogueFail('conflict', 'Addressed artifact conflict');
        }
        return {
          value: { digest, created: !!inserted.rowCount },
          events: [event(CATALOGUE_ARTIFACT, { digest, kind: options.kind })],
        };
      },
    ),
  );
}
export async function startCatalogueBuild(pool: Pool, options: WriteOptions & { pin: KindCataloguePin }) {
  const invocation = cataloguePublisherInvocation(pool, 'build', options.deadline);
  const pin = parseCataloguePin(options.pin);
  return result(
    await invocation.run(
      pin.rootDigest,
      commandOptions(options, 'definition_catalogues.build', 'definitions:publish'),
      async (tx, { transactionId }, work) => {
        const root = await cataloguePublisherControl(tx, 'rootDecode', async () =>
          parseCatalogueRoot(
            await readCatalogueArtifact(catalogueArtifactReader(tx), pin.rootDigest, CATALOGUE_LIMITS.nodeBytes),
          ),
        );
        const inserted = await cataloguePublisherQuery(tx, 'buildInsert', [pin.rootDigest, pin, transactionId]);
        if (inserted.rowCount) {
          await registerCatalogueRoot(tx, pin.rootDigest, transactionId, work);
          const task = await cataloguePublisherQuery<{ task_id: string }>(tx, 'firstTask', [
            pin.rootDigest,
            root.directoryDigest,
          ]);
          await cataloguePublisherQuery(tx, 'buildNext', [pin.rootDigest, task.rows[0]!.task_id]);
        }
        const value = await readCatalogueBuild(tx, pin);
        return { value: value!, events: [event(CATALOGUE_BUILD_REQUESTED, { rootDigest: pin.rootDigest })] };
      },
    ),
  );
}
export async function readCatalogueBuild(
  tx: CommandTransaction,
  pin: KindCataloguePin,
): Promise<CatalogueBuildStatus | null> {
  return (await cataloguePublisherQuery<CatalogueBuildStatus>(tx, 'buildStatus', [pin.rootDigest])).rows[0] ?? null;
}
async function identity(tx: CommandTransaction, root: string, name: string, body: unknown) {
  const digest = await cataloguePublisherControl(tx, 'memberIdentity', async () =>
    catalogueDigest(catalogueBytes(body)),
  );
  const saved = await cataloguePublisherQuery<{ identity: Buffer; digest: string }>(tx, 'identityUpsert', [
    root,
    catalogueKey(name),
    Buffer.from(name),
    digest,
  ]);
  if (saved.rows[0]?.identity.toString('utf8') !== name || saved.rows[0].digest !== digest)
    catalogueFail('conflict', `Conflicting immutable identity ${name}`);
}
async function nodeStep(tx: CommandTransaction, root: string, task: Task): Promise<number> {
  const node = await cataloguePublisherControl(tx, 'nodeDecode', async () =>
    parseCatalogueNode(
      await readCatalogueArtifact(catalogueArtifactReader(tx), task.digest, CATALOGUE_LIMITS.nodeBytes),
    ),
  );
  const range = catalogueNodeRange(node);
  if (
    task.first_key !== null &&
    (range.first !== task.first_key.toString('utf8') || range.last !== task.last_key?.toString('utf8'))
  )
    catalogueFail('corrupt', 'Inexact child directory range');
  let next = task.next_node;
  if (node.node === 'branch') {
    // Durable DFS stack, reversed insertion: visit every sibling in exact package order, regardless of height.
    for (const child of [...node.children].reverse()) {
      const added = await cataloguePublisherQuery<{ task_id: string }>(tx, 'branchTask', [
        root,
        child.digest,
        Buffer.from(child.first),
        Buffer.from(child.last),
        next,
      ]);
      if (!added.rowCount) catalogueFail('conflict', 'Repeated directory subtree or cycle');
      next = added.rows[0]!.task_id;
    }
  } else {
    // task_id ordinals capture declaration ID order without indexing unbounded text IDs in a B-tree.
    for (const entry of node.entries)
      await cataloguePublisherQuery(tx, 'leafTask', [root, entry.kind, entry.digest, Buffer.from(entry.key)]);
  }
  await cataloguePublisherQuery(tx, 'nodeProgress', [root, next]);
  await cataloguePublisherQuery(tx, 'taskDone', [root, task.task_id]);
  return node.node === 'branch' ? node.children.length : node.entries.length;
}
async function releaseStep(tx: CommandTransaction, root: string, task: Task): Promise<number> {
  const body = await cataloguePublisherControl(tx, 'releaseDecode', async () =>
    release(await readCatalogueArtifact(catalogueArtifactReader(tx), task.digest, RELEASE_LIMITS.bytes)),
  );
  if (releaseDigest(body) !== task.digest || task.entry_key?.toString('utf8') !== `release:${task.digest}`)
    catalogueFail('corrupt', 'Release directory identity mismatch');
  if (task.offset_rows === 0)
    await identity(tx, root, `release:${JSON.stringify([body.catalogue.id, body.catalogue.version])}`, body);
  // Sorting is confined to ONE original bounded Release, never the logical catalogue.
  const members = [
    ...Object.entries(body.types).map(([id, body]) => ({ category: 'type', id, body })),
    ...Object.entries(body.properties).map(([id, body]) => ({ category: 'property', id, body })),
    ...Object.entries(body.libraryProfiles ?? {}).map(([id, body]) => ({ category: 'profile', id, body })),
  ];
  const page = members.slice(task.offset_rows, task.offset_rows + 64);
  for (const member of page) {
    await identity(tx, root, `${member.category}:${member.id}`, member.body);
    const saved = await cataloguePublisherQuery<{ id: Buffer }>(tx, 'memberInsert', [
      root,
      task.digest,
      member.category,
      catalogueKey(member.id),
      Buffer.from(member.id),
      member.body,
    ]);
    if (!saved.rowCount) catalogueFail('conflict', 'Repeated member or identity hash collision');
  }
  const done = task.offset_rows + page.length === members.length;
  await cataloguePublisherQuery(tx, 'taskOffset', [root, task.task_id, page.length, done]);
  if (done) await cataloguePublisherQuery(tx, 'releaseProgress', [root]);
  return page.length * 2;
}
async function typeClosure(tx: CommandTransaction, root: string, digest: string, id: string) {
  const member = (
    await cataloguePublisherQuery<{ id: Buffer; body: TypeDefinition }>(tx, 'typeClosure', [
      root,
      digest,
      catalogueKey(id),
    ])
  ).rows[0];
  if (member?.id.toString('utf8') !== id) catalogueFail('missing', `Missing exact Type closure ${digest}/${id}`);
  if (member.body.library) {
    const profileId = member.body.library.profileId;
    const profile = (
      await cataloguePublisherQuery<{ id: Buffer }>(tx, 'profileClosure', [root, digest, catalogueKey(profileId)])
    ).rows[0];
    if (profile?.id.toString('utf8') !== profileId) catalogueFail('missing', 'Missing exact presentation profile');
  }
}
async function declarationStep(tx: CommandTransaction, root: string, task: Task): Promise<number> {
  const body = await cataloguePublisherControl(tx, 'declarationDecode', async () =>
    parseKindDeclaration(
      await readCatalogueArtifact(catalogueArtifactReader(tx), task.digest, CATALOGUE_LIMITS.declarationBytes),
    ),
  );
  requireConstructibleKind(body);
  if (body.condition.op !== 'exact-type') catalogueFail('unsupported', 'Unsupported native condition');
  if (task.entry_key?.toString('utf8') !== declarationKey(body.id))
    catalogueFail('corrupt', 'Declaration key mismatch');
  if (task.offset_rows === 0) {
    for (const pin of [body.condition.type, body.presentation.type])
      await typeClosure(tx, root, pin.releaseDigest, pin.typeId);
    const inserted = await cataloguePublisherQuery(tx, 'kindInsert', [
      root,
      catalogueKey(body.id),
      Buffer.from(body.id),
      task.task_id,
      task.digest,
      body,
      catalogueKey(body.condition.type.typeId),
      Buffer.from(body.condition.type.typeId),
      body.auto.precedence,
      body.auto.eligible,
    ]);
    if (!inserted.rowCount) catalogueFail('conflict', 'Duplicate declaration identity');
  }
  const labels = Object.entries(body.labels);
  const page = labels.slice(task.offset_rows, task.offset_rows + 64);
  for (const [language, label] of page)
    await cataloguePublisherQuery(tx, 'labelInsert', [
      root,
      catalogueKey(language),
      language,
      catalogueSort(label),
      task.task_id,
      catalogueKey(body.id),
    ]);
  const done = task.offset_rows + page.length === labels.length;
  await cataloguePublisherQuery(tx, 'taskOffset', [root, task.task_id, page.length, done]);
  if (done) await cataloguePublisherQuery(tx, 'declarationProgress', [root]);
  return page.length + (task.offset_rows === 0 ? 1 : 0);
}
/** Mechanical continuation of the immutable, already authorized input, never a restored publisher Actor. */
export async function advanceCatalogueBuild(
  tx: CommandTransaction,
  pin: KindCataloguePin,
): Promise<CatalogueBuildStatus> {
  const root = pin.rootDigest;
  let build = (await cataloguePublisherQuery<Build>(tx, 'buildLock', [root])).rows[0];
  if (!build) throw new DefinitionNotFoundError();
  if (build.state === 'ready' || build.state === 'refused') {
    const { next_node, ...status } = build;
    return status;
  }
  await cataloguePublisherQuery(tx, 'stepSavepoint');
  let examined = 0;
  try {
    let task: Task | undefined;
    if (build.phase === 'node' && build.next_node !== null)
      task = (await cataloguePublisherQuery<Task>(tx, 'nodeTask', [root, build.next_node])).rows[0];
    if (!task && build.phase === 'node') {
      await cataloguePublisherQuery(tx, 'phaseRelease', [root]);
      build.phase = 'release';
    }
    if (!task && build.phase === 'release') {
      task = (await cataloguePublisherQuery<Task>(tx, 'releaseTask', [root])).rows[0];
      if (!task) {
        if (build.releases === '0') catalogueFail('invalid', 'Catalogue contains no bounded Release members');
        await cataloguePublisherQuery(tx, 'phaseDeclaration', [root]);
        build.phase = 'declaration';
      }
    }
    if (!task && build.phase === 'declaration')
      task = (await cataloguePublisherQuery<Task>(tx, 'declarationTask', [root])).rows[0];
    let rows = 0;
    if (task) {
      const saved = await cataloguePublisherQuery<{ size: number; kind: string }>(tx, 'artifactSize', [task.digest]);
      if (!saved.rows[0]) {
        await cataloguePublisherQuery(tx, 'buildMissing', [root, task.digest]);
        await cataloguePublisherQuery(tx, 'stepRelease');
        return (await readCatalogueBuild(tx, pin))!;
      }
      examined = saved.rows[0].size;
      if (saved.rows[0].kind !== task.kind) catalogueFail('corrupt', 'Artifact kind disagrees with directory');
      rows =
        task.kind === 'node'
          ? await nodeStep(tx, root, task)
          : task.kind === 'release'
            ? await releaseStep(tx, root, task)
            : await declarationStep(tx, root, task);
    }
    await cataloguePublisherQuery(tx, 'buildProgress', [root, task ? 'building' : 'ready', rows, examined]);
    await cataloguePublisherQuery(tx, 'stepRelease');
  } catch (error) {
    if (!(error instanceof CatalogueArtifactError)) throw error;
    await cataloguePublisherQuery(tx, 'stepRollback');
    await cataloguePublisherQuery(tx, 'stepRelease');
    await cataloguePublisherQuery(
      tx,
      'buildRefused',
      // Code-point truncation keeps valid Unicode and at most 6 KiB of escaped JSON in the status projection.
      [
        root,
        Array.from(`${error.code}: ${error.message}`.replaceAll('\0', '\\u0000')).slice(0, 1024).join(''),
        examined,
      ],
    );
  }
  return (await readCatalogueBuild(tx, pin))!;
}
export async function stepCatalogueBuild(pool: Pool, options: WriteOptions & { pin: KindCataloguePin }) {
  const invocation = cataloguePublisherInvocation(pool, 'step', options.deadline);
  const pin = parseCataloguePin(options.pin);
  return result(
    await invocation.run(
      pin.rootDigest,
      commandOptions(options, 'definition_catalogues.step', 'definitions:publish'),
      async (tx) => {
        const value = await advanceCatalogueBuild(tx, pin);
        return {
          value,
          events: [event(CATALOGUE_PROGRESS, { rootDigest: pin.rootDigest, state: value.state, steps: value.steps })],
        };
      },
    ),
  );
}
export async function runCatalogueBuildStep(pool: Pool, pin: KindCataloguePin, clock: () => Date, position = '0') {
  const invocation = cataloguePublisherInvocation(pool, 'step');
  const parsed = parseCataloguePin(pin);
  return (
    await invocation.run(parsed.rootDigest, { partition: 0, clock }, async (tx) => {
      // Public steps and the scheduler share this lock. The committed build identity
      // and selected position identify a single native mutation/result association.
      const build = (await cataloguePublisherQuery<Build>(tx, 'buildLock', [parsed.rootDigest])).rows[0];
      if (!build) throw new DefinitionNotFoundError();
      const job = await cataloguePublisherQuery<{ recorded_transaction_id: string }>(tx, 'buildIdentity', [
        parsed.rootDigest,
      ]);
      const value = await catalogueCheckpoint(
        tx,
        { root: parsed.rootDigest, phase: 'step', jobId: job.rows[0]!.recorded_transaction_id, position },
        async () => {
          if (BigInt(position) > BigInt(build.steps))
            catalogueFail('conflict', 'Catalogue position is ahead of committed progress');
          return BigInt(position) < BigInt(build.steps)
            ? (await readCatalogueBuild(tx, parsed))!
            : advanceCatalogueBuild(tx, parsed);
        },
      );
      return { value, events: [] };
    })
  ).value;
}
/** A bounded mechanical step consumes only the durable authorized activation intent.
 * It cannot finish publication: that requires a new actual definitions:activate command.
 */
export async function runCatalogueActivationStep(
  pool: Pool,
  pin: KindCataloguePin,
  activationId: string,
  clock: () => Date,
  position = '0',
) {
  const invocation = cataloguePublisherInvocation(pool, 'activation-step');
  const parsed = parseCataloguePin(pin);
  return (
    await invocation.run(parsed.rootDigest, { partition: 0, clock }, async (tx, _context, work) => {
      // Head/root order is shared with enrollment and all activation callers.
      await lockCatalogueEnrollment(tx, parsed.rootDigest, work);
      const value = await catalogueCheckpoint(
        tx,
        { root: parsed.rootDigest, phase: 'activation-step', jobId: activationId, position },
        async () => {
          const progress = await advanceCatalogueActivation(tx, parsed.rootDigest, activationId, work);
          return progress.state === 'closing'
            ? advanceCatalogueActivation(tx, parsed.rootDigest, activationId, work)
            : progress;
        },
      );
      return { value, events: [] };
    })
  ).value;
}

export async function activateCatalogue(
  pool: Pool,
  options: WriteOptions & { pin: KindCataloguePin; expectedHead: number | null },
) {
  const invocation = cataloguePublisherInvocation(pool, 'activate', options.deadline);
  const pin = parseCataloguePin(options.pin);
  const command = await invocation.run(
    pin.rootDigest,
    commandOptions(options, 'definition_catalogues.activate', 'definitions:activate'),
    async (tx, { transactionId }, work) => {
      const build = await readCatalogueBuild(tx, pin);
      if (!build) throw new DefinitionNotFoundError();
      if (build.state !== 'ready') catalogueFail('missing', 'Catalogue indexes are not complete');
      const activation = await requestCatalogueActivation(tx, pin, options.expectedHead ?? 0, transactionId, work);
      const first = await advanceCatalogueActivation(tx, pin.rootDigest, activation.activation_id, work);
      if (first.state === 'closing')
        await advanceCatalogueActivation(tx, pin.rootDigest, activation.activation_id, work);
      const head = await finishCatalogueActivation(tx, pin, activation.activation_id, transactionId, work);
      if (head !== null) await advanceCatalogueRetirement(tx, pin.rootDigest, work);
      return {
        value: { pin, head },
        events: [
          head === null
            ? event(CATALOGUE_ACTIVATION_REQUESTED, {
                rootDigest: pin.rootDigest,
                activationId: activation.activation_id,
              })
            : event(CATALOGUE_ACTIVATED, {
                rootDigest: pin.rootDigest,
                head,
                kindSpec: pin.kindSpec,
                reduction: pin.reduction,
              }),
        ],
      };
    },
  );
  // Pending progress, receipt and wakeup commit together. Throwing inside the
  // command would roll back the close and lose the retained withdrawal cut.
  // A replay preserves this result; fresh final authorization uses a fresh key.
  if (command.value.head === null) catalogueFail('missing', 'Catalogue dependency withdrawal is pending');
  return result({ ...command, value: { pin: command.value.pin, head: command.value.head! } });
}
