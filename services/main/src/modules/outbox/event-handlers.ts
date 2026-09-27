import { join, resolve } from 'node:path';
import type { FusekiClient } from '../../infrastructure/fuseki.ts';
import type { MainOutboxBatch } from './relay.ts';

/** System receipts carry an owner-proved graph fact instead of an Access admission. */
export type OwnerEventReceipt = {
  id: string; action: string; outcome: 'succeeded' | 'cancelled'; requestDigest: string;
  [field: string]: unknown;
} & ({ admissionId: string; authorityEpoch: string; scope: string; systemProof?: never }
  | { admissionId?: never; authorityEpoch?: never; scope?: never;
    systemProof: { kind: string; [field: string]: unknown } });

export interface OwnerCloudEvent {
  specversion: '1.0';
  id: string;
  source: 'https://rezics.com/services/main';
  type: string;
  datacontenttype: 'application/json';
  data: {
    batchId: string;
    sourcePosition: { datasetId: 'product'; dataEpoch: string; sequence: string };
    routingEpoch: string;
    ordinal: number;
    receipt: OwnerEventReceipt;
  };
}

export interface OwnerOutboxEventHandler {
  /** Full RDF event class IRI; several outcome kinds may share one action. */
  kind: string;
  action: string;
  /** Exact additional receipt actions sharing this RDF event kind. */
  actions?: readonly string[];
  type: string;
  /** System handlers prove their own graph terminal; omitted means Access admission. */
  authority?: 'system';
  read: (input: { fuseki: FusekiClient; batch: MainOutboxBatch; eventId: string;
    value: (name: string) => string | undefined; ordinal: number }) => Promise<OwnerCloudEvent>;
}

/** Discover owner handlers once at relay startup, as receipt families are discovered. */
export async function discoverOutboxEventHandlers(directory = join(import.meta.dir, '..')) {
  const handlers = new Map<string, OwnerOutboxEventHandler>();
  const types = new Set<string>();
  for (const file of [...new Bun.Glob('*/outbox-event.ts').scanSync({ cwd: directory })].sort()) {
    const module = await import(resolve(directory, file)) as { outboxEventHandlers?: unknown };
    if (!Array.isArray(module.outboxEventHandlers) || module.outboxEventHandlers.length === 0) {
      throw new Error(`Outbox event handler declaration is empty in ${file}`);
    }
    for (const candidate of module.outboxEventHandlers) {
      const handler = candidate as Partial<OwnerOutboxEventHandler>;
      const actions = [handler.action, ...(handler.actions ?? [])];
      if (typeof handler.kind !== 'string' || !/^https:\/\/rezics\.com\/vocab\/[A-Za-z][A-Za-z0-9]*$/.test(handler.kind)
        || !Array.isArray(handler.actions ?? []) || new Set(actions).size !== actions.length
        || actions.some(action => typeof action !== 'string'
          || !/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/.test(action))
        || typeof handler.type !== 'string' || !/^com\.rezics\.[a-z0-9.-]+\.v[1-9][0-9]*$/.test(handler.type)
        || (handler.authority !== undefined && handler.authority !== 'system')
        || typeof handler.read !== 'function' || handlers.has(handler.kind)
        || types.has(handler.type)) {
        throw new Error(`Duplicate or invalid outbox event handler in ${file}`);
      }
      handlers.set(handler.kind, handler as OwnerOutboxEventHandler);
      types.add(handler.type);
    }
  }
  return handlers;
}

const handlers = await discoverOutboxEventHandlers();
export function ownerOutboxEventHandler(kind: string) { return handlers.get(kind); }
