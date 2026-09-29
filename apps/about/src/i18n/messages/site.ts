import type { PageId } from '../../pages.ts';
import { defineCopy } from '../define.ts';

/** Shared chrome: header, footer, status names and the notify form. Copy marked draft is replaced in G-481. */
export interface SiteCopy {
  brand: { tagline: string; description: string };
  skip: string;
  header: {
    menu: string;
    language: string;
    products: string;
    theme: string;
    light: string;
    dark: string;
    system: string;
    cta: string;
  };
  pages: Record<PageId, { name: string; summary: string }>;
  footer: {
    products: string;
    project: string;
    openSource: string;
    follow: string;
    languages: string;
    rights: string;
    cookies: string;
  };
  status: {
    available: string;
    inDevelopment: string;
    planned: string;
    now: string;
    next: string;
    later: string;
    availableHelp: string;
    inDevelopmentHelp: string;
    plannedHelp: string;
    legend: string;
  };
  notify: {
    title: string;
    body: string;
    emailLabel: string;
    submit: string;
    sending: string;
    privacy: string;
    successTitle: string;
    successBody: string;
    back: string;
    errors: {
      invalid_email: string;
      invalid_request: string;
      cross_origin: string;
      unavailable: string;
      network: string;
    };
  };
  notFound: { title: string; body: string };
}

const en: SiteCopy = {
  brand: {
    tagline: 'Read across languages. Keep it all.',
    description:
      'REZICS is a home for readers and writers of novels, visual novels, anime and manga: one library, every language and edition.',
  },
  skip: 'Skip to content',
  header: {
    menu: 'Menu',
    language: 'Language',
    products: 'Product lines',
    theme: 'Theme',
    light: 'Light',
    dark: 'Dark',
    system: 'Match system',
    cta: 'Get notified',
  },
  pages: {
    home: { name: 'REZICS', summary: 'Your reading, in every language and edition.' },
    reading: { name: 'Reading', summary: 'A library that goes wherever you read.' },
    'light-novels': {
      name: 'Light novels',
      summary: 'Follow a series across editions and translations.',
    },
    'serial-fiction': {
      name: 'Serial fiction',
      summary: 'Write and read stories one chapter at a time.',
    },
    acgn: {
      name: 'Visual novels, anime and manga',
      summary: 'Find a release you can actually play or watch.',
    },
    wikis: { name: 'Wikis', summary: 'Worldbuilding that stays accurate, with help from agents.' },
    communities: {
      name: 'Realms',
      summary: 'Communities for one story, one language or one idea.',
    },
    distribution: { name: 'Publishing', summary: 'Publish and sell books and games.' },
    developers: { name: 'Developers', summary: 'An API, an SDK and agents you bring yourself.' },
    trust: { name: 'Trust', summary: 'Safety, ratings, AI disclosure and your data.' },
    roadmap: {
      name: 'Roadmap',
      summary: 'What is available, what is being built, what comes later.',
    },
  },
  footer: {
    products: 'Product lines',
    project: 'The project',
    openSource: 'Source code',
    follow: 'Follow development',
    languages: 'Languages',
    rights: 'REZICS Inc.',
    cookies: 'This site sets two cookies: your language and your theme. It has no trackers.',
  },
  status: {
    available: 'Available',
    inDevelopment: 'In development',
    planned: 'Planned',
    now: 'Now',
    next: 'Next',
    later: 'Later',
    availableHelp: 'Works today.',
    inDevelopmentHelp: 'Being built now.',
    plannedHelp: 'Decided, not started.',
    legend: 'Each statement on this site shows whether it is available, in development or planned.',
  },
  notify: {
    title: 'Registration is not open yet',
    body: 'Leave your email and we will write once, when you can register. Nothing else.',
    emailLabel: 'Email address',
    submit: 'Get notified',
    sending: 'Sending',
    privacy: 'We keep your address and your language only to tell you when registration opens.',
    successTitle: 'You are on the list',
    successBody: 'We will write when registration opens.',
    back: 'Back to the site',
    errors: {
      invalid_email: 'Enter an email address like name@example.com.',
      invalid_request: 'The form could not be read. Reload the page and try again.',
      cross_origin: 'This form only works on this site.',
      unavailable: 'We could not save your address. Try again in a minute.',
      network: 'No connection. Check your network and try again.',
    },
  },
  notFound: {
    title: 'Page not found',
    body: 'This address leads nowhere. Choose a language to start from the home page.',
  },
};

export const site = defineCopy<SiteCopy>({
  en,
  'zh-Hant': {
    brand: {
      tagline: '跨越語言閱讀，全都留在身邊。',
      description:
        'REZICS 是小說、視覺小說、動畫與漫畫讀者與作者的家：一個書庫，涵蓋每一種語言與版本。',
    },
    skip: '跳到主要內容',
    header: {
      menu: '選單',
      language: '語言',
      products: '產品線',
      theme: '主題',
      light: '淺色',
      dark: '深色',
      system: '跟隨系統',
      cta: '通知我',
    },
    pages: {
      home: { name: 'REZICS', summary: '你的閱讀，跨越每一種語言與版本。' },
      reading: { name: '閱讀', summary: '跟著你到處走的書庫。' },
      'light-novels': { name: '輕小說', summary: '跨版本與翻譯追蹤一部系列。' },
      'serial-fiction': { name: '連載小說', summary: '一章一章地寫，一章一章地讀。' },
      acgn: { name: '視覺小說、動畫與漫畫', summary: '找到真正能玩、能看的發行版本。' },
      wikis: { name: 'Wiki', summary: '世界觀設定始終準確，還有代理協助。' },
      communities: { name: '社群', summary: '為一部作品、一種語言或一個想法而設的社群。' },
      distribution: { name: '出版', summary: '出版並販售書籍與遊戲。' },
      developers: { name: '開發者', summary: 'API、SDK，以及自帶的代理。' },
      trust: { name: '信任', summary: '安全、分級、AI 揭露與你的資料。' },
      roadmap: { name: '路線圖', summary: '哪些已可使用、哪些正在打造、哪些留待日後。' },
    },
    footer: {
      products: '產品線',
      project: '關於專案',
      openSource: '原始碼',
      follow: '追蹤開發進度',
      languages: '語言',
      rights: 'REZICS Inc.',
      cookies: '本網站只設定兩個 Cookie：語言與主題。沒有任何追蹤器。',
    },
    status: {
      available: '已提供',
      inDevelopment: '開發中',
      planned: '規劃中',
      now: '現在',
      next: '接下來',
      later: '之後',
      availableHelp: '現在就能使用。',
      inDevelopmentHelp: '正在打造。',
      plannedHelp: '已決定，尚未開始。',
      legend: '本站每項說明都會標示為已提供、開發中或規劃中。',
    },
    notify: {
      title: '註冊尚未開放',
      body: '留下電子郵件，開放註冊時我們只會寫一次信通知你。',
      emailLabel: '電子郵件',
      submit: '通知我',
      sending: '傳送中',
      privacy: '我們只會保留你的電子郵件與語言，用來在開放註冊時通知你。',
      successTitle: '已加入名單',
      successBody: '開放註冊時我們會寄信給你。',
      back: '回到網站',
      errors: {
        invalid_email: '請輸入像 name@example.com 的電子郵件。',
        invalid_request: '無法讀取表單，請重新整理頁面後再試。',
        cross_origin: '此表單只能在本站使用。',
        unavailable: '無法儲存你的電子郵件，請稍後再試。',
        network: '沒有網路連線，請檢查網路後再試。',
      },
    },
    notFound: { title: '找不到頁面', body: '這個網址沒有內容。請選擇語言，從首頁開始。' },
  },
  'zh-Hans': {
    brand: {
      tagline: '跨越语言阅读，全都留在身边。',
      description:
        'REZICS 是小说、视觉小说、动画与漫画读者和作者的家：一个书库，涵盖每一种语言与版本。',
    },
    skip: '跳到主要内容',
    header: {
      menu: '菜单',
      language: '语言',
      products: '产品线',
      theme: '主题',
      light: '浅色',
      dark: '深色',
      system: '跟随系统',
      cta: '通知我',
    },
    pages: {
      home: { name: 'REZICS', summary: '你的阅读，跨越每一种语言与版本。' },
      reading: { name: '阅读', summary: '跟着你到处走的书库。' },
      'light-novels': { name: '轻小说', summary: '跨版本与翻译追踪一部系列。' },
      'serial-fiction': { name: '连载小说', summary: '一章一章地写，一章一章地读。' },
      acgn: { name: '视觉小说、动画与漫画', summary: '找到真正能玩、能看的发行版本。' },
      wikis: { name: 'Wiki', summary: '世界观设定始终准确，还有智能体协助。' },
      communities: { name: '社区', summary: '为一部作品、一种语言或一个想法而设的社区。' },
      distribution: { name: '出版', summary: '出版并销售书籍与游戏。' },
      developers: { name: '开发者', summary: 'API、SDK，以及自带的智能体。' },
      trust: { name: '信任', summary: '安全、分级、AI 披露与你的数据。' },
      roadmap: { name: '路线图', summary: '哪些已可使用、哪些正在打造、哪些留待日后。' },
    },
    footer: {
      products: '产品线',
      project: '关于项目',
      openSource: '源代码',
      follow: '关注开发进度',
      languages: '语言',
      rights: 'REZICS Inc.',
      cookies: '本网站只设置两个 Cookie：语言与主题。没有任何追踪器。',
    },
    status: {
      available: '已提供',
      inDevelopment: '开发中',
      planned: '规划中',
      now: '现在',
      next: '接下来',
      later: '之后',
      availableHelp: '现在就能使用。',
      inDevelopmentHelp: '正在打造。',
      plannedHelp: '已决定，尚未开始。',
      legend: '本站每项说明都会标明为已提供、开发中或规划中。',
    },
    notify: {
      title: '注册尚未开放',
      body: '留下电子邮箱，开放注册时我们只会写一封信通知你。',
      emailLabel: '电子邮箱',
      submit: '通知我',
      sending: '发送中',
      privacy: '我们只会保留你的邮箱和语言，用来在开放注册时通知你。',
      successTitle: '已加入名单',
      successBody: '开放注册时我们会发邮件给你。',
      back: '回到网站',
      errors: {
        invalid_email: '请输入类似 name@example.com 的电子邮箱。',
        invalid_request: '无法读取表单，请刷新页面后重试。',
        cross_origin: '此表单只能在本站使用。',
        unavailable: '无法保存你的邮箱，请稍后再试。',
        network: '没有网络连接，请检查网络后重试。',
      },
    },
    notFound: { title: '找不到页面', body: '这个地址没有内容。请选择语言，从首页开始。' },
  },
  ja: {
    brand: {
      tagline: '言語をまたいで読み、すべて手元に。',
      description:
        'REZICS は、小説・ビジュアルノベル・アニメ・マンガの読者と作り手の場所です。ひとつのライブラリに、あらゆる言語と版。',
    },
    skip: '本文へスキップ',
    header: {
      menu: 'メニュー',
      language: '言語',
      products: 'プロダクト',
      theme: 'テーマ',
      light: 'ライト',
      dark: 'ダーク',
      system: 'システムに合わせる',
      cta: '通知を受け取る',
    },
    pages: {
      home: { name: 'REZICS', summary: 'あなたの読書を、あらゆる言語と版で。' },
      reading: { name: '読書', summary: '読む場所を選ばないライブラリ。' },
      'light-novels': { name: 'ライトノベル', summary: '版と翻訳をまたいでシリーズを追う。' },
      'serial-fiction': { name: '連載小説', summary: '一話ずつ書き、一話ずつ読む。' },
      acgn: {
        name: 'ビジュアルノベル・アニメ・マンガ',
        summary: '実際に遊べる・観られるリリースを見つける。',
      },
      wikis: { name: 'ウィキ', summary: 'エージェントの力も借りて、世界観を正確に保つ。' },
      communities: {
        name: 'コミュニティ',
        summary: 'ひとつの物語、ひとつの言語、ひとつの関心のために。',
      },
      distribution: { name: '出版', summary: '本とゲームを公開し、販売する。' },
      developers: { name: '開発者', summary: 'API、SDK、そして持ち込みのエージェント。' },
      trust: { name: '信頼', summary: '安全、年齢区分、AI の開示、そしてあなたのデータ。' },
      roadmap: { name: 'ロードマップ', summary: '今できること、開発中のこと、これから先のこと。' },
    },
    footer: {
      products: 'プロダクト',
      project: 'プロジェクト',
      openSource: 'ソースコード',
      follow: '開発をフォロー',
      languages: '言語',
      rights: 'REZICS Inc.',
      cookies: 'このサイトが設定する Cookie は言語とテーマの二つだけです。トラッカーはありません。',
    },
    status: {
      available: '提供中',
      inDevelopment: '開発中',
      planned: '計画中',
      now: '今',
      next: '次',
      later: 'その先',
      availableHelp: '今すぐ使えます。',
      inDevelopmentHelp: '現在開発中です。',
      plannedHelp: '決定済み、未着手です。',
      legend: 'このサイトの各記述には、提供中・開発中・計画中のいずれかが表示されます。',
    },
    notify: {
      title: '登録はまだ始まっていません',
      body: 'メールアドレスを残していただければ、登録開始時に一度だけご連絡します。',
      emailLabel: 'メールアドレス',
      submit: '通知を受け取る',
      sending: '送信中',
      privacy: 'アドレスと言語は、登録開始のお知らせにのみ使います。',
      successTitle: '登録しました',
      successBody: '登録が始まったらご連絡します。',
      back: 'サイトに戻る',
      errors: {
        invalid_email: 'name@example.com のようなメールアドレスを入力してください。',
        invalid_request:
          'フォームを読み取れませんでした。ページを再読み込みしてもう一度お試しください。',
        cross_origin: 'このフォームはこのサイトでのみ使えます。',
        unavailable: 'アドレスを保存できませんでした。少し待ってからもう一度お試しください。',
        network: '接続できません。ネットワークを確認してもう一度お試しください。',
      },
    },
    notFound: {
      title: 'ページが見つかりません',
      body: 'このアドレスには何もありません。言語を選んでホームから始めてください。',
    },
  },
  ko: {
    brand: {
      tagline: '언어를 넘나들며 읽고, 모두 간직하세요.',
      description:
        'REZICS는 소설, 비주얼 노벨, 애니메이션, 만화의 독자와 작가를 위한 공간입니다. 하나의 서재에 모든 언어와 판본을 담습니다.',
    },
    skip: '본문으로 건너뛰기',
    header: {
      menu: '메뉴',
      language: '언어',
      products: '제품군',
      theme: '테마',
      light: '라이트',
      dark: '다크',
      system: '시스템 설정 따르기',
      cta: '알림 받기',
    },
    pages: {
      home: { name: 'REZICS', summary: '모든 언어와 판본에 걸친 나의 독서.' },
      reading: { name: '독서', summary: '어디서 읽든 따라오는 서재.' },
      'light-novels': {
        name: '라이트 노벨',
        summary: '판본과 번역을 넘나들며 시리즈를 추적합니다.',
      },
      'serial-fiction': { name: '연재 소설', summary: '한 화씩 쓰고, 한 화씩 읽습니다.' },
      acgn: {
        name: '비주얼 노벨·애니메이션·만화',
        summary: '실제로 즐길 수 있는 릴리스를 찾습니다.',
      },
      wikis: { name: '위키', summary: '에이전트의 도움으로 세계관을 정확하게 유지합니다.' },
      communities: {
        name: '커뮤니티',
        summary: '하나의 이야기, 하나의 언어, 하나의 관심사를 위한 공간.',
      },
      distribution: { name: '출판', summary: '책과 게임을 출판하고 판매합니다.' },
      developers: { name: '개발자', summary: 'API, SDK, 그리고 직접 가져오는 에이전트.' },
      trust: { name: '신뢰', summary: '안전, 등급, AI 공개, 그리고 내 데이터.' },
      roadmap: { name: '로드맵', summary: '지금 쓸 수 있는 것, 만드는 중인 것, 나중에 올 것.' },
    },
    footer: {
      products: '제품군',
      project: '프로젝트',
      openSource: '소스 코드',
      follow: '개발 소식 따라가기',
      languages: '언어',
      rights: 'REZICS Inc.',
      cookies: '이 사이트는 언어와 테마, 두 가지 쿠키만 설정합니다. 트래커는 없습니다.',
    },
    status: {
      available: '이용 가능',
      inDevelopment: '개발 중',
      planned: '계획됨',
      now: '지금',
      next: '다음',
      later: '이후',
      availableHelp: '지금 사용할 수 있습니다.',
      inDevelopmentHelp: '지금 만들고 있습니다.',
      plannedHelp: '결정되었으나 시작 전입니다.',
      legend: '이 사이트의 모든 설명에는 이용 가능, 개발 중, 계획됨 중 하나가 표시됩니다.',
    },
    notify: {
      title: '아직 가입을 받지 않습니다',
      body: '이메일을 남겨 주시면 가입이 열릴 때 한 번만 알려 드립니다.',
      emailLabel: '이메일 주소',
      submit: '알림 받기',
      sending: '보내는 중',
      privacy: '주소와 언어는 가입 시작을 알리는 데에만 보관합니다.',
      successTitle: '등록되었습니다',
      successBody: '가입이 열리면 메일을 보내 드립니다.',
      back: '사이트로 돌아가기',
      errors: {
        invalid_email: 'name@example.com 형식의 이메일 주소를 입력하세요.',
        invalid_request: '양식을 읽을 수 없습니다. 페이지를 새로 고친 뒤 다시 시도하세요.',
        cross_origin: '이 양식은 이 사이트에서만 작동합니다.',
        unavailable: '주소를 저장하지 못했습니다. 잠시 후 다시 시도하세요.',
        network: '연결되지 않았습니다. 네트워크를 확인하고 다시 시도하세요.',
      },
    },
    notFound: {
      title: '페이지를 찾을 수 없습니다',
      body: '이 주소에는 아무것도 없습니다. 언어를 선택해 홈에서 시작하세요.',
    },
  },
  de: {
    brand: {
      tagline: 'Über Sprachen hinweg lesen. Alles behalten.',
      description:
        'REZICS ist ein Zuhause für Leserinnen und Autoren von Romanen, Visual Novels, Anime und Manga: eine Bibliothek, jede Sprache und jede Ausgabe.',
    },
    skip: 'Zum Inhalt springen',
    header: {
      menu: 'Menü',
      language: 'Sprache',
      products: 'Produktlinien',
      theme: 'Darstellung',
      light: 'Hell',
      dark: 'Dunkel',
      system: 'Wie das System',
      cta: 'Benachrichtigen',
    },
    pages: {
      home: { name: 'REZICS', summary: 'Dein Lesen, in jeder Sprache und Ausgabe.' },
      reading: { name: 'Lesen', summary: 'Eine Bibliothek, die dich überallhin begleitet.' },
      'light-novels': {
        name: 'Light Novels',
        summary: 'Eine Reihe über Ausgaben und Übersetzungen hinweg verfolgen.',
      },
      'serial-fiction': {
        name: 'Serielle Literatur',
        summary: 'Geschichten Kapitel für Kapitel schreiben und lesen.',
      },
      acgn: {
        name: 'Visual Novels, Anime und Manga',
        summary: 'Eine Veröffentlichung finden, die du wirklich spielen oder sehen kannst.',
      },
      wikis: { name: 'Wikis', summary: 'Weltenbau, der stimmig bleibt, mit Hilfe von Agenten.' },
      communities: {
        name: 'Realms',
        summary: 'Communitys für eine Geschichte, eine Sprache oder eine Idee.',
      },
      distribution: {
        name: 'Veröffentlichen',
        summary: 'Bücher und Spiele veröffentlichen und verkaufen.',
      },
      developers: {
        name: 'Entwickler',
        summary: 'Eine API, ein SDK und Agenten, die du selbst mitbringst.',
      },
      trust: {
        name: 'Vertrauen',
        summary: 'Sicherheit, Einstufungen, KI-Kennzeichnung und deine Daten.',
      },
      roadmap: {
        name: 'Roadmap',
        summary: 'Was verfügbar ist, was entsteht und was später kommt.',
      },
    },
    footer: {
      products: 'Produktlinien',
      project: 'Das Projekt',
      openSource: 'Quellcode',
      follow: 'Entwicklung verfolgen',
      languages: 'Sprachen',
      rights: 'REZICS Inc.',
      cookies:
        'Diese Website setzt zwei Cookies: deine Sprache und deine Darstellung. Es gibt keine Tracker.',
    },
    status: {
      available: 'Verfügbar',
      inDevelopment: 'In Entwicklung',
      planned: 'Geplant',
      now: 'Jetzt',
      next: 'Als Nächstes',
      later: 'Später',
      availableHelp: 'Funktioniert heute.',
      inDevelopmentHelp: 'Wird gerade gebaut.',
      plannedHelp: 'Beschlossen, noch nicht begonnen.',
      legend:
        'Jede Aussage auf dieser Website zeigt, ob sie verfügbar, in Entwicklung oder geplant ist.',
    },
    notify: {
      title: 'Die Registrierung ist noch nicht geöffnet',
      body: 'Hinterlasse deine E-Mail-Adresse, und wir schreiben dir einmal, sobald du dich registrieren kannst. Sonst nichts.',
      emailLabel: 'E-Mail-Adresse',
      submit: 'Benachrichtigen',
      sending: 'Wird gesendet',
      privacy:
        'Wir speichern deine Adresse und deine Sprache nur, um dir zu sagen, wann die Registrierung öffnet.',
      successTitle: 'Du stehst auf der Liste',
      successBody: 'Wir schreiben dir, sobald die Registrierung öffnet.',
      back: 'Zurück zur Website',
      errors: {
        invalid_email: 'Gib eine E-Mail-Adresse wie name@example.com ein.',
        invalid_request:
          'Das Formular konnte nicht gelesen werden. Lade die Seite neu und versuche es erneut.',
        cross_origin: 'Dieses Formular funktioniert nur auf dieser Website.',
        unavailable:
          'Deine Adresse konnte nicht gespeichert werden. Versuche es in einer Minute erneut.',
        network: 'Keine Verbindung. Prüfe dein Netzwerk und versuche es erneut.',
      },
    },
    notFound: {
      title: 'Seite nicht gefunden',
      body: 'Diese Adresse führt nirgendwohin. Wähle eine Sprache, um auf der Startseite zu beginnen.',
    },
  },
  fr: {
    brand: {
      tagline: 'Lisez d’une langue à l’autre. Gardez tout.',
      description:
        'REZICS est un lieu pour les lecteurs et les auteurs de romans, de visual novels, d’anime et de manga : une seule bibliothèque, toutes les langues et toutes les éditions.',
    },
    skip: 'Aller au contenu',
    header: {
      menu: 'Menu',
      language: 'Langue',
      products: 'Gammes de produits',
      theme: 'Thème',
      light: 'Clair',
      dark: 'Sombre',
      system: 'Suivre le système',
      cta: 'Être prévenu',
    },
    pages: {
      home: { name: 'REZICS', summary: 'Vos lectures, dans toutes les langues et éditions.' },
      reading: { name: 'Lecture', summary: 'Une bibliothèque qui vous suit partout.' },
      'light-novels': {
        name: 'Light novels',
        summary: 'Suivre une série à travers éditions et traductions.',
      },
      'serial-fiction': {
        name: 'Fiction en feuilleton',
        summary: 'Écrire et lire des histoires chapitre par chapitre.',
      },
      acgn: {
        name: 'Visual novels, anime et manga',
        summary: 'Trouver une sortie que vous pouvez vraiment jouer ou regarder.',
      },
      wikis: { name: 'Wikis', summary: 'Un univers qui reste cohérent, avec l’aide d’agents.' },
      communities: {
        name: 'Realms',
        summary: 'Des communautés pour une histoire, une langue ou une idée.',
      },
      distribution: { name: 'Édition', summary: 'Publier et vendre des livres et des jeux.' },
      developers: {
        name: 'Développeurs',
        summary: 'Une API, un SDK et des agents que vous apportez.',
      },
      trust: {
        name: 'Confiance',
        summary: 'Sécurité, classifications, mention de l’IA et vos données.',
      },
      roadmap: {
        name: 'Feuille de route',
        summary: 'Ce qui existe, ce qui se construit, ce qui viendra.',
      },
    },
    footer: {
      products: 'Gammes de produits',
      project: 'Le projet',
      openSource: 'Code source',
      follow: 'Suivre le développement',
      languages: 'Langues',
      rights: 'REZICS Inc.',
      cookies: 'Ce site dépose deux cookies : votre langue et votre thème. Il n’a aucun traceur.',
    },
    status: {
      available: 'Disponible',
      inDevelopment: 'En développement',
      planned: 'Prévu',
      now: 'Maintenant',
      next: 'Ensuite',
      later: 'Plus tard',
      availableHelp: 'Fonctionne aujourd’hui.',
      inDevelopmentHelp: 'En cours de construction.',
      plannedHelp: 'Décidé, pas commencé.',
      legend:
        'Chaque affirmation de ce site indique si elle est disponible, en développement ou prévue.',
    },
    notify: {
      title: 'L’inscription n’est pas encore ouverte',
      body: 'Laissez votre adresse e-mail : nous vous écrirons une seule fois, quand l’inscription ouvrira. Rien d’autre.',
      emailLabel: 'Adresse e-mail',
      submit: 'Être prévenu',
      sending: 'Envoi',
      privacy:
        'Nous gardons votre adresse et votre langue uniquement pour vous prévenir de l’ouverture des inscriptions.',
      successTitle: 'Vous êtes sur la liste',
      successBody: 'Nous vous écrirons à l’ouverture des inscriptions.',
      back: 'Retour au site',
      errors: {
        invalid_email: 'Saisissez une adresse e-mail comme nom@exemple.com.',
        invalid_request: 'Le formulaire n’a pas pu être lu. Rechargez la page et réessayez.',
        cross_origin: 'Ce formulaire ne fonctionne que sur ce site.',
        unavailable: 'Votre adresse n’a pas pu être enregistrée. Réessayez dans une minute.',
        network: 'Pas de connexion. Vérifiez votre réseau et réessayez.',
      },
    },
    notFound: {
      title: 'Page introuvable',
      body: 'Cette adresse ne mène nulle part. Choisissez une langue pour repartir de l’accueil.',
    },
  },
  es: {
    brand: {
      tagline: 'Lee entre idiomas. Conserva todo.',
      description:
        'REZICS es un hogar para lectores y autores de novelas, novelas visuales, anime y manga: una biblioteca, todos los idiomas y todas las ediciones.',
    },
    skip: 'Saltar al contenido',
    header: {
      menu: 'Menú',
      language: 'Idioma',
      products: 'Líneas de producto',
      theme: 'Tema',
      light: 'Claro',
      dark: 'Oscuro',
      system: 'Según el sistema',
      cta: 'Avísame',
    },
    pages: {
      home: { name: 'REZICS', summary: 'Tu lectura, en cada idioma y edición.' },
      reading: { name: 'Lectura', summary: 'Una biblioteca que va contigo a todas partes.' },
      'light-novels': {
        name: 'Light novels',
        summary: 'Sigue una serie a través de ediciones y traducciones.',
      },
      'serial-fiction': {
        name: 'Ficción por entregas',
        summary: 'Escribe y lee historias capítulo a capítulo.',
      },
      acgn: {
        name: 'Novelas visuales, anime y manga',
        summary: 'Encuentra una edición que de verdad puedas jugar o ver.',
      },
      wikis: { name: 'Wikis', summary: 'Mundos coherentes, con la ayuda de agentes.' },
      communities: {
        name: 'Realms',
        summary: 'Comunidades para una historia, un idioma o una idea.',
      },
      distribution: { name: 'Publicación', summary: 'Publica y vende libros y juegos.' },
      developers: { name: 'Desarrolladores', summary: 'Una API, un SDK y agentes que traes tú.' },
      trust: { name: 'Confianza', summary: 'Seguridad, clasificaciones, aviso de IA y tus datos.' },
      roadmap: {
        name: 'Hoja de ruta',
        summary: 'Qué está disponible, qué se está construyendo y qué viene después.',
      },
    },
    footer: {
      products: 'Líneas de producto',
      project: 'El proyecto',
      openSource: 'Código fuente',
      follow: 'Seguir el desarrollo',
      languages: 'Idiomas',
      rights: 'REZICS Inc.',
      cookies: 'Este sitio usa dos cookies: tu idioma y tu tema. No tiene rastreadores.',
    },
    status: {
      available: 'Disponible',
      inDevelopment: 'En desarrollo',
      planned: 'Planificado',
      now: 'Ahora',
      next: 'Después',
      later: 'Más adelante',
      availableHelp: 'Funciona hoy.',
      inDevelopmentHelp: 'Se está construyendo ahora.',
      plannedHelp: 'Decidido, sin empezar.',
      legend:
        'Cada afirmación de este sitio indica si está disponible, en desarrollo o planificada.',
    },
    notify: {
      title: 'El registro aún no está abierto',
      body: 'Deja tu correo y te escribiremos una sola vez, cuando puedas registrarte. Nada más.',
      emailLabel: 'Correo electrónico',
      submit: 'Avísame',
      sending: 'Enviando',
      privacy: 'Guardamos tu correo y tu idioma solo para avisarte cuando se abra el registro.',
      successTitle: 'Estás en la lista',
      successBody: 'Te escribiremos cuando se abra el registro.',
      back: 'Volver al sitio',
      errors: {
        invalid_email: 'Escribe un correo como nombre@ejemplo.com.',
        invalid_request: 'No se pudo leer el formulario. Recarga la página e inténtalo de nuevo.',
        cross_origin: 'Este formulario solo funciona en este sitio.',
        unavailable: 'No pudimos guardar tu correo. Inténtalo de nuevo en un minuto.',
        network: 'Sin conexión. Revisa tu red e inténtalo de nuevo.',
      },
    },
    notFound: {
      title: 'Página no encontrada',
      body: 'Esta dirección no lleva a ningún sitio. Elige un idioma para empezar por la página de inicio.',
    },
  },
});
