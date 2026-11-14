import type { TableCommandName } from '../../editor-table-commands.ts';

export type TableControlLabels = Readonly<Record<TableCommandName, string>>;

export const tableControlLabels: TableControlLabels = {
  addColumnBefore: 'Insert column before',
  addColumnAfter: 'Insert column after',
  deleteColumn: 'Delete column',
  addRowBefore: 'Insert row above',
  addRowAfter: 'Insert row below',
  deleteRow: 'Delete row',
  mergeCells: 'Merge cells',
  splitCell: 'Split cell',
  toggleHeaderRow: 'Toggle header row',
  toggleHeaderColumn: 'Toggle header column',
  deleteTable: 'Delete table',
};

// Per-instance defaults for the application's supported interface languages. Caller labels take precedence.
const translations: Record<string, TableControlLabels> = {
  'zh-Hant': {
    addColumnBefore: '在前方插入欄', addColumnAfter: '在後方插入欄', deleteColumn: '刪除欄',
    addRowBefore: '在上方插入列', addRowAfter: '在下方插入列', deleteRow: '刪除列',
    mergeCells: '合併儲存格', splitCell: '分割儲存格', toggleHeaderRow: '切換標題列',
    toggleHeaderColumn: '切換標題欄', deleteTable: '刪除表格',
  },
  'zh-Hans': {
    addColumnBefore: '在前方插入列', addColumnAfter: '在后方插入列', deleteColumn: '删除列',
    addRowBefore: '在上方插入行', addRowAfter: '在下方插入行', deleteRow: '删除行',
    mergeCells: '合并单元格', splitCell: '拆分单元格', toggleHeaderRow: '切换标题行',
    toggleHeaderColumn: '切换标题列', deleteTable: '删除表格',
  },
  ja: {
    addColumnBefore: '前に列を挿入', addColumnAfter: '後ろに列を挿入', deleteColumn: '列を削除',
    addRowBefore: '上に行を挿入', addRowAfter: '下に行を挿入', deleteRow: '行を削除',
    mergeCells: 'セルを結合', splitCell: 'セルを分割', toggleHeaderRow: '見出し行を切り替え',
    toggleHeaderColumn: '見出し列を切り替え', deleteTable: '表を削除',
  },
  ko: {
    addColumnBefore: '앞에 열 삽입', addColumnAfter: '뒤에 열 삽입', deleteColumn: '열 삭제',
    addRowBefore: '위에 행 삽입', addRowAfter: '아래에 행 삽입', deleteRow: '행 삭제',
    mergeCells: '셀 병합', splitCell: '셀 분할', toggleHeaderRow: '머리글 행 전환',
    toggleHeaderColumn: '머리글 열 전환', deleteTable: '표 삭제',
  },
  de: {
    addColumnBefore: 'Spalte davor einfügen', addColumnAfter: 'Spalte danach einfügen', deleteColumn: 'Spalte löschen',
    addRowBefore: 'Zeile darüber einfügen', addRowAfter: 'Zeile darunter einfügen', deleteRow: 'Zeile löschen',
    mergeCells: 'Zellen verbinden', splitCell: 'Zelle teilen', toggleHeaderRow: 'Kopfzeile umschalten',
    toggleHeaderColumn: 'Kopfspalte umschalten', deleteTable: 'Tabelle löschen',
  },
  fr: {
    addColumnBefore: 'Insérer une colonne avant', addColumnAfter: 'Insérer une colonne après', deleteColumn: 'Supprimer la colonne',
    addRowBefore: 'Insérer une ligne au-dessus', addRowAfter: 'Insérer une ligne en dessous', deleteRow: 'Supprimer la ligne',
    mergeCells: 'Fusionner les cellules', splitCell: 'Diviser la cellule', toggleHeaderRow: 'Basculer la ligne d’en-tête',
    toggleHeaderColumn: 'Basculer la colonne d’en-tête', deleteTable: 'Supprimer le tableau',
  },
  es: {
    addColumnBefore: 'Insertar columna antes', addColumnAfter: 'Insertar columna después', deleteColumn: 'Eliminar columna',
    addRowBefore: 'Insertar fila arriba', addRowAfter: 'Insertar fila abajo', deleteRow: 'Eliminar fila',
    mergeCells: 'Combinar celdas', splitCell: 'Dividir celda', toggleHeaderRow: 'Alternar fila de encabezado',
    toggleHeaderColumn: 'Alternar columna de encabezado', deleteTable: 'Eliminar tabla',
  },
};

export function tableLabelsForLanguage(language?: string): TableControlLabels {
  if (!language) return tableControlLabels;
  const locale = language.toLowerCase();
  if (/^zh(?:-|$)/.test(locale)) {
    return translations[/^zh-(?:hant|tw|hk|mo)(?:-|$)/.test(locale) ? 'zh-Hant' : 'zh-Hans']!;
  }
  return translations[locale.split('-')[0]!] ?? tableControlLabels;
}
