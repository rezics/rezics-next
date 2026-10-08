import { uuidToSid } from '@rezics/model/address/sid';
import type { CanonicalAddress } from '@rezics/model/address';
import type { AccessAdmissionRegistry } from '../access/admission.ts';
import { identityCanonical } from '../address/canonical.ts';
import { AccountAssertionDenied, AccountAssertionUnavailable,
  type AccountAssertionVerifier } from '../account/verify-assertion.ts';
import { canonicalLanguage, direction } from '../display-language/tag.ts';
import type { SparqlResult } from '../../infrastructure/fuseki.ts';
import { GRAPHS, RV, iri, lit, type WorkActivationEnvironment } from '../work/activate.ts';
import { assertGraphAdmissionOpen } from '../work/restore-lineage.ts';
import { InvalidZoneConfiguration } from './config-format.ts';
import { duringAttachmentPage } from './realm-attachment-authority.ts';
import { realmAttachHeld, realmAttachRequest } from './realm-attachment.ts';

/** The same answer as a Realm that is not there. Callers cannot tell a missing
 * Realm, a stranger, or a signed-out reader apart. */
export class RealmAttachmentListMissing extends Error {}

/** One bound page. The grant check is the existing `realm.attach` lookup and is
 * not repeated per row; this page is that lookup's graph read, so the share
 * lock covers it. Jena can find `rv:defaultRealm` for this Realm through POS.
 * An IRI `>` filter matches nothing in Jena 6, so the cursor stays STR(?zone)
 * and that posting is sorted rather than seeked. */
export const ZONE_ATTACHMENT_LIST_COST = { graphReads: 1, sqlReads: 1, pageSize: 24 } as const;

const CURSOR = /^v1:https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
const WHEN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

export interface ZoneAttachmentRow {
  zone: string;
  name: string | null;
  language: string;
  direction: 'ltr' | 'rtl';
  address: CanonicalAddress;
  attachedAt: string | null;
  withdraw: { method: 'POST'; path: string };
}

export async function listRealmZoneAttachments(env: WorkActivationEnvironment,
  account: Pick<AccountAssertionVerifier, 'verify'>,
  access: Partial<Pick<AccessAdmissionRegistry, 'assertAuthority'>>,
  request: Request, input: { realm: string; actingSubject?: string; after?: string; limit: number }) {
  if (input.after && !CURSOR.test(input.after)) {
    throw new InvalidZoneConfiguration('Unsupported Zone attachment cursor; restart the listing');
  }
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 50) {
    throw new InvalidZoneConfiguration('Zone attachment page size is invalid');
  }
  // Refuse before any Zone query, so a stranger and a missing Realm cost the same
  // and neither walks the attachment set.
  let principal;
  try { principal = await account.verify(request, ['governance:decide']); }
  catch (error) {
    if (error instanceof AccountAssertionUnavailable) throw error;
    if (error instanceof AccountAssertionDenied) throw new RealmAttachmentListMissing('Realm is unavailable');
    throw error;
  }
  if (!input.actingSubject) throw new RealmAttachmentListMissing('Realm is unavailable');
  const read: { query: string; budget: number; result?: SparqlResult } = {
    query: attachmentPageQuery(input.realm, input.after, input.limit), budget: 64 * 1024 };
  const held = await duringAttachmentPage(read, () => realmAttachHeld(access,
    realmAttachRequest(principal, input.actingSubject!, input.realm)));
  if (!held) throw new RealmAttachmentListMissing('Realm is unavailable');
  if (!read.result) throw new Error('Realm attachment page was not read with the grant');
  await assertGraphAdmissionOpen(env.fuseki, env.lineage);
  const rows = read.result.results?.bindings?.filter(row => row.zone?.value) ?? [];
  const selected = collapse(rows).slice(0, input.limit);
  const spaces = [...new Set(selected.map(row => row.space!.value))];
  const names = spaces.length ? await env.addresses?.currents(spaces).catch(() => new Map()) : new Map();
  const items = selected.map(row => rowOf(row, names));
  const more = rows.length > input.limit;
  return { realm: input.realm, items,
    next: more && items.length ? `v1:${items.at(-1)!.zone}` : null,
    cost: { graphReads: ZONE_ATTACHMENT_LIST_COST.graphReads,
      sqlReads: ZONE_ATTACHMENT_LIST_COST.sqlReads, rows: rows.length } };
}

function attachmentPageQuery(realm: string, after: string | undefined, limit: number): string {
  const cursor = after ? `FILTER(STR(?zone) > ${lit(after.slice(3))})` : '';
  return `PREFIX rv: <${RV}>
    PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
    SELECT ?open ?zone ?space ?name ?language ?attachedAt WHERE {
      GRAPH ${iri(GRAPHS.current)} {
        ${iri(realm)} a rv:Realm ; rv:realmState rv:Active ; rv:space ?realmSpace .
        FILTER NOT EXISTS { ${iri(realm)} rv:protectionHead ?protection }
        BIND("open" AS ?open)
      }
      OPTIONAL {
        GRAPH ${iri(GRAPHS.current)} {
          ?zone a rv:Zone ; rv:defaultRealm ${iri(realm)} ; rv:realmAttachment ?receipt ; rv:space ?space .
          OPTIONAL { ?zone rdfs:label ?name . BIND(LANG(?name) AS ?language) }
        }
        GRAPH ${iri(GRAPHS.receipts)} {
          ?receipt rv:outcome rv:Succeeded .
          OPTIONAL { ?receipt rv:realmAttachedAt ?attachedAt }
        }
        ${cursor}
      }
    } ORDER BY STR(?zone) LIMIT ${limit + 1}`;
}

function collapse<T extends { zone?: { value: string } }>(rows: T[]): T[] {
  const seen = new Set<string>();
  const unique: T[] = [];
  for (const row of rows) {
    const zone = row.zone?.value;
    if (!zone || seen.has(zone)) continue;
    seen.add(zone);
    unique.push(row);
  }
  return unique;
}

function rowOf(row: { zone?: { value: string }; space?: { value: string }; name?: { value: string };
  language?: { value: string }; attachedAt?: { value: string } },
  names: Map<string, { key: string }> | undefined): ZoneAttachmentRow {
  const zone = row.zone!.value;
  const space = row.space!.value;
  const language = canonicalLanguage(row.language?.value || 'und') ?? 'und';
  const name = row.name?.value?.trim() && row.name.value.length <= 300 ? row.name.value : null;
  const address = identityCanonical('zone', space, name ?? '');
  const current = names?.get(`space\0${space}`)?.key;
  if (current) address.key = current;
  else address.key = uuidToSid(space.slice(-36));
  const when = row.attachedAt?.value;
  return { zone, name, language, direction: direction(language, name ?? ''), address,
    attachedAt: when && WHEN.test(when) ? when : null,
    withdraw: { method: 'POST', path: `/v1/zones/${zone.slice(-36)}/realm-attachment-withdrawals` } };
}
