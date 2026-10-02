/** Account-owned birthday and content choices. Eligibility comes from the API. */
export interface ContentPreferences {
  revision: number; birthDate: string | null; country: string | null;
  birthdayPublic: boolean; publicId: string | null;
  age: 'unknown' | 'under-15' | '15-17' | 'adult'; accountEligible: boolean; adultAvailable: boolean;
  categories: { general: boolean; r15: boolean; r18: boolean; r18g: boolean };
  nsfwDisplay: 'mask' | 'show';
}
export interface ContentPreferenceChange {
  expectedRevision: number; birthDate?: string | null; country?: string;
  birthdayPublic?: boolean; categories?: Partial<ContentPreferences['categories']>;
  nsfwDisplay?: ContentPreferences['nsfwDisplay'];
}
export function parseContentPreferences(value: unknown): ContentPreferences | null {
  const body = value as Record<string, unknown> | null;
  const categories = body?.categories as Record<string, unknown> | null;
  if (!body || !Number.isSafeInteger(body.revision) || Number(body.revision) < 0
    || !(body.birthDate === null || typeof body.birthDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.birthDate))
    || !(body.country === null || typeof body.country === 'string' && /^[A-Z]{2}$/.test(body.country))
    || !(body.publicId === null || typeof body.publicId === 'string')
    || !['unknown', 'under-15', '15-17', 'adult'].includes(String(body.age))
    || !['mask', 'show'].includes(String(body.nsfwDisplay))
    || ['birthdayPublic', 'accountEligible', 'adultAvailable'].some(key => typeof body[key] !== 'boolean')
    || !categories || ['general', 'r15', 'r18', 'r18g'].some(key => typeof categories[key] !== 'boolean')) return null;
  return body as unknown as ContentPreferences;
}
