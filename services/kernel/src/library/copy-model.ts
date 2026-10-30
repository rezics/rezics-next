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
}>;
