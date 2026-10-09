const CC_BY_SA_3 = 'https://creativecommons.org/licenses/by-sa/3.0/';

/** An edited imported summary stays under the licence it was imported with. */
export function adaptationOfImportedText(source: string, licence: string): string {
  const stays = licence === CC_BY_SA_3
    ? `it stays under CC BY-SA 3.0 (${licence})`
    : 'it stays under its recorded licence';
  const note = `Adaptation of imported text from ${source}; ${stays}.`;
  return note.length <= 1024 ? note : note.slice(0, 1024);
}

export function adaptationNote(source: string, licence: string, changed: boolean): string | null {
  return changed ? adaptationOfImportedText(source, licence) : null;
}
