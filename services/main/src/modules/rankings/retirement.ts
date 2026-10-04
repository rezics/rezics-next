import type { Pool } from 'pg';
import { controlTransaction } from '../access/topology-control.ts';
import { GRAPHS, iri } from '../work/activate.ts';
import type { WorkReadSession } from '../work/read-session.ts';

/** One cut and at most 20 admissions (80 order rows) plus 20 jobs per tick.
 * Leaving one of several episodes sharing a cut must preserve the population.
 * A rejoin during retirement rebuilds the cut before it can serve a page. */
export const REALM_RETIREMENT_COST = {
  populations: 1,
  admissions: 20,
  jobs: 20,
  graphReads: 1,
  postgresStatements: 12,
} as const;

export async function retireRealmPopulation(
  access: Pool,
  session: WorkReadSession,
  epoch: string,
  realm: string,
  after: string,
) {
  const active =
    (
      await session.query(
        `SELECT ?realm WHERE {
    GRAPH ${iri(GRAPHS.current)} { VALUES ?realm { ${iri(realm)} }
      ?realm a rv:Realm ; rv:realmState rv:Active ; rv:space ?space .
      ?space a rv:Space ; rv:realmCapability ?realm . }
  } LIMIT 1`,
        1,
      )
    ).length > 0;
  await controlTransaction(access, async (client) => {
    const claimed = await client.query(
      `SELECT 1 FROM access.realm_thread_dirty
      WHERE data_epoch=$1 AND kind='population' AND resource=$2 AND after_key=$3 FOR UPDATE`,
      [epoch, realm, after],
    );
    if (!claimed.rowCount) return;
    const population = (
      await client.query<{ population: string; live: boolean }>(
        `
      SELECT p.population, EXISTS(
        SELECT 1 FROM access.realm_history_admission h
        WHERE h.data_epoch=p.floor_epoch AND h.sequence=p.floor_sequence AND (
          h.kind='agent' AND EXISTS(SELECT 1 FROM access.membership m WHERE m.id=h.membership_id
            AND m.generation=h.generation AND m.kind='realm' AND m.owner_subject=p.realm AND m.state='joined')
          OR h.kind='private' AND EXISTS(SELECT 1 FROM access.private_membership m WHERE m.id=h.membership_id
            AND m.generation=h.generation AND m.kind='realm' AND m.owner_subject=p.realm AND m.state='joined'))
      ) AS live FROM access.realm_thread_population p
      WHERE p.data_epoch=$1 AND p.realm=$2 AND p.population>$3
      ORDER BY p.population LIMIT 1 FOR UPDATE OF p`,
        [epoch, realm, after],
      )
    ).rows[0];
    if (!population) {
      await client.query(
        `DELETE FROM access.realm_thread_dirty
        WHERE data_epoch=$1 AND kind='population' AND resource=$2 AND after_key=$3`,
        [epoch, realm, after],
      );
      return;
    }
    const key = [epoch, realm, population.population];
    if (!active || !population.live) {
      // Fence every partially retired page, and restart admission if a live
      // episode acquires this same cut before the next tick.
      await client.query(
        `UPDATE access.realm_thread_population SET ready=false,after_reply=''
        WHERE data_epoch=$1 AND realm=$2 AND population=$3`,
        key,
      );
      const admissions = await client.query(
        `DELETE FROM access.realm_thread_population_admission
        WHERE (data_epoch,realm,population,reply) IN (
          SELECT data_epoch,realm,population,reply FROM access.realm_thread_population_admission
          WHERE data_epoch=$1 AND realm=$2 AND population=$3 ORDER BY reply LIMIT $4)`,
        [...key, REALM_RETIREMENT_COST.admissions],
      );
      const jobs = await client.query(
        `DELETE FROM access.realm_thread_population_job
        WHERE (data_epoch,realm,population,reply) IN (
          SELECT data_epoch,realm,population,reply FROM access.realm_thread_population_job
          WHERE data_epoch=$1 AND realm=$2 AND population=$3 ORDER BY reply LIMIT $4)`,
        [...key, REALM_RETIREMENT_COST.jobs],
      );
      if (admissions.rowCount || jobs.rowCount) return;
      await client.query(
        `DELETE FROM access.realm_thread_population
        WHERE data_epoch=$1 AND realm=$2 AND population=$3`,
        key,
      );
    }
    await client.query(
      `UPDATE access.realm_thread_dirty SET after_key=$4
      WHERE data_epoch=$1 AND kind='population' AND resource=$2 AND after_key=$3`,
      [epoch, realm, after, population.population],
    );
  });
}
