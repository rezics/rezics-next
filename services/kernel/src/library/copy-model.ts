import type { CopyConditionDisplay } from './copy-condition.ts';

export type CopyConditionEditing = Readonly<
  | {
      state: 'supported';
      currentness: 'current';
      choices: readonly Readonly<{ id: string; label: string; description: string }>[];
    }
  | {
      state: 'unavailable';
      currentness: 'current' | 'retired' | 'unavailable';
      reason: 'unsupported' | 'unrecognized_vocabulary' | 'retired' | 'current_source_unavailable';
    }
>;

/** Opt-in private owner detail. Accepting identities and pins never enter this DTO. */
export type CopyPresentation = Readonly<{
  meaning: 'known' | 'unknown' | 'unavailable';
  kindLabel?: string;
  kindLabelLanguage?: string;
  statusLabel?: string;
  statusLabelLanguage?: string;
  statusEditing: Readonly<
    | { state: 'supported'; statuses: readonly Readonly<{ id: string; label: string; labelLanguage: string }>[] }
    | { state: 'unsupported' | 'unavailable' }
  >;
  mediaCondition: CopyConditionDisplay;
  packagingCondition: CopyConditionDisplay;
  conditionEditing: CopyConditionEditing;
}>;
