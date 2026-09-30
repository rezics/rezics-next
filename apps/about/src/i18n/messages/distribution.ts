import { defineCopy } from '../define.ts';
import type { LinePageCopy } from './page.ts';

export const distribution = defineCopy<LinePageCopy>({
  en: {
    meta: {
      title: 'Publishing on REZICS: books and games sold as files people keep',
      description:
        'REZICS sells rights-cleared books, small games and visual novels from contracted creators as DRM-free files, next to the Work’s community and wiki, with every deduction on the statement.',
    },
    hero: {
      title: 'Sell books and games as files people keep.',
      lede: 'REZICS distributes rights-cleared books, small games and visual novels from the creators it works with: DRM-free files, the exact language edition a reader wants, and a store page that sits beside the Work’s community and wiki. Every deduction shows on the creator’s statement.',
    },
    story: {
      title: 'One purchase, start to finish.',
      lede: 'From choosing an edition to downloading it again years later.',
      steps: {
        choose: {
          title: 'Choose the exact edition.',
          body: 'The Traditional Chinese edition, translated by the credited translator, with a sample to read first.',
        },
        buy: {
          title: 'Pay once, see the total first.',
          body: 'The price with tax is shown before checkout, and the receipt lands in your library.',
        },
        keep: {
          title: 'Keep the file.',
          body: 'Download a DRM-free EPUB or PDF, or the game build for your platform, and download it again whenever you like.',
        },
        update: {
          title: 'Get the updates.',
          body: 'A corrected edition or a patched build arrives in your library with its changelog, and earlier versions stay available.',
        },
      },
    },
    showcase: {
      title: 'A store that knows the story.',
      lede: 'Selling is one part of a Work’s life on REZICS, not a separate place.',
      tiles: {
        statements: {
          title: 'Every deduction on the statement',
          body: 'Tax, payment fees and refunds, line by line.',
        },
        rights: {
          title: 'Rights, stated plainly',
          body: 'Who made it, who translated it and what readers may do with it.',
        },
        connected: {
          title: 'The Realm and wiki next door',
          body: 'A purchase lives beside the Work’s discussion and wiki.',
        },
        creators: {
          title: 'Creators across media',
          body: 'Follow an author or translator across books and games.',
        },
      },
    },
    compare: {
      title: 'What readers and creators get.',
      lede: 'Straightforward terms for the people who make things and the people who buy them.',
      today: 'Today',
      rezics: 'On REZICS',
      rows: {
        drm: {
          today: 'Books locked to one app',
          rezics: 'DRM-free files you keep',
        },
        editions: {
          today: 'Language editions buried under “English”',
          rezics: 'Each language edition on its own',
        },
        statements: {
          today: 'A payout with the arithmetic hidden',
          rezics: 'Every deduction on the statement',
        },
        silo: {
          today: 'A store page cut off from the community',
          rezics: 'The Work, its Realm and its wiki together',
        },
      },
    },
    statement: {
      text: 'Buy it once. Keep the file. Know where the money went.',
      body: 'Publishing begins with a small group of contracted creators and opens after payments are approved. Sexually explicit works are not sold.',
    },
    ledger: {
      title: 'Publishing on REZICS',
    },
    cta: {
      title: 'Hear when publishing opens.',
      body: 'Leave your email and we will write once, when registration opens.',
    },
  },
  'zh-Hant': {
    meta: {
      title: 'REZICS 出版：買下書與遊戲，檔案留在手中',
      description:
        'REZICS 販售合作創作者已取得授權的書籍、小型遊戲與視覺小說，提供無 DRM 檔案，連結作品社群與 Wiki，結算單逐項列出扣款。',
    },
    hero: {
      title: '書與遊戲，賣的是能留下的檔案。',
      lede: 'REZICS 發行合作創作者已取得授權的書籍、小型遊戲與視覺小說：無 DRM 檔案、讀者指定的語言版本，商店頁面緊鄰作品社群與 Wiki。創作者結算單列明每一筆扣款。',
    },
    story: {
      title: '一次購買，從頭到尾。',
      lede: '從挑選版本，到多年後再次下載。',
      steps: {
        choose: {
          title: '選對你要的版本。',
          body: '繁體中文版，清楚署名譯者，還能先試讀再決定。',
        },
        buy: {
          title: '付一次，先看清總價。',
          body: '結帳前顯示含稅價格，收據存進你的書庫。',
        },
        keep: {
          title: '檔案，留在你手中。',
          body: '下載無 DRM 的 EPUB、PDF，或適合你平台的遊戲檔案，隨時都能重新下載。',
        },
        update: {
          title: '更新，一樣收得到。',
          body: '修訂版或修補後的遊戲會連同更新說明放進書庫，舊版本仍可取得。',
        },
      },
    },
    showcase: {
      title: '懂故事的商店。',
      lede: '銷售是作品在 REZICS 上的一部分，不是另一座孤島。',
      tiles: {
        statements: {
          title: '每筆扣款，都列在結算單上',
          body: '稅款、支付手續費與退款，一筆筆列明。',
        },
        rights: {
          title: '權利，說清楚',
          body: '誰創作、誰翻譯、讀者能如何使用，都有說明。',
        },
        connected: {
          title: '社群與 Wiki，就在旁邊',
          body: '購買紀錄與作品的討論、Wiki 放在一起。',
        },
        creators: {
          title: '跨媒介追蹤創作者',
          body: '從書籍到遊戲，都能追蹤同一位作者或譯者。',
        },
      },
    },
    compare: {
      title: '讀者與創作者，各自得到什麼。',
      lede: '做作品的人、買作品的人，都該看得懂條件。',
      today: '目前的做法',
      rezics: '在 REZICS',
      rows: {
        drm: {
          today: '書只能在指定 App 裡讀',
          rezics: '無 DRM 的檔案，自己保留',
        },
        editions: {
          today: '其他語言版本埋在「英文」底下',
          rezics: '每種語言版本，獨立呈現',
        },
        statements: {
          today: '只看得到款項，看不到怎麼算',
          rezics: '每筆扣款，都列在結算單上',
        },
        silo: {
          today: '商店頁面與社群互不相連',
          rezics: '作品、社群與 Wiki 聚在一起',
        },
      },
    },
    statement: {
      text: '買一次，留住檔案，也看清錢花在哪裡。',
      body: '出版從少數簽約創作者開始，支付業務獲准後才開放。不販售露骨性描寫作品。',
    },
    ledger: {
      title: 'REZICS 出版',
    },
    cta: {
      title: '出版開放時，收到消息。',
      body: '留下電子郵件，我們會在開放註冊時通知你一次。',
    },
  },
  'zh-Hans': {
    meta: {
      title: 'REZICS 出版：买下书与游戏，文件留在手中',
      description:
        'REZICS 销售签约创作者已取得授权的图书、小型游戏与视觉小说，提供无 DRM 文件，连接作品社区与 Wiki，结算单逐项列出扣款。',
    },
    hero: {
      title: '书与游戏，卖的是能留下的文件。',
      lede: 'REZICS 发行签约创作者已取得授权的图书、小型游戏与视觉小说：无 DRM 文件、读者指定的语言版本，商店页面紧邻作品社区与 Wiki。创作者结算单列明每一笔扣款。',
    },
    story: {
      title: '一次购买，从头到尾。',
      lede: '从挑选版本，到多年后再次下载。',
      steps: {
        choose: {
          title: '选对你要的版本。',
          body: '繁体中文版，清楚署名译者，还能先试读再决定。',
        },
        buy: {
          title: '付一次，先看清总价。',
          body: '结账前显示含税价格，收据存进你的书库。',
        },
        keep: {
          title: '文件，留在你手中。',
          body: '下载无 DRM 的 EPUB、PDF，或适合你平台的游戏文件，随时都能重新下载。',
        },
        update: {
          title: '更新，一样收得到。',
          body: '修订版或修补后的游戏会连同更新说明放进书库，旧版本仍可获取。',
        },
      },
    },
    showcase: {
      title: '懂故事的商店。',
      lede: '销售是作品在 REZICS 上的一部分，不是另一座孤岛。',
      tiles: {
        statements: {
          title: '每笔扣款，都列在结算单上',
          body: '税款、支付手续费与退款，一笔笔列明。',
        },
        rights: {
          title: '权利，说清楚',
          body: '谁创作、谁翻译、读者能如何使用，都有说明。',
        },
        connected: {
          title: '社区与 Wiki，就在旁边',
          body: '购买记录与作品的讨论、Wiki 放在一起。',
        },
        creators: {
          title: '跨媒介关注创作者',
          body: '从图书到游戏，都能关注同一位作者或译者。',
        },
      },
    },
    compare: {
      title: '读者与创作者，各自得到什么。',
      lede: '做作品的人、买作品的人，都该看得懂条件。',
      today: '目前的做法',
      rezics: '在 REZICS',
      rows: {
        drm: {
          today: '书只能在指定 App 里读',
          rezics: '无 DRM 的文件，自己保留',
        },
        editions: {
          today: '其他语言版本埋在“英文”底下',
          rezics: '每种语言版本，独立呈现',
        },
        statements: {
          today: '只看得到款项，看不到怎么算',
          rezics: '每笔扣款，都列在结算单上',
        },
        silo: {
          today: '商店页面与社区互不相连',
          rezics: '作品、社区与 Wiki 聚在一起',
        },
      },
    },
    statement: {
      text: '买一次，留住文件，也看清钱花在哪里。',
      body: '出版从少数签约创作者开始，支付业务获准后才开放。不销售含露骨性描写的作品。',
    },
    ledger: {
      title: 'REZICS 出版',
    },
    cta: {
      title: '出版开放时，收到消息。',
      body: '留下电子邮箱，我们会在开放注册时通知你一次。',
    },
  },
  ja: {
    meta: {
      title: 'REZICSの出版：本もゲームも、手元に残るファイルで',
      description:
        '契約クリエイターの権利処理済みの本、小規模ゲーム、ビジュアルノベルをDRMなしで販売。作品のコミュニティやWikiと隣り合い、精算明細には控除をすべて記載します。',
    },
    hero: {
      title: '本もゲームも、手元に残るファイルで届ける。',
      lede: '契約クリエイターの権利処理済みの本、小規模ゲーム、ビジュアルノベルを届けます。DRMのないファイル、読者が選ぶ言語の版、作品のコミュニティやWikiにつながるストア。精算明細にはすべての控除を記載します。',
    },
    story: {
      title: '購入の、最初からその先まで。',
      lede: '版を選ぶところから、何年もあとに再ダウンロードするまで。',
      steps: {
        choose: {
          title: '欲しい版を、きちんと選ぶ。',
          body: '繁体字中国語版なら、訳者名を確認し、試し読みしてから選べます。',
        },
        buy: {
          title: '支払いは一度。総額は先に。',
          body: '決済前に税込価格を表示し、領収書はライブラリに保存します。',
        },
        keep: {
          title: 'ファイルは、手元に残る。',
          body: 'DRMなしのEPUBやPDF、対応機種用のゲームをダウンロード。いつでも再ダウンロードできます。',
        },
        update: {
          title: '更新版も受け取れる。',
          body: '修正版の本やゲームは変更履歴とともにライブラリへ。以前の版も引き続き入手できます。',
        },
      },
    },
    showcase: {
      title: '物語を知っているストア。',
      lede: '販売も、REZICSでの作品の歩みの一部。同じ場所につながっています。',
      tiles: {
        statements: {
          title: '控除はすべて明細に',
          body: '税金、決済手数料、返金を1行ずつ記載。',
        },
        rights: {
          title: '権利を、明確に',
          body: '作者、訳者、読者に許された利用を示します。',
        },
        connected: {
          title: '隣にはコミュニティとWiki',
          body: '購入した作品は、議論やWikiと同じ場所に。',
        },
        creators: {
          title: '媒体を越えて作り手を追う',
          body: '本からゲームまで、作者や訳者をフォローできます。',
        },
      },
    },
    compare: {
      title: '読者にも、作り手にも。',
      lede: '作る人にも買う人にも、わかりやすい条件を。',
      today: '今のやり方',
      rezics: 'REZICSなら',
      rows: {
        drm: {
          today: 'ひとつのアプリでしか読めない本',
          rezics: '手元に残るDRMなしのファイル',
        },
        editions: {
          today: '「英語」の中に埋もれた各言語版',
          rezics: '言語の版ごとに独立した表示',
        },
        statements: {
          today: '計算の内訳が見えない入金',
          rezics: '控除はすべて明細に',
        },
        silo: {
          today: 'コミュニティから切り離されたストア',
          rezics: '作品、コミュニティ、Wikiがひとつに',
        },
      },
    },
    statement: {
      text: '一度買って、手元に残す。お金の行き先もわかる。',
      body: '出版は少数の契約クリエイターから始め、決済が承認されてから開放します。性的に露骨な作品は販売しません。',
    },
    ledger: {
      title: 'REZICSの出版',
    },
    cta: {
      title: '出版の開始を、お知らせします。',
      body: 'メールアドレスを残していただければ、登録開始時に一度だけお知らせします。',
    },
  },
  ko: {
    meta: {
      title: 'REZICS 출판: 책과 게임을 간직할 수 있는 파일로',
      description:
        '계약 창작자의 권리가 확보된 책, 소규모 게임, 비주얼 노벨을 DRM 없는 파일로 판매합니다. 작품 커뮤니티와 위키가 함께하며, 정산서에 모든 공제 내역을 표시합니다.',
    },
    hero: {
      title: '책과 게임을 간직할 수 있는 파일로 판매하세요.',
      lede: 'REZICS는 계약 창작자의 권리가 확보된 책, 소규모 게임, 비주얼 노벨을 배포합니다. DRM 없는 파일, 독자가 원하는 정확한 언어판, 작품 커뮤니티와 위키 곁의 판매 페이지를 제공합니다. 창작자 정산서에는 모든 공제를 표시합니다.',
    },
    story: {
      title: '구매 한 번의 처음부터 끝까지.',
      lede: '판본을 고르는 순간부터 몇 년 뒤 다시 내려받을 때까지.',
      steps: {
        choose: {
          title: '원하는 판본을 정확히 고르세요.',
          body: '번체 중국어판의 번역자를 확인하고, 미리 읽기로 살펴본 뒤 고릅니다.',
        },
        buy: {
          title: '한 번 결제하고, 총액은 먼저 확인하세요.',
          body: '결제 전에 세금 포함 가격을 보여 주고, 영수증은 서재에 보관합니다.',
        },
        keep: {
          title: '파일은 직접 간직하세요.',
          body: 'DRM 없는 EPUB, PDF 또는 내 플랫폼용 게임 파일을 내려받고, 원할 때 다시 받을 수 있습니다.',
        },
        update: {
          title: '업데이트도 받아 보세요.',
          body: '수정된 판본이나 패치된 게임이 변경 내역과 함께 서재에 들어옵니다. 이전 버전도 계속 받을 수 있습니다.',
        },
      },
    },
    showcase: {
      title: '이야기를 아는 상점.',
      lede: '판매도 REZICS에서 작품이 살아가는 과정의 일부입니다. 따로 떨어진 공간이 아닙니다.',
      tiles: {
        statements: {
          title: '모든 공제를 정산서에',
          body: '세금, 결제 수수료, 환불을 한 줄씩 표시합니다.',
        },
        rights: {
          title: '권리를 명확하게',
          body: '누가 만들고 번역했는지, 독자가 어떻게 이용할 수 있는지 밝힙니다.',
        },
        connected: {
          title: '곁에 있는 커뮤니티와 위키',
          body: '구매한 작품의 토론과 위키를 바로 곁에 둡니다.',
        },
        creators: {
          title: '매체를 넘나드는 창작자',
          body: '책부터 게임까지 같은 작가나 번역자를 팔로우하세요.',
        },
      },
    },
    compare: {
      title: '독자와 창작자 모두에게.',
      lede: '만드는 사람과 사는 사람 모두에게 명확한 조건을 제공합니다.',
      today: '지금은',
      rezics: 'REZICS에서는',
      rows: {
        drm: {
          today: '앱 하나에 묶인 책',
          rezics: '간직할 수 있는 DRM 없는 파일',
        },
        editions: {
          today: '‘영어’ 아래 묻힌 다른 언어판',
          rezics: '언어판마다 따로 표시',
        },
        statements: {
          today: '계산 내역을 알 수 없는 정산',
          rezics: '모든 공제를 정산서에',
        },
        silo: {
          today: '커뮤니티와 떨어진 판매 페이지',
          rezics: '작품, 커뮤니티, 위키를 함께',
        },
      },
    },
    statement: {
      text: '한 번 사고, 파일을 간직하고, 돈의 흐름을 확인하세요.',
      body: '출판은 소수의 계약 창작자와 시작하며 결제 승인을 받은 뒤 엽니다. 노골적인 성적 콘텐츠는 판매하지 않습니다.',
    },
    ledger: {
      title: 'REZICS 출판',
    },
    cta: {
      title: '출판 시작 소식을 받아 보세요.',
      body: '이메일을 남겨 주시면 가입이 열릴 때 한 번만 알려 드립니다.',
    },
  },
  de: {
    meta: {
      title: 'Veröffentlichen auf REZICS: Bücher und Spiele als eigene Dateien',
      description:
        'REZICS verkauft rechtegeklärte Bücher, kleine Spiele und Visual Novels von Vertragspartnern ohne DRM, neben Community und Wiki. Jede Abgabe steht auf der Abrechnung.',
    },
    hero: {
      title: 'Bücher und Spiele als Dateien verkaufen, die bleiben.',
      lede: 'REZICS vertreibt rechtegeklärte Bücher, kleine Spiele und Visual Novels seiner Vertragspartner: ohne DRM, in der gewünschten Sprachausgabe und mit einer Shopseite neben Community und Wiki. Jede Abgabe steht auf der Abrechnung.',
    },
    story: {
      title: 'Ein Kauf, von Anfang bis Ende.',
      lede: 'Von der Auswahl bis zum erneuten Download Jahre später.',
      steps: {
        choose: {
          title: 'Genau die richtige Ausgabe wählen.',
          body: 'Die Ausgabe auf traditionellem Chinesisch, mit genanntem Übersetzer und Leseprobe.',
        },
        buy: {
          title: 'Einmal zahlen, vorher die Summe sehen.',
          body: 'Der Preis inklusive Steuern steht vor dem Bezahlen fest. Der Beleg landet in deiner Bibliothek.',
        },
        keep: {
          title: 'Die Datei behalten.',
          body: 'Lade EPUB oder PDF ohne DRM oder den Spiele-Build für deine Plattform herunter, jederzeit auch erneut.',
        },
        update: {
          title: 'Updates erhalten.',
          body: 'Korrigierte Ausgaben und gepatchte Builds kommen mit Änderungsprotokoll in die Bibliothek. Frühere Versionen bleiben verfügbar.',
        },
      },
    },
    showcase: {
      title: 'Ein Shop, der die Geschichte kennt.',
      lede: 'Verkaufen gehört zum Leben eines Werks auf REZICS und ist kein abgetrennter Ort.',
      tiles: {
        statements: {
          title: 'Jede Abgabe auf der Abrechnung',
          body: 'Steuern, Zahlungsgebühren und Erstattungen, Zeile für Zeile.',
        },
        rights: {
          title: 'Rechte, klar benannt',
          body: 'Wer es geschaffen und übersetzt hat und was Leser damit tun dürfen.',
        },
        connected: {
          title: 'Community und Wiki nebenan',
          body: 'Ein Kauf lebt neben Diskussion und Wiki des Werks.',
        },
        creators: {
          title: 'Kreative über Medien hinweg',
          body: 'Folge Autoren oder Übersetzern durch Bücher und Spiele.',
        },
      },
    },
    compare: {
      title: 'Was Leser und Kreative bekommen.',
      lede: 'Klare Bedingungen für Menschen, die etwas schaffen, und die, die es kaufen.',
      today: 'Heute',
      rezics: 'Auf REZICS',
      rows: {
        drm: {
          today: 'Bücher an eine App gebunden',
          rezics: 'Dateien ohne DRM, die du behältst',
        },
        editions: {
          today: 'Sprachausgaben unter „Englisch“ versteckt',
          rezics: 'Jede Sprachausgabe für sich',
        },
        statements: {
          today: 'Auszahlung ohne sichtbare Rechnung',
          rezics: 'Jede Abgabe auf der Abrechnung',
        },
        silo: {
          today: 'Shopseite getrennt von der Community',
          rezics: 'Werk, Community und Wiki zusammen',
        },
      },
    },
    statement: {
      text: 'Einmal kaufen. Datei behalten. Wissen, wohin das Geld geht.',
      body: 'Der Vertrieb beginnt mit wenigen vertraglich gebundenen Kreativen und öffnet nach Freigabe der Zahlungen. Sexuell explizite Werke werden nicht verkauft.',
    },
    ledger: {
      title: 'Veröffentlichen auf REZICS',
    },
    cta: {
      title: 'Vom Start des Vertriebs erfahren.',
      body: 'Hinterlasse deine E-Mail-Adresse. Wir schreiben dir einmal, wenn die Registrierung öffnet.',
    },
  },
  fr: {
    meta: {
      title: 'Publier sur REZICS : des livres et jeux en fichiers à garder',
      description:
        'Livres, petits jeux et visual novels aux droits vérifiés, issus de créateurs sous contrat, sans DRM, près du wiki et de la communauté. Chaque retenue figure au relevé.',
    },
    hero: {
      title: 'Vendre des livres et des jeux que l’on garde.',
      lede: 'REZICS distribue livres, petits jeux et visual novels aux droits vérifiés de ses créateurs partenaires : fichiers sans DRM, édition linguistique choisie et boutique près de la communauté et du wiki. Chaque retenue apparaît au relevé du créateur.',
    },
    story: {
      title: 'Un achat, du début à la suite.',
      lede: 'Du choix de l’édition au nouveau téléchargement, des années plus tard.',
      steps: {
        choose: {
          title: 'Choisissez l’édition exacte.',
          body: 'L’édition en chinois traditionnel, son traducteur crédité et un extrait à lire avant d’acheter.',
        },
        buy: {
          title: 'Payez une fois, voyez d’abord le total.',
          body: 'Le prix TTC est affiché avant paiement et le reçu rejoint votre bibliothèque.',
        },
        keep: {
          title: 'Gardez le fichier.',
          body: 'Téléchargez un EPUB, PDF ou jeu pour votre plateforme, sans DRM, puis retéléchargez-le quand vous voulez.',
        },
        update: {
          title: 'Recevez les mises à jour.',
          body: 'L’édition corrigée ou le jeu mis à jour arrive dans votre bibliothèque avec ses notes de version. Les versions antérieures restent disponibles.',
        },
      },
    },
    showcase: {
      title: 'Une boutique qui connaît l’histoire.',
      lede: 'La vente fait partie de la vie d’une œuvre sur REZICS, dans le même lieu.',
      tiles: {
        statements: {
          title: 'Chaque retenue sur le relevé',
          body: 'Taxes, frais de paiement et remboursements, ligne par ligne.',
        },
        rights: {
          title: 'Des droits clairement énoncés',
          body: 'Qui a créé, qui a traduit et ce que les lecteurs peuvent en faire.',
        },
        connected: {
          title: 'La communauté et le wiki à côté',
          body: 'L’achat vit près des discussions et du wiki de l’œuvre.',
        },
        creators: {
          title: 'Des créateurs au-delà des médias',
          body: 'Suivez un auteur ou traducteur, des livres aux jeux.',
        },
      },
    },
    compare: {
      title: 'Ce qu’y gagnent lecteurs et créateurs.',
      lede: 'Des conditions simples pour ceux qui créent et ceux qui achètent.',
      today: 'Aujourd’hui',
      rezics: 'Sur REZICS',
      rows: {
        drm: {
          today: 'Des livres enfermés dans une application',
          rezics: 'Des fichiers sans DRM à garder',
        },
        editions: {
          today: 'Des éditions noyées sous « anglais »',
          rezics: 'Chaque édition linguistique distincte',
        },
        statements: {
          today: 'Un versement au calcul opaque',
          rezics: 'Chaque retenue sur le relevé',
        },
        silo: {
          today: 'Une boutique coupée de la communauté',
          rezics: 'L’œuvre, sa communauté et son wiki réunis',
        },
      },
    },
    statement: {
      text: 'Acheter une fois. Garder le fichier. Savoir où va l’argent.',
      body: 'La vente commence avec un petit groupe de créateurs sous contrat, après approbation des paiements. Les œuvres sexuellement explicites ne sont pas vendues.',
    },
    ledger: {
      title: 'Publier sur REZICS',
    },
    cta: {
      title: 'Soyez informé de l’ouverture de l’édition.',
      body: 'Laissez votre adresse e-mail. Nous vous écrirons une seule fois, à l’ouverture des inscriptions.',
    },
  },
  es: {
    meta: {
      title: 'Publicar en REZICS: libros y juegos como archivos que conservas',
      description:
        'REZICS vende libros, juegos pequeños y novelas visuales con derechos autorizados de creadores con contrato, sin DRM, junto a su comunidad y wiki, con cada deducción detallada.',
    },
    hero: {
      title: 'Vende libros y juegos como archivos que se conservan.',
      lede: 'REZICS distribuye libros, juegos pequeños y novelas visuales con derechos autorizados de sus creadores asociados: archivos sin DRM, la edición lingüística elegida y una tienda junto a la comunidad y el wiki. Cada deducción figura en la liquidación.',
    },
    story: {
      title: 'Una compra, de principio a fin.',
      lede: 'Desde elegir la edición hasta descargarla de nuevo años después.',
      steps: {
        choose: {
          title: 'Elige la edición exacta.',
          body: 'La edición en chino tradicional, con su traductor acreditado y una muestra para leer antes.',
        },
        buy: {
          title: 'Paga una vez y conoce antes el total.',
          body: 'El precio con impuestos se muestra antes del pago y el recibo llega a tu biblioteca.',
        },
        keep: {
          title: 'Conserva el archivo.',
          body: 'Descarga un EPUB o PDF sin DRM, o el juego para tu plataforma, y vuelve a descargarlo cuando quieras.',
        },
        update: {
          title: 'Recibe las actualizaciones.',
          body: 'Una edición corregida o una versión parcheada llega a tu biblioteca con sus cambios. Las versiones anteriores siguen disponibles.',
        },
      },
    },
    showcase: {
      title: 'Una tienda que conoce la historia.',
      lede: 'La venta es parte de la vida de una obra en REZICS, no un espacio separado.',
      tiles: {
        statements: {
          title: 'Cada deducción en la liquidación',
          body: 'Impuestos, comisiones de pago y reembolsos, línea por línea.',
        },
        rights: {
          title: 'Derechos claros',
          body: 'Quién lo creó, quién lo tradujo y qué pueden hacer los lectores con ello.',
        },
        connected: {
          title: 'La comunidad y el wiki al lado',
          body: 'La compra convive con los debates y el wiki de la obra.',
        },
        creators: {
          title: 'Creadores entre medios',
          body: 'Sigue a un autor o traductor a través de libros y juegos.',
        },
      },
    },
    compare: {
      title: 'Qué reciben lectores y creadores.',
      lede: 'Condiciones claras para quienes crean y quienes compran.',
      today: 'Hoy',
      rezics: 'En REZICS',
      rows: {
        drm: {
          today: 'Libros encerrados en una app',
          rezics: 'Archivos sin DRM que conservas',
        },
        editions: {
          today: 'Ediciones en otros idiomas ocultas bajo «inglés»',
          rezics: 'Cada edición lingüística por separado',
        },
        statements: {
          today: 'Un pago sin desglose del cálculo',
          rezics: 'Cada deducción en la liquidación',
        },
        silo: {
          today: 'Una tienda desconectada de la comunidad',
          rezics: 'La obra, su comunidad y su wiki juntos',
        },
      },
    },
    statement: {
      text: 'Compra una vez. Conserva el archivo. Sabe adónde va el dinero.',
      body: 'La publicación empieza con un grupo pequeño de creadores con contrato y abre tras la aprobación de los pagos. No se venden obras sexualmente explícitas.',
    },
    ledger: {
      title: 'Publicar en REZICS',
    },
    cta: {
      title: 'Entérate cuando abra la publicación.',
      body: 'Deja tu correo y te escribiremos una sola vez, cuando se abra el registro.',
    },
  },
});
