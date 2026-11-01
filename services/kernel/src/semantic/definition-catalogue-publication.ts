import type { Pool } from 'pg';
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
  StaleEditorialHeadError,
  type WriteOptions,
} from './definitions.ts';
import { CATALOGUE_BUILD_REQUESTED, CATALOGUE_PROGRESS, CATALOGUE_ACTIVATED, CATALOGUE_ARTIFACT } from './events.ts';

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
  entry_key: string | null;
  first_key: string | null;
  last_key: string | null;
  next_node: string | null;
  offset_rows: number;
};
const progressColumns =
  'pin,state,phase,steps,nodes,releases,declarations,indexed_rows,examined_bytes,missing_digest,error';
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
      const row = await tx.query<{ bytes: Buffer }>(
        'SELECT bytes FROM semantic.definition_catalogue_artifact WHERE route=0 AND digest=$1',
        [digest],
      );
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
    await runCommand(
      pool,
      commandOptions(options, 'definition_catalogues.publish_artifact', 'definitions:publish'),
      async (tx, { transactionId }) => {
        // Decode/check inside authorized command, preserving denial-before-receipt semantics.
        const value = await readCatalogueArtifact({ read: async () => bytes }, digest, maximum);
        if (options.kind === 'release') {
          const admission = releaseAdmission(value);
          if (admission.length) throw new DefinitionInputError(admission);
          const caps = publicationLimits(value);
          // Same native exemption as small Release publication: an indexed existing original Release, never a flag.
          if (caps.length && !(await readRelease(tx, digest, { composed: false })))
            throw new DefinitionInputError(caps);
        }
        admit(options.kind, value);
        const inserted = await tx.query(
          `INSERT INTO semantic.definition_catalogue_artifact(route,digest,kind,bytes,recorded_transaction_id)
       VALUES(0,$1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING digest`,
          [digest, options.kind, Buffer.from(bytes), transactionId],
        );
        if (!inserted.rowCount) {
          const existing = await tx.query<{ kind: string; bytes: Buffer }>(
            'SELECT kind,bytes FROM semantic.definition_catalogue_artifact WHERE route=0 AND digest=$1',
            [digest],
          );
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
  const pin = parseCataloguePin(options.pin);
  return result(
    await runCommand(
      pool,
      commandOptions(options, 'definition_catalogues.build', 'definitions:publish'),
      async (tx, { transactionId }) => {
        const root = parseCatalogueRoot(
          await readCatalogueArtifact(catalogueArtifactReader(tx), pin.rootDigest, CATALOGUE_LIMITS.nodeBytes),
        );
        const inserted = await tx.query(
          `INSERT INTO semantic.definition_catalogue_build(route,root_digest,pin,state,recorded_transaction_id)
       VALUES(0,$1,$2,'building',$3) ON CONFLICT DO NOTHING RETURNING root_digest`,
          [pin.rootDigest, pin, transactionId],
        );
        if (inserted.rowCount) {
          const task = await tx.query<{ task_id: string }>(
            `INSERT INTO semantic.definition_catalogue_task(route,root_digest,kind,digest)
         VALUES(0,$1,'node',$2) RETURNING task_id`,
            [pin.rootDigest, root.directoryDigest],
          );
          await tx.query(
            'UPDATE semantic.definition_catalogue_build SET next_node=$2 WHERE route=0 AND root_digest=$1',
            [pin.rootDigest, task.rows[0]!.task_id],
          );
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
  return (
    (
      await tx.query<CatalogueBuildStatus>(
        `SELECT ${progressColumns} FROM semantic.definition_catalogue_build WHERE route=0 AND root_digest=$1`,
        [pin.rootDigest],
      )
    ).rows[0] ?? null
  );
}
async function identity(tx: CommandTransaction, root: string, name: string, body: unknown) {
  const digest = catalogueDigest(catalogueBytes(body));
  const saved = await tx.query<{ identity: string; digest: string }>(
    `INSERT INTO semantic.definition_catalogue_identity(route,root_digest,identity_key,identity,digest)
     VALUES(0,$1,$2,$3,$4) ON CONFLICT(route,root_digest,identity_key) DO UPDATE
     SET digest=semantic.definition_catalogue_identity.digest RETURNING identity,digest`,
    [root, catalogueKey(name), name, digest],
  );
  if (saved.rows[0]?.identity !== name || saved.rows[0].digest !== digest)
    catalogueFail('conflict', `Conflicting immutable identity ${name}`);
}
async function nodeStep(tx: CommandTransaction, root: string, task: Task): Promise<number> {
  const node = parseCatalogueNode(
    await readCatalogueArtifact(catalogueArtifactReader(tx), task.digest, CATALOGUE_LIMITS.nodeBytes),
  );
  const range = catalogueNodeRange(node);
  if (task.first_key !== null && (range.first !== task.first_key || range.last !== task.last_key))
    catalogueFail('corrupt', 'Inexact child directory range');
  let next = task.next_node;
  if (node.node === 'branch') {
    // Durable DFS stack, reversed insertion: visit every sibling in exact package order, regardless of height.
    for (const child of [...node.children].reverse()) {
      const added = await tx.query<{ task_id: string }>(
        `INSERT INTO semantic.definition_catalogue_task(route,root_digest,kind,digest,first_key,last_key,next_node)
         VALUES(0,$1,'node',$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING task_id`,
        [root, child.digest, child.first, child.last, next],
      );
      if (!added.rowCount) catalogueFail('conflict', 'Repeated directory subtree or cycle');
      next = added.rows[0]!.task_id;
    }
  } else {
    // task_id ordinals capture declaration ID order without indexing unbounded text IDs in a B-tree.
    for (const entry of node.entries)
      await tx.query(
        `INSERT INTO semantic.definition_catalogue_task(route,root_digest,kind,digest,entry_key) VALUES(0,$1,$2,$3,$4)`,
        [root, entry.kind, entry.digest, entry.key],
      );
  }
  await tx.query(
    'UPDATE semantic.definition_catalogue_build SET next_node=$2,nodes=nodes+1 WHERE route=0 AND root_digest=$1',
    [root, next],
  );
  await tx.query(
    'UPDATE semantic.definition_catalogue_task SET done=true WHERE route=0 AND root_digest=$1 AND task_id=$2',
    [root, task.task_id],
  );
  return node.node === 'branch' ? node.children.length : node.entries.length;
}
async function releaseStep(tx: CommandTransaction, root: string, task: Task): Promise<number> {
  const body = release(await readCatalogueArtifact(catalogueArtifactReader(tx), task.digest, RELEASE_LIMITS.bytes));
  if (releaseDigest(body) !== task.digest || task.entry_key !== `release:${task.digest}`)
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
    const saved = await tx.query<{ id: string }>(
      `INSERT INTO semantic.definition_catalogue_member(route,root_digest,release_digest,category,id_key,id,body)
       VALUES(0,$1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING id`,
      [root, task.digest, member.category, catalogueKey(member.id), member.id, member.body],
    );
    if (!saved.rowCount) catalogueFail('conflict', 'Repeated member or identity hash collision');
  }
  const done = task.offset_rows + page.length === members.length;
  await tx.query(
    'UPDATE semantic.definition_catalogue_task SET offset_rows=offset_rows+$3,done=$4 WHERE route=0 AND root_digest=$1 AND task_id=$2',
    [root, task.task_id, page.length, done],
  );
  if (done)
    await tx.query(
      'UPDATE semantic.definition_catalogue_build SET releases=releases+1 WHERE route=0 AND root_digest=$1',
      [root],
    );
  return page.length * 2;
}
async function typeClosure(tx: CommandTransaction, root: string, digest: string, id: string) {
  const member = (
    await tx.query<{ id: string; body: TypeDefinition }>(
      `SELECT id,body FROM semantic.definition_catalogue_member WHERE route=0 AND root_digest=$1 AND release_digest=$2 AND category='type' AND id_key=$3`,
      [root, digest, catalogueKey(id)],
    )
  ).rows[0];
  if (member?.id !== id) catalogueFail('missing', `Missing exact Type closure ${digest}/${id}`);
  if (member.body.library) {
    const profileId = member.body.library.profileId;
    const profile = (
      await tx.query<{ id: string }>(
        `SELECT id FROM semantic.definition_catalogue_member WHERE route=0 AND root_digest=$1 AND release_digest=$2 AND category='profile' AND id_key=$3`,
        [root, digest, catalogueKey(profileId)],
      )
    ).rows[0];
    if (profile?.id !== profileId) catalogueFail('missing', 'Missing exact presentation profile');
  }
}
async function declarationStep(tx: CommandTransaction, root: string, task: Task): Promise<number> {
  const body = parseKindDeclaration(
    await readCatalogueArtifact(catalogueArtifactReader(tx), task.digest, CATALOGUE_LIMITS.declarationBytes),
  );
  requireConstructibleKind(body);
  if (body.condition.op !== 'exact-type') catalogueFail('unsupported', 'Unsupported native condition');
  if (task.entry_key !== declarationKey(body.id)) catalogueFail('corrupt', 'Declaration key mismatch');
  if (task.offset_rows === 0) {
    for (const pin of [body.condition.type, body.presentation.type])
      await typeClosure(tx, root, pin.releaseDigest, pin.typeId);
    const inserted = await tx.query(
      `INSERT INTO semantic.definition_catalogue_kind(route,root_digest,id_key,id,ordinal,declaration_digest,body,exact_type_key,exact_type_id,precedence,eligible)
       VALUES(0,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING RETURNING id`,
      [
        root,
        catalogueKey(body.id),
        body.id,
        task.task_id,
        task.digest,
        body,
        catalogueKey(body.condition.type.typeId),
        body.condition.type.typeId,
        body.auto.precedence,
        body.auto.eligible,
      ],
    );
    if (!inserted.rowCount) catalogueFail('conflict', 'Duplicate declaration identity');
  }
  const labels = Object.entries(body.labels);
  const page = labels.slice(task.offset_rows, task.offset_rows + 64);
  for (const [language, label] of page)
    await tx.query(
      `INSERT INTO semantic.definition_catalogue_label(route,root_digest,language_key,language,label_sort,ordinal,id_key) VALUES(0,$1,$2,$3,$4,$5,$6)`,
      [root, catalogueKey(language), language, catalogueSort(label), task.task_id, catalogueKey(body.id)],
    );
  const done = task.offset_rows + page.length === labels.length;
  await tx.query(
    'UPDATE semantic.definition_catalogue_task SET offset_rows=offset_rows+$3,done=$4 WHERE route=0 AND root_digest=$1 AND task_id=$2',
    [root, task.task_id, page.length, done],
  );
  if (done)
    await tx.query(
      'UPDATE semantic.definition_catalogue_build SET declarations=declarations+1 WHERE route=0 AND root_digest=$1',
      [root],
    );
  return page.length + (task.offset_rows === 0 ? 1 : 0);
}
/** Mechanical continuation of the immutable, already authorized input, never a restored publisher Actor. */
export async function advanceCatalogueBuild(
  tx: CommandTransaction,
  pin: KindCataloguePin,
): Promise<CatalogueBuildStatus> {
  const root = pin.rootDigest;
  let build = (
    await tx.query<Build>(
      `SELECT ${progressColumns},next_node FROM semantic.definition_catalogue_build WHERE route=0 AND root_digest=$1 FOR UPDATE`,
      [root],
    )
  ).rows[0];
  if (!build) throw new DefinitionNotFoundError();
  if (build.state === 'ready' || build.state === 'refused') {
    const { next_node, ...status } = build;
    return status;
  }
  await tx.query('SAVEPOINT catalogue_step');
  let examined = 0;
  try {
    let task: Task | undefined;
    if (build.phase === 'node' && build.next_node !== null)
      task = (
        await tx.query<Task>(
          'SELECT * FROM semantic.definition_catalogue_task WHERE route=0 AND root_digest=$1 AND task_id=$2',
          [root, build.next_node],
        )
      ).rows[0];
    if (!task && build.phase === 'node') {
      await tx.query(
        "UPDATE semantic.definition_catalogue_build SET phase='release' WHERE route=0 AND root_digest=$1",
        [root],
      );
      build.phase = 'release';
    }
    if (!task && build.phase === 'release') {
      task = (
        await tx.query<Task>(
          "SELECT * FROM semantic.definition_catalogue_task WHERE route=0 AND root_digest=$1 AND kind='release' AND NOT done ORDER BY task_id LIMIT 1",
          [root],
        )
      ).rows[0];
      if (!task) {
        if (build.releases === '0') catalogueFail('invalid', 'Catalogue contains no bounded Release members');
        await tx.query(
          "UPDATE semantic.definition_catalogue_build SET phase='declaration' WHERE route=0 AND root_digest=$1",
          [root],
        );
        build.phase = 'declaration';
      }
    }
    if (!task && build.phase === 'declaration')
      task = (
        await tx.query<Task>(
          "SELECT * FROM semantic.definition_catalogue_task WHERE route=0 AND root_digest=$1 AND kind='declaration' AND NOT done ORDER BY task_id LIMIT 1",
          [root],
        )
      ).rows[0];
    let rows = 0;
    if (task) {
      const saved = await tx.query<{ size: number; kind: string }>(
        'SELECT octet_length(bytes) AS size,kind FROM semantic.definition_catalogue_artifact WHERE route=0 AND digest=$1',
        [task.digest],
      );
      if (!saved.rows[0]) {
        await tx.query(
          "UPDATE semantic.definition_catalogue_build SET state='incomplete',missing_digest=$2,steps=steps+1 WHERE route=0 AND root_digest=$1",
          [root, task.digest],
        );
        await tx.query('RELEASE SAVEPOINT catalogue_step');
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
    await tx.query(
      `UPDATE semantic.definition_catalogue_build SET state=$2,missing_digest=NULL,error=NULL,steps=steps+1,indexed_rows=indexed_rows+$3,examined_bytes=examined_bytes+$4 WHERE route=0 AND root_digest=$1`,
      [root, task ? 'building' : 'ready', rows, examined],
    );
    await tx.query('RELEASE SAVEPOINT catalogue_step');
  } catch (error) {
    if (!(error instanceof CatalogueArtifactError)) throw error;
    await tx.query('ROLLBACK TO SAVEPOINT catalogue_step');
    await tx.query('RELEASE SAVEPOINT catalogue_step');
    await tx.query(
      "UPDATE semantic.definition_catalogue_build SET state='refused',error=$2,steps=steps+1,examined_bytes=examined_bytes+$3 WHERE route=0 AND root_digest=$1",
      [root, `${error.code}: ${error.message}`.slice(0, 4096), examined],
    );
  }
  return (await readCatalogueBuild(tx, pin))!;
}
export async function stepCatalogueBuild(pool: Pool, options: WriteOptions & { pin: KindCataloguePin }) {
  const pin = parseCataloguePin(options.pin);
  return result(
    await runCommand(pool, commandOptions(options, 'definition_catalogues.step', 'definitions:publish'), async (tx) => {
      const value = await advanceCatalogueBuild(tx, pin);
      return {
        value,
        events: [event(CATALOGUE_PROGRESS, { rootDigest: pin.rootDigest, state: value.state, steps: value.steps })],
      };
    }),
  );
}
export async function runCatalogueBuildStep(pool: Pool, pin: KindCataloguePin, clock: () => Date) {
  return (
    await runCommand(pool, { partition: 0, clock }, async (tx) => {
      const value = await advanceCatalogueBuild(tx, parseCataloguePin(pin));
      return {
        value,
        events: [event(CATALOGUE_PROGRESS, { rootDigest: pin.rootDigest, state: value.state, steps: value.steps })],
      };
    })
  ).value;
}
export async function activateCatalogue(
  pool: Pool,
  options: WriteOptions & { pin: KindCataloguePin; expectedHead: number | null },
) {
  const pin = parseCataloguePin(options.pin);
  return result(
    await runCommand(
      pool,
      commandOptions(options, 'definition_catalogues.activate', 'definitions:activate'),
      async (tx, { transactionId }) => {
        const build = await readCatalogueBuild(tx, pin);
        if (!build) throw new DefinitionNotFoundError();
        if (build.state !== 'ready') catalogueFail('missing', 'Catalogue indexes are not complete');
        const saved = await tx.query<{ head: number }>(
          `UPDATE semantic.definition_catalogue_head SET root_digest=$1,head=head+1,recorded_transaction_id=$3 WHERE route=0 AND head=$2 RETURNING head`,
          [pin.rootDigest, options.expectedHead ?? 0, transactionId],
        );
        if (!saved.rows[0]) throw new StaleEditorialHeadError();
        const value = { pin, head: saved.rows[0].head };
        return {
          value,
          events: [
            event(CATALOGUE_ACTIVATED, {
              rootDigest: pin.rootDigest,
              head: value.head,
              kindSpec: pin.kindSpec,
              reduction: pin.reduction,
            }),
          ],
        };
      },
    ),
  );
}
