/** REZICS locale adapter for the adopted slash, table creation and link/media controls. */
export const productControlLabels = {
  blockFormat: 'Format',
  blockInsert: 'Insert',
  searchBlocks: 'Find a block',
  tableSize: 'Table size',
  tableRows: 'Rows',
  tableColumns: 'Columns',
  tableHeader: 'Header row',
  insertTable: 'Insert table',
};

export type ProductControlLabels = { readonly [K in keyof typeof productControlLabels]: string };

const translations: Record<string, ProductControlLabels> = {
  'zh-Hant': {
    blockFormat: '格式',
    blockInsert: '插入',
    searchBlocks: '尋找區塊',
    tableSize: '表格大小',
    tableRows: '列數',
    tableColumns: '欄數',
    tableHeader: '標題列',
    insertTable: '插入表格',
  },
  'zh-Hans': {
    blockFormat: '格式',
    blockInsert: '插入',
    searchBlocks: '查找区块',
    tableSize: '表格大小',
    tableRows: '行数',
    tableColumns: '列数',
    tableHeader: '标题行',
    insertTable: '插入表格',
  },
  ja: {
    blockFormat: '書式',
    blockInsert: '挿入',
    searchBlocks: 'ブロックを検索',
    tableSize: '表のサイズ',
    tableRows: '行数',
    tableColumns: '列数',
    tableHeader: '見出し行',
    insertTable: '表を挿入',
  },
  ko: {
    blockFormat: '서식',
    blockInsert: '삽입',
    searchBlocks: '블록 찾기',
    tableSize: '표 크기',
    tableRows: '행 수',
    tableColumns: '열 수',
    tableHeader: '머리글 행',
    insertTable: '표 삽입',
  },
  de: {
    blockFormat: 'Format',
    blockInsert: 'Einfügen',
    searchBlocks: 'Block suchen',
    tableSize: 'Tabellengröße',
    tableRows: 'Zeilen',
    tableColumns: 'Spalten',
    tableHeader: 'Kopfzeile',
    insertTable: 'Tabelle einfügen',
  },
  fr: {
    blockFormat: 'Format',
    blockInsert: 'Insérer',
    searchBlocks: 'Rechercher un bloc',
    tableSize: 'Taille du tableau',
    tableRows: 'Lignes',
    tableColumns: 'Colonnes',
    tableHeader: 'Ligne d’en-tête',
    insertTable: 'Insérer le tableau',
  },
  es: {
    blockFormat: 'Formato',
    blockInsert: 'Insertar',
    searchBlocks: 'Buscar un bloque',
    tableSize: 'Tamaño de la tabla',
    tableRows: 'Filas',
    tableColumns: 'Columnas',
    tableHeader: 'Fila de encabezado',
    insertTable: 'Insertar tabla',
  },
};

export function productLabelsForLanguage(language?: string): ProductControlLabels {
  const locale = language?.toLowerCase() ?? 'en';
  if (/^zh(?:-|$)/.test(locale))
    return translations[/^zh-(?:hant|tw|hk|mo)(?:-|$)/.test(locale) ? 'zh-Hant' : 'zh-Hans']!;
  return translations[locale.split('-')[0]!] ?? productControlLabels;
}
