import { defineCopy } from '../define.ts';
import type { LinePageCopy } from './page.ts';

export const lightNovels = defineCopy<LinePageCopy>({
  en: {
    meta: {
      title: 'Light novels on REZICS: every volume, every translation, one series',
      description:
        'Follow a light novel across Japanese originals, official and fan translations. See what you own and read, and know the day the next volume is out in your language.',
    },
    hero: {
      title: 'Know which volume comes next.',
      lede: 'The Japanese original, the English release, the Traditional Chinese edition and the fan translation that got there first: REZICS lines up every volume of a series, marks what you own and have read, and tells you when the next one arrives in your language.',
    },
    story: {
      title: 'One series, every edition.',
      lede: 'Follow a series the way you actually read it: in more than one language, bought in more than one place.',
      steps: {
        lined: {
          title: 'Every edition, lined up.',
          body: 'Each volume appears once per language and edition. Volume 7 in Japanese, in English and in Traditional Chinese are three books you can tell apart at a glance.',
        },
        yours: {
          title: 'What you own, what you have read.',
          body: 'Mark the paperback on your shelf, the ebook you finished and the translation you are waiting for. Your place in the series stays the same whichever edition you read.',
        },
        next: {
          title: 'The next volume, the day it is out.',
          body: 'When volume 7 is dated in 繁體中文, the date appears on your series page. On release day you get one note, and only for the languages you follow.',
        },
        provenance: {
          title: 'Official, fan or machine, always clear.',
          body: 'Every translation says who made it and how far it has got. Fan groups are credited by name, and machine translation is labelled as machine translation.',
        },
      },
    },
    showcase: {
      title: 'Made for how the scene reads.',
      lede: 'Light novels arrive in parts, omnibuses, special editions and several languages at once. REZICS keeps each one straight.',
      tiles: {
        omnibus: {
          title: 'Omnibuses and special editions',
          body: 'An omnibus lists the volumes inside it, and a special edition keeps its extras. Nothing merges because two titles match.',
        },
        calendar: {
          title: 'A release calendar in your languages',
          body: 'This month’s volumes in the languages you read, each date marked confirmed or expected.',
        },
        zone: {
          title: 'The Light Novels Zone',
          body: 'New volumes, finished translations and discussion in your languages, over the same catalogue as every other Zone.',
        },
        wiki: {
          title: 'A wiki for the series',
          body: 'Characters and places cite their chapters, and nothing past the volume you have reached is shown.',
        },
      },
    },
    compare: {
      title: 'From a spreadsheet to one series page.',
      lede: 'Keeping up with a series across languages shouldn’t take three tabs and a notebook.',
      today: 'Today',
      rezics: 'On REZICS',
      rows: {
        spreadsheet: {
          today: 'A spreadsheet of the volumes you own',
          rezics: 'Owned, read and next, marked on the series',
        },
        newsletters: {
          today: 'Publisher newsletters in three languages',
          rezics: 'One note when your language’s volume is out',
        },
        official: {
          today: 'Guessing whether a translation is official',
          rezics: 'Every translation labelled and credited',
        },
        stores: {
          today: 'Purchases scattered across stores and countries',
          rezics: 'Every copy you own recorded in one library',
        },
      },
    },
    statement: {
      text: 'The next volume, in the language you read, on the day it is out.',
      body: 'Light novels lead because they need everything REZICS is built on: distinct editions, native languages and a library that remembers.',
    },
    ledger: {
      title: 'Light novels on REZICS',
      lede: 'Each capability shows where it stands today.',
    },
    cta: {
      title: 'Follow your first series on day one.',
      body: 'Leave your email and we will write once, when registration opens.',
    },
  },
  'zh-Hant': {
    meta: {
      title: 'REZICS 輕小說：每一集、每個譯本，同一個系列',
      description:
        '日文原版、官方譯本、同好翻譯，一起追蹤。看清楚哪些已收藏、已讀，下一集有你閱讀的語言版本時，發售當天就知道。',
    },
    hero: {
      title: '下一集讀哪本，一眼就知道。',
      lede: '日文原版、英文版、繁中版，還有更早推出的同好翻譯：REZICS 把系列每一集排在一起，標出已收藏與已讀，並在下一集推出你閱讀的語言版本時通知你。',
    },
    story: {
      title: '一個系列，所有版本。',
      lede: '讀不同語言、在不同地方買書，都能照自己的方式追系列。',
      steps: {
        lined: {
          title: '每個版本，排得清清楚楚。',
          body: '每集依語言與版本各列一次。日文第 7 集、英文第 7 集與繁中第 7 集，是三本一眼就能分清楚的書。',
        },
        yours: {
          title: '哪些已收藏，哪些已讀。',
          body: '標記架上的紙本、讀完的電子書與等待中的譯本。不論讀哪個版本，系列進度都能接續。',
        },
        next: {
          title: '下一集上市，當天就知道。',
          body: '第 7 集繁中版一公布日期，就會顯示在系列頁面。發售當天收到一次通知，而且只通知你追蹤的語言。',
        },
        provenance: {
          title: '官方、同好或機翻，清楚標示。',
          body: '每個譯本都標明譯者與進度。同好翻譯團隊具名署名，機器翻譯也明確標成機器翻譯。',
        },
      },
    },
    showcase: {
      title: '懂輕小說讀者的閱讀方式。',
      lede: '分冊、合訂本、特裝版，同時還有多種語言版本。REZICS 把每一本都分清楚。',
      tiles: {
        omnibus: {
          title: '合訂本與特裝版',
          body: '合訂本列出收錄集數，特裝版保留附加內容。書名相同，也不會混成一本。',
        },
        calendar: {
          title: '只看你閱讀語言的發售日曆',
          body: '列出本月有你閱讀語言的集數，每個日期都標明已確認或預計。',
        },
        zone: {
          title: '輕小說 Zone',
          body: '新書、已完成的翻譯與你閱讀語言的討論，和其他 Zone 共用同一份作品目錄。',
        },
        wiki: {
          title: '系列專屬 Wiki',
          body: '人物與地點都引用出處章節，不顯示超過你目前集數的內容。',
        },
      },
    },
    compare: {
      title: '從試算表，搬進一個系列頁面。',
      lede: '跨語言追系列，不該得開三個分頁再加一本筆記。',
      today: '目前的做法',
      rezics: '在 REZICS',
      rows: {
        spreadsheet: {
          today: '用試算表記錄藏書集數',
          rezics: '系列頁面直接標出已收藏、已讀與下一集',
        },
        newsletters: {
          today: '訂閱三種語言的出版社電子報',
          rezics: '你閱讀語言的新一集上市時，通知一次',
        },
        official: {
          today: '得自己猜翻譯是否為官方版本',
          rezics: '每個譯本都有標示與署名',
        },
        stores: {
          today: '購書紀錄散落不同商店與國家',
          rezics: '所有藏書，都記在同一個書庫',
        },
      },
    },
    statement: {
      text: '下一集，用你閱讀的語言，發售當天就知道。',
      body: '輕小說率先登場，因為它需要 REZICS 的每一項基礎：分明的版本、原生的語言支援，以及記得閱讀歷程的書庫。',
    },
    ledger: {
      title: 'REZICS 輕小說',
      lede: '每項功能都標明目前進度。',
    },
    cta: {
      title: '開放第一天，就追起第一個系列。',
      body: '留下電子郵件，我們會在開放註冊時通知你一次。',
    },
  },
  'zh-Hans': {
    meta: {
      title: 'REZICS 轻小说：每一卷、每个译本，同一个系列',
      description:
        '日文原版、官方译本、同好翻译，一起追踪。看清楚哪些已收藏、已读，下一卷有你阅读的语言版本时，发售当天就知道。',
    },
    hero: {
      title: '下一卷读哪本，一眼就知道。',
      lede: '日文原版、英文版、繁中版，还有更早推出的同好翻译：REZICS 把系列每一卷排在一起，标出已收藏与已读，并在下一卷推出你阅读的语言版本时通知你。',
    },
    story: {
      title: '一个系列，所有版本。',
      lede: '读不同语言、在不同地方买书，都能照自己的方式追系列。',
      steps: {
        lined: {
          title: '每个版本，排得清清楚楚。',
          body: '每卷按语言与版本各列一次。日文第 7 卷、英文第 7 卷与繁中第 7 卷，是三本一眼就能分清楚的书。',
        },
        yours: {
          title: '哪些已收藏，哪些已读。',
          body: '标记架上的纸书、读完的电子书与等待中的译本。无论读哪个版本，系列进度都能接续。',
        },
        next: {
          title: '下一卷上市，当天就知道。',
          body: '第 7 卷繁中版一公布日期，就会显示在系列页面。发售当天收到一次通知，而且只通知你追踪的语言。',
        },
        provenance: {
          title: '官方、同好或机翻，清楚标明。',
          body: '每个译本都注明译者与进度。同好翻译团队具名署名，机器翻译也明确标成机器翻译。',
        },
      },
    },
    showcase: {
      title: '懂轻小说读者的阅读方式。',
      lede: '分册、合订本、特别版，同时还有多种语言版本。REZICS 把每一本都分清楚。',
      tiles: {
        omnibus: {
          title: '合订本与特别版',
          body: '合订本列出收录卷数，特别版保留附加内容。书名相同，也不会混成一本。',
        },
        calendar: {
          title: '只看你阅读语言的发售日历',
          body: '列出本月有你阅读语言的卷数，每个日期都标明已确认或预计。',
        },
        zone: {
          title: '轻小说 Zone',
          body: '新书、已完成的翻译与你阅读语言的讨论，和其他 Zone 共用同一份作品目录。',
        },
        wiki: {
          title: '系列专属 Wiki',
          body: '人物与地点都引用出处章节，不显示超过你当前卷数的内容。',
        },
      },
    },
    compare: {
      title: '从电子表格，搬进一个系列页面。',
      lede: '跨语言追系列，不该得开三个标签页再加一本笔记。',
      today: '目前的做法',
      rezics: '在 REZICS',
      rows: {
        spreadsheet: {
          today: '用电子表格记录藏书卷数',
          rezics: '系列页面直接标出已收藏、已读与下一卷',
        },
        newsletters: {
          today: '订阅三种语言的出版社邮件',
          rezics: '你阅读语言的新一卷上市时，通知一次',
        },
        official: {
          today: '得自己猜翻译是否为官方版本',
          rezics: '每个译本都有标注与署名',
        },
        stores: {
          today: '购书记录散落不同商店与国家',
          rezics: '所有藏书，都记在同一个书库',
        },
      },
    },
    statement: {
      text: '下一卷，用你阅读的语言，发售当天就知道。',
      body: '轻小说率先登场，因为它需要 REZICS 的每一项基础：分明的版本、原生的语言支持，以及记得阅读历程的书库。',
    },
    ledger: {
      title: 'REZICS 轻小说',
      lede: '每项功能都标明当前进度。',
    },
    cta: {
      title: '开放第一天，就追起第一个系列。',
      body: '留下电子邮箱，我们会在开放注册时通知你一次。',
    },
  },
  ja: {
    meta: {
      title: 'REZICSのライトノベル：全巻も翻訳も、ひとつのシリーズに',
      description:
        '日本語の原作から公式翻訳、ファン翻訳まで追えるライトノベル管理。持っている巻、読んだ巻を確認し、読む言語で次巻が出た日に知ることができます。',
    },
    hero: {
      title: '次に読む巻が、すぐわかる。',
      lede: '日本語の原作、英語版、繁体字中国語版、いち早く出たファン翻訳。REZICSはシリーズ全巻を並べ、蔵書と既読を表示し、あなたが読む言語で次巻が出たら知らせます。',
    },
    story: {
      title: 'ひとつのシリーズに、すべての版を。',
      lede: '複数の言語で読み、いろいろな店で買う。そんな読み方のままシリーズを追えます。',
      steps: {
        lined: {
          title: '版を並べて、見比べる。',
          body: '各巻を言語と版ごとに1冊ずつ表示。日本語、英語、繁体字中国語の第7巻は、別々の3冊として一目で見分けられます。',
        },
        yours: {
          title: '持っている巻、読んだ巻。',
          body: '棚の文庫、読み終えた電子書籍、待っている翻訳をマーク。読む版が変わっても、シリーズの読書位置は引き継がれます。',
        },
        next: {
          title: '次巻の発売を、その日に知る。',
          body: '第7巻の繁体字中国語版に発売日が決まれば、シリーズのページに表示。発売当日に1通、フォローしている言語についてだけ知らせます。',
        },
        provenance: {
          title: '公式・ファン・機械翻訳を、はっきりと。',
          body: 'どの翻訳にも訳者と進捗を表示。ファン翻訳はグループ名を明記し、機械翻訳は機械翻訳として示します。',
        },
      },
    },
    showcase: {
      title: 'ラノベの読み方に、しっくりくる。',
      lede: '分冊、合本、特装版、さまざまな言語版。REZICSはそれぞれをきちんと区別します。',
      tiles: {
        omnibus: {
          title: '合本と特装版',
          body: '合本は収録巻を、特装版は特典を記録。タイトルが同じでも、勝手にひとつにはまとめません。',
        },
        calendar: {
          title: '読む言語で見る発売カレンダー',
          body: '読む言語で今月出る巻を一覧に。各日付が確定か予定かも明記します。',
        },
        zone: {
          title: 'ライトノベルZone',
          body: '新刊、完了した翻訳、読む言語での議論を、ほかのZoneと共通の作品カタログから届けます。',
        },
        wiki: {
          title: 'シリーズのWiki',
          body: '人物や場所には出典の章を明記。読んだ巻より先の情報は表示しません。',
        },
      },
    },
    compare: {
      title: '表計算から、シリーズのページへ。',
      lede: '言語をまたいで追いかけるために、タブ3つとノートまで開かなくても。',
      today: '今のやり方',
      rezics: 'REZICSなら',
      rows: {
        spreadsheet: {
          today: '持っている巻を表計算で管理',
          rezics: '蔵書・既読・次巻をシリーズ上に表示',
        },
        newsletters: {
          today: '3言語の出版社ニュースレター',
          rezics: '読む言語の新刊が出たら1通お知らせ',
        },
        official: {
          today: '公式翻訳かどうかを自分で推測',
          rezics: 'どの翻訳にも種別とクレジット',
        },
        stores: {
          today: '国やストアごとに購入履歴が分散',
          rezics: '持っている本をひとつのライブラリに',
        },
      },
    },
    statement: {
      text: 'あなたが読む言語の次巻を、発売当日に。',
      body: 'ライトノベルから始めるのは、版の区別、言語をそのまま扱うこと、読書を覚えているライブラリというREZICSの土台がすべて必要だからです。',
    },
    ledger: {
      title: 'REZICSのライトノベル',
      lede: '各機能に、現在の開発状況を表示しています。',
    },
    cta: {
      title: '初日から、好きなシリーズをフォロー。',
      body: 'メールアドレスを残していただければ、登録開始時に一度だけお知らせします。',
    },
  },
  ko: {
    meta: {
      title: 'REZICS 라이트 노벨: 모든 권과 번역을 한 시리즈로',
      description:
        '일본어 원서부터 정식 번역과 팬 번역까지 따라가세요. 소장한 권과 읽은 권을 확인하고, 읽는 언어로 다음 권이 나오면 발매 당일 알 수 있습니다.',
    },
    hero: {
      title: '다음에 읽을 권을 한눈에.',
      lede: '일본어 원서, 영어판, 번체 중국어판, 먼저 나온 팬 번역까지. REZICS는 시리즈의 모든 권을 나란히 놓고 소장·읽음 상태를 표시하며, 읽는 언어로 다음 권이 나오면 알려 줍니다.',
    },
    story: {
      title: '한 시리즈, 모든 판본.',
      lede: '여러 언어로 읽고 여러 곳에서 사더라도, 내 방식 그대로 시리즈를 따라갑니다.',
      steps: {
        lined: {
          title: '판본마다 나란히.',
          body: '각 권은 언어와 판본별로 한 번씩 표시됩니다. 일본어 7권, 영어 7권, 번체 중국어 7권을 서로 다른 세 권으로 한눈에 구분할 수 있습니다.',
        },
        yours: {
          title: '소장한 권, 읽은 권.',
          body: '책장에 꽂힌 종이책, 다 읽은 전자책, 기다리는 번역을 표시하세요. 어느 판본을 읽어도 시리즈에서 읽은 지점은 이어집니다.',
        },
        next: {
          title: '다음 권 소식은 발매 당일에.',
          body: '7권 번체 중국어판의 발매일이 정해지면 시리즈 페이지에 표시됩니다. 발매 당일 알림을 한 번 보내며, 팔로우한 언어만 알려 드립니다.',
        },
        provenance: {
          title: '정식·팬·기계 번역을 분명하게.',
          body: '모든 번역에 번역자와 진행 상황을 표시합니다. 팬 번역 팀은 이름을 밝히고, 기계 번역은 기계 번역이라고 명시합니다.',
        },
      },
    },
    showcase: {
      title: '라이트 노벨 독자의 방식에 맞게.',
      lede: '분권, 합본, 특별판, 여러 언어판까지. REZICS는 라이트 노벨의 각 판본을 정확히 구분합니다.',
      tiles: {
        omnibus: {
          title: '합본과 특별판',
          body: '합본은 수록 권을, 특별판은 부록을 기록합니다. 제목이 같다고 합치지 않습니다.',
        },
        calendar: {
          title: '읽는 언어로 보는 발매 달력',
          body: '읽는 언어로 이달에 나오는 권을 모으고, 날짜마다 확정인지 예상인지 표시합니다.',
        },
        zone: {
          title: '라이트 노벨 Zone',
          body: '신간, 완역 소식, 읽는 언어의 토론을 다른 Zone과 같은 작품 목록에서 모아 보여 줍니다.',
        },
        wiki: {
          title: '시리즈 위키',
          body: '인물과 장소에 출처 장을 달고, 읽은 권 이후의 내용은 보여 주지 않습니다.',
        },
      },
    },
    compare: {
      title: '스프레드시트 대신 시리즈 한 페이지.',
      lede: '여러 언어로 시리즈를 따라가는 데 탭 세 개와 수첩까지 필요해서는 안 되죠.',
      today: '지금은',
      rezics: 'REZICS에서는',
      rows: {
        spreadsheet: {
          today: '소장 권을 스프레드시트로 정리',
          rezics: '시리즈에 소장·읽음·다음 권 표시',
        },
        newsletters: {
          today: '세 언어로 오는 출판사 소식지',
          rezics: '읽는 언어로 새 권이 나오면 알림 한 번',
        },
        official: {
          today: '정식 번역인지 직접 추측',
          rezics: '모든 번역에 유형과 번역자 표시',
        },
        stores: {
          today: '상점과 국가마다 흩어진 구매 기록',
          rezics: '소장한 모든 책을 한 서재에 기록',
        },
      },
    },
    statement: {
      text: '내가 읽는 언어의 다음 권을, 발매 당일에.',
      body: '라이트 노벨부터 시작하는 이유는 REZICS의 기반이 모두 필요하기 때문입니다. 명확한 판본 구분, 언어를 있는 그대로 다루는 지원, 독서를 기억하는 서재까지요.',
    },
    ledger: {
      title: 'REZICS 라이트 노벨',
      lede: '각 기능에 현재 진행 상황을 표시합니다.',
    },
    cta: {
      title: '첫날부터 첫 시리즈를 팔로우하세요.',
      body: '이메일을 남겨 주시면 가입이 열릴 때 한 번만 알려 드립니다.',
    },
  },
  de: {
    meta: {
      title: 'Light Novels auf REZICS: alle Bände und Übersetzungen einer Reihe',
      description:
        'Verfolge Originale, offizielle und Fanübersetzungen. Behalte gelesene und eigene Bände im Blick und erfahre am Erscheinungstag vom nächsten Band in deiner Sprache.',
    },
    hero: {
      title: 'Wissen, welcher Band als Nächstes kommt.',
      lede: 'Japanisches Original, englische Veröffentlichung, Ausgabe auf traditionellem Chinesisch und die frühere Fanübersetzung: REZICS ordnet alle Bände, markiert Besitz und Lesestand und meldet den nächsten Band in deiner Sprache.',
    },
    story: {
      title: 'Eine Reihe, alle Ausgaben.',
      lede: 'Verfolge eine Reihe so, wie du sie liest: in mehreren Sprachen und an verschiedenen Orten gekauft.',
      steps: {
        lined: {
          title: 'Alle Ausgaben nebeneinander.',
          body: 'Jeder Band erscheint einmal je Sprache und Ausgabe. Band 7 auf Japanisch, Englisch und traditionellem Chinesisch sind drei klar unterscheidbare Bücher.',
        },
        yours: {
          title: 'Was dir gehört, was du gelesen hast.',
          body: 'Markiere das Taschenbuch im Regal, das fertige E-Book und die ersehnte Übersetzung. Dein Stand in der Reihe bleibt erhalten, egal welche Ausgabe du liest.',
        },
        next: {
          title: 'Den nächsten Band am Erscheinungstag entdecken.',
          body: 'Sobald Band 7 auf traditionellem Chinesisch einen Termin hat, steht er auf deiner Reihenseite. Am Erscheinungstag kommt eine Nachricht, nur für Sprachen, denen du folgst.',
        },
        provenance: {
          title: 'Offiziell, von Fans oder maschinell: klar erkennbar.',
          body: 'Jede Übersetzung nennt Urheber und Fortschritt. Fangruppen werden namentlich gewürdigt, maschinelle Übersetzungen als solche gekennzeichnet.',
        },
      },
    },
    showcase: {
      title: 'So vielseitig wie die Szene.',
      lede: 'Light Novels kommen in Teilen, Sammelbänden, Sonderausgaben und mehreren Sprachen zugleich. REZICS hält sie auseinander.',
      tiles: {
        omnibus: {
          title: 'Sammel- und Sonderausgaben',
          body: 'Ein Sammelband nennt seine enthaltenen Bände, eine Sonderausgabe ihre Extras. Gleiche Titel führen nie zum Zusammenlegen.',
        },
        calendar: {
          title: 'Neuerscheinungen in deinen Sprachen',
          body: 'Die Bände dieses Monats in deinen Lesesprachen, mit bestätigten oder voraussichtlichen Terminen.',
        },
        zone: {
          title: 'Die Light-Novels-Zone',
          body: 'Neue Bände, fertige Übersetzungen und Diskussionen in deinen Sprachen, aus demselben Katalog wie alle anderen Zones.',
        },
        wiki: {
          title: 'Ein Wiki für die Reihe',
          body: 'Figuren und Orte verweisen auf ihre Kapitel. Nichts nach deinem aktuellen Band wird gezeigt.',
        },
      },
    },
    compare: {
      title: 'Von der Tabelle zur Reihenseite.',
      lede: 'Eine Reihe über Sprachen hinweg zu verfolgen sollte keine drei Tabs und ein Notizbuch brauchen.',
      today: 'Heute',
      rezics: 'Auf REZICS',
      rows: {
        spreadsheet: {
          today: 'Eigene Bände in einer Tabelle',
          rezics: 'Besitz, Lesestand und nächster Band an der Reihe',
        },
        newsletters: {
          today: 'Verlagsnewsletter in drei Sprachen',
          rezics: 'Eine Nachricht zum neuen Band in deiner Sprache',
        },
        official: {
          today: 'Rätseln, ob eine Übersetzung offiziell ist',
          rezics: 'Jede Übersetzung gekennzeichnet und mit Credits',
        },
        stores: {
          today: 'Käufe über Läden und Länder verstreut',
          rezics: 'Alle eigenen Exemplare in einer Bibliothek',
        },
      },
    },
    statement: {
      text: 'Der nächste Band, in deiner Sprache, am Erscheinungstag.',
      body: 'Light Novels machen den Anfang, weil sie alle Grundlagen von REZICS brauchen: klar getrennte Ausgaben, Sprachen ohne Umwege und eine Bibliothek, die sich erinnert.',
    },
    ledger: {
      title: 'Light Novels auf REZICS',
      lede: 'Jede Funktion zeigt ihren aktuellen Stand.',
    },
    cta: {
      title: 'Folge deiner ersten Reihe gleich zum Start.',
      body: 'Hinterlasse deine E-Mail-Adresse. Wir schreiben dir einmal, wenn die Registrierung öffnet.',
    },
  },
  fr: {
    meta: {
      title: 'Light novels sur REZICS : chaque tome, chaque traduction, une même série',
      description:
        'Suivez originaux japonais, traductions officielles et de fans. Retrouvez les tomes lus et possédés, et apprenez dès sa sortie que le suivant existe dans votre langue.',
    },
    hero: {
      title: 'Savoir quel tome vient ensuite.',
      lede: 'Original japonais, version anglaise, édition en chinois traditionnel, traduction de fans sortie en premier : REZICS aligne les tomes, indique ceux que vous avez et avez lus, puis vous avertit du suivant dans votre langue.',
    },
    story: {
      title: 'Une série, toutes ses éditions.',
      lede: 'Suivez une série comme vous la lisez : dans plusieurs langues, achetée à plusieurs endroits.',
      steps: {
        lined: {
          title: 'Chaque édition, côte à côte.',
          body: 'Chaque tome apparaît une fois par langue et édition. Le tome 7 en japonais, anglais et chinois traditionnel forme trois livres distincts au premier coup d’œil.',
        },
        yours: {
          title: 'Ce que vous avez, ce que vous avez lu.',
          body: 'Marquez le poche sur l’étagère, l’ebook terminé et la traduction attendue. Votre progression dans la série reste la même, quelle que soit l’édition.',
        },
        next: {
          title: 'Le prochain tome, dès sa sortie.',
          body: 'Dès que le tome 7 en chinois traditionnel est daté, la date apparaît sur la série. Le jour de la sortie, vous recevez un message, uniquement pour les langues suivies.',
        },
        provenance: {
          title: 'Officielle, de fans ou automatique : c’est précisé.',
          body: 'Chaque traduction indique qui l’a faite et son avancement. Les équipes de fans sont créditées, les traductions automatiques clairement signalées.',
        },
      },
    },
    showcase: {
      title: 'Pensé pour les lecteurs de light novels.',
      lede: 'Volumes séparés, intégrales, éditions spéciales, plusieurs langues à la fois : REZICS distingue chaque version.',
      tiles: {
        omnibus: {
          title: 'Intégrales et éditions spéciales',
          body: 'Une intégrale liste ses tomes, une édition spéciale garde ses suppléments. Un titre identique ne suffit pas à fusionner deux livres.',
        },
        calendar: {
          title: 'Un calendrier dans vos langues',
          body: 'Les tomes du mois dans vos langues, avec chaque date marquée comme confirmée ou prévue.',
        },
        zone: {
          title: 'La Zone Light novels',
          body: 'Nouveaux tomes, traductions achevées et discussions dans vos langues, sur le même catalogue que les autres Zones.',
        },
        wiki: {
          title: 'Un wiki pour la série',
          body: 'Personnages et lieux citent leurs chapitres. Rien au-delà du tome atteint n’est affiché.',
        },
      },
    },
    compare: {
      title: 'Du tableur à la page de série.',
      lede: 'Suivre une série entre langues ne devrait pas demander trois onglets et un carnet.',
      today: 'Aujourd’hui',
      rezics: 'Sur REZICS',
      rows: {
        spreadsheet: {
          today: 'Les tomes possédés dans un tableur',
          rezics: 'Possédés, lus et suivants indiqués sur la série',
        },
        newsletters: {
          today: 'Des newsletters d’éditeurs en trois langues',
          rezics: 'Un message à la sortie du tome dans votre langue',
        },
        official: {
          today: 'Deviner si la traduction est officielle',
          rezics: 'Chaque traduction identifiée et créditée',
        },
        stores: {
          today: 'Des achats éparpillés entre boutiques et pays',
          rezics: 'Tous vos exemplaires dans une bibliothèque',
        },
      },
    },
    statement: {
      text: 'Le prochain tome, dans votre langue, dès sa sortie.',
      body: 'Les light novels ouvrent la voie : ils ont besoin de tous les fondements de REZICS, des éditions distinctes, des langues respectées et une bibliothèque qui garde la mémoire.',
    },
    ledger: {
      title: 'Les light novels sur REZICS',
      lede: 'Chaque fonctionnalité indique où elle en est.',
    },
    cta: {
      title: 'Suivez votre première série dès l’ouverture.',
      body: 'Laissez votre adresse e-mail. Nous vous écrirons une seule fois, à l’ouverture des inscriptions.',
    },
  },
  es: {
    meta: {
      title: 'Novelas ligeras en REZICS: cada volumen y traducción de una serie',
      description:
        'Sigue originales japoneses, traducciones oficiales y de fans. Consulta qué tienes y qué has leído, y entérate el día que salga el siguiente volumen en tu idioma.',
    },
    hero: {
      title: 'Ten claro qué volumen sigue.',
      lede: 'El original japonés, la versión inglesa, la edición en chino tradicional y la traducción de fans que llegó antes: REZICS ordena los volúmenes, marca los que tienes y has leído y te avisa del siguiente en tu idioma.',
    },
    story: {
      title: 'Una serie, todas sus ediciones.',
      lede: 'Sigue una serie como la lees: en varios idiomas y comprada en distintos sitios.',
      steps: {
        lined: {
          title: 'Todas las ediciones, en orden.',
          body: 'Cada volumen aparece una vez por idioma y edición. El volumen 7 en japonés, inglés y chino tradicional son tres libros que distingues de un vistazo.',
        },
        yours: {
          title: 'Qué tienes y qué has leído.',
          body: 'Marca el libro de tu estantería, el ebook terminado y la traducción que esperas. Tu progreso en la serie se mantiene, leas la edición que leas.',
        },
        next: {
          title: 'El siguiente volumen, el día que sale.',
          body: 'Cuando el volumen 7 en chino tradicional tenga fecha, aparecerá en la página de la serie. El día del lanzamiento recibirás un aviso, solo para los idiomas que sigues.',
        },
        provenance: {
          title: 'Oficial, de fans o automática: siempre claro.',
          body: 'Cada traducción indica quién la hizo y cuánto abarca. Los grupos de fans reciben crédito por su nombre y la traducción automática se identifica como tal.',
        },
      },
    },
    showcase: {
      title: 'Pensado para quienes leen novelas ligeras.',
      lede: 'Entregas, integrales, ediciones especiales y varios idiomas a la vez: REZICS distingue cada versión.',
      tiles: {
        omnibus: {
          title: 'Integrales y ediciones especiales',
          body: 'Una integral enumera sus volúmenes y una edición especial conserva sus extras. Dos títulos iguales no se fusionan por eso.',
        },
        calendar: {
          title: 'Un calendario en tus idiomas',
          body: 'Los volúmenes del mes en tus idiomas, con cada fecha marcada como confirmada o prevista.',
        },
        zone: {
          title: 'La Zone de novelas ligeras',
          body: 'Nuevos volúmenes, traducciones terminadas y debates en tus idiomas, sobre el mismo catálogo que las demás Zones.',
        },
        wiki: {
          title: 'Un wiki para la serie',
          body: 'Personajes y lugares citan sus capítulos. No se muestra nada posterior al volumen que has alcanzado.',
        },
      },
    },
    compare: {
      title: 'De la hoja de cálculo a una página de serie.',
      lede: 'Seguir una serie entre idiomas no debería exigir tres pestañas y un cuaderno.',
      today: 'Hoy',
      rezics: 'En REZICS',
      rows: {
        spreadsheet: {
          today: 'Una hoja de cálculo con tus volúmenes',
          rezics: 'En la serie, lo que tienes, lo leído y lo siguiente',
        },
        newsletters: {
          today: 'Boletines editoriales en tres idiomas',
          rezics: 'Un aviso cuando salga el volumen en tu idioma',
        },
        official: {
          today: 'Adivinar si una traducción es oficial',
          rezics: 'Cada traducción identificada y acreditada',
        },
        stores: {
          today: 'Compras repartidas entre tiendas y países',
          rezics: 'Todos tus ejemplares en una biblioteca',
        },
      },
    },
    statement: {
      text: 'El siguiente volumen, en tu idioma, el día que sale.',
      body: 'Las novelas ligeras van primero porque necesitan todas las bases de REZICS: ediciones diferenciadas, idiomas tratados de forma nativa y una biblioteca con memoria.',
    },
    ledger: {
      title: 'Novelas ligeras en REZICS',
      lede: 'Cada función indica su estado actual.',
    },
    cta: {
      title: 'Sigue tu primera serie desde el primer día.',
      body: 'Deja tu correo y te escribiremos una sola vez, cuando se abra el registro.',
    },
  },
});
