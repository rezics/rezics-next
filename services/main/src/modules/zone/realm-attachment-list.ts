import { uuidToSid } from '@rezics/model/address/sid';
import type { CanonicalAddress } from '@rezics/model/address';
import type { AccessAdmissionRegistry } from '../access/admission.ts';
import { identityCanonical } from '../address/canonical.ts';
import { AccountAssertionDenied, AccountAssertionUnavailable,
  type AccountAssertionVerifier } from '../account/verify-assertion.ts';
import { canonicalLanguage, direction } from '../display-language/tag.ts';
import { GRAPHS, RV, iri, lit, type WorkActivationEnvironment } from '../work/activate.ts';
import { assertGraphAdmissionOpen } from '../work/restore-lineage.ts';
import { InvalidZoneConfiguration } from './config-format.ts';
import { realmAttachHeld, realmAttachRequest } from './realm-attachment.ts';

/** The same answer as a Realm that is not there. Callers cannot tell a missing
 * Realm, a stranger, or a signed-out reader apart. */
export class RealmAttachmentListMissing extends Error {}

/** One bound page. The grant check is the existing `realm.attach` lookup and is
 * not repeated per row. Jena can find `rv:defaultRealm` for this Realm through
 * POS, then sorts that Realm's matches; an ordered posting would seek the page. */
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
  if (!input.actingSubject || !await realmAttachHeld(access,
    realmAttachRequest(principal, input.actingSubject, input.realm))) {
    throw new RealmAttachmentListMissing('Realm is unavailable');
  }
  await assertGraphAdmissionOpen(env.fuseki, env.lineage);
  const after = input.after ? `FILTER(STR(?zone) > ${lit(input.after.slice(3))})` : '';
  const rows = (await env.fuseki.query(`PREFIX rv: <${RV}>
    PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
    SELECT ?zone ?space ?name ?language ?attachedAt WHERE {
      GRAPH ${iri(GRAPHS.current)} {
        ?zone a rv:Zone ; rv:defaultRealm ${iri(input.realm)} ; rv:realmAttachment ?receipt ; rv:space ?space .
        OPTIONAL { ?zone rdfs:label ?name . BIND(LANG(?name) AS ?language) }
      }
      GRAPH ${iri(GRAPHS.receipts)} {
        ?receipt rv:outcome rv:Succeeded .
        OPTIONAL { ?receipt rv:realmAttachedAt ?attachedAt }
      }
      ${after}
    } ORDER BY STR(?zone) LIMIT ${input.limit + 1}`, 64 * 1024)).results?.bindings ?? [];
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
