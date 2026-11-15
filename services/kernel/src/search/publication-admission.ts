// Creation and publication share this target lock, including before the home-zero gate exists.
export const lockPublicationAdmission = 'SELECT pg_advisory_xact_lock_shared(hashtextextended($1,741))';
export const lockPublicationFence = 'SELECT pg_advisory_xact_lock(hashtextextended($1,741))';
export const readPublicationFence = `SELECT publication_fence FROM search.identity_writer_gate
  WHERE partition_no=0 AND physical_target=$1 AND publication_fence IS NOT NULL`;

export async function lockWriterPublicationAdmission(
  tx: Pick<import('pg').PoolClient, 'query'>,
  physicalTarget: string,
): Promise<void> {
  await tx.query(lockPublicationAdmission, [physicalTarget]);
  // A Serializable command may have taken its snapshot before waiting for the
  // advisory lock. A row lock detects a newer fence transition and retries the
  // command. The unique insert handles the first-absence case the same way.
  const witness = await tx.query(
    'SELECT 1 FROM search.generation_publication_lock WHERE physical_target=$1 FOR SHARE',
    [physicalTarget],
  );
  if (!witness.rowCount)
    await tx.query(
      'INSERT INTO search.generation_publication_lock (physical_target) VALUES ($1) ON CONFLICT DO NOTHING',
      [physicalTarget],
    );
}

export async function advanceWriterPublicationAdmission(
  tx: Pick<import('pg').PoolClient, 'query'>,
  physicalTarget: string,
): Promise<void> {
  await tx.query(
    `INSERT INTO search.generation_publication_lock AS witness (physical_target) VALUES ($1)
     ON CONFLICT (physical_target) DO UPDATE SET revision=witness.revision+1`,
    [physicalTarget],
  );
}
