import { Compile } from 'typebox/compile';
import { ProblemError } from '../http/problem.ts';
import type { CommandTransaction, AuthoritativeTime } from '../command/command.ts';
import type { AccessContext, AccountActor } from '../request/access.ts';
import { routeOf } from '../route/route.ts';
import { bulkAdmissionSchema } from './bulk-schemas.ts';
import { BULK_ADMISSION_BODY_BYTES, BULK_MAX_SELECTION_IDS } from './bulk-limits.ts';
import { LibraryNotFoundError } from './command-support.ts';
import { resolveSubject, type ResolvedSubject, type SubjectAnchorDependencies } from './subject-anchor.ts';
import type { BulkAdmission } from './bulk-contract.ts';
import type { CollectionBulkTarget } from './collection-bulk-store.ts';

export type ExplicitLibraryRemoval = Extract<BulkAdmission, { action: 'remove_from_library' }> & {
  selection: Extract<BulkAdmission['selection'], { kind: 'explicit' }>;
};

const validate = Compile(bulkAdmissionSchema);

/** Validate the whole native command before any subject access or canonicalization. */
export function explicitLibraryRemoval(input: BulkAdmission): ExplicitLibraryRemoval {
  if (Buffer.byteLength(JSON.stringify(input)) > BULK_ADMISSION_BODY_BYTES)
    throw new RangeError('Bulk command exceeds 64 KiB');
  if (!validate.Check(input)) throw new TypeError('Invalid bulk selection');
  if (input.action !== 'remove_from_library' || input.selection.kind !== 'explicit')
    throw new ProblemError('dependency_unavailable');
  const targets = input.selection.targets.map(({ subjectId }) => ({ subjectId: subjectId.toLowerCase() }));
  if (!targets.length || targets.length > BULK_MAX_SELECTION_IDS) throw new RangeError('Select 1 to 1,000 subjects');
  return { ...input, selection: { kind: 'explicit', targets } };
}

/** Resolve one current canonical Subject per first selected identity, before the owner write transaction. */
export async function resolveLibraryRemovalSubjects(
  deps: SubjectAnchorDependencies,
  owner: AccountActor,
  input: ExplicitLibraryRemoval,
  at: AuthoritativeTime,
  context: AccessContext,
): Promise<ResolvedSubject[]> {
  const resolved: ResolvedSubject[] = [];
  const seen = new Set<string>();
  for (const target of input.selection.targets) {
    const subject = await resolveSubject(deps, owner, target.subjectId, at, context);
    if (!subject) throw new LibraryNotFoundError();
    if (!seen.has(subject.subjectId)) {
      seen.add(subject.subjectId);
      resolved.push(subject);
    }
  }
  return resolved;
}

/** Capture current entries and the real owner counter in the preview command's transaction. */
export async function captureLibraryRemovalTargets(
  tx: CommandTransaction,
  owner: AccountActor,
  subjects: readonly ResolvedSubject[],
): Promise<CollectionBulkTarget[]> {
  const route = routeOf(owner.accountId);
  if (route === null) throw new TypeError('Invalid owner route');
  const counter = (
    await tx.query<{ sequence: string }>(
      `SELECT seq::text AS sequence FROM library.owner_write_counter
       WHERE route=$1 AND account_id=$2 FOR SHARE`,
      [route, owner.accountId],
    )
  ).rows[0]?.sequence;
  if (counter === undefined || !/^(0|[1-9][0-9]*)$/.test(counter)) throw new ProblemError('dependency_unavailable');

  const rows = await tx.query<{
    subjectId: string;
    incarnation: string | null;
    revision: number;
    ownerWriteSeq: string | null;
  }>(
    `SELECT subject_id AS "subjectId",incarnation_id AS incarnation,revision,
       owner_write_seq::text AS "ownerWriteSeq" FROM library.entry
     WHERE route=$1 AND account_id=$2 AND subject_id=ANY($3::uuid[]) ORDER BY subject_id`,
    [route, owner.accountId, subjects.map(({ subjectId }) => subjectId)],
  );
  const entries = new Map(rows.rows.map((entry) => [entry.subjectId, entry]));
  return subjects.map((subject): CollectionBulkTarget => {
    const entry = entries.get(subject.subjectId);
    if (!entry) {
      return {
        kind: 'subject',
        ...subject,
        expected: { kind: 'absent', slotGeneration: counter },
      };
    }
    if (!entry.incarnation || entry.ownerWriteSeq === null || !/^(0|[1-9][0-9]*)$/.test(entry.ownerWriteSeq))
      throw new ProblemError('dependency_unavailable');
    return {
      kind: 'subject',
      ...subject,
      expected: {
        kind: 'present',
        incarnation: entry.incarnation,
        revision: entry.revision,
        admissionSequence: entry.ownerWriteSeq,
      },
    };
  });
}
