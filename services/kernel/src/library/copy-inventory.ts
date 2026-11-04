import type { Pool, PoolClient } from 'pg';
import type { Release } from '@rezics/definitions';
import { readRelease } from '../semantic/definitions.ts';
import { chooseLabel } from '../semantic/language.ts';
import { decodeLibraryProfilePin } from './profile-pin.ts';
import { resolveLibraryProfilePin } from './profile.ts';
import optionsQuery from './copy-inventory-options.sql';
import { deadlineClient } from '../access/authenticate.ts';
import { withConnection } from '../database/pool.ts';

export const MAX_COPY_FILTER_OPTIONS = 64;
const MAX_COPY_FILTER_OPTIONS_BYTES = 65_536;

export type CopyInventoryChoice = Readonly<{
  id: string;
  label: string;
  labelLanguage?: string;
  meaning: 'available' | 'unsupported' | 'unavailable';
}>;
export type CopyInventoryFacet = Readonly<{
  state: 'available' | 'unavailable';
  choices: readonly CopyInventoryChoice[];
}>;
export type CopyInventory = Readonly<{
  kinds: CopyInventoryFacet;
  statuses: CopyInventoryFacet;
}>;
export type CopyInventoryValue = Readonly<{
  dimension: 'kind' | 'status';
  id: string;
  copyId: string;
  copyKind: string | null;
  profilePin: unknown;
}>;
export type CopyInventorySnapshot = Readonly<{ digest: string; release: Release }> | null;

function queryClient(client: Pick<PoolClient, 'query'>) {
  return { query: client.query.bind(client) };
}

/** Bounded distinct value seeks; the owner home remains the caller's already admitted transaction. */
export async function readCopyInventoryValues(
  client: Pick<PoolClient, 'query'>,
  route: number,
  accountId: string,
): Promise<CopyInventoryValue[]> {
  return optionsQuery.run(queryClient(client), {
    route,
    account_id: accountId,
    limit: MAX_COPY_FILTER_OPTIONS + 1,
  });
}

function unavailableFacet(): CopyInventoryFacet {
  return { state: 'unavailable', choices: [] };
}

function selectedLabel(
  row: CopyInventoryValue,
  snapshots: ReadonlyMap<string, CopyInventorySnapshot>,
  languages: readonly string[],
): CopyInventoryChoice {
  const unknown = { id: row.id, label: row.id, meaning: 'unavailable' } as const;
  let pin;
  try {
    pin = decodeLibraryProfilePin(row.profilePin);
  } catch {
    return unknown;
  }
  if (!pin) return unknown;
  const snapshot = snapshots.get(pin.releaseDigest);
  if (!snapshot) return unknown;
  const profile = resolveLibraryProfilePin(snapshot, pin);
  if (!profile) return unknown;
  const candidate =
    row.dimension === 'kind'
      ? profile.copies?.kinds.find((kind) => kind.id === row.id)
      : profile.copies?.kinds.find((kind) => kind.id === row.copyKind)?.statuses.find((status) => status.id === row.id);
  if (!candidate) return { id: row.id, label: row.id, meaning: 'unsupported' };
  const label = chooseLabel(candidate.labels, languages);
  if (!label || new TextEncoder().encode(label.value).byteLength > 256)
    return { id: row.id, label: row.id, meaning: 'unavailable' };
  return { id: row.id, label: label.value, labelLanguage: label.language, meaning: 'available' };
}

function facet(
  dimension: CopyInventoryValue['dimension'],
  values: readonly CopyInventoryValue[],
  snapshots: ReadonlyMap<string, CopyInventorySnapshot>,
  languages: readonly string[],
): CopyInventoryFacet {
  const selected = values.filter((value) => value.dimension === dimension);
  if (selected.length > MAX_COPY_FILTER_OPTIONS) return unavailableFacet();
  return {
    state: 'available',
    choices: selected.map((value) => selectedLabel(value, snapshots, languages)),
  };
}

export function presentCopyInventory(
  values: readonly CopyInventoryValue[],
  snapshots: ReadonlyMap<string, CopyInventorySnapshot>,
  languages: readonly string[] = [],
): CopyInventory {
  const kinds = values.filter((value) => value.dimension === 'kind');
  const statuses = values.filter((value) => value.dimension === 'status');
  const inventory: CopyInventory = {
    kinds: facet('kind', kinds, snapshots, languages),
    statuses: facet('status', statuses, snapshots, languages),
  };
  if (new TextEncoder().encode(JSON.stringify(inventory)).byteLength > MAX_COPY_FILTER_OPTIONS_BYTES)
    return { kinds: unavailableFacet(), statuses: unavailableFacet() };
  return inventory;
}

/** Historical option labels come only from each value's retained accepting pin. */
export async function prepareCopyInventory(
  pool: Pool,
  values: readonly CopyInventoryValue[],
  deadline: number,
  languages: readonly string[] = [],
): Promise<CopyInventory> {
  const kinds = values.filter((value) => value.dimension === 'kind');
  const statuses = values.filter((value) => value.dimension === 'status');
  const pins = new Map<string, ReturnType<typeof decodeLibraryProfilePin>>();
  const selected = [
    ...(kinds.length > MAX_COPY_FILTER_OPTIONS ? [] : kinds),
    ...(statuses.length > MAX_COPY_FILTER_OPTIONS ? [] : statuses),
  ];
  for (const row of selected) {
    try {
      const pin = decodeLibraryProfilePin(row.profilePin);
      if (pin) pins.set(`${pin.releaseDigest}\0${pin.provenance}\0${pin.acceptingType ?? ''}\0${pin.profileId}`, pin);
    } catch {
      // A malformed retained pin makes this option label unavailable; it never selects a new profile.
    }
  }
  const snapshots = new Map<string, CopyInventorySnapshot>();
  const digests = new Set([...pins.values()].flatMap((pin) => (pin ? [pin.releaseDigest] : [])));
  for (const digest of digests) {
    try {
      const release = await withConnection(pool, (client) =>
        readRelease(deadlineClient(client, deadline), digest, { composed: false }),
      );
      snapshots.set(digest, release ? { digest, release } : null);
    } catch {
      snapshots.set(digest, null);
    }
  }
  return presentCopyInventory(values, snapshots, languages);
}
