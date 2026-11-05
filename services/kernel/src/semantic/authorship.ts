import { currentCommand, type CommandTransaction } from '../command/command.ts';
import { creationDeclares, initializeResourceGrants } from '../access/index.ts';
import type { Resource } from '../request/access.ts';
import { derivedId, routeOf } from '../route/route.ts';
import { recordSemanticProducerRole, recordSemanticSourceCommit } from './erasure-producer.ts';

export const REVISION_NS = '8af5a11d-ae8c-4cc8-9173-ef84bd62057d';

/** The stable resource identity for the account that authored an original write revision. */
export function revisionResource(subject: string, revision: number): Resource {
  const route = routeOf(subject);
  if (route === null || !Number.isSafeInteger(revision) || revision < 1)
    throw new RangeError('Invalid semantic revision resource');
  return { route, id: derivedId(REVISION_NS, `${subject}\n${revision}`, route) };
}

export class StaleRevisionAuthorshipError extends Error {
  constructor() {
    super('The declared original write revision is stale');
    this.name = 'StaleRevisionAuthorshipError';
  }
}

export async function initializeRevisionAuthorship(
  tx: CommandTransaction,
  input: Readonly<{ subject: string; revision: number }>,
): Promise<void> {
  const route = routeOf(input.subject);
  if (route === null || !Number.isSafeInteger(input.revision) || input.revision < 1)
    throw new TypeError('Invalid semantic revision authorship input');
  const command = currentCommand(tx);
  const transactionId = command.transactionId;
  const creator = command.basis?.actorAccountId;
  if (command.authorization?.mode !== 'execute' || creator == null || routeOf(creator) === null)
    throw new TypeError('Revision authorship requires an account-authored command');

  const anchor = revisionResource(input.subject, input.revision);
  const declaredRevision = creationDeclares(tx, anchor);
  const subject = { route, id: input.subject };
  const declaredSubject = input.revision === 1 && creationDeclares(tx, subject);
  if (!declaredRevision) throw new TypeError('Revision authorship resource was not declared');

  const provenance = await tx.query<{ recorded_transaction_id: string }>(
    `SELECT recorded_transaction_id::text FROM semantic.revision
     WHERE route=$1 AND subject_id=$2 AND revision=$3 AND kind IN ('create','propose','terms')
       AND recorded_transaction_id=$4::uuid`,
    [route, input.subject, input.revision, transactionId],
  );
  if (provenance.rows.length !== 1 || !provenance.rows[0]?.recorded_transaction_id)
    throw new TypeError('Original native revision is missing from the current command body');

  // Enroll the actual creator and this native commit with the existing Source producer.
  // This local custody does not certify shared history/set completeness or account cleanup.
  await recordSemanticProducerRole(tx, transactionId, creator, 'operator');
  await recordSemanticSourceCommit(tx, transactionId);
  await initializeResourceGrants(tx, { resource: anchor, type: 'semantic.revision', creator });

  if (declaredSubject) {
    const created = await tx.query<{ valid: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM semantic.subject s
         JOIN semantic.revision r
           ON r.route = s.route AND r.subject_id = s.subject_id AND r.revision = 1
          AND r.recorded_transaction_id = s.recorded_transaction_id
         WHERE s.route = $1::integer AND s.subject_id = $2::uuid AND r.kind='create'
           AND s.recorded_transaction_id=$3::uuid
       ) AS valid`,
      [route, input.subject, transactionId],
    );
    if (created.rows[0]?.valid !== true) throw new TypeError('Native subject creation basis is invalid');
    await initializeResourceGrants(tx, { resource: subject, type: 'semantic.subject', creator });
  }
}
