import {
  applyExtension,
  checkExtensionUpdate,
  extensionDigest,
  termContext,
  validateExtension,
  type Extension,
  type ExtensionViolation,
} from '@rezics/definitions/extension';
import { releaseDigest, type Release } from '@rezics/definitions';
import type { Pool } from 'pg';
import { ProblemError } from '../http/problem.ts';
import { runCommand, type CommandTransaction } from '../command/command.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import composite from './composite-read.sql';
import registerComposite from './composite-register.sql';
import readCommunity from './context-read-community.sql';
import {
  activeRelease,
  commandOptions,
  DefinitionNotFoundError,
  freeze,
  GLOBAL_CONTEXT,
  readRelease,
  StaleEditorialHeadError,
  type WriteOptions,
} from './definitions.ts';
import activate from './extension-activate.sql';
import pointer from './extension-active.sql';
import publish from './extension-publish.sql';
import read from './extension-read.sql';

const DIGEST = /^sha256:[0-9a-f]{64}$/;
type Layer = { digest: string; release: Release };
type Db = Pool | CommandTransaction;
/** Extension bodies by digest; a body embeds its Context and is immutable. */
const extensions = new Map<string, Extension>();
/** Composed releases by their own digest, and the digest each (parent, extension) pair composes to. */
const composed = new Map<string, Release>();
const pairs = new Map<string, string>();
/** The published release each composed digest builds on. */
const bases = new Map<string, string>();
/** Composed digests this process has registered, so a stored digest resolves in any process. */
const registered = new Set<string>();

export class ExtensionInputError extends Error {
  constructor(readonly violations: ExtensionViolation[]) {
    super('Invalid definition extension');
  }
}

function contextRoute(context: string): number | null {
  return context === GLOBAL_CONTEXT ? 0 : routeOf(context);
}

async function loadExtension(db: Db, route: number, context: string, digest: string): Promise<Extension | null> {
  const row = await read.run(db, { route, context_id: context, digest });
  if (!row) return null;
  const extension = row.body as Extension;
  if (extensionDigest(extension) !== digest) throw new Error('Stored definition extension digest mismatch');
  freeze(extension);
  extensions.set(digest, extension);
  return extension;
}

/** Current availability and head are point probes; the immutable body is read once per digest per process. */
export async function activeExtension(
  db: Db,
  context: string,
): Promise<{ digest: string; head: number; extension: Extension } | null> {
  const route = contextRoute(context);
  if (route === null || (context !== GLOBAL_CONTEXT && !(await readCommunity.run(db, { route, context_id: context }))))
    throw new ProblemError('not_found');
  return storedActiveExtension(db, route, context);
}

/** Retained definition meaning/birth evidence, never current Context read eligibility. */
async function storedActiveExtension(db: Db, route: number, context: string) {
  const active = await pointer.run(db, { route, context_id: context });
  // A table function types its columns as nullable; the statement returns no row when there is no head.
  if (!active || active.digest === null || active.head === null) return null;
  const { digest, head } = active;
  const extension = extensions.get(digest) ?? (await loadExtension(db, route, context, digest));
  if (!extension) throw new Error('Active definition extension is missing');
  return { digest, head, extension };
}

async function compose(db: Db, parent: Layer, digest: string, extension: Extension, persist: boolean): Promise<Layer> {
  const key = `${parent.digest}|${digest}`;
  let result = pairs.get(key);
  let release = result === undefined ? undefined : composed.get(result);
  if (result === undefined || release === undefined) {
    release = applyExtension(parent.release, extension);
    result = releaseDigest(release);
    freeze(release);
    composed.set(result, release);
    pairs.set(key, result);
    if (result !== parent.digest) bases.set(result, bases.get(parent.digest) ?? parent.digest);
  }
  // Only a digest that a write stores needs a row; reads may run in a read-only transaction.
  if (persist && !registered.has(result)) {
    await registerComposite.run(db, {
      digest: result,
      parent_digest: parent.digest,
      extension_route: contextRoute(extension.context)!,
      extension_context_id: extension.context,
      extension_digest: digest,
    });
    registered.add(result);
  }
  return { digest: result, release };
}

/**
 * `base` as `context` sees it: Global's extension, then the Context's own. Without an extension the base comes back
 * unchanged, so a warm request pays each Context's current availability and extension head probes.
 */
export async function layeredRelease(db: Db, base: Layer, context: string, persist = false): Promise<Layer> {
  let layer = base;
  const global = await activeExtension(db, GLOBAL_CONTEXT);
  if (global) layer = await compose(db, layer, global.digest, global.extension, persist);
  if (context !== GLOBAL_CONTEXT) {
    const own = await activeExtension(db, context);
    if (own) layer = await compose(db, layer, own.digest, own.extension, persist);
  }
  return layer;
}

/**
 * The active release with the terms `context` sees; Global's view is the default. A write passes `persist`, so the
 * composed digest it stores is registered; a read never writes.
 */
export async function effectiveRelease(
  pool: Pool,
  context: string = GLOBAL_CONTEXT,
  persist = false,
): Promise<{ digest: string; head: number; release: Release } | null> {
  const active = await activeRelease(pool);
  if (!active) return null;
  const layer = await layeredRelease(pool, active, context, persist);
  return { ...active, digest: layer.digest, release: layer.release };
}

/** The Context whose extension a statement on `property` would use, when the property is a Context term. */
export function propertyContext(property: string): string | null {
  return termContext(property);
}

/**
 * The published release a digest builds on. A subject's own revisions record this one, so reading the subject in
 * another Context never picks up the relation types of the Context that last edited it.
 */
export function baseOf(digest: string): string {
  return bases.get(digest) ?? digest;
}

export function composedRelease(digest: string): Release | null {
  return composed.get(digest) ?? null;
}

/** Resolve a stored composed digest again, in a process that has not composed it yet. */
export async function readComposedRelease(db: Db, digest: string): Promise<Release | null> {
  const row = await composite.run(db, { digest });
  if (!row) return null;
  const parent = await readRelease(db, row.parent_digest);
  if (!parent) return null;
  const context = row.extension_context_id;
  const extension =
    extensions.get(row.extension_digest) ??
    (await loadExtension(db, row.extension_route, context, row.extension_digest));
  if (!extension) return null;
  const release = applyExtension(parent, extension);
  if (releaseDigest(release) !== digest) throw new Error('Stored composed release digest mismatch');
  freeze(release);
  composed.set(digest, release);
  bases.set(digest, bases.get(row.parent_digest) ?? row.parent_digest);
  return release;
}

async function adoptionSources(db: Db, context: string, value: unknown): Promise<Map<string, Extension>> {
  const sources = new Map<string, Extension>();
  if (context !== GLOBAL_CONTEXT || typeof value !== 'object' || value === null) return sources;
  const terms = (value as { terms?: unknown }).terms;
  if (typeof terms !== 'object' || terms === null) return sources;
  for (const key of Object.keys(terms)) {
    const source = termContext(key);
    if (source === null || source === context || sources.has(source)) continue;
    // A deleted source still proves where an immutable term was born. This does not make that Context readable.
    const route = contextRoute(source);
    const active = route === null ? null : await storedActiveExtension(db, route, source);
    if (active) sources.set(source, active.extension);
  }
  return sources;
}

async function checked(db: Db, context: string, value: unknown): Promise<Extension> {
  const base = await activeRelease(db);
  if (!base) throw new DefinitionNotFoundError();
  const sources = await adoptionSources(db, context, value);
  const violations = validateExtension(value, base.release, { context, sources });
  if (violations.length) throw new ExtensionInputError(violations);
  return value as Extension;
}

function target(context: string) {
  const route = contextRoute(context);
  if (route === null) throw new DefinitionNotFoundError();
  return { partition: partitionOf(route), resource: { route, id: context }, route };
}

async function requireContext(tx: CommandTransaction, context: string, route: number): Promise<void> {
  if (context !== GLOBAL_CONTEXT && !(await readCommunity.run(tx, { route, context_id: context })))
    throw new DefinitionNotFoundError();
}

export async function publishExtension(pool: Pool, options: WriteOptions & { context: string; extension: unknown }) {
  const where = target(options.context);
  // Validate before runCommand can check out a connection, including for a replay.
  const extension = await checked(pool, options.context, options.extension);
  const digest = extensionDigest(extension);
  const command = await runCommand(
    pool,
    commandOptions(options, 'definitions.extension.publish', 'definitions:publish', where),
    async (tx, { transactionId }) => {
      await requireContext(tx, options.context, where.route);
      const rows = await publish.run(tx, {
        route: where.route,
        context_id: options.context,
        digest,
        body: extension,
        transaction_id: transactionId,
      });
      return {
        value: { digest, created: rows !== null },
        events: [{ type: 'com.rezics.definitions.published.v1', subject: options.context, data: { digest } }],
      };
    },
  );
  return {
    ...command.value,
    component: { partition: command.partition, epoch: command.epoch, position: command.position },
    replayed: command.replayed,
  };
}

export async function activateExtension(
  pool: Pool,
  options: WriteOptions & { context: string; extensionDigest: string; expectedHead: number | null },
) {
  const where = target(options.context);
  const command = await runCommand(
    pool,
    commandOptions(options, 'definitions.extension.activate', 'definitions:activate', where),
    async (tx, { transactionId }) => {
      const digest = options.extensionDigest;
      // This runs after command authorization and receipt lookup, even for a malformed digest.
      if (!DIGEST.test(digest)) throw new DefinitionNotFoundError();
      await requireContext(tx, options.context, where.route);
      const row = await read.run(tx, { route: where.route, context_id: options.context, digest });
      if (!row) throw new DefinitionNotFoundError();
      const prior = await activeExtension(tx, options.context);
      if ((prior?.head ?? 0) !== (options.expectedHead ?? 0)) throw new StaleEditorialHeadError();
      const next = await checked(tx, options.context, row.body);
      if (prior) {
        const violations = checkExtensionUpdate(prior.extension, next);
        if (violations.length) throw new ExtensionInputError(violations);
      }
      const rows = await activate.run(tx, {
        route: where.route,
        context_id: options.context,
        digest,
        expected_head: options.expectedHead ?? 0,
        transaction_id: transactionId,
      });
      if (!rows.length) throw new StaleEditorialHeadError();
      const head = rows[0]!.head;
      return {
        value: { digest, head },
        events: [{ type: 'com.rezics.definitions.activated.v1', subject: options.context, data: { digest, head } }],
      };
    },
  );
  return {
    ...command.value,
    component: { partition: command.partition, epoch: command.epoch, position: command.position },
    replayed: command.replayed,
  };
}
