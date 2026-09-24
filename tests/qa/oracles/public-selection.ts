/** A deliberately storage-free model of Main and Realm publication choice.
 * Fixtures supply facts established by product-command receipts; this module
 * neither queries RDF nor imports the production selection/query code.
 */
export interface SelectedText {
  selection: string;
  matchUnit: string;
  contribution: string;
  revision: string;
  language: string;
  body: string;
}

export type LocalPublication =
  | { kind: 'adopted'; text: SelectedText }
  | { kind: 'rejected' }
  | { kind: 'unavailable' };

export interface WorkPublication {
  work: string;
  mainVersion: string;
  main: SelectedText | null;
  /** Missing Realm key means no local decision; rejection and unavailable are distinct. */
  local: Readonly<Record<string, LocalPublication>>;
}

export type SelectionContext = { kind: 'main' } | { kind: 'realm'; id: string };

export function effectiveText(work: WorkPublication, context: SelectionContext):
  { text: SelectedText; reason?: 'realm-adoption' | 'main-fallback' } | null {
  if (context.kind === 'main') return work.main ? { text: work.main } : null;
  const local = work.local[context.id];
  if (local?.kind === 'unavailable') throw new Error('local publication is unavailable');
  if (local?.kind === 'rejected') return null;
  if (local?.kind === 'adopted') {
    return { text: local.text, reason: 'realm-adoption' };
  }
  return work.main ? { text: work.main, reason: 'main-fallback' } : null;
}

/** Only literal, unique-marker phrases are used by the live comparison. */
export function expectedPublicPhraseRows(works: readonly WorkPublication[], context: SelectionContext,
  phrase: string, language: string | null) {
  const needle = phrase.normalize('NFC').toLowerCase();
  return works.flatMap(work => {
    const effective = effectiveText(work, context);
    if (!effective || (language !== null && effective.text.language !== language)
      || !effective.text.body.normalize('NFC').toLowerCase().includes(needle)) return [];
    return [{ work: work.work, mainVersion: work.mainVersion,
      matchUnit: effective.text.matchUnit, contribution: effective.text.contribution,
      revision: effective.text.revision, selection: effective.text.selection,
      language: effective.text.language, ...(effective.reason ? { reason: effective.reason } : {}) }];
  }).sort((a, b) => a.work.localeCompare(b.work));
}
