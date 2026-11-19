import type { Pool } from 'pg';
import type { AdmissionYield } from '../http/request.ts';

function control(columns: Record<string, string>, sql: string) {
  const names = Object.keys(columns);
  const types = Object.values(columns);
  return (members: number) => {
    const tuples = Array.from(
      { length: members },
      (_, i) => '(' + types.map((type, j) => `$${i * types.length + j + 1}::${type}`).join(',') + ')',
    );
    return `WITH input(${names.join(',')}) AS (VALUES ${tuples.join(',')}) ${sql}`;
  };
}

// Every transition returns its own page ID. A missing locked row can only
// withhold that page. The native guards apply to each row of the statement.
const saveObservation = control(
  { home: 'integer', observation: 'text', work: 'text', previous: 'text', bootstrap: 'text' },
  `UPDATE search.public_filter_observation o SET consumer_work=i.work,consumer_bootstrap=i.bootstrap FROM input i
   WHERE (o.partition_no,o.observation)=(i.home,i.observation) AND o.consumer_work IS NOT DISTINCT FROM i.previous
     AND o.state='open' RETURNING o.observation AS id`,
);
const saveRegistration = control(
  { home: 'integer', registration: 'text', work: 'text', previous: 'text', bootstrap: 'text' },
  `UPDATE search.public_filter_registration r SET consumer_work=i.work,consumer_bootstrap=i.bootstrap FROM input i
   WHERE (r.partition_no,r.id)=(i.home,i.registration) AND r.consumer_work IS NOT DISTINCT FROM i.previous RETURNING r.id`,
);
export const pageControls = {
  previousWindow: control(
    { home: 'integer', observation: 'text', execution: 'text' },
    `SELECT e.observation AS id,e.consumer_window FROM input i JOIN search.public_filter_execution e
       ON (e.partition_no,e.observation,e.id)=(i.home,i.observation,i.execution)`,
  ),
  claim: saveRegistration,
  savePit: saveRegistration,
  transfer: control(
    { home: 'integer', registration: 'text', work: 'text', bootstrap: 'text', observation: 'text', adopted: 'text' },
    `, claimed AS MATERIALIZED (
       SELECT i.* FROM input i JOIN search.public_filter_registration r ON (r.partition_no,r.id)=(i.home,i.registration)
       WHERE r.consumer_work=i.work AND r.consumer_bootstrap=i.bootstrap ORDER BY r.id FOR UPDATE OF r),
     moved AS (UPDATE search.public_filter_observation o SET consumer_work=i.adopted,consumer_bootstrap=i.bootstrap
       FROM claimed i WHERE (o.partition_no,o.registration,o.observation)=(i.home,i.registration,i.observation)
         AND o.state='open' AND o.consumer_work IS NULL RETURNING o.partition_no,o.registration)
     UPDATE search.public_filter_registration r SET consumer_work=NULL,consumer_bootstrap=NULL FROM moved o
     WHERE (r.partition_no,r.id)=(o.partition_no,o.registration) RETURNING r.id`,
  ),

  load: control(
    { home: 'integer', observation: 'text' },
    `SELECT o.observation AS id,o.consumer_work FROM input i JOIN search.public_filter_observation o
     ON (o.partition_no,o.observation)=(i.home,i.observation) WHERE o.state='open'`,
  ),
  saveReservation: saveObservation,
  saveWindow: saveObservation,
  plan: control(
    {
      home: 'integer',
      observation: 'text',
      page: 'uuid',
      token: 'uuid',
      now: 'bigint',
      deadline: 'bigint',
      parent: 'text',
      consumed: 'integer',
      previous: 'text',
      ceiling: 'integer',
      work: 'text',
    },
    `, locked AS MATERIALIZED (
      SELECT o.registration,r.definition,r.consumer,i.*
      FROM input i JOIN search.public_filter_observation o ON (o.partition_no,o.observation)=(i.home,i.observation)
      JOIN search.public_filter_registration r ON (r.partition_no,r.id)=(o.partition_no,o.registration)
      JOIN search.public_filter_reference f ON (f.partition_no,f.observation,f.token)=(o.partition_no,o.observation,i.token)
      LEFT JOIN search.public_filter_execution e ON (e.partition_no,e.observation,e.id)=(o.partition_no,o.observation,i.parent)
      WHERE o.state='open' AND o.expires_at>i.now AND f.expires_at>i.now AND r.state='active'
        AND (i.parent IS NULL OR (e.consumer_window=i.previous AND (e.page_id IS NULL OR e.page_status='complete')))
        AND NOT EXISTS (SELECT 1 FROM search.public_filter_coverage_page p
          WHERE (p.partition_no,p.observation)=(o.partition_no,o.observation)
            AND (p.state IN ('planned','open','sealed') OR p.pending IS NOT NULL))
      FOR UPDATE OF o FOR SHARE OF r,f)
    INSERT INTO search.public_filter_coverage_page
      (partition_no,id,observation,registration,definition,consumer,deadline,reference_token,boundary,boundary_consumed,boundary_window,ceiling,state,work)
    SELECT home,page,observation,registration,definition,consumer,deadline,token,parent,consumed,previous,ceiling,'planned',work
    FROM locked RETURNING id`,
  ),
  reserve: control(
    {
      home: 'integer',
      page: 'uuid',
      observation: 'text',
      token: 'uuid',
      now: 'bigint',
      execution: 'text',
      parent: 'text',
      consumed: 'integer',
      size: 'integer',
      payload: 'text',
      work: 'text',
    },
    `, locked AS MATERIALIZED (
      SELECT i.* FROM input i JOIN search.public_filter_coverage_page p ON (p.partition_no,p.id)=(i.home,i.page)
      JOIN search.public_filter_observation o ON (o.partition_no,o.observation)=(p.partition_no,p.observation)
      JOIN search.public_filter_reference f ON (f.partition_no,f.observation,f.token)=(o.partition_no,o.observation,i.token)
      WHERE p.observation=i.observation AND p.reference_token=i.token AND p.state='open' AND p.pending IS NULL AND p.deadline>i.now
        AND o.state='open' AND f.expires_at>i.now AND p.rounds<3 AND p.charged+i.size<=p.ceiling
        AND coalesce(p.tail,p.boundary) IS NOT DISTINCT FROM i.parent
        AND ((p.tail IS NOT NULL AND p.tail_consumed=i.consumed) OR (p.tail IS NULL AND p.boundary_consumed=i.consumed))
      FOR UPDATE OF p FOR SHARE OF o,f), advanced AS (
      UPDATE search.public_filter_coverage_page p SET pending=i.execution,rounds=p.rounds+1,charged=p.charged+i.size,
        revision=p.revision+1,work=i.work FROM locked i
      WHERE (p.partition_no,p.id)=(i.home,i.page)
      RETURNING p.partition_no,p.id,p.observation,p.rounds,p.charged,i.execution,i.payload,i.parent,i.consumed,i.size), appended AS (
      INSERT INTO search.public_filter_execution
        (partition_no,observation,id,execution,page_id,page_ordinal,page_parent,page_consumed,page_size,page_status,page_engine_started)
      SELECT partition_no,observation,execution,payload,id,rounds,parent,consumed,size,'dispatched',false
      FROM advanced RETURNING partition_no,page_id)
    SELECT p.id,p.rounds,p.charged FROM advanced p JOIN appended a ON (a.partition_no,a.page_id)=(p.partition_no,p.id)`,
  ),
  dispatch: control(
    {
      home: 'integer',
      page: 'uuid',
      execution: 'text',
      token: 'uuid',
      now: 'bigint',
      observation: 'text',
      work: 'text',
    },
    `, funded AS (
      UPDATE search.public_filter_coverage_page p SET work=i.work,revision=p.revision+1 FROM input i
      WHERE (p.partition_no,p.id)=(i.home,i.page) AND p.state='open' AND p.pending=i.execution
        AND p.observation=i.observation AND p.reference_token=i.token AND p.deadline>i.now
      RETURNING p.partition_no,p.observation,p.id,p.pending)
    UPDATE search.public_filter_execution e SET page_engine_started=true FROM funded p
    WHERE (e.partition_no,e.observation,e.id)=(p.partition_no,p.observation,p.pending)
      AND e.page_id=p.id AND e.page_status='dispatched' AND e.page_engine_started IS FALSE RETURNING e.page_id AS id`,
  ),
  complete: control(
    {
      home: 'integer',
      page: 'uuid',
      execution: 'text',
      payload: 'text',
      raw_window: 'text',
      unused: 'integer',
      work: 'text',
      raw: 'integer',
    },
    `, locked AS MATERIALIZED (
      SELECT i.*,p.observation FROM input i JOIN search.public_filter_coverage_page p
        ON (p.partition_no,p.id)=(i.home,i.page)
      WHERE p.state='open' AND p.pending=i.execution FOR UPDATE OF p), completed AS (
      UPDATE search.public_filter_execution e SET execution=i.payload,consumer_window=i.raw_window,page_status='complete',page_raw=i.raw
      FROM locked i WHERE (e.partition_no,e.observation,e.id)=(i.home,i.observation,i.execution)
        AND e.page_id=i.page AND e.page_status='dispatched' AND e.consumer_window IS NULL
      RETURNING e.partition_no,e.page_id,e.id,i.unused,i.work)
    UPDATE search.public_filter_coverage_page p SET tail=c.id,tail_consumed=NULL,pending=NULL,charged=p.charged-c.unused,
      revision=p.revision+1,work=c.work FROM completed c
    WHERE (p.partition_no,p.id)=(c.partition_no,c.page_id) RETURNING p.id`,
  ),
  consume: control(
    { home: 'integer', page: 'uuid', execution: 'text', consumed: 'integer', work: 'text' },
    `, locked AS MATERIALIZED (
      SELECT i.* FROM input i JOIN search.public_filter_coverage_page p ON (p.partition_no,p.id)=(i.home,i.page)
      JOIN search.public_filter_execution e ON (e.partition_no,e.observation,e.id)=(p.partition_no,p.observation,p.tail)
      WHERE p.state='open' AND p.pending IS NULL AND p.tail=i.execution AND p.tail_consumed IS NULL
        AND e.page_id=p.id AND e.page_status='complete' AND i.consumed<=e.page_raw FOR UPDATE OF p)
    UPDATE search.public_filter_coverage_page p SET tail_consumed=i.consumed,revision=p.revision+1,work=i.work
    FROM locked i WHERE (p.partition_no,p.id)=(i.home,i.page) RETURNING p.id`,
  ),
  seal: control(
    { home: 'integer', page: 'uuid', tail: 'text', deadline: 'bigint', work: 'text' },
    `UPDATE search.public_filter_coverage_page p SET state='sealed',revision=p.revision+1,work=i.work FROM input i
    WHERE (p.partition_no,p.id)=(i.home,i.page) AND p.state='open' AND p.pending IS NULL AND p.tail=i.tail
      AND p.tail_consumed IS NOT NULL AND p.deadline=i.deadline RETURNING p.id`,
  ),
};

export type ControlPhase = keyof typeof pageControls;
export type ControlRow = {
  id: string;
  rounds?: number;
  charged?: number;
  consumer_window?: string | null;
  consumer_work?: string | null;
};
export type PageControl = {
  phase: ControlPhase;
  pool: Pool;
  observation: string;
  id: string;
  page: string | null;
  deadline: number;
  fund: (sql: string) => unknown[];
  receive: (rows: ControlRow[]) => void;
  submit: (text: string, values: unknown[], receive: (rows: ControlRow[]) => void) => Promise<void>;
};
export type WaitingControl = PageControl & {
  admit: AdmissionYield;
  answer: PromiseWithResolvers<ControlRow | undefined>;
};

export async function readPageControls(waiting: WaitingControl[], check: () => void) {
  const resume = new Map<WaitingControl, () => void>();
  for (const peers of Map.groupBy(waiting, (control) => control.pool).values()) {
    // Two requests on the same observation must see one another's commits.
    const groups: WaitingControl[][] = [];
    for (const peer of peers) {
      const group = groups.find((g) => g.every((v) => v.observation !== peer.observation && v.id !== peer.id));
      if (group) group.push(peer);
      else groups.push([peer]);
    }
    for (const group of groups) {
      // Its metered checkout enforces the earliest participating deadline and
      // observes the physical reply even if a caller has already timed out.
      try {
        check();
        const statement = pageControls[group[0]!.phase];
        const reservation = statement(group.length);
        const participants: WaitingControl[] = [];
        const values: unknown[] = [];
        for (const member of group) {
          try {
            values.push(...member.fund(reservation));
            participants.push(member);
          } catch (error) {
            resume.set(member, () => member.answer.reject(error));
          }
        }
        if (!participants.length) continue;
        const first = participants.reduce((a, b) => (a.deadline <= b.deadline ? a : b));
        const text = participants.length === group.length ? reservation : statement(participants.length);
        const settled = new Map<WaitingControl, () => void>();
        await first.admit(async () => {
          await first.submit(text, values, (rows) => {
            const answers = new Map(rows.map((row) => [row.id, row]));
            for (const member of participants) {
              const row = answers.get(member.id);
              try {
                member.receive(row ? [row] : []);
                settled.set(member, () => member.answer.resolve(row));
              } catch (error) {
                settled.set(member, () => member.answer.reject(error));
              }
            }
          });
        });
        for (const [member, reply] of settled) resume.set(member, reply);
      } catch (error) {
        for (const member of group) if (!resume.has(member)) resume.set(member, () => member.answer.reject(error));
      }
    }
  }
  return resume;
}
