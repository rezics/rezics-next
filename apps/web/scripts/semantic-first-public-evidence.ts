export type JourneyResult = {
  name: string;
  status: 'Passing' | 'Failing';
  persona: string;
  failure?: { owner: string; actual: string };
};

function cell(value: string): string {
  return value.replace(/\s+/gu, ' ').replaceAll('|', '/').replaceAll('<', '&lt;').trim();
}

/** Retain the authored paths, including when an earlier failure wrote a multiline result cell. */
export function updateFirstPublicInventory(
  document: string,
  revision: string,
  utc: string,
  results: readonly JourneyResult[],
): string {
  const byName = new Map(results.map((row) => [row.name, row]));
  return document.replace(/^\| ([^|\n]+) \| ([^|\n]+) \| ([\s\S]*?) \|$/gm, (line, name: string, path: string) => {
    const row = byName.get(name.trim());
    if (!row) return line;
    const binding = `${row.status} ${revision.slice(0, 12)} ${utc} ${cell(row.persona)}`;
    const failure = row.failure ? `; ${cell(row.failure.owner)}: ${cell(row.failure.actual).slice(0, 160)}` : '';
    return `| ${name.trim()} | ${path.trim()} | ${binding}${failure} |`;
  });
}
