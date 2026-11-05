const en = {
  hint: 'Type to search.',
  searching: 'Searching…',
  empty: 'Nothing matches “{query}”.',
  failed: 'The search failed.',
  retry: 'Try again',
  remove: 'Remove {title}',
  selected: 'Selected',
};

export type EntityPickerMessages = typeof en;

/** The words the picker says itself; subject titles and type labels arrive already in the reader's language. */
export const entityPickerMessages: Record<
  'en' | 'zh-Hant' | 'zh-Hans' | 'ja' | 'ko' | 'de' | 'fr' | 'es',
  EntityPickerMessages
> = {
  en,
  'zh-Hant': {
    hint: '輸入文字以搜尋。',
    searching: '搜尋中…',
    empty: '沒有符合「{query}」的結果。',
    failed: '搜尋失敗。',
    retry: '重試',
    remove: '移除{title}',
    selected: '已選取',
  },
  'zh-Hans': {
    hint: '输入文字以搜索。',
    searching: '搜索中…',
    empty: '没有符合“{query}”的结果。',
    failed: '搜索失败。',
    retry: '重试',
    remove: '移除{title}',
    selected: '已选择',
  },
  ja: {
    hint: '文字を入力して検索します。',
    searching: '検索中…',
    empty: '「{query}」に一致する結果はありません。',
    failed: '検索に失敗しました。',
    retry: '再試行',
    remove: '{title}を削除',
    selected: '選択済み',
  },
  ko: {
    hint: '검색어를 입력하세요.',
    searching: '검색 중…',
    empty: '“{query}”와(과) 일치하는 결과가 없습니다.',
    failed: '검색하지 못했습니다.',
    retry: '다시 시도',
    remove: '{title} 삭제',
    selected: '선택됨',
  },
  de: {
    hint: 'Zum Suchen tippen.',
    searching: 'Suche läuft…',
    empty: 'Nichts passt zu „{query}“.',
    failed: 'Die Suche ist fehlgeschlagen.',
    retry: 'Erneut versuchen',
    remove: '{title} entfernen',
    selected: 'Ausgewählt',
  },
  fr: {
    hint: 'Saisissez du texte pour chercher.',
    searching: 'Recherche en cours…',
    empty: 'Aucun résultat pour « {query} ».',
    failed: 'La recherche a échoué.',
    retry: 'Réessayer',
    remove: 'Retirer {title}',
    selected: 'Sélection',
  },
  es: {
    hint: 'Escribe para buscar.',
    searching: 'Buscando…',
    empty: 'Nada coincide con «{query}».',
    failed: 'La búsqueda ha fallado.',
    retry: 'Reintentar',
    remove: 'Quitar {title}',
    selected: 'Seleccionados',
  },
};
