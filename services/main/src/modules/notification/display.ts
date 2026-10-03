import type { Pool } from 'pg';
import type { ResourceSummary } from '../media/summary.ts';
import type { WorkActivationEnvironment } from '../work/activate.ts';
import { GRAPHS, RV, iri } from '../work/activate.ts';
import { publicWork } from '../work/public-patterns.ts';
import { readCurrentProfile } from '../realm-profile/commands.ts';
import { selectDisplayName } from '../display-language/select.ts';
import { uuidToSid } from '@rezics/model/address/sid';

const native = /^https:\/\/rezics\.com\/id\/([0-9a-f-]{36})$/;

/** Current, recipient-authorized presentation. Call only after subject disclosure succeeds. */
export async function notificationRealmDisplay(env: WorkActivationEnvironment, realm: string) {
  const match = native.exec(realm);
  if (!match) return {};
  const profile = await readCurrentProfile(env, realm).catch(() => null);
  const rows = (await env.fuseki.query(`PREFIX rv: <${RV}>
    PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
    SELECT ?name ?space WHERE {
      GRAPH ${iri(GRAPHS.current)} { ${iri(realm)} a rv:Realm ; rv:space ?space .
        OPTIONAL { ${iri(realm)} rdfs:label ?name }
      }
    } LIMIT 3`, 8_192)).results?.bindings ?? [];
  if (rows.length > 2) throw new Error('notification Realm display is ambiguous');
  const name = profile ? selectDisplayName(profile.profile.name, [])?.value : rows[0]?.name?.value;
  const space = rows[0]?.space?.value;
  const segment = space ? (await env.addresses?.currents([space]).catch(() => new Map()))?.get(`space\0${space}`)?.key
    ?? uuidToSid(space.slice(-36)) : match[1];
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

/** A current saved-view match is private to its recipient. Its optional Concept
 * name and the Work name come from the same public, disclosure-aware summary read. */
export async function notificationNewWorkDisplay(access: Pool, input: {
  principalId: string; owner: string; ref: string; work: string;
}, summaries: (resources: string[]) => Promise<ResourceSummary[]>) {
  if (!native.test(input.work)) return null;
  type View = { name: string | null; concept: string | null; revision: string };
  const readView = async () => (await access.query<View>(`SELECT name, concept, revision::text
    FROM access.saved_filter WHERE id = $1 AND principal_id = $2`, [input.ref, input.principalId])).rows[0];
  const view = input.owner === 'access' ? await readView() : null;
  if (input.owner === 'access' && !view) return null;
  const resources = [input.work, ...(view?.concept ? [view.concept] : [])];
  const current = await summaries(resources);
  const work = current.find(item => item.reference === input.work);
  const concept = view?.concept ? current.find(item => item.reference === view.concept) : null;
  if (work?.status !== 'available' || work.type !== 'work' || work.disclosure !== 'public'
    || view?.concept && (concept?.status !== 'available' || concept.type !== 'concept'
      || concept.disclosure !== 'public')) return null;
  if (view) {
    const after = await readView();
    if (!after || after.revision !== view.revision || after.name !== view.name || after.concept !== view.concept) return null;
  }
  return { title: work.name.value, language: work.name.language,
    topicName: view?.name ?? (concept?.status === 'available' ? concept.name.value : null),
    href: `${work.address.prefix}${encodeURIComponent(work.address.key)}`, linkTarget: work.reference };
}

/** Per notice: two exact recipient/view reads and one summary batch of at most two identities. */
export const NOTIFICATION_NEW_WORK_DISPLAY_COST = { accessStatements: 2, summaryItems: 2 } as const;
