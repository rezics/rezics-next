import { enrollResourceRecordSources } from './record-purge-custody.ts';
import {
  checkExtensionUpdate,
  extensionDigest,
  termContext,
  validateExtension,
  type Extension,
  type ExtensionViolation,
} from '@rezics/definitions/extension';
import type { Pool } from 'pg';
import { runCommand, type CommandTransaction } from '../command/command.ts';
import { partitionOf } from '../route/route.ts';
import { commandOptions, type WriteOptions } from './definitions.ts';
import { GLOBAL_SUBJECT_CONTEXT as GLOBAL_CONTEXT } from './contract/subject-values.ts';
import { DefinitionNotFoundError, StaleEditorialHeadError } from './contract/definition-values.ts';
import { activeRelease, activeExtension, contextRoute, storedActiveExtension } from './definition-release-read.ts';
import readCommunity from './context-read-community.sql';
import activate from './extension-activate.sql';
import publish from './extension-publish.sql';
import read from './extension-read.sql';

export {
  composedRelease,
  readPublishedExtension,
  activeExtension,
  layeredRelease,
  effectiveRelease,
  propertyContext,
  baseOf,
  readComposedRelease,
} from './definition-release-read.ts';

type Db = Pool | CommandTransaction;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
export class ExtensionInputError extends Error {
  constructor(readonly violations: ExtensionViolation[]) {
    super('Invalid definition extension');
  }
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
  const violations = validateExtension(value, base.release, {
    context,
    sources,
  });
  if (violations.length) throw new ExtensionInputError(violations);
  return value as Extension;
}

function target(context: string) {
  const route = contextRoute(context);
  if (route === null) throw new DefinitionNotFoundError();
  return {
    partition: partitionOf(route),
    resource: { route, id: context },
    route,
  };
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
      await enrollResourceRecordSources(tx, [{ kind: 'context', contextId: options.context }], {
        kind: 'definitions.extension.publish',
      });
      const rows = await publish.run(tx, {
        route: where.route,
        context_id: options.context,
        digest,
        body: extension,
        transaction_id: transactionId,
      });
      return {
        value: { digest, created: rows !== null },
        events: [
          {
            type: 'com.rezics.definitions.published.v1',
            subject: options.context,
            data: { digest },
          },
        ],
      };
    },
  );
  return {
    ...command.value,
    component: {
      partition: command.partition,
      epoch: command.epoch,
      position: command.position,
    },
    replayed: command.replayed,
  };
}

export async function activateExtension(
  pool: Pool,
  options: WriteOptions & {
    context: string;
    extensionDigest: string;
    expectedHead: number | null;
  },
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
      await enrollResourceRecordSources(tx, [{ kind: 'context', contextId: options.context }], {
        kind: 'definitions.extension.activate',
      });
      const row = await read.run(tx, {
        route: where.route,
        context_id: options.context,
        digest,
      });
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
        events: [
          {
            type: 'com.rezics.definitions.activated.v1',
            subject: options.context,
            data: { digest, head },
          },
        ],
      };
    },
  );
  return {
    ...command.value,
    component: {
      partition: command.partition,
      epoch: command.epoch,
      position: command.position,
    },
    replayed: command.replayed,
  };
}
