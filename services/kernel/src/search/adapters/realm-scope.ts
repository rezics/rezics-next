import { AccessWorkAccounting, type AccessWork, type AccessWorkSink } from '../../access/work.ts';
import type { Actor } from '../../request/access.ts';
import { zeroScopeWork } from '../contract/index.ts';
import type { ScopeExecutionDimensions, ScopeExecutionLedger } from '../contract/index.ts';
type RealmExecutionReader = Readonly<{ actor: Actor; deadline: number }>;
export type RealmExecutionContext = Readonly<{ actor: Actor; deadline: number; work: AccessWorkAccounting }>;
function accessDimensions(value: AccessWork): ScopeExecutionDimensions {
  return {
    candidateKeys: value.keys,
    nativeRows: value.rows,
    identityMetadataRows: 0,
    emptySeeks: value.emptySeeks,
    nativePoints: value.points,
    witnessKeys: value.witnesses,
    statements: 0,
    bytes: value.bytes,
  };
}

function add(left: ScopeExecutionDimensions, right: ScopeExecutionDimensions): ScopeExecutionDimensions {
  return {
    candidateKeys: left.candidateKeys + right.candidateKeys,
    nativeRows: left.nativeRows + right.nativeRows,
    identityMetadataRows: left.identityMetadataRows + right.identityMetadataRows,
    emptySeeks: left.emptySeeks + right.emptySeeks,
    nativePoints: left.nativePoints + right.nativePoints,
    witnessKeys: left.witnessKeys + right.witnessKeys,
    statements: left.statements + right.statements,
    bytes: left.bytes + right.bytes,
  };
}

function subtract(left: ScopeExecutionDimensions, right: ScopeExecutionDimensions): ScopeExecutionDimensions {
  return {
    candidateKeys: left.candidateKeys - right.candidateKeys,
    nativeRows: left.nativeRows - right.nativeRows,
    identityMetadataRows: left.identityMetadataRows - right.identityMetadataRows,
    emptySeeks: left.emptySeeks - right.emptySeeks,
    nativePoints: left.nativePoints - right.nativePoints,
    witnessKeys: left.witnessKeys - right.witnessKeys,
    statements: left.statements - right.statements,
    bytes: left.bytes - right.bytes,
  };
}

function fits(value: ScopeExecutionDimensions, limit: ScopeExecutionDimensions): boolean {
  return Object.keys(value).every((axis) => {
    const key = axis as keyof ScopeExecutionDimensions;
    return value[key] <= limit[key];
  });
}

function disclosureContext(reader: RealmExecutionReader, work: AccessWorkAccounting) {
  return { actor: reader.actor, deadline: reader.deadline, work } satisfies RealmExecutionContext;
}

/** Charge native Access reservations and receipts to the caller's existing Search root. */
export async function withRealmDisclosureWork<T>(
  reader: RealmExecutionReader,
  scope: ScopeExecutionLedger,
  maximum: ScopeExecutionDimensions,
  run: (context: RealmExecutionContext) => Promise<T>,
): Promise<T> {
  let reserved = zeroScopeWork();
  let settled = zeroScopeWork();
  const sink: AccessWorkSink = {
    reserve(_operation, bound) {
      const held = accessDimensions(bound);
      const reservation = { ...held, statements: 1 };
      const nextReserved = add(reserved, reservation);
      const total = add(settled, nextReserved);
      if (!fits(nextReserved, maximum) || !fits(total, scope.remaining().remaining)) return null;
      reserved = nextReserved;
      let open = true;
      return {
        settle(actual) {
          if (!open) return;
          open = false;
          reserved = subtract(reserved, reservation);
          settled = add(settled, { ...accessDimensions(actual), statements: 1 });
        },
      };
    },
  };
  const accounting = new AccessWorkAccounting(sink, reader.deadline);
  try {
    return await run(disclosureContext(reader, accounting));
  } finally {
    scope.consume(settled);
  }
}
