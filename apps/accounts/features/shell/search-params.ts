export type PageSearchParams = Promise<Record<string, string | string[] | undefined>>;

/** One value per name, as the query string the visitor arrived with. */
export async function pageQuery(searchParams: PageSearchParams): Promise<URLSearchParams> {
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(await searchParams)) {
    for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) {
      query.append(name, item);
    }
  }
  return query;
}
