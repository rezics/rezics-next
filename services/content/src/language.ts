/** Content's canonical language identity is shared by variants and procedure sections. */
export function canonicalContentLanguage(value: string): string {
  if (typeof value !== 'string' || !value) throw new Error('invalid Content language');
  const canonical = Intl.getCanonicalLocales(value)[0];
  if (!canonical) throw new Error('invalid Content language');
  return canonical;
}
