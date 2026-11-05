const rangePattern = /^[a-z]{1,8}(?:-[a-z0-9]{1,8})*$/i;
const entryPattern = /^([a-z]{1,8}(?:-[a-z0-9]{1,8})*|\*)(?:[ \t]*;[ \t]*q=(0(?:\.\d{0,3})?|1(?:\.0{0,3})?))?$/i;

/** RFC 9110 language preferences, in quality order, bounded including an explicit override. */
export function languageRanges(header: string | null | undefined, override?: string): string[] {
  const ranges = (header ?? '')
    .split(',')
    .flatMap((entry, index) => {
      const match = entry.trim().match(entryPattern);
      if (!match || match[1] === '*') return [];
      const quality = match[2] === undefined ? 1 : Number(match[2]);
      return quality > 0 ? [{ tag: match[1]!, quality, index }] : [];
    })
    .sort((a, b) => b.quality - a.quality || a.index - b.index)
    .map(({ tag }) => tag);
  const first = override?.trim();
  if (first && rangePattern.test(first)) ranges.unshift(first);
  return ranges.slice(0, 16);
}

/** Exact tags followed by RFC 4647 truncation, including removal of extension singletons. */
function lookup(tags: ReadonlyMap<string, string>, range: string): string | undefined {
  const parts = range.toLowerCase().split('-');
  while (parts.length) {
    const found = tags.get(parts.join('-'));
    if (found !== undefined) return found;
    parts.pop();
    if (parts.at(-1)?.length === 1) parts.pop();
  }
  return undefined;
}

/** The single display-label rule for semantic reads; preserves the label's actual stored tag. */
export function chooseLabel(
  labels: Readonly<Record<string, string>>,
  ranges: readonly string[],
  original?: string | null,
): { value: string; language: string } | null {
  const languages = Object.keys(labels).sort();
  const tags = new Map<string, string>();
  for (const language of languages) if (!tags.has(language.toLowerCase())) tags.set(language.toLowerCase(), language);
  for (const range of [...ranges, ...(original ? [original] : []), 'en']) {
    if (!rangePattern.test(range)) continue;
    let language = lookup(tags, range);
    if (language === undefined) {
      try {
        language = lookup(tags, new Intl.Locale(range).maximize().toString());
      } catch {
        // Valid basic ranges can be unknown to Intl (for example grandfathered tags).
      }
    }
    if (language !== undefined) return { value: labels[language]!, language };
  }
  const language = languages[0];
  return language === undefined ? null : { value: labels[language]!, language };
}
