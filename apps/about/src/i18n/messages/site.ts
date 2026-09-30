import type { PageId } from '../../pages.ts';
import { defineCopy } from '../define.ts';

/** Shared chrome: header, footer, status names and the notify form. */
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
    inDevelopment: string;
    /** Roadmap progress only: stages following the current one. */
    next: string;
    /** The only feature label: delivery after launch. */
    later: string;
    laterHelp: string;
  };
  /** The control that pauses the site's looping illustrations. */
  motion: { pause: string };
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
    tagline: 'Every story. Every language. One home.',
    description:
      'Web novels, light novels, books, visual novels, anime, manga, games and more, each with a complete page in the language you read, a whole community around it, and fans from every platform in one place.',
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
    home: {
      name: 'REZICS',
      summary: 'Every story, every language, and fans together beyond any one platform.',
    },
    reading: { name: 'Reading', summary: 'A library that remembers every edition.' },
    'light-novels': {
      name: 'Light novels',
      summary: 'Every volume and translation of a series, in one place.',
    },
    'serial-fiction': {
      name: 'Serial fiction',
      summary: 'Write chapter by chapter. Read without losing your place.',
    },
    acgn: {
      name: 'ACGN',
      summary: 'The release you can play, the episode you are on.',
    },
    wikis: { name: 'Wikis', summary: 'Wikis with sources, and a world bible for authors.' },
    agents: { name: 'Agents', summary: 'Agents propose with evidence. People decide.' },
    communities: {
      name: 'Realms',
      summary: 'Communities for one story, one language or one idea.',
    },
    distribution: { name: 'Publishing', summary: 'Books and games sold as files people keep.' },
    developers: {
      name: 'Developers',
      summary: 'The whole product as an API, for apps and agents.',
    },
    trust: { name: 'Trust', summary: 'Safety, ratings, AI disclosure and your data.' },
    roadmap: { name: 'Roadmap', summary: 'Five stages to launch, and where each one stands.' },
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
    inDevelopment: 'In development',
    next: 'Up next',
    later: 'Later',
    laterHelp: 'Comes after launch.',
  },
  motion: { pause: 'Pause animation' },
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
      tagline: '所有故事。所有語言。共同的家。',
      description:
        '網路小說、輕小說、書籍、視覺小說、動畫、漫畫、遊戲……每部作品都有完整的介紹，以你閱讀的語言呈現，還有完整的社群，讓來自各個平台的同好相聚。',
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
      home: { name: 'REZICS', summary: '所有故事、所有語言，讓同好跨越平台相聚。' },
      reading: { name: '閱讀', summary: '記得每一個版本的書庫。' },
      'light-novels': { name: '輕小說', summary: '一部系列的每一冊、每種翻譯，盡在一處。' },
      'serial-fiction': { name: '連載小說', summary: '一章章寫下去，隨時接著上次讀。' },
      acgn: { name: 'ACGN', summary: '能玩的發行版本，正在看的那一集。' },
      wikis: { name: 'Wiki', summary: '附出處的 Wiki，以及作者的世界觀設定集。' },
      agents: { name: '代理程式', summary: '代理程式附上證據提案，由人決定。' },
      communities: { name: '社群', summary: '為一部作品、一種語言或一個想法而設的社群。' },
      distribution: { name: '出版', summary: '以能保留的檔案販售書籍與遊戲。' },
      developers: { name: '開發者', summary: '完整產品都能透過 API 使用，供 App 與代理程式開發。' },
      trust: { name: '信任', summary: '安全、分級、AI 揭露與你的資料。' },
      roadmap: { name: '開發規劃', summary: '邁向上線的五個階段，以及各自的進度。' },
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
      inDevelopment: '開發中',
      next: '接下來',
      later: '之後',
      laterHelp: '上線後推出。',
    },
    motion: { pause: '暫停動畫' },
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
      tagline: '所有故事。所有语言。共同的家。',
      description:
        '网络小说、轻小说、图书、视觉小说、动画、漫画、游戏……每部作品都有完整的介绍，以你阅读的语言呈现，还有完整的社区，让来自各个平台的同好相聚。',
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
      home: { name: 'REZICS', summary: '所有故事、所有语言，让同好跨越平台相聚。' },
      reading: { name: '阅读', summary: '记得每一个版本的书库。' },
      'light-novels': { name: '轻小说', summary: '一个系列的每一卷、每种翻译，都在一处。' },
      'serial-fiction': { name: '连载小说', summary: '一章章写下去，随时接着上次读。' },
      acgn: { name: 'ACGN', summary: '能玩的发行版本，正在看的那一集。' },
      wikis: { name: 'Wiki', summary: '附出处的 Wiki，以及作者的世界观设定集。' },
      agents: { name: '智能体', summary: '智能体附上证据提出建议，由人来决定。' },
      communities: { name: '社区', summary: '为一部作品、一种语言或一个想法而设的社区。' },
      distribution: { name: '出版', summary: '以能保留的文件销售图书与游戏。' },
      developers: { name: '开发者', summary: '整个产品都是 API，供应用与智能体使用。' },
      trust: { name: '信任', summary: '安全、分级、AI 披露与你的数据。' },
      roadmap: { name: '开发计划', summary: '迈向上线的五个阶段，以及各自的进度。' },
    },
    footer: {
      products: '产品线',
      project: '关于项目',
      openSource: '源代码',
      follow: '关注开发进度',
      languages: '语言',
      rights: 'REZICS Inc.',
      cookies: '本网站只设置两个 Cookie：语言与主题。没有任何跟踪器。',
    },
    status: {
      inDevelopment: '开发中',
      next: '接下来',
      later: '之后',
      laterHelp: '上线后推出。',
    },
    motion: { pause: '暂停动画' },
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
      tagline: 'すべての物語。すべての言語。ひとつの居場所。',
      description:
        'Web小説、ライトノベル、本、ビジュアルノベル、アニメ、マンガ、ゲームまで。読める言語で作品の情報を知り、充実したコミュニティで、プラットフォームを越えてファンと出会えます。',
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
      home: {
        name: 'REZICS',
        summary: 'あらゆる物語を、あらゆる言語で。プラットフォームを越えてファンが集まる場所。',
      },
      reading: { name: '読書', summary: 'すべての版を覚えているライブラリ。' },
      'light-novels': {
        name: 'ライトノベル',
        summary: 'シリーズの全巻と全翻訳を、ひとつの場所に。',
      },
      'serial-fiction': { name: '小説連載', summary: '一章ずつ書く。読んだところから続きを。' },
      acgn: {
        name: 'ACGN',
        summary: '遊べる版を見つけ、観た話数を記録。',
      },
      wikis: { name: 'Wiki', summary: '出典つきのWikiと、作者のための世界設定集。' },
      agents: { name: 'エージェント', summary: 'エージェントは根拠を添えて提案し、決めるのは人。' },
      communities: {
        name: 'コミュニティ',
        summary: 'ひとつの物語、ひとつの言語、ひとつの関心のために。',
      },
      distribution: { name: '出版', summary: '手元に残るファイルで、本とゲームを販売。' },
      developers: {
        name: '開発者',
        summary: 'プロダクトのすべてを API で。アプリとエージェントのために。',
      },
      trust: { name: '信頼', summary: '安全、年齢区分、AI の開示、そしてあなたのデータ。' },
      roadmap: {
        name: 'ロードマップ',
        summary: 'ローンチまでの五つの段階と、それぞれの進み具合。',
      },
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
      inDevelopment: '開発中',
      next: '次に取り組むこと',
      later: 'その先',
      laterHelp: '公開後に追加します。',
    },
    motion: { pause: 'アニメーションを一時停止' },
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
      tagline: '모든 이야기, 모든 언어가 모이는 곳.',
      description:
        '웹소설, 라이트 노벨, 책, 비주얼 노벨, 애니메이션, 만화, 게임까지. 읽을 수 있는 언어로 작품 정보를 살펴보고, 풍성한 커뮤니티에서 플랫폼을 넘어 팬들과 만납니다.',
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
      home: { name: 'REZICS', summary: '모든 이야기와 언어, 플랫폼을 넘어 함께하는 팬들.' },
      reading: { name: '독서', summary: '모든 판본을 기억하는 서재.' },
      'light-novels': { name: '라이트 노벨', summary: '시리즈의 모든 권과 번역을 한곳에.' },
      'serial-fiction': { name: '웹소설', summary: '한 화씩 쓰고, 읽던 자리를 잃지 않고 읽기.' },
      acgn: {
        name: 'ACGN',
        summary: '즐길 수 있는 버전과 지금 보고 있는 회차.',
      },
      wikis: { name: '위키', summary: '출처가 있는 위키와 작가를 위한 설정집.' },
      agents: {
        name: '에이전트',
        summary: '에이전트는 근거와 함께 제안하고, 결정은 사람이 합니다.',
      },
      communities: {
        name: '커뮤니티',
        summary: '하나의 이야기, 하나의 언어, 하나의 관심사를 위한 공간.',
      },
      distribution: { name: '출판', summary: '간직할 수 있는 파일로 파는 책과 게임.' },
      developers: { name: '개발자', summary: '제품 전체를 API로, 앱과 에이전트를 위해.' },
      trust: { name: '신뢰', summary: '안전, 등급, AI 공개, 그리고 내 데이터.' },
      roadmap: { name: '로드맵', summary: '출시까지의 다섯 단계와 각 단계의 현황.' },
    },
    footer: {
      products: '제품군',
      project: '프로젝트',
      openSource: '소스 코드',
      follow: '개발 소식 따라가기',
      languages: '언어',
      rights: 'REZICS Inc.',
      cookies: '이 사이트는 언어와 테마를 기억하는 쿠키 두 개만 사용합니다. 추적기는 없습니다.',
    },
    status: {
      inDevelopment: '개발 중',
      next: '다음 단계',
      later: '이후',
      laterHelp: '출시 후에 제공됩니다.',
    },
    motion: { pause: '애니메이션 일시 정지' },
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
      tagline: 'Jede Geschichte. Jede Sprache. Ein Zuhause.',
      description:
        'Webromane, Light Novels, Bücher, Visual Novels, Anime, Manga und Spiele: mit vollständigen Seiten in deiner Sprache und einer Community, die Fans über Plattformen hinweg verbindet.',
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
      home: {
        name: 'REZICS',
        summary: 'Jede Geschichte, jede Sprache: Fans finden über Plattformen hinweg zusammen.',
      },
      reading: { name: 'Lesen', summary: 'Eine Bibliothek, die sich jede Ausgabe merkt.' },
      'light-novels': {
        name: 'Light Novels',
        summary: 'Jeder Band und jede Übersetzung einer Reihe an einem Ort.',
      },
      'serial-fiction': {
        name: 'Serienromane',
        summary: 'Kapitel für Kapitel schreiben. Lesen, ohne die Stelle zu verlieren.',
      },
      acgn: {
        name: 'ACGN',
        summary: 'Die Veröffentlichung, die du spielen kannst, die Folge, bei der du bist.',
      },
      wikis: {
        name: 'Wikis',
        summary: 'Wikis mit Quellen und eine Weltenbibel für Autorinnen und Autoren.',
      },
      agents: {
        name: 'Agenten',
        summary: 'Agenten schlagen mit Belegen vor, Menschen entscheiden.',
      },
      communities: {
        name: 'Communitys',
        summary: 'Communitys für eine Geschichte, eine Sprache oder eine Idee.',
      },
      distribution: {
        name: 'Veröffentlichen',
        summary: 'Bücher und Spiele als Dateien, die man behält.',
      },
      developers: {
        name: 'Entwickler',
        summary: 'Das ganze Produkt als API, für Apps und Agenten.',
      },
      trust: {
        name: 'Vertrauen',
        summary: 'Sicherheit, Einstufungen, KI-Kennzeichnung und deine Daten.',
      },
      roadmap: { name: 'Roadmap', summary: 'Fünf Etappen bis zum Start und wo jede steht.' },
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
      inDevelopment: 'In Entwicklung',
      next: 'Als Nächstes',
      later: 'Später',
      laterHelp: 'Kommt nach dem Start.',
    },
    motion: { pause: 'Animation anhalten' },
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
      tagline: 'Toutes les histoires. Toutes les langues. Un même lieu.',
      description:
        'Romans web, light novels, livres, visual novels, anime, manga, jeux… Chaque œuvre a sa page dans votre langue et sa communauté, où se retrouvent les fans de toutes les plateformes.',
    },
    skip: 'Aller au contenu',
    header: {
      menu: 'Menu',
      language: 'Langue',
      products: 'À découvrir',
      theme: 'Thème',
      light: 'Clair',
      dark: 'Sombre',
      system: 'Suivre le système',
      cta: 'Être prévenu',
    },
    pages: {
      home: {
        name: 'REZICS',
        summary:
          'Toutes les histoires, toutes les langues : les fans se retrouvent au-delà des plateformes.',
      },
      reading: { name: 'Lecture', summary: 'Une bibliothèque qui se souvient de chaque édition.' },
      'light-novels': {
        name: 'Light novels',
        summary: 'Chaque tome et chaque traduction d’une série, au même endroit.',
      },
      'serial-fiction': {
        name: 'Feuilletons',
        summary: 'Écrire chapitre par chapitre. Lire sans perdre sa page.',
      },
      acgn: {
        name: 'ACGN',
        summary: 'La version à laquelle vous pouvez jouer, l’épisode où vous en êtes.',
      },
      wikis: {
        name: 'Wikis',
        summary: 'Des wikis sourcés et une bible d’univers pour les auteurs.',
      },
      agents: {
        name: 'Agents',
        summary: 'Les agents proposent, preuves à l’appui ; les humains décident.',
      },
      communities: {
        name: 'Communautés',
        summary: 'Des communautés pour une histoire, une langue ou une idée.',
      },
      distribution: {
        name: 'Édition',
        summary: 'Des livres et des jeux vendus en fichiers que l’on garde.',
      },
      developers: {
        name: 'Développeurs',
        summary: 'Tout le produit en API, pour les applications et les agents.',
      },
      trust: {
        name: 'Confiance',
        summary: 'Sécurité, classifications, mention de l’IA et vos données.',
      },
      roadmap: {
        name: 'Feuille de route',
        summary: 'Cinq étapes jusqu’au lancement, et où en est chacune.',
      },
    },
    footer: {
      products: 'À découvrir',
      project: 'Le projet',
      openSource: 'Code source',
      follow: 'Suivre le développement',
      languages: 'Langues',
      rights: 'REZICS Inc.',
      cookies: 'Ce site dépose deux cookies : votre langue et votre thème. Il n’a aucun traceur.',
    },
    status: {
      inDevelopment: 'En développement',
      next: 'Ensuite',
      later: 'Plus tard',
      laterHelp: 'Prévu après le lancement.',
    },
    motion: { pause: 'Mettre l’animation en pause' },
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
      tagline: 'Todas las historias. Todos los idiomas. Un mismo hogar.',
      description:
        'Novelas web, novelas ligeras, libros, novelas visuales, anime, manga y juegos: cada obra con su página completa en tu idioma y una comunidad que reúne a fans de todas las plataformas.',
    },
    skip: 'Saltar al contenido',
    header: {
      menu: 'Menú',
      language: 'Idioma',
      products: 'Qué ofrece REZICS',
      theme: 'Tema',
      light: 'Claro',
      dark: 'Oscuro',
      system: 'Según el sistema',
      cta: 'Avísame',
    },
    pages: {
      home: {
        name: 'REZICS',
        summary: 'Todas las historias, todos los idiomas: fans unidos más allá de las plataformas.',
      },
      reading: { name: 'Lectura', summary: 'Una biblioteca que recuerda cada edición.' },
      'light-novels': {
        name: 'Novelas ligeras',
        summary: 'Cada volumen y cada traducción de una serie, en un solo lugar.',
      },
      'serial-fiction': {
        name: 'Por entregas',
        summary: 'Escribe capítulo a capítulo. Lee sin perder tu sitio.',
      },
      acgn: {
        name: 'ACGN',
        summary: 'La versión que puedes jugar, el episodio por el que vas.',
      },
      wikis: { name: 'Wikis', summary: 'Wikis con fuentes y una biblia del mundo para autores.' },
      agents: {
        name: 'Agentes',
        summary: 'Los agentes proponen con pruebas; las personas deciden.',
      },
      communities: {
        name: 'Comunidades',
        summary: 'Comunidades para una historia, un idioma o una idea.',
      },
      distribution: {
        name: 'Publicación',
        summary: 'Libros y juegos vendidos como archivos que conservas.',
      },
      developers: {
        name: 'Desarrolladores',
        summary: 'Todo el producto como API, para apps y agentes.',
      },
      trust: { name: 'Confianza', summary: 'Seguridad, clasificaciones, aviso de IA y tus datos.' },
      roadmap: {
        name: 'Hoja de ruta',
        summary: 'Cinco etapas hasta el lanzamiento y cómo va cada una.',
      },
    },
    footer: {
      products: 'Qué ofrece REZICS',
      project: 'El proyecto',
      openSource: 'Código fuente',
      follow: 'Seguir el desarrollo',
      languages: 'Idiomas',
      rights: 'REZICS Inc.',
      cookies: 'Este sitio usa dos cookies: tu idioma y tu tema. No tiene rastreadores.',
    },
    status: {
      inDevelopment: 'En desarrollo',
      next: 'A continuación',
      later: 'Más adelante',
      laterHelp: 'Llega después del lanzamiento.',
    },
    motion: { pause: 'Pausar la animación' },
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
