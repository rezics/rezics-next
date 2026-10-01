import { knownCountry } from './country.ts';

export type Label = 'r15' | 'r18' | 'r18g';
/** General is the empty set. Adult dimensions are independent; r15 stands alone. */
export type Labels = [] | ['r15'] | ['r18'] | ['r18g'] | ['r18', 'r18g'];
export type Assessment = { status: 'unassessed' } | { status: 'assessed'; labels: Labels };
export const UNASSESSED = Object.freeze({
  status: 'unassessed',
  displayLabel: 'Not assessed',
} as const);
export type Age = 'unknown' | 'under-15' | '15-17' | 'adult';
/** Media, derivatives, history, caches and exports retain their delivery channel. */
export type Channel = 'read' | 'index' | 'preview' | 'email' | 'push';
export interface Viewer {
  signedIn: boolean;
  age: Age;
  country: string | null;
  optIns: { general: boolean; r15: boolean; sexual: boolean; grotesque: boolean };
}
export interface RealmCeiling {
  maxAge: 'general' | 'r15' | 'adult';
  sexual: boolean;
  grotesque: boolean;
}
export const REASONS = [
  'general_disabled',
  'r15_opt_in_required',
  'sign_in_required',
  'age_unknown',
  'country_unknown',
  'age_below_15',
  'adult_required',
  'sexual_opt_in_required',
  'grotesque_opt_in_required',
  'market_restricted',
  'channel_restricted',
  'realm_ceiling',
] as const;
export type Reason = (typeof REASONS)[number];
export const ANONYMOUS_VIEWER: Viewer = Object.freeze({
  signedIn: false,
  age: 'unknown',
  country: null,
  optIns: Object.freeze({ general: true, r15: false, sexual: false, grotesque: false }),
});

export function validLabels(labels: readonly string[]): labels is Labels {
  return (
    Array.isArray(labels) &&
    (labels.length === 0 ||
      (labels.length === 1 && ['r15', 'r18', 'r18g'].includes(labels[0]!)) ||
      (labels.length === 2 && labels[0] === 'r18' && labels[1] === 'r18g'))
  );
}

/** The partial order keeps sexual and grotesque separate. */
export function atLeastAsRestrictive(candidate: Labels, prior: Labels): boolean {
  if (!prior.length) return true;
  if (prior[0] === 'r15') return candidate.length > 0;
  return prior.every((label) => (candidate as readonly Label[]).includes(label));
}

/** Product policy, not age assurance. No storage or channel adapter may grant
 * eligibility independently. Index and preview always use anonymous evidence. */
export function eligible(input: {
  assessment: Assessment;
  viewer: Viewer;
  realmCeiling?: RealmCeiling;
  channel: Channel;
}): { eligible: boolean; reasons: Reason[] } {
  const { assessment, realmCeiling, channel } = input;
  const viewer = channel === 'index' || channel === 'preview' ? ANONYMOUS_VIEWER : input.viewer;
  if (assessment.status === 'unassessed') {
    // Manager's G-509 review admits missing assessments on every channel.
    // Admission never changes their state or presents them as general.
    return { eligible: true, reasons: [] };
  }
  const labels: readonly Label[] = assessment.labels;
  if (!labels.length) return viewer.optIns.general ? { eligible: true, reasons: [] }
    : { eligible: false, reasons: ['general_disabled'] };
  const reasons: Reason[] = [];
  const adult = labels.includes('r18') || labels.includes('r18g');
  if (!viewer.signedIn) reasons.push('sign_in_required');
  if (viewer.age === 'unknown') reasons.push('age_unknown');
  const country = knownCountry(viewer.country);
  if (adult && !country) reasons.push('country_unknown');
  if (viewer.age === 'under-15') reasons.push('age_below_15');
  if (labels.includes('r15') && !viewer.optIns.r15) reasons.push('r15_opt_in_required');
  if (adult) {
    if (viewer.age !== 'adult') reasons.push('adult_required');
    if (labels.includes('r18') && !viewer.optIns.sexual) reasons.push('sexual_opt_in_required');
    if (labels.includes('r18g') && !viewer.optIns.grotesque)
      reasons.push('grotesque_opt_in_required');
    if (country === 'KR' || country === 'GB' || country === 'CN') reasons.push('market_restricted');
    if (channel === 'email' || channel === 'push') reasons.push('channel_restricted');
  }
  if (
    realmCeiling &&
    (realmCeiling.maxAge === 'general' ||
      (adult &&
        (realmCeiling.maxAge !== 'adult' ||
          (labels.includes('r18') && !realmCeiling.sexual) ||
          (labels.includes('r18g') && !realmCeiling.grotesque))))
  )
    reasons.push('realm_ceiling');
  return { eligible: reasons.length === 0, reasons };
}
