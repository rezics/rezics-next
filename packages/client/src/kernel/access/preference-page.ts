/** Preference-page DTOs mirror the closed public schema owned by Kernel Access. */
export type PreferencePageKind = {
  kind: string;
  optional: boolean;
  default: boolean;
  enabled: boolean;
};

export type PreferencePageAction = {
  name: 'edit' | 'reset';
  expectedVersion: number;
};

export type PreferencePage = {
  version: number;
  kinds: PreferencePageKind[];
  actions: PreferencePageAction[];
};
