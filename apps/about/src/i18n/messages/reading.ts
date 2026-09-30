import { defineCopy } from '../define.ts';
import type { LinePageCopy } from './page.ts';

export const reading = defineCopy<LinePageCopy>({
  en: {
    meta: {
      title: 'Reading on REZICS: a library that remembers every edition',
      description:
        'Import your reading history, keep every edition and reread, track what you own and borrowed, and export all of it whenever you want. A library that goes wherever you read.',
    },
    hero: {
      title: 'A library that remembers every edition.',
      lede: 'The paperback you own, the ebook you finished on the train, the audiobook you switched to halfway, the library copy due back on Friday. REZICS keeps them as one story read your way, and lets you take the whole record with you.',
    },
    story: {
      title: 'Move in without starting over.',
      lede: 'Years of reading history come with you, edition by edition.',
      steps: {
        upload: {
          title: 'Bring your export.',
          body: 'Drop in the file from Goodreads, StoryGraph or your own spreadsheet. Nothing changes in your library until you say so.',
        },
        match: {
          title: 'Each book finds its edition.',
          body: 'Rows are matched to the edition you actually read. When two look alike, say a 2019 paperback and its 2021 reissue, you choose, and REZICS never guesses from a title alone.',
        },
        preview: {
          title: 'See what will not carry over.',
          body: 'Before anything is applied, a preview lists every row that could not be matched and every field the source could not express, so nothing disappears quietly.',
        },
        resume: {
          title: 'Pick up where you were.',
          body: 'Your current reads arrive with their page, percent or minute, and rereads and set-aside books keep their history.',
        },
      },
    },
    showcase: {
      title: 'Reading the way it actually happens.',
      lede: 'Real reading is messy. The record should be honest about it.',
      tiles: {
        formats: {
          title: 'One read, many formats',
          body: 'Start in print, finish on audio, count it once.',
        },
        rereads: {
          title: 'Rereads and set-asides',
          body: 'Every reread is its own session; a book you set down stays set down, not failed.',
        },
        copies: {
          title: 'Owned, borrowed, due back',
          body: 'Copies and loans live apart from what you have read.',
        },
        notes: {
          title: 'Notes on the passage',
          body: 'Private notes tied to the edition and the exact place.',
        },
        reviews: {
          title: 'Reviews that say what they judge',
          body: 'Story, translation and narration rated on their own.',
        },
        export: {
          title: 'Leave with everything',
          body: 'Export the whole library, notes and dates included.',
        },
      },
    },
    compare: {
      title: 'A reading record that survives the move.',
      lede: 'Most libraries are easy to enter and hard to leave.',
      today: 'Today',
      rezics: 'On REZICS',
      rows: {
        editions: {
          today: 'Every edition a separate book, reviews split between them',
          rezics: 'One story, its editions kept distinct and together',
        },
        rereads: {
          today: 'A reread overwrites the first read',
          rezics: 'Each read is its own session',
        },
        export: {
          today: 'Exports that drop notes and dates',
          rezics: 'A complete export you can import again',
        },
        sync: {
          today: 'Three apps to update after every chapter',
          rezics: 'One record, reachable by the tools you use',
        },
      },
    },
    statement: {
      text: 'Your reading life is a record worth keeping. Keep it.',
      body: 'Everything you log on REZICS can leave with you, whole, whenever you want.',
    },
    ledger: {
      title: 'Reading on REZICS',
    },
    cta: {
      title: 'Bring your library on day one.',
      body: 'Leave your email and we will write once, when registration opens.',
    },
  },
  'zh-Hant': {
    meta: {
      title: '在 REZICS 閱讀：記得每個版本的書庫',
      description:
        '匯入閱讀紀錄，保留每個版本與重讀歷程，管理藏書與借書，隨時完整匯出。不論在哪裡閱讀，書庫都跟著你。',
    },
    hero: {
      title: '每個版本，書庫都記得。',
      lede: '架上的平裝書、通勤時讀完的電子書、讀到一半改聽的有聲書，還有週五得還的圖書館借書。REZICS 把它們記成同一個故事、屬於你的閱讀歷程，完整紀錄隨時都能帶走。',
    },
    story: {
      title: '搬個家，不必從頭來過。',
      lede: '多年閱讀紀錄，連同每個版本一起搬過來。',
      steps: {
        upload: {
          title: '帶上匯出的檔案。',
          body: '放入 Goodreads、StoryGraph 或自己的試算表檔案。在你確認之前，書庫不會有任何變動。',
        },
        match: {
          title: '每一本，都對上你讀的版本。',
          body: '每筆資料都比對到你實際讀過的版本。若兩版很像，例如 2019 年平裝版與 2021 年再版，就由你選擇；REZICS 不會只憑書名猜測。',
        },
        preview: {
          title: '先看清楚哪些資料帶不過來。',
          body: '套用之前，預覽會列出所有無法比對的資料，以及來源格式無法表達的欄位，不讓任何資訊悄悄消失。',
        },
        resume: {
          title: '從上次讀到的地方繼續。',
          body: '正在讀的書會帶著頁碼、百分比或分鐘數一起匯入，重讀與暫時擱下的書也保留原有歷程。',
        },
      },
    },
    showcase: {
      title: '照著真實的閱讀習慣來記。',
      lede: '閱讀不總是按部就班，紀錄也該如實呈現。',
      tiles: {
        formats: {
          title: '一次閱讀，多種形式',
          body: '紙本開讀，有聲書收尾，只計一次。',
        },
        rereads: {
          title: '重讀與暫放',
          body: '每次重讀都有獨立紀錄；暫時放下的書就記成暫放，不算失敗。',
        },
        copies: {
          title: '藏書、借書、還書日',
          body: '藏書與借閱分開管理，不混入閱讀紀錄。',
        },
        notes: {
          title: '寫在段落上的筆記',
          body: '私人筆記連到確切版本與位置。',
        },
        reviews: {
          title: '評論，說清楚評的是什麼',
          body: '故事、翻譯、旁白，分別評分。',
        },
        export: {
          title: '全部帶走',
          body: '整個書庫都能匯出，筆記與日期也不漏。',
        },
      },
    },
    compare: {
      title: '搬家之後，閱讀紀錄依然完整。',
      lede: '多數書庫容易入門，卻很難完整搬走。',
      today: '目前的做法',
      rezics: '在 REZICS',
      rows: {
        editions: {
          today: '每個版本各算一本書，評論散落各處',
          rezics: '同一個故事，各版清楚區分、彼此相連',
        },
        rereads: {
          today: '重讀覆蓋掉第一次的紀錄',
          rezics: '每次閱讀都各有紀錄',
        },
        export: {
          today: '匯出時遺失筆記與日期',
          rezics: '完整匯出，也能重新匯入',
        },
        sync: {
          today: '每讀完一章，要更新三個 App',
          rezics: '同一份紀錄，慣用工具都能存取',
        },
      },
    },
    statement: {
      text: '你的閱讀歲月，值得好好留下。',
      body: '在 REZICS 記下的一切，隨時都能完整帶走。',
    },
    ledger: {
      title: '在 REZICS 閱讀',
    },
    cta: {
      title: '開放第一天，就帶著書庫加入。',
      body: '留下電子郵件，我們會在開放註冊時通知你一次。',
    },
  },
  'zh-Hans': {
    meta: {
      title: '在 REZICS 阅读：记得每个版本的书库',
      description:
        '导入阅读记录，保留每个版本与重读历程，管理藏书与借书，随时完整导出。无论在哪里阅读，书库都跟着你。',
    },
    hero: {
      title: '每个版本，书库都记得。',
      lede: '架上的平装书、通勤时读完的电子书、读到一半改听的有声书，还有周五得还的图书馆借书。REZICS 把它们记成同一个故事、属于你的阅读历程，完整记录随时都能带走。',
    },
    story: {
      title: '搬个家，不必从头来过。',
      lede: '多年阅读记录，连同每个版本一起搬过来。',
      steps: {
        upload: {
          title: '带上导出的文件。',
          body: '放入 Goodreads、StoryGraph 或自己的电子表格文件。在你确认之前，书库不会有任何变动。',
        },
        match: {
          title: '每一本，都对上你读的版本。',
          body: '每条数据都匹配到你实际读过的版本。如果两版很像，例如 2019 年平装版与 2021 年再版，就由你选择；REZICS 不会只凭书名猜测。',
        },
        preview: {
          title: '先看清楚哪些数据带不过来。',
          body: '应用之前，预览会列出所有无法匹配的数据，以及来源格式无法表达的字段，不让任何信息悄悄消失。',
        },
        resume: {
          title: '从上次读到的地方继续。',
          body: '正在读的书会带着页码、百分比或分钟数一起导入，重读与暂时搁下的书也保留原有历程。',
        },
      },
    },
    showcase: {
      title: '照着真实的阅读习惯来记。',
      lede: '阅读不总是按部就班，记录也该如实呈现。',
      tiles: {
        formats: {
          title: '一次阅读，多种形式',
          body: '纸书开读，有声书收尾，只计一次。',
        },
        rereads: {
          title: '重读与暂放',
          body: '每次重读都有独立记录；暂时放下的书就记成暂放，不算失败。',
        },
        copies: {
          title: '藏书、借书、还书日',
          body: '藏书与借阅分开管理，不混入阅读记录。',
        },
        notes: {
          title: '写在段落上的笔记',
          body: '私人笔记连到确切版本与位置。',
        },
        reviews: {
          title: '评论，说清楚评的是什么',
          body: '故事、翻译、旁白，分别评分。',
        },
        export: {
          title: '全部带走',
          body: '整个书库都能导出，笔记与日期也不漏。',
        },
      },
    },
    compare: {
      title: '搬家之后，阅读记录依然完整。',
      lede: '多数书库容易入门，却很难完整搬走。',
      today: '目前的做法',
      rezics: '在 REZICS',
      rows: {
        editions: {
          today: '每个版本各算一本书，评论散落各处',
          rezics: '同一个故事，各版清楚区分、彼此相连',
        },
        rereads: {
          today: '重读覆盖掉第一次的记录',
          rezics: '每次阅读都各有记录',
        },
        export: {
          today: '导出时丢失笔记与日期',
          rezics: '完整导出，也能重新导入',
        },
        sync: {
          today: '每读完一章，要更新三个 App',
          rezics: '同一份记录，常用工具都能访问',
        },
      },
    },
    statement: {
      text: '你的阅读岁月，值得好好留下。',
      body: '在 REZICS 记下的一切，随时都能完整带走。',
    },
    ledger: {
      title: '在 REZICS 阅读',
    },
    cta: {
      title: '开放第一天，就带着书库加入。',
      body: '留下电子邮箱，我们会在开放注册时通知你一次。',
    },
  },
  ja: {
    meta: {
      title: 'REZICSの読書：どの版を読んだかまで残るライブラリ',
      description:
        '読書履歴を取り込み、読んだ版も再読も記録。蔵書と借りた本を管理し、いつでも丸ごと書き出せます。読む場所が変わっても、ライブラリは一緒です。',
    },
    hero: {
      title: 'どの版を読んだかまで、覚えている。',
      lede: '手元の文庫、電車で読み終えた電子書籍、途中から切り替えたオーディオブック、金曜が返却期限の図書館の本。REZICSはそれらを、ひとつの物語をあなたなりに読んだ記録としてまとめます。記録は丸ごと持ち出せます。',
    },
    story: {
      title: '積み重ねた読書は、そのままに。',
      lede: '何年分もの読書履歴を、版ごと引き継げます。',
      steps: {
        upload: {
          title: '書き出したファイルを用意。',
          body: 'Goodreads、StoryGraph、自分の表計算ファイルを取り込みます。確認するまで、ライブラリは変わりません。',
        },
        match: {
          title: '読んだ本を、読んだ版に。',
          body: '各行を、実際に読んだ版と照合します。2019年の文庫版と2021年の再刊など、候補が似ていればあなたが選択。タイトルだけでは決めつけません。',
        },
        preview: {
          title: '引き継げない内容を、先に確認。',
          body: '反映する前のプレビューで、照合できなかった行も、元の形式では扱えなかった項目もすべて確認。知らないうちに情報が消えることはありません。',
        },
        resume: {
          title: '続きは、前に読んでいた場所から。',
          body: '読みかけの本はページ、割合、再生分数まで引き継ぎます。再読も、いったん置いた本も、履歴はそのままです。',
        },
      },
    },
    showcase: {
      title: '読書は、思いどおりに進まないから。',
      lede: '寄り道も中断もある。それも正直に残せる記録を。',
      tiles: {
        formats: {
          title: '形式を変えても、ひと続きの読書',
          body: '紙で読み始め、音声で読み終えても、1回として記録。',
        },
        rereads: {
          title: '再読も、読みかけも',
          body: '再読はそのつど別の読書記録に。いったん置いた本は「中断」であって、失敗ではありません。',
        },
        copies: {
          title: '蔵書、借りた本、返却期限',
          body: '持っている本や借りた本は、読書履歴とは別に管理。',
        },
        notes: {
          title: 'あの一節に、メモを',
          body: '非公開のメモを、その版の正確な位置に結びつけます。',
        },
        reviews: {
          title: '何を評価したかがわかるレビュー',
          body: '物語、翻訳、朗読をそれぞれ評価。',
        },
        export: {
          title: 'すべて持ち出せる',
          body: 'メモも日付も含め、ライブラリ全体を書き出せます。',
        },
      },
    },
    compare: {
      title: '引っ越しても、読書の記録はそのまま。',
      lede: '多くのライブラリは、始めるのは簡単でも離れるのは大変です。',
      today: '今のやり方',
      rezics: 'REZICSなら',
      rows: {
        editions: {
          today: '版ごとに別の本になり、レビューも分散',
          rezics: 'ひとつの物語に、区別された各版がつながる',
        },
        rereads: {
          today: '再読で初読の記録が上書きされる',
          rezics: '読むたびに独立した記録',
        },
        export: {
          today: '書き出すとメモや日付が抜け落ちる',
          rezics: '丸ごと書き出し、再び取り込める',
        },
        sync: {
          today: '1章読むたびに3つのアプリを更新',
          rezics: 'いつものツールから使える、ひとつの記録',
        },
      },
    },
    statement: {
      text: '読んできた日々は、残す価値がある。',
      body: 'REZICSに残したものはすべて、好きなときに丸ごと持ち出せます。',
    },
    ledger: {
      title: 'REZICSで読む',
    },
    cta: {
      title: '初日から、あなたのライブラリと一緒に。',
      body: 'メールアドレスを残していただければ、登録開始時に一度だけお知らせします。',
    },
  },
  ko: {
    meta: {
      title: 'REZICS 독서: 판본까지 기억하는 서재',
      description:
        '독서 기록을 가져와 판본과 재독 이력을 보관하고, 소장·대출 도서를 관리하세요. 언제든 전부 내보낼 수 있습니다. 어디서 읽든 서재가 함께합니다.',
    },
    hero: {
      title: '판본까지 기억하는 서재.',
      lede: '소장한 종이책, 지하철에서 다 읽은 전자책, 중간에 바꿔 들은 오디오북, 금요일까지 반납할 도서관 책. REZICS는 모두 한 이야기를 나만의 방식으로 읽은 기록으로 남깁니다. 그 기록은 언제든 통째로 가져갈 수 있습니다.',
    },
    story: {
      title: '처음부터 다시 기록할 필요 없이.',
      lede: '오랜 독서 기록을 판본 하나하나까지 가져옵니다.',
      steps: {
        upload: {
          title: '내보낸 파일을 가져오세요.',
          body: 'Goodreads, StoryGraph 또는 직접 만든 스프레드시트 파일을 넣으세요. 확인하기 전에는 서재가 바뀌지 않습니다.',
        },
        match: {
          title: '내가 읽은 판본으로 맞춥니다.',
          body: '각 행을 실제로 읽은 판본과 맞춥니다. 2019년판과 2021년 재판처럼 비슷한 후보가 있으면 직접 고릅니다. REZICS는 제목만 보고 추측하지 않습니다.',
        },
        preview: {
          title: '옮겨지지 않는 정보부터 확인하세요.',
          body: '적용 전에 미리보기에서 일치 항목을 찾지 못한 모든 행과 원본 형식이 담지 못하는 필드를 확인합니다. 정보가 모르게 사라지지 않습니다.',
        },
        resume: {
          title: '읽던 곳에서 이어 읽으세요.',
          body: '읽는 중인 책은 페이지, 퍼센트, 재생 시간까지 가져옵니다. 다시 읽거나 잠시 내려놓은 책의 이력도 그대로 남습니다.',
        },
      },
    },
    showcase: {
      title: '실제로 읽는 방식 그대로.',
      lede: '독서는 늘 계획대로 흘러가지 않죠. 기록도 그 모습을 솔직하게 담아야 합니다.',
      tiles: {
        formats: {
          title: '형식이 바뀌어도 한 번의 독서',
          body: '종이책으로 시작해 오디오북으로 끝내도 한 번으로 기록합니다.',
        },
        rereads: {
          title: '재독과 잠시 멈춘 책',
          body: '재독은 매번 별도의 기록으로 남습니다. 내려놓은 책은 잠시 멈춘 책일 뿐, 실패가 아닙니다.',
        },
        copies: {
          title: '소장, 대출, 반납일',
          body: '소장·대출 정보는 독서 기록과 따로 관리합니다.',
        },
        notes: {
          title: '구절에 남기는 메모',
          body: '비공개 메모를 해당 판본의 정확한 위치에 연결합니다.',
        },
        reviews: {
          title: '평가 대상을 분명히 하는 리뷰',
          body: '이야기, 번역, 낭독을 각각 평가합니다.',
        },
        export: {
          title: '모두 가져가세요',
          body: '메모와 날짜까지 서재 전체를 내보냅니다.',
        },
      },
    },
    compare: {
      title: '옮겨도 온전히 남는 독서 기록.',
      lede: '대부분의 서재는 들어가기는 쉽지만 떠나기는 어렵습니다.',
      today: '지금은',
      rezics: 'REZICS에서는',
      rows: {
        editions: {
          today: '판본마다 다른 책으로 나뉘고 리뷰도 흩어짐',
          rezics: '한 이야기 아래 판본을 구분해 모아 둠',
        },
        rereads: {
          today: '재독이 첫 독서 기록을 덮어씀',
          rezics: '읽을 때마다 별도의 기록',
        },
        export: {
          today: '내보내면 메모와 날짜가 빠짐',
          rezics: '전체를 내보내고 다시 가져올 수 있음',
        },
        sync: {
          today: '한 장 읽을 때마다 앱 세 개를 갱신',
          rezics: '쓰던 도구에서 접근하는 하나의 기록',
        },
      },
    },
    statement: {
      text: '책과 함께한 시간, 간직할 가치가 있어요.',
      body: 'REZICS에 남긴 모든 기록은 원할 때 언제든 온전히 가져갈 수 있습니다.',
    },
    ledger: {
      title: 'REZICS에서 읽기',
    },
    cta: {
      title: '첫날부터 내 서재와 함께.',
      body: '이메일을 남겨 주시면 가입이 열릴 때 한 번만 알려 드립니다.',
    },
  },
  de: {
    meta: {
      title: 'Lesen auf REZICS: eine Bibliothek, die jede Ausgabe kennt',
      description:
        'Leseverlauf importieren, Ausgaben und erneutes Lesen bewahren, Besitz und Ausleihen verwalten und alles jederzeit exportieren. Deine Bibliothek kommt mit.',
    },
    hero: {
      title: 'Eine Bibliothek, die jede Ausgabe kennt.',
      lede: 'Dein Taschenbuch, das im Zug beendete E-Book, das Hörbuch für die zweite Hälfte und das Bibliotheksbuch, das Freitag fällig ist. REZICS hält fest, wie du dieselbe Geschichte gelesen hast. Den ganzen Verlauf kannst du mitnehmen.',
    },
    story: {
      title: 'Umziehen, ohne von vorn anzufangen.',
      lede: 'Jahre voller Leseerinnerungen kommen mit, Ausgabe für Ausgabe.',
      steps: {
        upload: {
          title: 'Bring deine Exportdatei mit.',
          body: 'Lade die Datei aus Goodreads, StoryGraph oder deiner Tabelle hoch. In deiner Bibliothek ändert sich nichts ohne dein Okay.',
        },
        match: {
          title: 'Jedes Buch findet seine Ausgabe.',
          body: 'Jede Zeile wird deiner gelesenen Ausgabe zugeordnet. Sehen zwei gleich aus, etwa das Taschenbuch von 2019 und die Neuauflage von 2021, entscheidest du. REZICS rät nie nur anhand des Titels.',
        },
        preview: {
          title: 'Vorher sehen, was nicht mitkommt.',
          body: 'Die Vorschau zeigt vor dem Anwenden jede nicht zugeordnete Zeile und jedes Feld, das die Quelle nicht abbilden konnte. Nichts verschwindet unbemerkt.',
        },
        resume: {
          title: 'Dort weiterlesen, wo du warst.',
          body: 'Aktuelle Bücher kommen mit Seitenzahl, Prozent oder Minute an. Erneutes Lesen und beiseitegelegte Bücher behalten ihren Verlauf.',
        },
      },
    },
    showcase: {
      title: 'Lesen, wie es wirklich ist.',
      lede: 'Lesen verläuft selten geradlinig. Der Verlauf sollte das ehrlich abbilden.',
      tiles: {
        formats: {
          title: 'Einmal lesen, mehrere Formate',
          body: 'Gedruckt anfangen, als Hörbuch beenden, einmal zählen.',
        },
        rereads: {
          title: 'Noch mal lesen oder beiseitelegen',
          body: 'Jedes erneute Lesen bekommt einen eigenen Verlauf. Ein beiseitegelegtes Buch ist eine Pause, kein Scheitern.',
        },
        copies: {
          title: 'Besitz, Ausleihe, Rückgabe',
          body: 'Exemplare und Ausleihen werden getrennt vom Leseverlauf geführt.',
        },
        notes: {
          title: 'Notizen zur Textstelle',
          body: 'Private Notizen an der genauen Stelle der jeweiligen Ausgabe.',
        },
        reviews: {
          title: 'Bewertungen mit klarem Bezug',
          body: 'Geschichte, Übersetzung und Lesung einzeln bewerten.',
        },
        export: {
          title: 'Alles mitnehmen',
          body: 'Die ganze Bibliothek exportieren, mit Notizen und Daten.',
        },
      },
    },
    compare: {
      title: 'Ein Leseverlauf, der den Umzug übersteht.',
      lede: 'In viele Bibliotheken kommt man leicht hinein, aber schwer wieder heraus.',
      today: 'Heute',
      rezics: 'Auf REZICS',
      rows: {
        editions: {
          today: 'Jede Ausgabe ein eigenes Buch, Rezensionen verstreut',
          rezics: 'Eine Geschichte, ihre Ausgaben unterscheidbar und verbunden',
        },
        rereads: {
          today: 'Erneutes Lesen überschreibt das erste',
          rezics: 'Jeder Durchgang ein eigener Verlauf',
        },
        export: {
          today: 'Beim Export fehlen Notizen und Daten',
          rezics: 'Vollständig exportieren und wieder importieren',
        },
        sync: {
          today: 'Nach jedem Kapitel drei Apps aktualisieren',
          rezics: 'Ein Verlauf, den deine Tools erreichen',
        },
      },
    },
    statement: {
      text: 'Dein Leseleben ist es wert, bewahrt zu werden.',
      body: 'Alles, was du auf REZICS festhältst, kannst du jederzeit vollständig mitnehmen.',
    },
    ledger: {
      title: 'Lesen auf REZICS',
    },
    cta: {
      title: 'Bring deine Bibliothek zum Start mit.',
      body: 'Hinterlasse deine E-Mail-Adresse. Wir schreiben dir einmal, wenn die Registrierung öffnet.',
    },
  },
  fr: {
    meta: {
      title: 'Lire sur REZICS : une bibliothèque qui connaît chaque édition',
      description:
        'Importez votre historique, gardez éditions et relectures, suivez vos achats et emprunts, puis exportez tout quand vous voulez. Votre bibliothèque vous accompagne.',
    },
    hero: {
      title: 'Une bibliothèque qui connaît chaque édition.',
      lede: 'Le poche sur votre étagère, l’ebook fini dans le train, le livre audio pris en cours de route, l’emprunt à rendre vendredi. REZICS les réunit comme une même histoire lue à votre façon, avec un historique que vous pouvez emporter en entier.',
    },
    story: {
      title: 'Changez de bibliothèque, sans repartir de zéro.',
      lede: 'Des années de lecture vous suivent, édition par édition.',
      steps: {
        upload: {
          title: 'Apportez votre fichier d’export.',
          body: 'Déposez votre fichier Goodreads, StoryGraph ou votre tableur. Rien ne change dans votre bibliothèque sans votre accord.',
        },
        match: {
          title: 'Chaque livre retrouve son édition.',
          body: 'Chaque ligne est rapprochée de l’édition lue. Si deux se ressemblent, comme le poche de 2019 et sa réédition de 2021, vous choisissez. REZICS ne se fie jamais au seul titre.',
        },
        preview: {
          title: 'Voyez ce qui ne sera pas repris.',
          body: 'Avant toute modification, l’aperçu liste les lignes sans correspondance et les champs que le format source ne pouvait pas représenter. Rien ne disparaît en silence.',
        },
        resume: {
          title: 'Reprenez là où vous en étiez.',
          body: 'Vos lectures en cours gardent leur page, pourcentage ou minute. Relectures et livres mis de côté conservent leur historique.',
        },
      },
    },
    showcase: {
      title: 'La lecture, telle qu’elle se vit.',
      lede: 'On ne lit pas toujours en ligne droite. L’historique doit le refléter.',
      tiles: {
        formats: {
          title: 'Une lecture, plusieurs formats',
          body: 'Commencez sur papier, terminez en audio : une seule lecture.',
        },
        rereads: {
          title: 'Relire ou mettre de côté',
          body: 'Chaque relecture a son propre parcours. Un livre mis de côté reste une pause, pas un échec.',
        },
        copies: {
          title: 'Achats, emprunts, retours',
          body: 'Exemplaires et prêts restent distincts de votre historique de lecture.',
        },
        notes: {
          title: 'Des notes au fil du texte',
          body: 'Des notes privées liées à l’édition et au passage exact.',
        },
        reviews: {
          title: 'Des avis qui précisent leur sujet',
          body: 'Histoire, traduction et narration évaluées séparément.',
        },
        export: {
          title: 'Tout emporter',
          body: 'Exportez toute la bibliothèque, notes et dates comprises.',
        },
      },
    },
    compare: {
      title: 'Un historique qui résiste au déménagement.',
      lede: 'Dans beaucoup de bibliothèques, il est facile d’entrer et difficile de partir.',
      today: 'Aujourd’hui',
      rezics: 'Sur REZICS',
      rows: {
        editions: {
          today: 'Des éditions séparées, des avis dispersés',
          rezics: 'Une histoire, des éditions distinctes et réunies',
        },
        rereads: {
          today: 'La relecture écrase la première lecture',
          rezics: 'Un parcours pour chaque lecture',
        },
        export: {
          today: 'Un export qui perd notes et dates',
          rezics: 'Un export complet, réimportable',
        },
        sync: {
          today: 'Trois applications à mettre à jour par chapitre',
          rezics: 'Un même historique accessible depuis vos outils',
        },
      },
    },
    statement: {
      text: 'Votre vie de lecteur mérite d’être conservée.',
      body: 'Tout ce que vous consignez sur REZICS peut partir avec vous, en entier, quand vous voulez.',
    },
    ledger: {
      title: 'Lire sur REZICS',
    },
    cta: {
      title: 'Venez avec votre bibliothèque dès l’ouverture.',
      body: 'Laissez votre adresse e-mail. Nous vous écrirons une seule fois, à l’ouverture des inscriptions.',
    },
  },
  es: {
    meta: {
      title: 'Leer en REZICS: una biblioteca que recuerda cada edición',
      description:
        'Importa tu historial, conserva ediciones y relecturas, lleva el control de tus libros y préstamos y expórtalo todo cuando quieras. Tu biblioteca te acompaña.',
    },
    hero: {
      title: 'Una biblioteca que recuerda cada edición.',
      lede: 'El libro de bolsillo que tienes, el ebook que terminaste en el tren, el audiolibro al que cambiaste a mitad y el préstamo que vence el viernes. REZICS los reúne como una historia leída a tu manera y te deja llevarte todo el registro.',
    },
    story: {
      title: 'Múdate sin empezar de cero.',
      lede: 'Años de lecturas se vienen contigo, edición por edición.',
      steps: {
        upload: {
          title: 'Trae tu archivo de exportación.',
          body: 'Sube el archivo de Goodreads, StoryGraph o tu hoja de cálculo. Nada cambia en tu biblioteca hasta que lo confirmes.',
        },
        match: {
          title: 'Cada libro encuentra su edición.',
          body: 'Cada fila se vincula con la edición que leíste. Si dos se parecen, como el bolsillo de 2019 y su reedición de 2021, tú eliges. REZICS nunca adivina solo por el título.',
        },
        preview: {
          title: 'Revisa qué no se podrá trasladar.',
          body: 'Antes de aplicar nada, la vista previa muestra cada fila sin correspondencia y cada campo que el formato de origen no podía representar. Nada desaparece sin aviso.',
        },
        resume: {
          title: 'Retoma donde lo dejaste.',
          body: 'Tus lecturas actuales llegan con su página, porcentaje o minuto. Las relecturas y los libros aparcados conservan su historial.',
        },
      },
    },
    showcase: {
      title: 'La lectura tal como ocurre.',
      lede: 'Leer no siempre sigue un orden. El registro debe reflejarlo.',
      tiles: {
        formats: {
          title: 'Una lectura, varios formatos',
          body: 'Empieza en papel, termina en audio y cuenta una sola lectura.',
        },
        rereads: {
          title: 'Relecturas y libros aparcados',
          body: 'Cada relectura tiene su propio registro. Un libro aparcado queda aparcado, no cuenta como un fracaso.',
        },
        copies: {
          title: 'En propiedad, prestado, por devolver',
          body: 'Los ejemplares y préstamos se gestionan aparte de lo que has leído.',
        },
        notes: {
          title: 'Notas sobre el pasaje',
          body: 'Notas privadas vinculadas a la edición y al punto exacto.',
        },
        reviews: {
          title: 'Reseñas que aclaran qué valoran',
          body: 'Valora por separado la historia, la traducción y la narración.',
        },
        export: {
          title: 'Llévatelo todo',
          body: 'Exporta toda la biblioteca, incluidas notas y fechas.',
        },
      },
    },
    compare: {
      title: 'Un historial que sobrevive a la mudanza.',
      lede: 'Muchas bibliotecas facilitan entrar, pero complican salir.',
      today: 'Hoy',
      rezics: 'En REZICS',
      rows: {
        editions: {
          today: 'Cada edición como libro distinto, reseñas dispersas',
          rezics: 'Una historia, con sus ediciones diferenciadas y reunidas',
        },
        rereads: {
          today: 'La relectura borra la primera lectura',
          rezics: 'Un registro por cada lectura',
        },
        export: {
          today: 'Exportaciones que pierden notas y fechas',
          rezics: 'Una exportación completa que puedes volver a importar',
        },
        sync: {
          today: 'Actualizar tres apps después de cada capítulo',
          rezics: 'Un registro accesible desde tus herramientas',
        },
      },
    },
    statement: {
      text: 'Tu vida lectora merece conservarse.',
      body: 'Todo lo que registres en REZICS puede irse contigo, completo, cuando quieras.',
    },
    ledger: {
      title: 'Leer en REZICS',
    },
    cta: {
      title: 'Trae tu biblioteca desde el primer día.',
      body: 'Deja tu correo y te escribiremos una sola vez, cuando se abra el registro.',
    },
  },
});
