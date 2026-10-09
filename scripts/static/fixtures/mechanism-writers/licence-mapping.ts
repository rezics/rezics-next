/** A source mapping carries the licence identifier. It does not decide an obligation. */
export function mapImportedSource(record: { url: string; licence: string | null }): { source: string; licence: string } {
  return {
    source: record.url,
    licence: record.licence ?? 'https://creativecommons.org/licenses/by-sa/4.0/',
  };
}
