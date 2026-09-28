import { canonicalLanguage, validLocalizedText, type LocalizedText } from '../display-language/select.ts';

interface NameBinding { localizedName?: { value: string; 'xml:lang'?: string };
  originalNameLanguage?: { value: string } }

/** Decode v2 RDF labels and the earlier single-JSON projection without rewriting old Agents. */
export function agentLocalizedName(rows: readonly NameBinding[], originalLabel: string): LocalizedText | null {
  const names = rows.flatMap(row => row.localizedName ? [row.localizedName] : []);
  const originals = new Set(rows.flatMap(row => row.originalNameLanguage
    ? [row.originalNameLanguage.value] : []));
  if (!names.length && !originals.size) return null;
  let result: LocalizedText;
  if (!originals.size) {
    if (names.length !== 1 || names[0]!['xml:lang']) throw new Error('Legacy Agent names are ambiguous');
    try { result = JSON.parse(names[0]!.value) as LocalizedText; }
    catch { throw new Error('Legacy Agent names are invalid'); }
  } else {
    if (originals.size !== 1 || names.length < 1 || names.length > 20) {
      throw new Error('Agent name labels are ambiguous');
    }
    const labels: Record<string, string> = {};
    for (const name of names) {
      const language = canonicalLanguage(name['xml:lang'] ?? '');
      if (!language || language in labels) throw new Error('Agent name language is ambiguous');
      labels[language] = name.value;
    }
    result = { original: [...originals][0]!, labels };
  }
  if (!validLocalizedText(result, 200) || result.labels[result.original] !== originalLabel) {
    throw new Error('Agent original name differs from its labels');
  }
  return result;
}
