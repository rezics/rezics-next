/** Fills `{name}` placeholders in a catalog string; `tests/catalogs.test.ts` keeps them in every locale. */
export function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in values ? String(values[key]) : match,
  );
}
