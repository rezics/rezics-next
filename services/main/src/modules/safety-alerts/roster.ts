export interface SafetyResponders {
  issuer: string;
  primary: string;
  backup: string;
}

// Config loaders share this parser without loading the service's storage runtime.
export function safetyResponders(
  issuer: string,
  primary?: string,
  backup?: string,
): SafetyResponders | null {
  if (primary === undefined && backup === undefined) return null;
  if (
    !primary?.trim() ||
    !backup?.trim() ||
    primary === backup ||
    [primary, backup].some(
      (value) =>
        value.length > 128 ||
        value.trim() !== value ||
        /[\s\x00-\x1f]/.test(value) ||
        /^(TBD|TODO|UNSET|<.*>)$/i.test(value),
    )
  ) {
    throw new Error(
      'SAFETY_PRIMARY_ACCOUNT and SAFETY_BACKUP_ACCOUNT require distinct existing Account subjects',
    );
  }
  return { issuer, primary, backup };
}
