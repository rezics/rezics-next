import type { Pool } from 'pg';
import { controlTransaction } from '../access/topology-control.ts';
import { canonicalCandidate, EditorialInvalid, type ApplyInput, type CommandOutcome,
  type OrderedCommandJournal, type OwnerCommand } from './contract.ts';

/** Shared Access journal. Its rows contain delivery bindings and receipts, never
 * a copy of owner state or another review state machine. */
export class EditorialCommandJournal implements OrderedCommandJournal {
  constructor(private readonly pool: Pool) {}
  async plan(input: ApplyInput, keys: readonly string[]) {
    await controlTransaction(this.pool,async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`editorial-admission:${input.permit.proof}`]);
      const rows = (await client.query<{ command_key: string; candidate_digest: string }>(`SELECT command_key,candidate_digest
        FROM access.editorial_application_command WHERE application = $1 ORDER BY position`,[input.permit.proof])).rows;
      if (rows.length) {
        if (rows.length !== keys.length || rows.some((row,index) => row.command_key !== keys[index]
          || row.candidate_digest !== input.revision.candidateDigest)) throw new EditorialInvalid('Ordered plan changed');
        return;
      }
      const application = (await client.query(`SELECT 1 FROM access.editorial_application a
        JOIN access.editorial_revision r ON r.proposal = a.proposal AND r.n = a.revision
        WHERE a.id = $1 AND a.proposal = $2 AND a.revision = $3 AND r.candidate_digest = $4
          AND NOT EXISTS (SELECT 1 FROM access.editorial_application_outcome o WHERE o.application = a.id)`,
      [input.permit.proof,input.revision.proposal,input.revision.n,input.revision.candidateDigest])).rowCount;
      if (!application) throw new EditorialInvalid('Ordered plan lacks its application');
      await client.query(`INSERT INTO access.editorial_application_command(application,position,command_key,candidate_digest)
        SELECT $1,ordinality-1,key,$3 FROM unnest($2::text[]) WITH ORDINALITY AS keys(key,ordinality)`,
      [input.permit.proof,keys,input.revision.candidateDigest]);
    });
  }
  async read(input: ApplyInput, position: number) {
    const row = (await this.pool.query<{ binding: OwnerCommand | null; admission: string | null; outcome: CommandOutcome | null }>(`
      SELECT CASE WHEN b.action IS NOT NULL THEN jsonb_build_object('action',b.action,'scope',b.scope,'digest',b.request_digest) END AS binding,
        a.admission,o.outcome FROM access.editorial_application_command c
        LEFT JOIN access.editorial_command_binding b USING (application,position)
        LEFT JOIN access.editorial_command_admission a USING (application,position)
        LEFT JOIN access.editorial_command_outcome o USING (application,position)
      WHERE c.application = $1 AND c.position = $2`,[input.permit.proof,position])).rows[0];
    if (!row) throw new EditorialInvalid('Ordered command is missing');
    return { binding: row.binding,outcome: row.outcome,...(row.admission ? { admissionId: row.admission } : {}) };
  }
  async bind(input: ApplyInput, position: number, binding: OwnerCommand) {
    await this.pool.query(`INSERT INTO access.editorial_command_binding(application,position,action,scope,request_digest)
      VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,[input.permit.proof,position,binding.action,binding.scope,binding.digest]);
    if (canonicalCandidate((await this.read(input,position)).binding).digest !== canonicalCandidate(binding).digest) {
      throw new EditorialInvalid('Ordered binding changed');
    }
  }
  async settle(input: ApplyInput, position: number, outcome: CommandOutcome) {
    await this.pool.query(`INSERT INTO access.editorial_command_outcome(application,position,outcome)
      VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,[input.permit.proof,position,outcome]);
    if (canonicalCandidate((await this.read(input,position)).outcome).digest !== canonicalCandidate(outcome).digest) {
      throw new EditorialInvalid('Ordered outcome changed');
    }
  }
}
