import { discloseInventory } from '../disclosure/read.ts';
import { disclosureViewer } from '../disclosure/viewer.ts';
import type { VerifiedPrincipal } from '../access/admission.ts';
import {
  readRealizationSourceBasis,
  type RealizationSourceBasisRead,
} from '../realization/source-basis.ts';
import { GRAPHS, RV, iri, type WorkActivationEnvironment } from '../work/activate.ts';
import type { SemanticValue } from '../semantic/value.ts';
import { readReleaseReceipt, type ReleaseCommandReceipt } from './command.ts';
import {
  parseStoredRelease,
  releaseDigest,
  RELEASE_PROFILE,
  RELEASE_V2_PROFILE,
  RELEASE_V3_PROFILE,
  RELEASE_V2_COST,
  type ReleaseV2Record,
} from './schema.ts';
import {
  isReleaseNativeId,
  releaseNativeAdmission,
  releaseNativeFailure,
  releaseNativeValueMatches,
  validReleaseNativeCommand,
  type ReleaseNativeCommandBasis,
  type ReleaseNativeCompleteness,
  type ReleaseSourceNativeBasis,
  type ReleaseSourceVerification,
  type ReleaseSourceVerificationFailure,
  type ReleaseSourceVerificationInput,
} from '../source/release-native-verifier.ts';

interface VerifiedReleaseRealization {
  status: 'available';
  release: { record: ReleaseV2Record; receipt: ReleaseCommandReceipt; head: string };
  realization: RealizationSourceBasisRead;
}

/** Private owner verification only. Source still owns retained-coordinate/value
 * correspondence, authority/rights admission, support settlement and replay. */
export async function verifyReleaseRealizationCorrespondence(
  env: WorkActivationEnvironment,
  input: {
    principal: VerifiedPrincipal;
    actingSubject: string;
    target: string;
    release: ReleaseNativeCommandBasis;
    realization: ReleaseNativeCommandBasis;
    completeness: ReleaseNativeCompleteness;
  },
): Promise<VerifiedReleaseRealization | ReleaseSourceVerificationFailure> {
  const basis = structuredClone({
    target: input.target,
    release: input.release,
    realization: input.realization,
    completeness: input.completeness,
  });
  if (
    !input.principal.issuer ||
    !input.principal.subject ||
    !isReleaseNativeId(input.actingSubject)
  ) {
    return releaseNativeFailure('unavailable', 'verified-principal-unavailable');
  }
  if (
    !isReleaseNativeId(basis.target) ||
    !validReleaseNativeCommand(basis.release) ||
    !validReleaseNativeCommand(basis.realization)
  ) {
    return releaseNativeFailure('target-mismatch', 'native-command-basis-invalid');
  }
  try {
    const admission = await releaseNativeAdmission(env, basis.release.receipt);
    const receipt = admission ? await readReleaseReceipt(env, admission) : null;
    if (!receipt || receipt.outcome !== 'succeeded') {
      return releaseNativeFailure('unavailable', 'release-command-receipt-unavailable');
    }
    if (
      receipt.receipt !== basis.release.receipt ||
      receipt.release !== basis.release.component ||
      receipt.revision !== basis.release.revision ||
      !receipt.work
    ) {
      return releaseNativeFailure('target-mismatch', 'release-command-basis-differs');
    }
    const rows =
      (
        await env.fuseki.query(
          `PREFIX rv: <${RV}>
      SELECT ?work ?head ?state WHERE {
        GRAPH ${iri(GRAPHS.current)} { ${iri(basis.release.component)} a rv:Release ; rv:work ?work ; rv:releaseHead ?head . }
        GRAPH ${iri(GRAPHS.revisions)} { ${iri(basis.release.revision)} a rv:ReleaseRevision ;
          rv:component ${iri(basis.release.component)} ; rv:modelRevision ?profile ; rv:releaseState ?state .
          VALUES ?profile { ${iri(RELEASE_PROFILE)} ${iri(RELEASE_V2_PROFILE)} ${iri(RELEASE_V3_PROFILE)} }
          FILTER NOT EXISTS { ${iri(basis.release.revision)} a rv:ErasedRevision } }
      } LIMIT 2`,
          RELEASE_V2_COST.stateBytes * 2,
        )
      ).results?.bindings ?? [];
    const row = rows[0];
    if (rows.length !== 1 || !row?.work || !row.head || !row.state) {
      return releaseNativeFailure('unavailable', 'release-owner-evidence-unavailable');
    }
    if (row.work.value !== receipt.work)
      return releaseNativeFailure('target-mismatch', 'release-work-differs');
    const record = parseStoredRelease(row.state.value, row.work.value);
    if (
      record.id !== basis.release.component ||
      receipt.scope !== `work:edit:${record.work}` ||
      releaseDigest(record) !== receipt.requestDigest
    ) {
      return releaseNativeFailure('target-mismatch', 'release-command-state-differs');
    }
    if (row.head.value !== basis.release.expectedHead)
      return releaseNativeFailure('head-mismatch', 'release-head-moved');
    if (
      record.profile !== 'release-v2' ||
      record.kind === 'virtual' ||
      record.status === 'withdrawn' ||
      record.status === 'cancelled'
    ) {
      return releaseNativeFailure('unavailable', 'release-has-no-admissible-exact-text-coverage');
    }
    const entry = record.coverage.find((item) => item.realization === basis.realization.component);
    const covered = record.resolvedCoverage.find(
      (item) => item.realization === basis.realization.component,
    );
    if (
      !entry ||
      !covered ||
      entry.revision !== basis.realization.revision ||
      covered.revision !== basis.realization.revision ||
      covered.work !== basis.target
    ) {
      return releaseNativeFailure(
        'target-mismatch',
        'release-does-not-cover-exact-work-realization-revision',
      );
    }
    if (entry.completeness !== basis.completeness) {
      return releaseNativeFailure('value-mismatch', 'release-coverage-completeness-differs');
    }
    const realization = await readRealizationSourceBasis(env, basis.realization);
    if (realization.status !== 'available') return realization;
    const text = realization.record;
    if (
      text.work !== basis.target ||
      text.language !== covered.language ||
      text.kind !== covered.kind ||
      text.status !== covered.status ||
      (record.status === 'official' && text.status !== 'official')
    ) {
      return releaseNativeFailure('target-mismatch', 'release-realization-correspondence-differs');
    }
    const works = [...new Set([record.work, ...record.resolvedCoverage.map((item) => item.work)])];
    const targets = [
      ...works.map((resource) => ({
        owner: 'graph' as const,
        resource,
        component: 'name' as const,
      })),
      {
        owner: 'graph' as const,
        resource: record.id,
        component: 'name' as const,
        revision: basis.release.revision,
        work: record.work,
      },
      {
        owner: 'graph' as const,
        resource: text.id,
        component: 'name' as const,
        revision: basis.realization.revision,
        work: text.work,
      },
    ];
    const decisions = await discloseInventory(
      env,
      targets,
      disclosureViewer(input.principal, input.actingSubject),
      'read',
    );
    if (
      decisions.length !== targets.length ||
      decisions.some((decision) => decision !== 'visible')
    ) {
      return releaseNativeFailure('unavailable', 'native-owner-evidence-not-disclosed');
    }
    // One last bounded owner read detects movement during receipt, coverage and
    // disclosure verification. It is not a lock across Source's later commit.
    const heads =
      (
        await env.fuseki.query(
          `PREFIX rv: <${RV}>
      SELECT ?releaseHead ?realizationHead WHERE { GRAPH ${iri(GRAPHS.current)} {
        ${iri(record.id)} a rv:Release ; rv:work ${iri(record.work)} ; rv:releaseHead ?releaseHead .
        ${iri(text.id)} a rv:Realization ; rv:work ${iri(text.work)} ; rv:head ?realizationHead .
      } } LIMIT 2`,
          4096,
        )
      ).results?.bindings ?? [];
    if (heads.length !== 1 || !heads[0]?.releaseHead || !heads[0].realizationHead) {
      return releaseNativeFailure('unavailable', 'native-current-heads-unavailable');
    }
    if (
      heads[0].releaseHead.value !== basis.release.expectedHead ||
      heads[0].realizationHead.value !== basis.realization.expectedHead
    ) {
      return releaseNativeFailure('head-mismatch', 'native-head-moved-during-verification');
    }
    return {
      status: 'available',
      release: { record, receipt, head: heads[0].releaseHead.value },
      realization: { ...realization, head: heads[0].realizationHead.value },
    };
  } catch {
    return releaseNativeFailure('unavailable', 'native-owner-evidence-unavailable');
  }
}

function releaseProperty(
  basis: ReleaseSourceNativeBasis,
  record: ReleaseV2Record,
  text: RealizationSourceBasisRead['record'],
): SemanticValue | undefined {
  const string = (value: string | null): SemanticValue | undefined =>
    value === null ? undefined : { kind: 'string', lexical: value };
  switch (basis.property.predicate) {
    case 'https://schema.org/name':
      return {
        kind: 'language-string',
        lexical: record.title.value,
        language: record.title.language,
      };
    case 'https://schema.org/datePublished':
      return record.publicationYear === null
        ? undefined
        : {
            kind: 'temporal',
            lexical: String(record.publicationYear).padStart(4, '0'),
            precision: 'year',
            calendar: 'gregorian',
          };
    case `${RV}releaseKind`:
      return string(record.kind);
    case `${RV}releaseStatus`:
      return string(record.status);
    case `${RV}platform`:
      return string(record.platform);
    case `${RV}territory`:
      return string(record.territory);
    case `${RV}contentLanguage`:
      return string(text.language);
    case `${RV}completeness`:
      return string(basis.coverage.completeness);
    default:
      return undefined;
  }
}

export async function verifyReleaseSourceNative(
  env: WorkActivationEnvironment,
  input: ReleaseSourceVerificationInput<ReleaseSourceNativeBasis>,
): Promise<ReleaseSourceVerification<ReleaseSourceNativeBasis, 'release'>> {
  const native = structuredClone(input.native),
    selected = structuredClone(input.selected);
  if (native.owner !== 'release' || native.kind !== 'component-property') {
    return releaseNativeFailure('target-mismatch', 'release-property-basis-required');
  }
  const proof = await verifyReleaseRealizationCorrespondence(env, {
    principal: input.principal,
    actingSubject: input.actingSubject,
    target: native.target,
    release: native,
    realization: native.coverage.realization,
    completeness: native.coverage.completeness,
  });
  if (proof.status !== 'available') return proof;
  if (
    !releaseNativeValueMatches(
      native.property,
      selected,
      releaseProperty(native, proof.release.record, proof.realization.record),
    )
  ) {
    return releaseNativeFailure(
      'value-mismatch',
      'release-selected-property-differs-or-is-unrepresented',
    );
  }
  return {
    status: 'verified',
    receipt: proof.release.receipt,
    revision: native.revision,
    native,
    selected,
    headGuarantee: 'verified-before-commit',
    currentHeads: { release: proof.release.head, realization: proof.realization.head },
    correspondence: {
      work: native.target,
      release: {
        component: native.component,
        revision: native.revision,
        receipt: native.receipt,
        expectedHead: native.expectedHead,
      },
      realization: native.coverage.realization,
      completeness: native.coverage.completeness,
      language: proof.realization.record.language,
    },
  };
}
