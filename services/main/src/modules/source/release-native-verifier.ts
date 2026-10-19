import type { VerifiedPrincipal } from '../access/admission.ts';
import { canonicalRecord } from '../release/schema.ts';
import { recordedLanguageTag } from '../release/languages.ts';
import { checkedSemanticValue, type SemanticValue } from '../semantic/value.ts';
import { GRAPHS, RV, iri, type WorkActivationEnvironment } from '../work/activate.ts';
import type { WorkEditReceipt } from '../work/command-envelope.ts';

/** An acknowledged command and an independently selected current-head precondition.
 * A release may still cover an older realization revision after its head advances. */
export interface ReleaseNativeCommandBasis {
  component: string;
  revision: string;
  receipt: string;
  expectedHead: string;
}

export type ReleaseNativeCompleteness = 'complete' | 'partial' | 'trial' | 'unknown';

interface ReleaseNativePropertyBasis extends ReleaseNativeCommandBasis {
  kind: 'component-property';
  /** The selected continuity Work, not a descriptive release/event resource. */
  target: string;
  property: { predicate: string; value: SemanticValue };
}

export interface ReleaseSourceNativeBasis extends ReleaseNativePropertyBasis {
  owner: 'release';
  coverage: {
    realization: ReleaseNativeCommandBasis;
    completeness: ReleaseNativeCompleteness;
  };
}

export interface RealizationSourceNativeBasis extends ReleaseNativePropertyBasis {
  owner: 'realization';
  release: ReleaseNativeCommandBasis;
  completeness: ReleaseNativeCompleteness;
}

/** Source supplies the typed selected value after its registered retained-value
 * correspondence rule. This verifier neither admits retained bytes nor normalizes
 * provider data. Optional language preserves omitted/null/value source evidence. */
export interface ReleaseSourceSelectedValue {
  value: SemanticValue;
  language?: string | null;
}

export interface ReleaseSourceVerificationInput<B> {
  principal: VerifiedPrincipal;
  actingSubject: string;
  native: B;
  selected: ReleaseSourceSelectedValue;
}

export interface ReleaseSourceVerificationFailure {
  status: 'unavailable' | 'target-mismatch' | 'value-mismatch' | 'head-mismatch';
  reason: string;
}

export interface ReleaseSourceVerified<B, K extends 'release' | 'realization'> {
  status: 'verified';
  /** The actual owner command receipt, never a component/revision/support ID. */
  receipt: WorkEditReceipt<K>;
  revision: string;
  native: B;
  selected: ReleaseSourceSelectedValue;
  headGuarantee: 'verified-before-commit';
  currentHeads: { release: string; realization: string };
  correspondence: {
    work: string;
    release: ReleaseNativeCommandBasis;
    realization: ReleaseNativeCommandBasis;
    completeness: ReleaseNativeCompleteness;
    language: string;
  };
}

export type ReleaseSourceVerification<B, K extends 'release' | 'realization'> =
  | ReleaseSourceVerificationFailure
  | ReleaseSourceVerified<B, K>;

export const releaseNativeFailure = (
  status: ReleaseSourceVerificationFailure['status'],
  reason: string,
): ReleaseSourceVerificationFailure => ({ status, reason });

export const isReleaseNativeId = (value: string): boolean =>
  /^https:\/\/rezics\.com\/id\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
    value,
  );

export function validReleaseNativeCommand(value: ReleaseNativeCommandBasis): boolean {
  return (
    [value.component, value.revision, value.expectedHead].every(isReleaseNativeId) &&
    /^urn:rezics:receipt:[0-9a-f]{64}$/.test(value.receipt)
  );
}

/** Resolve the supplied receipt itself before calling the existing owner reader.
 * No reverse lookup from a component/revision is allowed to invent a receipt. */
export async function releaseNativeAdmission(
  env: Pick<WorkActivationEnvironment, 'fuseki'>,
  receipt: string,
): Promise<string | null> {
  if (!/^urn:rezics:receipt:[0-9a-f]{64}$/.test(receipt)) return null;
  const rows =
    (
      await env.fuseki.query(
        `PREFIX rv: <${RV}>
    SELECT ?admission WHERE { GRAPH ${iri(GRAPHS.receipts)} {
      ${iri(receipt)} a rv:OperationReceipt ; rv:admissionId ?admission .
    } } LIMIT 2`,
        4096,
      )
    ).results?.bindings ?? [];
  const admission = rows[0]?.admission?.value;
  return rows.length === 1 &&
    admission &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(admission)
    ? admission
    : null;
}

export function releaseNativeValueMatches(
  property: ReleaseNativePropertyBasis['property'],
  selected: ReleaseSourceSelectedValue,
  actual: SemanticValue | undefined,
): boolean {
  if (!actual) return false;
  try {
    const value = checkedSemanticValue(property.value);
    if (
      canonicalRecord(value) !== canonicalRecord(actual) ||
      canonicalRecord(checkedSemanticValue(selected.value)) !== canonicalRecord(actual)
    )
      return false;
    // A tag in the native title cannot supply missing source language evidence.
    if (actual.kind === 'language-string')
      return (
        typeof selected.language === 'string' &&
        recordedLanguageTag(selected.language) === actual.language
      );
    return selected.language === undefined || selected.language === null;
  } catch {
    return false;
  }
}
