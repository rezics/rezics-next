const copy = {
  en: {
    apply: 'Apply all filters',
    current: 'Current search filters',
    help: 'Apply saves all changes below to the search address. Results, available choices and navigation links still use the current search.',
    pending: 'Unapplied filter edits',
    scope: 'The resource scope changed. Previous facet choices were cleared. Apply to load choices for the new scope.',
  },
  'zh-Hans': {
    apply: '应用全部筛选条件',
    current: '当前搜索条件',
    help: '应用后，下方的全部更改将写入搜索地址。结果、可用选项和导航链接仍使用当前搜索条件。',
    pending: '有尚未应用的筛选更改',
    scope: '资源范围已更改，原有的属性选项已清除。应用后可加载新范围的选项。',
  },
  'zh-Hant': {
    apply: '套用全部篩選條件',
    current: '目前的搜尋條件',
    help: '套用後，下方的全部變更將寫入搜尋網址。結果、可用選項和導覽連結仍使用目前的搜尋條件。',
    pending: '有尚未套用的篩選變更',
    scope: '資源範圍已變更，原有的屬性選項已清除。套用後可載入新範圍的選項。',
  },
  ja: {
    apply: 'すべてのフィルターを適用',
    current: '現在の検索フィルター',
    help: '適用すると、以下の変更がすべて検索URLに反映されます。結果、選択肢、移動リンクは現在の検索条件を使用します。',
    pending: '未適用のフィルター変更があります',
    scope: 'リソースの範囲が変更され、以前の属性の選択が解除されました。適用すると新しい範囲の選択肢を読み込みます。',
  },
  ko: {
    apply: '모든 필터 적용',
    current: '현재 검색 필터',
    help: '적용하면 아래의 모든 변경 사항이 검색 주소에 반영됩니다. 결과, 선택 항목 및 탐색 링크는 현재 검색 조건을 사용합니다.',
    pending: '아직 적용하지 않은 필터 변경 사항',
    scope: '리소스 범위가 변경되어 이전 속성 선택이 지워졌습니다. 적용하면 새 범위의 선택 항목을 불러옵니다.',
  },
  de: {
    apply: 'Alle Filter anwenden',
    current: 'Filter der aktuellen Suche',
    help: 'Anwenden übernimmt alle Änderungen unten in die Suchadresse. Ergebnisse, verfügbare Optionen und Navigationslinks verwenden weiterhin die aktuelle Suche.',
    pending: 'Noch nicht angewendete Filteränderungen',
    scope: 'Der Ressourcenbereich wurde geändert. Die bisherige Facettenauswahl wurde gelöscht. Anwenden lädt die Optionen für den neuen Bereich.',
  },
  fr: {
    apply: 'Appliquer tous les filtres',
    current: 'Filtres de la recherche actuelle',
    help: 'Appliquer enregistre toutes les modifications ci-dessous dans l’adresse de recherche. Les résultats, les options disponibles et les liens de navigation utilisent encore la recherche actuelle.',
    pending: 'Modifications des filtres non appliquées',
    scope: 'Le périmètre des ressources a changé. Les anciennes sélections de facettes ont été effacées. Appliquez pour charger les options du nouveau périmètre.',
  },
  es: {
    apply: 'Aplicar todos los filtros',
    current: 'Filtros de la búsqueda actual',
    help: 'Aplicar guarda todos los cambios siguientes en la dirección de búsqueda. Los resultados, las opciones disponibles y los enlaces de navegación siguen usando la búsqueda actual.',
    pending: 'Cambios de filtros sin aplicar',
    scope: 'El ámbito de recursos ha cambiado. Se han borrado las selecciones de facetas anteriores. Aplica para cargar las opciones del nuevo ámbito.',
  },
};

export function filterApplicationCopy(locale: string) {
  return copy[locale as keyof typeof copy] ?? copy.en;
}
