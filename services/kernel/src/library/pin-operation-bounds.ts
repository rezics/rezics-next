import { statementBytes } from '../database/statement-bytes.ts';
import { declareBound, sumBounds, type Bound } from '@rezics/bounds';
import { RELEASE_LIMITS } from '@rezics/definitions';
import accountRead from '../access/account-read.sql';
import openingRead from '../access/gates/opening-read.sql';
import readTime from '../command/time.sql';
import partitionRead from '../partition/read.sql';
import { collectionDirectoryRowPlan } from './collection-directory-bounds.ts';
import type { PinStoreStatement } from './pin-store.ts';
import { runLibraryBoundedStep } from './collection-command-work.ts';

const uuid = 'f'.repeat(36);
const escaped = (characters: number) => '\0'.repeat(characters);
const jsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const zero = () =>
  declareBound({
    candidateKeys: 0,
    nativeRows: 0,
    identityMetadataRows: 0,
    emptySeeks: 0,
    nativePoints: 0,
    witnessKeys: 0,
    statements: 0,
    bytes: 0,
    engineRequests: 0,
  });
const rows = (value: Omit<Bound, 'engineRequests'>): Bound => declareBound({ ...value, engineRequests: 0 });
const byteCost = (bytes: number): Bound =>
  rows({
    candidateKeys: 0,
    nativeRows: 0,
    identityMetadataRows: 0,
    emptySeeks: 0,
    nativePoints: 0,
    witnessKeys: 0,
    statements: 0,
    bytes,
  });

function maximum(...values: readonly Bound[]): Bound {
  if (!values.length) return zero();
  const result = Object.fromEntries(
    Object.keys(values[0]!).map((axis) => [axis, Math.max(...values.map((value) => value[axis as keyof Bound]))]),
  );
  return declareBound(result);
}

function serializedBytes(value: unknown): number {
  return jsonBytes(value) + 2;
}

const pinProjection = {
  ids: Array.from({ length: 100 }, () => uuid),
  revision: '9007199254740991',
};
const revisionProjection = { revision: '9007199254740991' };
const triggerSql = `INSERT INTO library.native_source_fence(route,kind,owner_id,generation,account_id)
VALUES($1,'account',$2,1,$2)
ON CONFLICT (route,kind,owner_id) DO UPDATE
SET generation=library.native_source_fence.generation+1,
    account_id=COALESCE(library.native_source_fence.account_id,EXCLUDED.account_id)`;

function triggerBound(route: number, accountId: string, writes: number): Bound {
  if (writes === 0) return zero();
  const binds = [route, accountId, accountId];
  return sumBounds(
    rows({
      candidateKeys: writes,
      nativeRows: 2 * writes,
      identityMetadataRows: 0,
      emptySeeks: writes,
      nativePoints: writes,
      witnessKeys: 0,
      statements: writes,
      bytes: 0,
    }),
    byteCost(
      writes *
        (Buffer.byteLength(triggerSql) + serializedBytes(binds) + serializedBytes({ generation: '9'.repeat(19) })),
    ),
  );
}

/** The exact INSERT/UPDATE schedule, original binds and trigger work from collection_pins. */
export function pinStoreStatementBound(statement: PinStoreStatement): Bound {
  const { values, kind } = statement;
  const route = values[0] as number;
  const accountId = values[1] as string;
  const output = kind === 'read' ? pinProjection : revisionProjection;
  const lookup = kind === 'read' || kind === 'update' || (kind === 'insert' && statement.before === 0);
  const triggerWrites = kind === 'insert' ? (statement.before === 0 ? 1 : 0) : kind === 'update' ? 2 : 0;
  const leaf = rows({
    candidateKeys: lookup ? 1 : 0,
    nativeRows: lookup ? (kind === 'read' ? 2 : 2) : 0,
    identityMetadataRows: 0,
    emptySeeks: lookup ? 1 : 0,
    nativePoints: lookup ? 1 : 0,
    witnessKeys: 0,
    statements: 1,
    bytes: 0,
  });
  return sumBounds(
    leaf,
    byteCost(statementBytes(statement) + serializedBytes(values) + serializedBytes(output)),
    triggerBound(route, accountId, triggerWrites),
  );
}

/** Charge one exact store dispatch through the installed nine-to-eight-axis native translation. */
export function runPinStoreStatement<T>(statement: PinStoreStatement, dispatch: () => Promise<T>): Promise<T> {
  const bound = pinStoreStatementBound(statement);
  if (bound.engineRequests !== 0) throw new TypeError('Native pin SQL cannot declare engine requests');
  return runLibraryBoundedStep(`library.pin.preference.${statement.kind}`, bound, dispatch);
}

export function runPinBoundedStep<T>(operation: string, bound: Bound, dispatch: () => Promise<T>): Promise<T> {
  if (bound.engineRequests !== 0) throw new TypeError('Native pin SQL cannot declare engine requests');
  return runLibraryBoundedStep(operation, bound, dispatch);
}

/** Owner transaction framing and current account/time observations; the full pin row is a separate exact leaf. */
export function pinOwnerObservationBound(input: { route: number; accountId: string; cursor?: string }): Bound {
  const controls = ['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', 'COMMIT', 'ROLLBACK'];
  const accountProjection = {
    route: 65535,
    accountId: uuid,
    kind: 'organization',
    handle: 'a'.repeat(64),
    displayName: escaped(4096),
    avatarUrl: escaped(RELEASE_LIMITS.bytes * 6),
    biography: escaped(4096),
    state: 'suspended',
    operatorAccountId: uuid,
    controllerId: uuid,
    birthDate: '9999-12-31',
    contentPreferences: { posts: false, reviews: false, collections: false, realms: false },
    suspensionReason: escaped(1024),
    minimumAuthnEpoch: '9223372036854775807',
    fenced: true,
    createdAt: 9999999999999,
    rateTier: 'trusted',
    transactionId: uuid,
  };
  const base = rows({
    candidateKeys: 1,
    nativeRows: 3,
    identityMetadataRows: 0,
    emptySeeks: 1,
    nativePoints: 1,
    witnessKeys: 0,
    statements: controls.length + 2,
    bytes: 0,
  });
  const sqlBytes =
    statementBytes(accountRead) + statementBytes(readTime) + controls.reduce((n, sql) => n + Buffer.byteLength(sql), 0);
  const inputBytes =
    serializedBytes([input.route, input.accountId]) + serializedBytes({ at: '' }) + serializedBytes(input.cursor ?? '');
  const cursorOutput = input.cursor === undefined ? 0 : Buffer.byteLength(input.cursor);
  return sumBounds(
    base,
    byteCost(
      sqlBytes + inputBytes + serializedBytes(accountProjection) + serializedBytes({ at: escaped(64) }) + cursorOutput,
    ),
  );
}

/** The common Collection resolver's existing exact point derivation plus its bounded native header branches. */
export function pinCollectionHeaderBound(input: { accountId: string; route: number; collectionId: string }): Bound {
  const collection = collectionDirectoryRowPlan({ route: input.route, id: input.collectionId }).total;
  const commonAccess = rows({
    candidateKeys: 5,
    nativeRows: 12,
    identityMetadataRows: 1,
    emptySeeks: 5,
    nativePoints: 5,
    witnessKeys: 0,
    statements: 8,
    bytes: 0,
  });
  const commonBytes = byteCost(
    Buffer.byteLength(`SELECT * FROM access.account WHERE route=$1 AND account_id=$2`) +
      serializedBytes([input.route, input.accountId]) +
      serializedBytes({ accountId: uuid, kind: 'actor', state: 'active', minimumAuthnEpoch: '9223372036854775807' }),
  );
  const builtin = rows({
    candidateKeys: 6,
    nativeRows: 16,
    identityMetadataRows: 2,
    emptySeeks: 5,
    nativePoints: 6,
    witnessKeys: 0,
    statements: 9,
    bytes: 0,
  });
  const builtinBytes = byteCost(
    Buffer.byteLength(
      `SELECT labels FROM library.owner_index_state WHERE route=$1 AND account_id=$2 AND collection_id=$3 ORDER BY pin->>'releaseDigest',pin LIMIT 1`,
    ) +
      Buffer.byteLength(
        `SELECT builtin_kind,curator_account_id,membership_kind,state,visibility,title,description,revision,presentation_kind,cover_media_id FROM library.collection WHERE route=$1 AND collection_id=$2`,
      ) +
      serializedBytes([input.route, input.accountId, input.collectionId]) +
      serializedBytes({
        labels: { en: escaped(RELEASE_LIMITS.bytes * 6) },
        id: uuid,
        title: escaped(200),
        description: escaped(2000),
      }),
  );
  return sumBounds(
    maximum(sumBounds(commonAccess, commonBytes, collection), sumBounds(builtin, builtinBytes)),
    byteCost(
      serializedBytes({
        id: uuid,
        curatorAccountId: uuid,
        title: escaped(200),
        description: escaped(2000),
        visibility: 'private',
        revision: 2147483647,
        memberCount: 2147483647,
        orderEpoch: 2147483647,
        createdAt: escaped(64),
        updatedAt: escaped(64),
        builtinLabels: { en: escaped(RELEASE_LIMITS.bytes * 6) },
      }),
    ),
  );
}

/** Shared group admission occurs once per nonempty page; the open and closed native branches are both retained. */
export function pinTargetGateBound(input: {
  accountId: string;
  route: number;
  group?: string;
  clientAction?: string;
}): Bound {
  const exposure = rows({
    candidateKeys: 2,
    nativeRows: 6,
    identityMetadataRows: 0,
    emptySeeks: 2,
    nativePoints: 2,
    witnessKeys: 0,
    statements: 4,
    bytes: 0,
  });
  const closedAuthority = rows({
    candidateKeys: 5,
    nativeRows: 12,
    identityMetadataRows: 1,
    emptySeeks: 4,
    nativePoints: 5,
    witnessKeys: 0,
    statements: 8,
    bytes: 0,
  });
  const sqlBytes = statementBytes(openingRead) + statementBytes(partitionRead);
  const group = input.group ?? 'collections';
  const action = input.clientAction ?? 'collection:read';
  const operands =
    serializedBytes([0]) +
    serializedBytes({ group, at: escaped(64) }) +
    serializedBytes([input.route, input.accountId, group, action]);
  const projections =
    serializedBytes({
      partitionNo: 4095,
      node: escaped(255),
      writeState: 'moved',
      movedTo: escaped(255),
      epoch: 2147483647,
      position: '9223372036854775807',
    }) + serializedBytes({ at: escaped(64), open: true });
  return sumBounds(
    maximum(exposure, sumBounds(exposure, closedAuthority)),
    byteCost(sqlBytes + operands + projections),
  );
}

/** Current actor admission at the attempt's original T; Core still owns receipt and transaction custody. */
export function pinCommandAdmissionBound(input: { route: number; accountId: string }): Bound {
  const projection = {
    route: input.route,
    accountId: input.accountId,
    kind: 'actor',
    handle: 'a'.repeat(64),
    displayName: escaped(4096),
    avatarUrl: escaped(RELEASE_LIMITS.bytes * 6),
    biography: escaped(4096),
    state: 'active',
    operatorAccountId: uuid,
    controllerId: uuid,
    birthDate: '9999-12-31',
    contentPreferences: { posts: false, reviews: false, collections: false, realms: false },
    suspensionReason: escaped(1024),
    minimumAuthnEpoch: '9223372036854775807',
    fenced: true,
    createdAt: 9999999999999,
    rateTier: 'trusted',
    transactionId: uuid,
  };
  return sumBounds(
    rows({
      candidateKeys: 1,
      nativeRows: 2,
      identityMetadataRows: 0,
      emptySeeks: 1,
      nativePoints: 1,
      witnessKeys: 0,
      statements: 1,
      bytes: 0,
    }),
    byteCost(
      statementBytes(accountRead) + serializedBytes([input.route, input.accountId]) + serializedBytes(projection),
    ),
  );
}

/** Final route mapping serializes only selected headers; owner preference projection remains fixed at 100 IDs. */
export function pinWireResponseBound(input: { pins: number; revision: number; next: string | null }): Bound {
  const curated = {
    collectionId: uuid,
    target: {
      id: uuid,
      curatorAccountId: uuid,
      title: escaped(200),
      description: escaped(2000),
      visibility: 'unlisted',
      membershipKind: 'curated',
      revision: 2147483647,
      memberCount: 2147483647,
      orderEpoch: 2147483647,
      createdAt: escaped(64),
      updatedAt: escaped(64),
    },
  };
  const builtin = {
    collectionId: uuid,
    target: {
      id: uuid,
      curatorAccountId: uuid,
      membershipKind: 'dynamic',
      builtinKind: 'state',
      builtin: { kind: 'state', profileId: 'a'.repeat(64), stateSetId: 'a'.repeat(64), stateId: 'a'.repeat(64) },
      builtinLabels: { en: escaped(RELEASE_LIMITS.bytes * 6) },
      title: escaped(200),
      description: escaped(2000),
      visibility: 'private',
      revision: 2147483647,
    },
  };
  const largestHeader = Math.max(
    serializedBytes(curated),
    serializedBytes(builtin),
    serializedBytes({ collectionId: uuid, target: null }),
  );
  const bodyBytes = serializedBytes({
    pins: Array.from({ length: input.pins }, () => ({ collectionId: uuid, target: { ...builtin.target } })),
    revision: input.revision,
    next: input.next ?? escaped(4096),
  });
  return sumBounds(
    rows({
      candidateKeys: 0,
      nativeRows: 0,
      identityMetadataRows: 0,
      emptySeeks: 0,
      nativePoints: 0,
      witnessKeys: 0,
      statements: 0,
      bytes: 0,
    }),
    byteCost(Math.max(bodyBytes, input.pins * largestHeader)),
  );
}
