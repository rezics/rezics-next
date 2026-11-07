import { applyExtension, extensionDigest, termContext, type Extension } from '@rezics/definitions/extension';
import { releaseDigest, validateRelease, type Release } from '@rezics/definitions';
import { Pool } from 'pg';
import { currentCommand, runCommand, type CommandTransaction } from '../command/command.ts';
import { ProblemError } from '../http/problem-error.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { GLOBAL_SUBJECT_CONTEXT as GLOBAL_CONTEXT } from './contract/subject-values.ts';
import { DefinitionInputError, DefinitionNotFoundError } from './contract/definition-values.ts';
import { freeze } from './core/freeze.ts';
import releaseExists from './definitions-exists.sql';
import { nativeSourceQuery } from './native-source-query.ts';
import releaseRead from './definitions-read.sql';
import releasePointer from './definitions-active.sql';
import composite from './composite-read.sql';
import registerComposite from './composite-register.sql';
import readCommunity from './context-read-community.sql';
import readContextOwner from './context-read-creator.sql';
import pointer from './extension-active.sql';
import read from './extension-read.sql';

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const releases = new Map<string, Release>();
function validated(value: unknown): Release {
  const violations = validateRelease(value);
  if (violations.length) throw new DefinitionInputError(violations);
  return value as Release;
}

/** A cache hit reads the digest only. The cache stores validated, digest-checked bodies, and a release is immutable. */
export async function readRelease(
  pool: Pool | CommandTransaction,
  digest: string,
  options: { composed?: boolean } = {},
): Promise<Release | null> {
  if (DIGEST.exec(digest)?.[0] !== digest) return null;
  const cached = releases.get(digest);
  if (cached) return (await nativeSourceQuery(pool, releaseExists, { route: 0, digest })) ? cached : null;
  const row = await nativeSourceQuery(pool, releaseRead, { route: 0, digest });
  if (!row) return options.composed === false ? null : readComposedRelease(pool, digest);
  const release = validated(row.body);
  if (releaseDigest(release) !== digest) throw new Error('Stored definition release digest mismatch');
  freeze(release);
  releases.set(digest, release);
  return release;
}

export async function activeRelease(
  pool: Pool | CommandTransaction,
): Promise<{ digest: string; head: number; release: Release } | null> {
  const active = await releasePointer.run(pool, { route: 0 });
  if (!active) return null;
  const release = releases.get(active.digest) ?? (await readRelease(pool, active.digest));
  if (!release) throw new Error('Active definition release is missing');
  return { ...active, release };
}

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

/** Compatibility cache probe. Current Context custody requires the asynchronous native read below. */
export function composedRelease(_digest: string): Release | null {
  return null;
}

export function contextRoute(context: string): number | null {
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

/** Independently reread one published extension body; never the current head. */
export async function readPublishedExtension(db: Db, context: string, digest: string): Promise<Extension | null> {
  const route = contextRoute(context);
  if (route === null || DIGEST.exec(digest)?.[0] !== digest) return null;
  if (context !== GLOBAL_CONTEXT && !(await readCommunity.run(db, { route, context_id: context }))) return null;
  return loadExtension(db, route, context, digest);
}

/** Current availability and head are point probes; the immutable body is read once per digest per process. */
export async function activeExtension(
  db: Db,
  context: string,
): Promise<{ digest: string; head: number; extension: Extension } | null> {
  const route = contextRoute(context);
  if (route === null || (context !== GLOBAL_CONTEXT && !(await readCommunity.run(db, { route, context_id: context }))))
    throw new ProblemError('not_found');
  if (context !== GLOBAL_CONTEXT && !(await readContextOwner.run(db, { route, context_id: context })))
    throw new ProblemError('not_found');
  return storedActiveExtension(db, route, context);
}

/** Retained definition meaning/birth evidence, never current Context read eligibility. */
export async function storedActiveExtension(db: Db, route: number, context: string) {
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
    const input = {
      digest: result,
      parent_digest: parent.digest,
      extension_route: contextRoute(extension.context)!,
      extension_context_id: extension.context,
      extension_digest: digest,
    };
    if (db instanceof Pool) {
      // A persisted derived key belongs to the extension home, with its own committed source event.
      await runCommand(db, { partition: partitionOf(input.extension_route) }, async (tx) => {
        const owner = await activeExtension(tx, extension.context);
        if (!owner || owner.digest !== digest) throw new DefinitionNotFoundError();
        await registerComposite.run(tx, input);
        return {
          value: null,
          events: [
            {
              type: 'com.rezics.semantic.composite.registered.v1',
              data: { context: extension.context, digest: result },
            },
          ],
        };
      });
    } else {
      if (currentCommand(db).partition !== partitionOf(input.extension_route))
        throw new TypeError('Composite registration requires its extension home');
      await registerComposite.run(db, input);
    }
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

/** Resolve a stored composed digest again, in a process that has not composed it yet. */
export async function readComposedRelease(db: Db, digest: string): Promise<Release | null> {
  const row = await composite.run(db, { digest });
  if (!row) return null;
  const parent = await readRelease(db, row.parent_digest);
  if (!parent) return null;
  const context = row.extension_context_id;
  if (context !== GLOBAL_CONTEXT) {
    if (!(await readContextOwner.run(db, { route: row.extension_route, context_id: context }))) return null;
    // A warm body is not current authority. Retain the current communal extension; an older private body
    // needs its actual live source, even while physical minimization is paused.
    const eligible = await db.query(
      `SELECT 1 FROM semantic.context_extension e WHERE e.route=$1 AND e.context_id=$2 AND e.digest=$3 AND (
        EXISTS (SELECT 1 FROM semantic.context_extension_head(e.route,e.context_id) h WHERE h.digest=e.digest)
        OR EXISTS (SELECT 1 FROM editorial.write_basis b JOIN access.account a
          ON a.route=((get_byte(uuid_send(b.principal_id),10)*256)+get_byte(uuid_send(b.principal_id),11))
          AND a.account_id=b.principal_id AND a.state='active' AND NOT a.authn_fenced
          WHERE b.partition_no=e.route/16 AND b.transaction_id=e.recorded_transaction_id AND b.principal_kind='account'))`,
      [row.extension_route, context, row.extension_digest],
    );
    if (!eligible.rowCount) return null;
  }
  const cached = composed.get(digest);
  if (cached) return cached;
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
