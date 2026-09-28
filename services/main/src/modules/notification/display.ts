import type { Pool } from 'pg';
import type { WorkActivationEnvironment } from '../work/activate.ts';
import { GRAPHS, RV, iri } from '../work/activate.ts';
import { publicWork } from '../work/public-patterns.ts';
import { readCurrentProfile } from '../realm-profile/commands.ts';
import { selectDisplayName } from '../display-language/select.ts';

const native = /^https:\/\/rezics\.com\/id\/([0-9a-f-]{36})$/;

/** Current, recipient-authorized presentation. Call only after subject disclosure succeeds. */
export async function notificationRealmDisplay(env: WorkActivationEnvironment, realm: string) {
  const match = native.exec(realm);
  if (!match) return {};
  const profile = await readCurrentProfile(env, realm).catch(() => null);
  const rows = (await env.fuseki.query(`PREFIX rv: <${RV}>
    PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
    SELECT ?name ?segment WHERE {
      GRAPH ${iri(GRAPHS.current)} { ${iri(realm)} a rv:Realm .
        OPTIONAL { ${iri(realm)} rdfs:label ?name }
        OPTIONAL { ?zone a rv:Zone ; rv:official true ; rv:zoneState rv:Active ;
          rv:disclosure rv:Public ; rv:defaultRealm ${iri(realm)} ; rv:routeSegment ?segment }
      }
    } LIMIT 3`, 8_192)).results?.bindings ?? [];
  if (rows.length > 2) throw new Error('notification Realm display is ambiguous');
  const name = profile ? selectDisplayName(profile.profile.name, [])?.value : rows[0]?.name?.value;
  const segment = rows.find(row => row.segment)?.segment?.value ?? match[1];
  return { ...(name ? { realmName: name.slice(0, 200) } : {}),
    ...(segment ? { realmRouteSegment: segment.slice(0, 100) } : {}) };
}

export async function notificationWorkTitle(env: WorkActivationEnvironment, work: string,
  publicOnly = true): Promise<string | null> {
  if (!native.test(work)) return null;
  const rows = (await env.fuseki.query(`PREFIX rv: <${RV}>
    PREFIX schema: <https://schema.org/>
    PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
    SELECT ?title WHERE { GRAPH ${iri(GRAPHS.current)} { ${iri(work)} rdfs:label ?title }
      ${publicOnly ? publicWork(iri(work), '?main') : ''}
    } LIMIT 2`, 8_192)).results?.bindings ?? [];
  return rows.length === 1 && rows[0]?.title?.value ? rows[0].title.value.slice(0, 200) : null;
}

/** Legacy receipts without role metadata use a name only when one role association matches. */
export async function notificationRoleName(access: Pool, realm: string, member: string,
  receiptRole: unknown): Promise<string | null> {
  if (typeof receiptRole === 'object' && receiptRole !== null && 'id' in receiptRole
    && typeof receiptRole.id === 'string') {
    const current = (await access.query<{ name: string }>(`SELECT name FROM access.realm_admin_role
      WHERE realm = $1 AND id = $2`, [realm, receiptRole.id])).rows[0]?.name;
    if (current) return current;
  }
  if (typeof receiptRole === 'object' && receiptRole !== null && 'name' in receiptRole
    && typeof receiptRole.name === 'string' && receiptRole.name.length <= 80) return receiptRole.name;
  const rows = (await access.query<{ name: string }>(`SELECT r.name FROM access.realm_admin_assignment a
    JOIN access.realm_admin_role r ON r.realm = a.realm AND r.id = a.role_id
    WHERE a.realm = $1 AND a.member = $2
    ORDER BY r.id LIMIT 2`, [realm, member])).rows;
  return rows.length === 1 ? rows[0]!.name : null;
}
