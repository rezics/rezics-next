import { defineCopy } from '../define.ts';

export interface RoadmapCopy {
  meta: { title: string; description: string };
  hero: { title: string; lede: string };
  /** Says what order and missing dates mean. */
  note: string;
  availableTitle: string;
}

export const roadmap = defineCopy<RoadmapCopy>({
  en: {
    meta: {
      title: 'Roadmap: what is available, in development and planned',
      description:
        'The direction of REZICS with an honest status for every capability: now, next and later.',
    },
    hero: {
      title: 'Where REZICS is going.',
      lede: 'Registration is not open yet. This is what exists, what is being built now and what comes next.',
    },
    note: 'There are no dates on purpose. Order inside a column is not a promise, and a capability can move between columns as we learn.',
    availableTitle: 'Available today',
  },
  'zh-Hant': {
    meta: {
      title: '路線圖：已提供、開發中與規劃中',
      description: 'REZICS 的方向，並為每項功能如實標示狀態：現在、接下來、之後。',
    },
    hero: {
      title: 'REZICS 的去向。',
      lede: '註冊尚未開放。以下是已存在的、正在打造的，以及接下來的計畫。',
    },
    note: '我們刻意不標日期。同一欄內的順序不是承諾，功能也可能隨著我們的學習在欄位間移動。',
    availableTitle: '現在已提供',
  },
  'zh-Hans': {
    meta: {
      title: '路线图：已提供、开发中与规划中',
      description: 'REZICS 的方向，并为每项功能如实标明状态：现在、接下来、之后。',
    },
    hero: {
      title: 'REZICS 的去向。',
      lede: '注册尚未开放。以下是已存在的、正在打造的，以及接下来的计划。',
    },
    note: '我们刻意不标日期。同一栏内的顺序不是承诺，功能也可能随着我们的学习在栏位间移动。',
    availableTitle: '现在已提供',
  },
  ja: {
    meta: {
      title: 'ロードマップ：提供中・開発中・計画中',
      description: 'REZICS の方向性を、すべての機能について正直な状況とともに：今、次、その先。',
    },
    hero: {
      title: 'REZICS の行き先。',
      lede: '登録はまだ始まっていません。すでにあるもの、今作っているもの、次に来るものをお見せします。',
    },
    note: '日付はあえて載せていません。列の中の順番は約束ではなく、学びに応じて機能が列を移ることもあります。',
    availableTitle: '今すぐ使えるもの',
  },
  ko: {
    meta: {
      title: '로드맵: 이용 가능, 개발 중, 계획됨',
      description: 'REZICS의 방향을 모든 기능의 솔직한 상태와 함께: 지금, 다음, 이후.',
    },
    hero: {
      title: 'REZICS가 향하는 곳.',
      lede: '아직 가입을 받지 않습니다. 이미 있는 것, 지금 만드는 것, 다음에 올 것을 보여 드립니다.',
    },
    note: '날짜는 일부러 적지 않았습니다. 한 열 안의 순서는 약속이 아니며, 배우는 과정에서 기능이 열 사이를 옮겨 갈 수 있습니다.',
    availableTitle: '지금 이용 가능',
  },
  de: {
    meta: {
      title: 'Roadmap: verfügbar, in Entwicklung und geplant',
      description:
        'Die Richtung von REZICS mit ehrlichem Status für jede Fähigkeit: jetzt, als Nächstes und später.',
    },
    hero: {
      title: 'Wohin REZICS geht.',
      lede: 'Die Registrierung ist noch nicht geöffnet. Das gibt es schon, das wird gerade gebaut und das kommt als Nächstes.',
    },
    note: 'Es gibt absichtlich keine Termine. Die Reihenfolge innerhalb einer Spalte ist kein Versprechen, und eine Fähigkeit kann die Spalte wechseln, wenn wir dazulernen.',
    availableTitle: 'Heute verfügbar',
  },
  fr: {
    meta: {
      title: 'Feuille de route : disponible, en développement et prévu',
      description:
        'La direction de REZICS, avec un statut honnête pour chaque capacité : maintenant, ensuite, plus tard.',
    },
    hero: {
      title: 'Où va REZICS.',
      lede: 'L’inscription n’est pas encore ouverte. Voici ce qui existe, ce qui se construit maintenant et ce qui vient ensuite.',
    },
    note: 'Il n’y a pas de dates, volontairement. L’ordre dans une colonne n’est pas une promesse, et une capacité peut changer de colonne au fil de ce que nous apprenons.',
    availableTitle: 'Disponible aujourd’hui',
  },
  es: {
    meta: {
      title: 'Hoja de ruta: disponible, en desarrollo y planificado',
      description:
        'La dirección de REZICS con un estado honesto para cada capacidad: ahora, después y más adelante.',
    },
    hero: {
      title: 'Hacia dónde va REZICS.',
      lede: 'El registro aún no está abierto. Esto es lo que existe, lo que se está construyendo ahora y lo que viene después.',
    },
    note: 'No hay fechas a propósito. El orden dentro de una columna no es una promesa, y una capacidad puede cambiar de columna a medida que aprendemos.',
    availableTitle: 'Disponible hoy',
  },
});
