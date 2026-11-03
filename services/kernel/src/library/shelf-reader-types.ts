import type { ShelfTypeKeys } from './shelf-contract.ts';
import { applyShelfTypeDigest, sha256ShelfTypeDigest, type ShelfTypeDigest } from './shelf-type-keys.ts';
import root from './shelf-reader-type-root.sql';
import edge from './shelf-reader-type-edge.sql';
import equal from './shelf-reader-type-equal.sql';
import { ShelfReadUnavailableError } from './shelf-reader-unavailable.ts';

/** Read-only consumer of the installed root/edge/value dictionary; no reservation or allocation. */
export function createShelfTypeLookup(digest: ShelfTypeDigest = sha256ShelfTypeDigest): ShelfTypeKeys['lookup'] {
  return async (client, route, accountId, fullType) => {
    const query = { query: client.query.bind(client) };
    const bytes = Buffer.from(fullType, 'utf8');
    const found = await root.run(query, {
      route,
      account_id: accountId,
      digest: applyShelfTypeDigest(bytes, digest),
    });
    if (found === null) return null;
    async function matches(typeId: string) {
      const value = await equal.run(query, { route, account_id: accountId, type_id: typeId, full_type: fullType });
      if (!value) throw new ShelfReadUnavailableError('complete private type dictionary');
      return value.equal;
    }
    if (await matches(found.typeId)) return found.typeId;
    let nodeId = found.nodeId;
    let terminal: string | null = null;
    // Work follows the input's exact bytes, never the number of dictionary siblings.
    for (let offset = 0; offset < bytes.length; offset += 256) {
      const next = await edge.run(query, {
        route,
        account_id: accountId,
        parent_id: nodeId,
        chunk: bytes.subarray(offset, offset + 256),
      });
      if (next === null) return null;
      nodeId = next.nodeId;
      terminal = next.typeId;
    }
    return terminal !== null && (await matches(terminal)) ? terminal : null;
  };
}

export const lookupShelfType = createShelfTypeLookup();
