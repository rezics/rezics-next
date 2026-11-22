import type { Pool } from 'pg';
import { CommandUnavailableError } from '../access/unavailable.ts';

// Each cut covers 32 homes. The native scan touches original page keys, not a
// 512-home array of live heads. Changed homes use the ordinary bounded bridge.
export const maxHeldQuietPages = 16;
const pageHomes = 32;

export async function readHeldQuietRange(
  db: Pick<Pool, 'query'>,
  input: { bootstrap: string; birth: string; start: number; retainedHomes?: number },
) {
  const { start, retainedHomes } = input;
  const width = retainedHomes ?? Math.min(maxHeldQuietPages * pageHomes, 4096 - start);
  if (
    !Number.isInteger(start) ||
    start < 0 ||
    start % pageHomes ||
    !Number.isInteger(width) ||
    width < pageHomes ||
    width % pageHomes ||
    width > maxHeldQuietPages * pageHomes ||
    start + width > 4096
  )
    throw new TypeError('Invalid held Subject cut interval');

  // A new producer also observes the current raw inventory and command heads.
  // On replay a later creation belongs to the writer. The original digest was
  // issued by the cut trigger only for empty inventory and zero command bases.
  let end = start + width;
  if (retainedHomes === undefined) {
    const occupied = await db.query<{ stop: number }>(
      `/* semantic.native-keyed:5:5 */
       SELECT least($2::integer,
         (SELECT partition_no/32*32 FROM core.partition WHERE partition_no>=$1 AND partition_no<$2
           AND position>0 ORDER BY partition_no LIMIT 1),
         (SELECT route/512*32 FROM semantic.subject WHERE route>=$1::integer*16 AND route<$2::integer*16
           ORDER BY route,subject_id LIMIT 1),
         CASE WHEN NOT EXISTS (SELECT FROM semantic.subject_access_page_v1 p WHERE (p.birth,p.first_home)=($3,$1)
           AND semantic.subject_quiet_page_current_v1(p)) THEN $1::integer END) AS stop`,
      [start, end, input.birth],
    );
    end = occupied.rows[0]!.stop;
    if (start === end) return [];
  }
  // The anchor reopens registration, key closure and store/restore lineage.
  // Each interval needs one Access and one Core original and at most two
  // keyed continuity reads. The stamp and both empty seeks share the captured
  // zero base: a newly committed write can only advance it.
  const points = 97 + 4 * ((end - start) / pageHomes);
  const result = await db.query<{ first_home: number; digest: string | null; current: boolean }>(
    `/* semantic.native-keyed:${points}:${points} */
     WITH anchor AS MATERIALIZED (
       SELECT m.birth,p.definition_digest FROM semantic.subject_access_cut_v1($1,$2) m
       JOIN semantic.subject_access_page_v1 p ON (p.birth,p.first_home)=(m.birth,$2)
       WHERE m.birth=$3
     )
     SELECT i AS first_home,p.quiet_digest AS digest,semantic.subject_quiet_page_current_v1(p) AS current
     FROM anchor CROSS JOIN generate_series($2::integer,$4::integer-32,32) i
     LEFT JOIN LATERAL (SELECT p.* FROM semantic.subject_access_page_v1 p
       JOIN core.subject_retention_page_v1 c ON (c.birth,c.first_home,c.end_home)=(p.birth,p.first_home,p.end_home)
       WHERE (p.birth,p.first_home,p.end_home,p.definition_digest)=(anchor.birth,i,i+32,anchor.definition_digest)
       LIMIT 1) p ON true ORDER BY i`,
    [input.bootstrap, start, input.birth, end],
  );
  const digests: string[] = [];
  for (const page of result.rows) {
    if (page.first_home !== start + digests.length * pageHomes || !page.digest) break;
    if (!page.current) {
      if (retainedHomes !== undefined) {
        // Recheck one stale page from its original Core/Access authority and
        // commit its current revision. A retry can then reopen this prefix.
        await db.query(
          `/* semantic.native-keyed:320:320:1 */
           MERGE INTO semantic.subject_quiet_recheck_v1 q USING (VALUES($1::bigint,$2::integer)) i(birth,home)
           ON (q.birth,q.first_home)=(i.birth,i.home)
           WHEN MATCHED THEN UPDATE SET first_home=i.home
           WHEN NOT MATCHED THEN INSERT (birth,first_home) VALUES(i.birth,i.home)`,
          [input.birth, page.first_home],
        );
      }
      break;
    }
    digests.push(page.digest);
  }
  if (retainedHomes !== undefined && digests.length * pageHomes !== retainedHomes)
    throw new CommandUnavailableError('contention', start);
  return digests;
}
