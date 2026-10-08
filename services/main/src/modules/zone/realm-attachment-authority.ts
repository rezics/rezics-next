import type { PoolClient } from 'pg';
import type { FusekiClient } from '../../infrastructure/fuseki.ts';
import { GRAPHS, iri } from '../work/activate.ts';

export const REALM_ATTACH_ACTION = 'realm.attach';
export const realmAttachScope = (realm: string) => `realm:attach:${realm}`;

/** A Realm steward holds an administrative grant on the Realm's own governance
 * scope, as for every other Realm permission. Attaching a Zone grants nothing
 * beyond what the Realm's own read and post rules already allow.
 * Cost: one indexed grant lookup and one exact 1 KiB graph ASK. The row stays
 * share-locked, so a revocation waits for the admission that judged it. */
export async function realmAttachAllowed(client: Pick<PoolClient, 'query'>,
  graph: Pick<FusekiClient, 'query'> | undefined, actingSubject: string, realm: string): Promise<boolean> {
  if (!graph) return false;
  const steward = await client.query(`SELECT g.id FROM access.permission_grant g
    WHERE g.recipient_subject = $1 AND g.scope_id = $2
      AND g.action IN ('realm.owner', 'realm.settings.manage')
      AND g.active AND g.valid_until > clock_timestamp()
      AND (g.membership_id IS NULL OR EXISTS (SELECT 1 FROM access.membership m
        WHERE m.id = g.membership_id AND m.state = 'joined' AND m.generation = g.membership_generation))
    ORDER BY g.id LIMIT 1 FOR SHARE OF g`, [actingSubject, `governance:realm:${realm}`]);
  if (!steward.rowCount) return false;
  return (await graph.query(`PREFIX rv: <https://rezics.com/vocab/> ASK {
    GRAPH ${iri(GRAPHS.current)} { ${iri(realm)} a rv:Realm ; rv:realmState rv:Active ;
      rv:space ?space . FILTER NOT EXISTS { ${iri(realm)} rv:protectionHead ?protection } }
  }`, 1024)).boolean === true;
}
