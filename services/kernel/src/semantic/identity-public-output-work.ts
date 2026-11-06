import { memoizedValue } from '../memoized.ts';
import type { WorkDimensions } from '../library/contract/work-dimensions.ts';
import type { NativeCollectionWork } from '../library/collection-source-work.ts';
import s0 from './identity-public-output-accepted.sql';
import s1 from './identity-public-output-insert.sql';
import s2 from './identity-public-output-progress.sql';
import s3 from './identity-public-output-progress-start.sql';
import s4 from './identity-public-output-component.sql';
import s5 from './identity-public-output-plan.sql';
import s6 from './identity-public-output-page.sql';
import s7 from './identity-public-output-original.sql';
import s8 from './identity-public-output-advance.sql';
import s9 from './identity-public-output-scope-start.sql';
import s10 from './identity-public-output-scope.sql';
import s11 from './identity-public-output-scope-seal.sql';
import s12 from './identity-public-output-seal.sql';
import s13 from './identity-public-output-seal-insert.sql';
import s14 from './identity-public-output-fence.sql';
import s15 from './identity-public-output-fence-insert.sql';
import s16 from './identity-public-output-prefix.sql';
import s17 from './identity-public-output-membership.sql';
import s18 from './identity-public-output-definition-size.sql';
import s19 from './identity-public-output-mapping.sql';
import s20 from './identity-public-output-cut-group.sql';
import s21 from './identity-public-output-cut-group-read.sql';
import s22 from './identity-public-output-cut-slot.sql';
import s23 from './identity-public-output-cut-slot-lock.sql';
import s24 from './identity-public-output-cut-bridge.sql';
import s25 from './identity-public-output-cut-bridge-lock.sql';
import s26 from './identity-public-output-cut-member.sql';
import s27 from './identity-public-output-cut-insert.sql';
import s28 from './identity-public-output-cut.sql';
import s29 from './identity-public-output-cut-release.sql';
import s30 from './identity-public-output-cut-released.sql';
import s31 from './identity-public-output-release-setting.sql';
import s32 from './identity-public-output-disposition.sql';
import s33 from './identity-public-output-disposition-insert.sql';
import s34 from './identity-public-output-transition.sql';
import s35 from './identity-public-output-admissions.sql';
import s36 from './identity-public-output-consumer.sql';
import s37 from './identity-public-output-plans.sql';
import s38 from './identity-public-output-close-progress.sql';
import existingSQL from './identity-public-output-existing.sql';
import dispositionLocatorSQL from './identity-public-output-disposition-locator.sql';
import cutLiveSQL from './identity-public-output-cut-live.sql';
import prearmAttemptSQL from './identity-public-output-prearm-attempt.sql';
import prearmUnsafeSQL from './identity-public-output-prearm-unsafe.sql';
import prearmAttemptInsertSQL from './identity-public-output-prearm-attempt-insert.sql';
import prearmReceiptInsertSQL from './identity-public-output-prearm-receipt-insert.sql';
import prearmReceiptSQL from './identity-public-output-prearm-receipt.sql';
import prearmCancelledSQL from './identity-public-output-prearm-cancelled.sql';
import ticketSQL from './identity-epoch-prearm-ticket.sql';
import gateStartSQL from './identity-public-output-gate-start.sql';
import gateCloseSQL from './identity-public-output-gate-close.sql';
import gateSQL from './identity-public-output-gate.sql';
import stageSQL from './identity-public-output-stage.sql';
import timeSQL from '../command/time.sql';
import fenceSQL from '../command/fence.sql';
import nativeSQL from './identity-epoch-store-insert-native-commit.sql';
import regSQL from './public-filter-source-binding-register.sql';
import defineSQL from './public-filter-source-binding-define.sql';
import definitionSQL from './public-filter-source-binding-definition.sql';
import existsSQL from './definitions-exists.sql';
import releaseSQL from './definitions-read.sql';
import ownersSQL from './identity-epoch-read-owners.sql';
import sourcesSQL from './identity-epoch-read-sources.sql';
import pendingSQL from './identity-epoch-read-pending.sql';
import currentSQL from './identity-epoch-read-current.sql';
type Plan = readonly [
  metadata: number,
  rows: number,
  points: number,
  bytes: number,
  candidates: number,
  witnesses: number,
  empty: number,
  statements?: number,
];
function plans() {
  return memoizedValue(
    plans,
    () =>
      new Map<string, Plan>([
        [stageSQL.sql, [17, 168, 21, 32768, 0, 0, 3, 3]],
        [gateSQL.sql, [6, 48, 6, 1024, 0, 0, 1]],
        [gateCloseSQL.sql, [5, 56, 7, 1024, 0, 0, 2, 2]],
        [gateStartSQL.sql, [3, 48, 6, 32768, 0, 0, 2, 2]],
        [existingSQL.sql, [1, 8, 1, 64, 0, 0, 1]],
        [dispositionLocatorSQL.sql, [1, 8, 1, 256, 0, 0, 1]],
        [cutLiveSQL.sql, [2, 16, 2, 64, 0, 0, 1]],
        [prearmAttemptSQL.sql, [1, 8, 1, 1024, 0, 0, 1]],
        [prearmUnsafeSQL.sql, [2, 32, 4, 512, 0, 0, 3, 3]],
        [prearmAttemptInsertSQL.sql, [4, 48, 6, 4096, 0, 0, 5, 5]],
        [prearmReceiptInsertSQL.sql, [2, 32, 4, 512, 0, 0, 3, 3]],
        [prearmReceiptSQL.sql, [4, 32, 4, 256, 0, 0, 1]],
        [prearmCancelledSQL.sql, [4, 32, 4, 64, 0, 0, 1]],
        [ticketSQL.sql, [12, 96, 12, 6144, 0, 0, 1]],

        [s0.sql, [5, 40, 5, 2114560, 0, 0, 1]],
        [s1.sql, [5, 64, 8, 32768, 0, 0, 3, 3]],
        [s2.sql, [1, 8, 1, 66304, 0, 0, 1]],
        [s3.sql, [0, 24, 3, 64, 0, 0, 1]],
        [s4.sql, [1, 8, 1, 128, 0, 0, 1]],
        [s5.sql, [1, 24, 3, 131072, 0, 0, 2, 2]],
        [s6.sql, [7, 88, 11, 131072, 0, 0, 6, 6]],
        [s7.sql, [0, 256, 32, 4096, 0, 0, 1]],
        [s8.sql, [1, 24, 3, 131072, 0, 0, 2, 2]],
        [s9.sql, [2, 32, 4, 32768, 0, 0, 3, 3]],
        [s10.sql, [1, 8, 1, 9216, 0, 0, 1]],
        [s11.sql, [2, 32, 4, 32768, 0, 0, 3, 3]],
        [s12.sql, [4, 32, 4, 512, 0, 0, 1]],
        [s13.sql, [7, 88, 11, 131072, 0, 0, 6, 6]],
        [s14.sql, [4, 32, 4, 256, 0, 0, 1]],
        [s15.sql, [3, 48, 6, 1024, 0, 0, 2, 2]],
        [s16.sql, [101, 808, 1, 6464, 101, 0, 1]],
        [s17.sql, [100, 800, 100, 6400, 100, 0, 1]],
        [s18.sql, [2, 16, 2, 128, 0, 0, 1]],
        [s19.sql, [1, 8, 1, 256, 0, 0, 1]],
        [s20.sql, [2, 16, 2, 512, 0, 0, 1]],
        [s21.sql, [2, 16, 2, 512, 0, 0, 1]],
        [s22.sql, [0, 16, 2, 0, 0, 0, 1]],
        [s23.sql, [1, 8, 1, 256, 0, 0, 1]],
        [s24.sql, [5, 80, 10, 1024, 0, 0, 6, 6]],
        [s25.sql, [2, 16, 2, 256, 0, 0, 1]],
        [s26.sql, [1, 8, 1, 64, 0, 0, 1]],
        [s27.sql, [12, 192, 24, 16384, 0, 1, 9, 9]],
        [s28.sql, [8, 64, 8, 768, 0, 1, 1]],
        [s29.sql, [3, 64, 8, 1024, 0, 0, 2, 2]],
        [s30.sql, [4, 32, 4, 64, 0, 0, 1]],
        [s31.sql, [0, 0, 0, 64, 0, 0, 0]],
        [s32.sql, [8, 64, 8, 32768, 0, 0, 1]],
        [s33.sql, [14, 136, 17, 32768, 0, 0, 3, 3]],
        [s34.sql, [14, 136, 17, 32768, 0, 0, 3, 3]],
        [s35.sql, [1, 8, 1, 64, 0, 0, 1]],
        [s36.sql, [9, 104, 13, 131072, 0, 0, 8, 8]],
        [s37.sql, [1, 8, 1, 66560, 0, 0, 1]],
        [s38.sql, [1, 24, 3, 131072, 0, 0, 2, 2]],
        [timeSQL.sql, [1, 8, 1, 128, 0, 0, 1]],
        [fenceSQL.sql, [0, 40, 5, 128, 0, 0, 1]],
        [nativeSQL.sql, [1, 32, 4, 128, 0, 0, 1]],
        [regSQL.sql, [2, 32, 4, 256, 0, 0, 1]],
        [defineSQL.sql, [3, 40, 5, 128, 0, 0, 1]],
        [definitionSQL.sql, [3, 24, 3, -1, 0, 0, 1]],
        [existsSQL.sql, [1, 8, 1, 128, 0, 0, 1]],
        [releaseSQL.sql, [1, 8, 1, -2, 0, 0, 1]],
        [ownersSQL.sql, [1, 8, 1, 256, 0, 0, 1]],
        [sourcesSQL.sql, [400, 400, 400, 102400, 0, 0, 1]],
        [pendingSQL.sql, [100, 100, 100, 25600, 0, 0, 1]],
        [currentSQL.sql, [200, 200, 200, 25600, 0, 0, 1]],
      ]),
  );
}
const controls = new Set([
  'BEGIN ISOLATION LEVEL SERIALIZABLE',
  'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
  'BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY',
  'COMMIT',
  'ROLLBACK',
  "SET LOCAL lock_timeout = '200ms'",
]);
/** Literal owners only. Unknown SQL refuses before dispatch. Cleanup is reserved by the instrumenter at BEGIN.
 * Rows are logical operation bounds, including dispatched failures and constraint-trigger indexed probes.
 * Result bodies are constrained at the writer, or admitted by a preceding immutable size point.
 */
export function outputCaptureFootprint(
  work: NativeCollectionWork,
  sql: string,
  values: readonly unknown[],
): WorkDimensions | undefined {
  const control = controls.has(sql) || /^SET LOCAL statement_timeout = '[1-9][0-9]*ms'$/.test(sql);
  let plan = plans().get(sql);
  if (!plan && !control) return undefined;
  if (!plan) plan = [0, 0, 0, 0, 0, 0, 0];
  let [identityMetadataRows, nativeRows, nativePoints, bytes, candidateKeys, witnessKeys, emptySeeks, statements = 1] =
    plan;
  if (bytes === -1) {
    const bound = work.resultByteBound('public-output-definition');
    if (bound === undefined) return undefined;
    bytes = bound;
  }
  if (bytes === -2) {
    const bound = work.resultByteBound('public-output-release');
    if (bound === undefined) return undefined;
    bytes = bound;
  }
  // Array arguments retain their caller's smaller page bounds, including zero-key calls.
  if (sql === ownersSQL.sql) {
    const n = (values[0] as unknown[]).length;
    if (n > 100) return undefined;
    identityMetadataRows = n;
    nativeRows = n * 8;
    nativePoints = n;
    bytes = n * 256;
    emptySeeks = n;
  }
  if (sql === sourcesSQL.sql) {
    const n = (values[0] as unknown[]).length;
    identityMetadataRows = n * 4;
    nativeRows = n * 32;
    nativePoints = n * 4;
    bytes = n * 1024;
    emptySeeks = n * 4;
  }
  if (sql === pendingSQL.sql) {
    const n = (values[0] as unknown[]).length;
    identityMetadataRows = n;
    nativeRows = n * 8;
    nativePoints = n;
    bytes = n * 256;
    emptySeeks = n;
  }
  if (sql === currentSQL.sql) {
    const n = (values[0] as unknown[]).length;
    identityMetadataRows = n * 2;
    nativeRows = n * 16;
    nativePoints = n * 2;
    bytes = n * 256;
    emptySeeks = n * 2;
  }
  if (sql === s16.sql) {
    const n = Number(values[3]);
    if (!Number.isInteger(n) || n < 1 || n > 101) return undefined;
    identityMetadataRows = n;
    nativeRows = n * 8;
    candidateKeys = n;
    bytes = n * 64;
  }
  if (sql === s17.sql) {
    const n = (values[2] as unknown[]).length;
    if (n > 100) return undefined;
    identityMetadataRows = n;
    nativeRows = n * 8;
    nativePoints = n;
    candidateKeys = n;
    bytes = n * 64;
    emptySeeks = n;
  }
  if (sql === fenceSQL.sql) {
    const events = typeof values[1] === 'string' ? JSON.parse(values[1]) : values[1];
    if (
      !Array.isArray(events) ||
      events.length !== 1 ||
      events[0]?.type !== 'com.rezics.semantic.public-output.capture.v1' ||
      values[3] != null ||
      values[4] != null
    )
      return undefined;
  }
  const input = JSON.stringify(values, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));
  return {
    candidateKeys,
    identityMetadataRows,
    nativeRows,
    nativePoints,
    witnessKeys,
    statements,
    bytes: bytes + Buffer.byteLength(sql) + Buffer.byteLength(input),
    emptySeeks,
  };
}
