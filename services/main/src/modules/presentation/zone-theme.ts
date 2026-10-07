import { checkFirstPartyBundle } from '../theme/first-party-bundle.ts';
import { readFirstPartyTheme, zonePackageExecution, type FirstPartyView }
  from '../theme/first-party-lifecycle.ts';
import { ThemeInvalid, ThemeUnavailable } from '../theme/activation.ts';
import { GRAPHS, ID, RV, iri, type WorkActivationEnvironment } from '../work/activate.ts';

const NATIVE = /^https:\/\/rezics\.com\/id\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export interface ZoneThemeSelection { revision: string; activation: string }
export interface ZoneThemeExecution {
  execution: ReturnType<typeof zonePackageExecution>;
  selection: ZoneThemeSelection | null;
}
export const ZONE_THEME_EXECUTION_COST = { selectionGraphReads: 1, selectionRows: 2,
  selectionResponseBytes: 32_000 } as const;

/** Undefined selects the current approved activation for publication; null
 * retains the absence of an approved package. A published selection keeps its
 * immutable package while revocation, expiry and global controls remain live. */
export async function readZoneThemeExecution(env: WorkActivationEnvironment,
  theme: string, zone: string, selection?: ZoneThemeSelection | null): Promise<ZoneThemeExecution> {
  if (!NATIVE.test(theme) || !NATIVE.test(zone) || selection &&
    (!NATIVE.test(selection.revision) || !NATIVE.test(selection.activation))) {
    throw new ThemeInvalid('invalid Zone theme selection');
  }
  if (selection === null) return { execution: zonePackageExecution(null, zone), selection: null };
  const current = await readFirstPartyTheme(env, theme.slice(ID.length));
  if (!current || current.hostZone !== zone) {
    return { execution: zonePackageExecution(current, zone), selection: selection ?? null };
  }
  const selected = selection ?? (current.activation && current.activationRevision
    ? { activation: current.activation, revision: current.activationRevision } : null);
  if (!selected) return { execution: zonePackageExecution(current, zone), selection: null };
  const result = await env.fuseki.query(`PREFIX rv: <${RV}>
    SELECT ?digest ?bundle ?submitter ?submitterPrincipal ?review ?reviewer ?reviewerPrincipal
      ?decision ?evidence ?expiry ?activationControl ?revocation WHERE {
      GRAPH ${iri(GRAPHS.revisions)} {
        ${iri(selected.activation)} a rv:FirstPartyThemeActivation ; rv:component ${iri(theme)} ;
          rv:revision ${iri(selected.revision)} ; rv:hostZone ${iri(zone)} ;
          rv:review ?review ; rv:approvalExpiresAt ?expiry ; rv:controlBasis ?activationControl .
        ${iri(selected.revision)} a rv:FirstPartyThemeRevision ; rv:component ${iri(theme)} ;
          rv:hostZone ${iri(zone)} ; rv:dependencyDigest ?digest ; rv:bundle ?bundle ;
          rv:submittedBy ?submitter ; rv:submittedPrincipal ?submitterPrincipal .
        ?review a rv:FirstPartyThemeReview ; rv:component ${iri(theme)} ;
          rv:revision ${iri(selected.revision)} ; rv:reviewedBy ?reviewer ;
          rv:reviewerPrincipal ?reviewerPrincipal ; rv:decision ?decision ; rv:reviewEvidenceDigest ?evidence .
      }
      GRAPH ${iri(GRAPHS.current)} { ${iri(selected.revision)} rv:reviewHead ?review }
      OPTIONAL { GRAPH ${iri(GRAPHS.current)} { ${iri(selected.activation)} rv:revocation ?revocation } }
    } LIMIT ${ZONE_THEME_EXECUTION_COST.selectionRows}`, ZONE_THEME_EXECUTION_COST.selectionResponseBytes);
  const rows = result.results?.bindings ?? [];
  if (rows.length !== 1) throw new ThemeUnavailable('published Zone theme proof is unavailable or ambiguous');
  const row = rows[0]!;
  const get = (key: string) => row[key]?.value ?? null;
  if (!get('bundle') || !get('digest') || !get('submitter') || !get('submitterPrincipal')
    || !get('review') || !get('reviewer') || !get('reviewerPrincipal') || !get('evidence')
    || !get('expiry') || !get('activationControl')
    || ![`${RV}Approved`, `${RV}Rejected`].includes(get('decision') ?? '')) {
    throw new ThemeUnavailable('published Zone theme proof is incomplete');
  }
  let checked: ReturnType<typeof checkFirstPartyBundle>;
  try { checked = checkFirstPartyBundle(JSON.parse(get('bundle')!)); }
  catch { throw new ThemeUnavailable('published Zone theme bundle is invalid'); }
  if (checked.dependencyDigest !== get('digest') || checked.bundle.hostZone !== zone) {
    throw new ThemeUnavailable('published Zone theme bundle digest or host differs');
  }
  const pinned: FirstPartyView = { ...current, revision: selected.revision,
    activation: selected.activation, activationRevision: selected.revision,
    dependencyDigest: checked.dependencyDigest, bundle: checked.bundle,
    submitter: get('submitter'), submitterPrincipal: get('submitterPrincipal'),
    review: get('review'), reviewer: get('reviewer'), reviewerPrincipal: get('reviewerPrincipal'),
    decision: get('decision') === `${RV}Approved` ? 'approved' : 'rejected',
    reviewEvidenceDigest: get('evidence'), approvalExpiresAt: get('expiry'),
    activationControl: get('activationControl'), revoked: !!get('revocation') };
  const execution = zonePackageExecution(pinned, zone);
  return { execution, selection: selection === undefined && execution.state === 'fallback' ? null : selected };
}
