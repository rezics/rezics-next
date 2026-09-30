import { defineCopy } from '../define.ts';
import type { LinePageCopy } from './page.ts';

export const trust = defineCopy<LinePageCopy>({
  en: {
    meta: {
      title: 'Trust on REZICS: suitability, AI disclosure, safety and your data',
      description:
        'Separate choices for teen, sexual and grotesque material, declared AI use, reporting and appeals for everyone, fast action on the worst harms, no trackers and data you can take with you.',
    },
    hero: {
      title: 'You decide what you see. You keep what you make.',
      lede: 'Suitability is a set of separate choices, never a guess. AI use is declared, not hidden. Anyone can report a problem, every decision can be appealed, and your drafts, reading and library stay yours.',
    },
    story: {
      title: 'What happens when something goes wrong.',
      lede: 'A report, from the moment it is filed to its decision.',
      steps: {
        report: {
          title: 'Anyone can report.',
          body: 'Signed in or not, from any page. You get a private link to follow the case.',
        },
        review: {
          title: 'A person reviews the evidence.',
          body: 'Automated checks can flag, but a person decides, with the reported passage in front of them.',
        },
        decide: {
          title: 'The decision comes with its reason.',
          body: 'Which rule applied and what changed, stated plainly to the people involved.',
        },
        appeal: {
          title: 'Every decision can be appealed.',
          body: 'An appeal is reviewed again, and the outcome is recorded with the case.',
        },
      },
    },
    showcase: {
      title: 'The commitments behind it.',
      lede: 'The rules REZICS holds itself to.',
      tiles: {
        suitability: {
          title: 'Suitability you control',
          body: 'Teen, sexual and grotesque material are separate choices; unrated is never shown as general.',
        },
        ai: {
          title: 'AI use, declared',
          body: 'Prose, art and translations say whether AI helped and whether a person reviewed it.',
        },
        training: {
          title: 'Not training data',
          body: 'Private drafts and reading records stay out of training unless you opt in.',
        },
        trackers: {
          title: 'No trackers',
          body: 'No advertising trackers and no third-party analytics.',
        },
        export: {
          title: 'Your data leaves with you',
          body: 'Library, notes and drafts export whole.',
        },
        safety: {
          title: 'The worst harms first',
          body: 'Known abuse imagery blocked at upload; intimate images shared without consent removed within 48 hours.',
        },
      },
    },
    compare: {
      title: 'Trust you can check.',
      lede: 'Safety and honesty are rules you can read, not moods.',
      today: 'Today',
      rezics: 'On REZICS',
      rows: {
        ratings: {
          today: 'Unrated content shown as suitable for everyone',
          rezics: 'Unrated stays unrated until assessed',
        },
        ai: {
          today: 'AI-written text passed off as human',
          rezics: 'AI use declared and filterable',
        },
        detectors: {
          today: 'An AI detector treated as proof',
          rezics: 'People decide, detectors never do',
        },
        appeals: {
          today: 'Bans without a reason or an appeal',
          rezics: 'A reason for every decision, an appeal for every case',
        },
      },
    },
    statement: {
      text: 'Safety is not a setting. It is how every page is served.',
      body: 'Suitability, spoilers, privacy and blocks are checked by the server for every page, search result, notification and export, not hidden in the browser.',
    },
    ledger: {
      title: 'Trust on REZICS',
    },
    cta: {
      title: 'Hear when registration opens.',
      body: 'Leave your email and we will write once. We keep your address and language for that alone.',
    },
  },
  'zh-Hant': {
    meta: {
      title: '信任 REZICS：內容分級、AI 揭露、安全與你的資料',
      description:
        '青少年、性與獵奇內容分開選擇，AI 使用明確揭露，人人可檢舉與申訴，優先處理嚴重傷害。不設追蹤器，資料隨時帶得走。',
    },
    hero: {
      title: '看什麼由你決定，創作始終屬於你。',
      lede: '各類內容分開選擇，不靠猜測。AI 使用明確揭露，不藏起來。任何人都能檢舉問題，每項決定都能申訴，你的草稿、閱讀紀錄與書庫始終屬於你。',
    },
    story: {
      title: '出問題時，會怎麼處理。',
      lede: '一件檢舉，從送出到作成決定。',
      steps: {
        report: {
          title: '任何人都能檢舉。',
          body: '不論是否登入，都能從任何頁面檢舉，並取得私人連結追蹤案件。',
        },
        review: {
          title: '由人檢視證據。',
          body: '自動檢查可以標記問題，但會由人看著遭檢舉的段落，作出決定。',
        },
        decide: {
          title: '決定，一定附上理由。',
          body: '適用哪條規則、做了哪些處理，都向當事人清楚說明。',
        },
        appeal: {
          title: '每項決定都能申訴。',
          body: '申訴會重新審查，結果也記錄在案件中。',
        },
      },
    },
    showcase: {
      title: '背後的承諾。',
      lede: 'REZICS 對自己訂下的規則。',
      tiles: {
        suitability: {
          title: '內容尺度，自己掌握',
          body: '青少年、性與獵奇內容分開選擇；未分級絕不當作普遍級顯示。',
        },
        ai: {
          title: 'AI 使用，明確揭露',
          body: '文字、圖像與翻譯，標明是否使用 AI，以及是否經過人工審核。',
        },
        training: {
          title: '不是訓練資料',
          body: '除非你主動同意，私人草稿與閱讀紀錄不會拿來訓練。',
        },
        trackers: {
          title: '沒有追蹤器',
          body: '沒有廣告追蹤器，也沒有第三方分析工具。',
        },
        export: {
          title: '資料，隨你帶走',
          body: '書庫、筆記與草稿，都能完整匯出。',
        },
        safety: {
          title: '最嚴重的傷害，優先處理',
          body: '已知虐待影像在上傳時攔截；未經同意散布的私密影像，在 48 小時內移除。',
        },
      },
    },
    compare: {
      title: '信任，有據可查。',
      lede: '安全與誠實，是看得見的規則，不是看心情。',
      today: '目前的做法',
      rezics: '在 REZICS',
      rows: {
        ratings: {
          today: '未分級內容被當作適合所有人',
          rezics: '未評估之前，未分級就是未分級',
        },
        ai: {
          today: 'AI 寫的文字，假裝是人寫的',
          rezics: 'AI 使用有揭露，也能依此篩選',
        },
        detectors: {
          today: '把 AI 偵測器的結果當證據',
          rezics: '由人決定，不由偵測器裁定',
        },
        appeals: {
          today: '封鎖沒有理由，也無法申訴',
          rezics: '每項決定附理由，每個案件可申訴',
        },
      },
    },
    statement: {
      text: '安全不只是設定，而是每個頁面的運作方式。',
      body: '每個頁面、搜尋結果、通知與匯出，伺服器都會檢查內容分級、暴雷、隱私與封鎖規則，不只是瀏覽器把內容藏起來。',
    },
    ledger: {
      title: '信任 REZICS',
    },
    cta: {
      title: '開放註冊時，收到通知。',
      body: '留下電子郵件，我們只通知一次。你的地址與語言，只為這個用途保存。',
    },
  },
  'zh-Hans': {
    meta: {
      title: '信任 REZICS：内容分级、AI 披露、安全与你的数据',
      description:
        '青少年、性与猎奇内容分开选择，AI 使用明确披露，人人可举报与申诉，优先处理严重伤害。不设跟踪器，数据随时带得走。',
    },
    hero: {
      title: '看什么由你决定，创作始终属于你。',
      lede: '各类内容分开选择，不靠猜测。AI 使用明确披露，不藏起来。任何人都能举报问题，每项决定都能申诉，你的草稿、阅读记录与书库始终属于你。',
    },
    story: {
      title: '出问题时，会怎么处理。',
      lede: '一件举报，从提交到作出决定。',
      steps: {
        report: {
          title: '任何人都能举报。',
          body: '无论是否登录，都能从任何页面举报，并获得私密链接跟进案件。',
        },
        review: {
          title: '由人查看证据。',
          body: '自动检查可以标记问题，但会由人看着被举报的段落，作出决定。',
        },
        decide: {
          title: '决定，一定附上理由。',
          body: '适用哪条规则、做了哪些处理，都向当事人清楚说明。',
        },
        appeal: {
          title: '每项决定都能申诉。',
          body: '申诉会重新审查，结果也记录在案件中。',
        },
      },
    },
    showcase: {
      title: '背后的承诺。',
      lede: 'REZICS 对自己定下的规则。',
      tiles: {
        suitability: {
          title: '内容尺度，自己掌握',
          body: '青少年、性与猎奇内容分开选择；未分级绝不当作全年龄内容显示。',
        },
        ai: {
          title: 'AI 使用，明确披露',
          body: '文字、图像与翻译，注明是否使用 AI，以及是否经过人工审核。',
        },
        training: {
          title: '不是训练数据',
          body: '除非你主动同意，私人草稿与阅读记录不会拿来训练。',
        },
        trackers: {
          title: '没有跟踪器',
          body: '没有广告跟踪器，也没有第三方分析工具。',
        },
        export: {
          title: '数据，随你带走',
          body: '书库、笔记与草稿，都能完整导出。',
        },
        safety: {
          title: '最严重的伤害，优先处理。',
          body: '已知虐待影像在上传时拦截；未经同意传播的私密影像，在 48 小时内移除。',
        },
      },
    },
    compare: {
      title: '信任，有据可查。',
      lede: '安全与诚实，是看得见的规则，不是看心情。',
      today: '目前的做法',
      rezics: '在 REZICS',
      rows: {
        ratings: {
          today: '未分级内容被当作适合所有人',
          rezics: '未评估之前，未分级就是未分级',
        },
        ai: {
          today: 'AI 写的文字，假装是人写的',
          rezics: 'AI 使用有披露，也能据此筛选',
        },
        detectors: {
          today: '把 AI 检测器的结果当证据',
          rezics: '由人决定，不由检测器裁定',
        },
        appeals: {
          today: '封禁没有理由，也无法申诉',
          rezics: '每项决定附理由，每个案件可申诉',
        },
      },
    },
    statement: {
      text: '安全不只是设置，而是每个页面的运行方式。',
      body: '每个页面、搜索结果、通知与导出，服务器都会检查内容分级、剧透、隐私与屏蔽规则，不只是浏览器把内容藏起来。',
    },
    ledger: {
      title: '信任 REZICS',
    },
    cta: {
      title: '开放注册时，收到通知。',
      body: '留下电子邮箱，我们只通知一次。你的地址与语言，只为这个用途保存。',
    },
  },
  ja: {
    meta: {
      title: 'REZICSの信頼：閲覧設定、AI表示、安全とデータ',
      description:
        '青少年向け・性的・グロテスクな内容を別々に設定。AI利用を明記し、誰でも通報・異議申し立てができます。深刻な被害への迅速な対応、追跡なし、持ち出せるデータを。',
    },
    hero: {
      title: '何を見るかは自分で決める。作ったものは自分の手に。',
      lede: '閲覧する内容は種類ごとに選び、勝手に判断されません。AI利用は隠さず明記。誰でも問題を通報でき、どの判断にも異議を申し立てられます。草稿、読書履歴、ライブラリはあなたのものです。',
    },
    story: {
      title: '問題が起きたら、どう進むか。',
      lede: '通報の提出から、判断が出るまで。',
      steps: {
        report: {
          title: '誰でも通報できる。',
          body: 'ログインの有無を問わず、どのページからでも通報できます。案件を確認するための非公開リンクを受け取れます。',
        },
        review: {
          title: '人が証拠を確かめる。',
          body: '自動検査は注意を促せますが、通報された箇所を読んだ人が判断します。',
        },
        decide: {
          title: '判断には、理由を添える。',
          body: '適用したルールと変更内容を、当事者にわかりやすく説明します。',
        },
        appeal: {
          title: 'どの判断にも、異議を申し立てられる。',
          body: '異議申し立ては改めて審査し、結果を案件に記録します。',
        },
      },
    },
    showcase: {
      title: 'その仕組みを支える約束。',
      lede: 'REZICS自身が守るルールです。',
      tiles: {
        suitability: {
          title: '見る内容を自分で選ぶ',
          body: '青少年向け・性的・グロテスクな内容を別々に選択。未分類を全年齢向けとしては扱いません。',
        },
        ai: {
          title: 'AI利用を明記',
          body: '文章、絵、翻訳に、AIを使ったか、人が確認したかを表示します。',
        },
        training: {
          title: '学習データにしない',
          body: '明示的な同意がない限り、非公開の草稿や読書履歴を学習に使いません。',
        },
        trackers: {
          title: 'トラッカーなし',
          body: '広告トラッカーも、第三者のアクセス解析もありません。',
        },
        export: {
          title: 'データは、あなたと一緒に',
          body: 'ライブラリ、メモ、草稿を丸ごと書き出せます。',
        },
        safety: {
          title: '深刻な被害から先に対処',
          body: '既知の虐待画像はアップロード時に遮断。同意なく共有された私的な性的画像は48時間以内に削除します。',
        },
      },
    },
    compare: {
      title: '確かめられる信頼。',
      lede: '安全と誠実さは気分次第ではなく、読んで確かめられるルールです。',
      today: '今のやり方',
      rezics: 'REZICSなら',
      rows: {
        ratings: {
          today: '未分類を誰でも見られる内容として表示',
          rezics: '評価するまで、未分類は未分類のまま',
        },
        ai: {
          today: 'AI文章を人が書いたと偽る',
          rezics: 'AI利用を明記し、絞り込みも可能',
        },
        detectors: {
          today: 'AI検出結果を証拠扱い',
          rezics: '判断するのは人、検出器ではない',
        },
        appeals: {
          today: '理由も異議の手段もない利用停止',
          rezics: 'すべての判断に理由、すべての案件に異議の手段',
        },
      },
    },
    statement: {
      text: '安全は設定だけではなく、すべてのページの仕組みに。',
      body: 'ページ、検索結果、通知、書き出しのすべてで、サーバーが閲覧設定、ネタバレ、プライバシー、ブロックを確認します。ブラウザで隠すだけではありません。',
    },
    ledger: {
      title: 'REZICSの信頼',
    },
    cta: {
      title: '登録開始のお知らせを受け取る。',
      body: 'メールアドレスを残していただければ、一度だけお知らせします。アドレスと言語はそのためだけに保管します。',
    },
  },
  ko: {
    meta: {
      title: 'REZICS 신뢰: 콘텐츠 설정, AI 공개, 안전과 내 데이터',
      description:
        '청소년·성적·혐오감을 주는 콘텐츠를 각각 설정하고 AI 사용을 공개합니다. 누구나 신고와 이의 제기를 할 수 있으며 심각한 피해부터 신속히 대응합니다. 추적기는 없고 데이터는 가져갈 수 있습니다.',
    },
    hero: {
      title: '볼 것은 직접 정하고, 만든 것은 간직하세요.',
      lede: '콘텐츠 유형별로 직접 선택하며 추측으로 정하지 않습니다. AI 사용은 숨기지 않고 공개합니다. 누구나 문제를 신고하고 모든 결정에 이의를 제기할 수 있습니다. 초고, 독서 기록, 서재는 계속 내 것입니다.',
    },
    story: {
      title: '문제가 생기면 어떻게 처리할까요.',
      lede: '신고 접수부터 결정까지.',
      steps: {
        report: {
          title: '누구나 신고할 수 있습니다.',
          body: '로그인 여부와 관계없이 어느 페이지에서나 신고할 수 있습니다. 사건을 확인할 비공개 링크를 받습니다.',
        },
        review: {
          title: '사람이 근거를 검토합니다.',
          body: '자동 검사는 문제를 표시할 수 있지만, 신고된 구절을 보고 사람이 결정합니다.',
        },
        decide: {
          title: '결정에는 이유가 따릅니다.',
          body: '어떤 규칙을 적용했고 무엇을 바꿨는지 당사자에게 분명히 설명합니다.',
        },
        appeal: {
          title: '모든 결정에 이의를 제기할 수 있습니다.',
          body: '이의 제기는 다시 검토하며 결과를 사건 기록에 남깁니다.',
        },
      },
    },
    showcase: {
      title: '이 모든 것을 뒷받침하는 약속.',
      lede: 'REZICS가 스스로 지키는 규칙입니다.',
      tiles: {
        suitability: {
          title: '콘텐츠 범위를 직접 설정',
          body: '청소년·성적·혐오감을 주는 콘텐츠를 각각 선택합니다. 미분류를 일반 콘텐츠로 표시하지 않습니다.',
        },
        ai: {
          title: 'AI 사용 공개',
          body: '글, 그림, 번역에 AI 도움 여부와 사람의 검토 여부를 표시합니다.',
        },
        training: {
          title: '학습 데이터로 쓰지 않기',
          body: '직접 동의하지 않는 한 비공개 초고와 독서 기록은 학습에 쓰지 않습니다.',
        },
        trackers: {
          title: '추적기 없음',
          body: '광고 추적기와 외부 분석 도구를 사용하지 않습니다.',
        },
        export: {
          title: '데이터는 나와 함께',
          body: '서재, 메모, 초고를 온전히 내보냅니다.',
        },
        safety: {
          title: '심각한 피해부터 대응',
          body: '알려진 학대 이미지는 업로드 시 차단하고, 동의 없이 공유된 사적 성적 이미지는 48시간 이내에 삭제합니다.',
        },
      },
    },
    compare: {
      title: '확인할 수 있는 신뢰.',
      lede: '안전과 정직은 기분에 따라 달라지는 말이 아니라 읽고 확인할 수 있는 규칙입니다.',
      today: '지금은',
      rezics: 'REZICS에서는',
      rows: {
        ratings: {
          today: '미분류를 모두에게 적합한 콘텐츠로 표시',
          rezics: '평가 전까지 미분류는 미분류로 유지',
        },
        ai: {
          today: 'AI 글을 사람이 쓴 것처럼 제시',
          rezics: 'AI 사용 공개와 필터링',
        },
        detectors: {
          today: 'AI 탐지 결과를 증거로 취급',
          rezics: '결정은 사람이, 탐지기는 판단하지 않음',
        },
        appeals: {
          today: '이유도 이의 제기도 없는 이용 정지',
          rezics: '모든 결정에 이유, 모든 사건에 이의 제기',
        },
      },
    },
    statement: {
      text: '안전은 설정 하나가 아니라 모든 페이지가 작동하는 방식입니다.',
      body: '페이지, 검색 결과, 알림, 내보내기마다 서버가 콘텐츠 설정, 스포일러, 개인정보, 차단을 확인합니다. 브라우저에서 가리기만 하지 않습니다.',
    },
    ledger: {
      title: 'REZICS 신뢰',
    },
    cta: {
      title: '가입 시작 소식을 받아 보세요.',
      body: '이메일을 남겨 주시면 한 번만 알려 드립니다. 주소와 언어는 그 용도로만 보관합니다.',
    },
  },
  de: {
    meta: {
      title: 'Vertrauen auf REZICS: Inhalte, KI-Kennzeichnung, Sicherheit und Daten',
      description:
        'Inhalte getrennt wählen, KI-Nutzung erkennen, melden und Einspruch einlegen. Schwere Schäden zuerst angehen, keine Tracker, Daten zum Mitnehmen.',
    },
    hero: {
      title: 'Du bestimmst, was du siehst. Du behältst, was du schaffst.',
      lede: 'Welche Inhalte passen, entscheidest du getrennt nach Kategorien. KI-Nutzung wird offengelegt. Jeder kann Probleme melden und gegen Entscheidungen Einspruch erheben. Entwürfe, Leseverlauf und Bibliothek bleiben deine.',
    },
    story: {
      title: 'Was passiert, wenn etwas schiefläuft.',
      lede: 'Eine Meldung, vom Eingang bis zur Entscheidung.',
      steps: {
        report: {
          title: 'Jeder kann melden.',
          body: 'Angemeldet oder nicht, von jeder Seite aus. Du erhältst einen privaten Link zum Fall.',
        },
        review: {
          title: 'Ein Mensch prüft die Belege.',
          body: 'Automatische Prüfungen können markieren. Entscheiden wird ein Mensch, der die gemeldete Passage vor sich hat.',
        },
        decide: {
          title: 'Jede Entscheidung mit Begründung.',
          body: 'Welche Regel galt und was geändert wurde, erfahren die Beteiligten klar und verständlich.',
        },
        appeal: {
          title: 'Gegen jede Entscheidung Einspruch erheben.',
          body: 'Ein Einspruch wird erneut geprüft, das Ergebnis im Fall festgehalten.',
        },
      },
    },
    showcase: {
      title: 'Die Zusagen dahinter.',
      lede: 'Die Regeln, an die REZICS sich selbst hält.',
      tiles: {
        suitability: {
          title: 'Inhalte selbst auswählen',
          body: 'Jugendliche, sexuelle und groteske Inhalte getrennt wählen. Unbewertet wird nie als allgemein geeignet angezeigt.',
        },
        ai: {
          title: 'KI-Nutzung offenlegen',
          body: 'Texte, Bilder und Übersetzungen nennen KI-Einsatz und menschliche Prüfung.',
        },
        training: {
          title: 'Keine Trainingsdaten',
          body: 'Private Entwürfe und Leseverläufe bleiben ohne ausdrückliche Zustimmung aus dem Training.',
        },
        trackers: {
          title: 'Keine Tracker',
          body: 'Keine Werbetracker und keine Analyse durch Dritte.',
        },
        export: {
          title: 'Deine Daten kommen mit',
          body: 'Bibliothek, Notizen und Entwürfe vollständig exportieren.',
        },
        safety: {
          title: 'Schwere Schäden zuerst',
          body: 'Bekannte Missbrauchsbilder beim Upload blockiert; ohne Einwilligung geteilte intime Bilder binnen 48 Stunden entfernt.',
        },
      },
    },
    compare: {
      title: 'Vertrauen, das sich prüfen lässt.',
      lede: 'Sicherheit und Ehrlichkeit stehen in lesbaren Regeln, nicht im Belieben Einzelner.',
      today: 'Heute',
      rezics: 'Auf REZICS',
      rows: {
        ratings: {
          today: 'Unbewertete Inhalte als allgemein geeignet',
          rezics: 'Unbewertet bleibt unbewertet bis zur Prüfung',
        },
        ai: {
          today: 'KI-Texte als menschlich ausgegeben',
          rezics: 'KI-Einsatz gekennzeichnet und filterbar',
        },
        detectors: {
          today: 'KI-Detektoren als Beweis behandelt',
          rezics: 'Menschen entscheiden, niemals Detektoren',
        },
        appeals: {
          today: 'Sperren ohne Begründung oder Einspruch',
          rezics: 'Jede Entscheidung begründet, jeder Fall anfechtbar',
        },
      },
    },
    statement: {
      text: 'Sicherheit ist mehr als eine Einstellung: Sie gehört zu jeder Seite.',
      body: 'Für jede Seite, Suche, Benachrichtigung und jeden Export prüft der Server Inhaltseignung, Spoiler, Privatsphäre und Blockierungen. Der Browser versteckt nicht bloß etwas.',
    },
    ledger: {
      title: 'Vertrauen auf REZICS',
    },
    cta: {
      title: 'Erfahre, wann die Registrierung öffnet.',
      body: 'Hinterlasse deine E-Mail-Adresse, wir schreiben dir einmal. Adresse und Sprache speichern wir allein dafür.',
    },
  },
  fr: {
    meta: {
      title: 'Confiance sur REZICS : contenus, déclaration d’IA, sécurité et données',
      description:
        'Choix distincts pour les contenus ados, sexuels et dérangeants, IA déclarée, signalements et recours pour tous, réponse aux préjudices graves, sans traceurs et avec des données portables.',
    },
    hero: {
      title: 'Vous choisissez ce que vous voyez. Vous gardez ce que vous créez.',
      lede: 'Vous choisissez les contenus par critères distincts, sans supposition. L’usage de l’IA est déclaré. Tout le monde peut signaler un problème, toute décision peut être contestée. Brouillons, lectures et bibliothèque restent à vous.',
    },
    story: {
      title: 'Quand quelque chose ne va pas.',
      lede: 'Un signalement, de son dépôt à la décision.',
      steps: {
        report: {
          title: 'Tout le monde peut signaler.',
          body: 'Connecté ou non, depuis toute page. Un lien privé permet de suivre le dossier.',
        },
        review: {
          title: 'Une personne examine les preuves.',
          body: 'Les contrôles automatiques peuvent alerter ; une personne décide, le passage signalé sous les yeux.',
        },
        decide: {
          title: 'La décision vient avec son motif.',
          body: 'La règle appliquée et les changements sont expliqués clairement aux personnes concernées.',
        },
        appeal: {
          title: 'Toute décision peut être contestée.',
          body: 'Le recours fait l’objet d’un nouvel examen, dont l’issue est consignée au dossier.',
        },
      },
    },
    showcase: {
      title: 'Les engagements qui soutiennent l’ensemble.',
      lede: 'Les règles que REZICS s’impose.',
      tiles: {
        suitability: {
          title: 'Des contenus selon vos choix',
          body: 'Contenus ados, sexuels et dérangeants : des choix distincts. Non classé ne signifie jamais tout public.',
        },
        ai: {
          title: 'L’usage de l’IA déclaré',
          body: 'Textes, images et traductions précisent l’aide de l’IA et la relecture humaine.',
        },
        training: {
          title: 'Pas des données d’entraînement',
          body: 'Brouillons privés et historiques de lecture sont exclus de l’entraînement, sauf accord explicite.',
        },
        trackers: {
          title: 'Aucun traceur',
          body: 'Ni traceurs publicitaires ni outils d’analyse tiers.',
        },
        export: {
          title: 'Vos données partent avec vous',
          body: 'Bibliothèque, notes et brouillons s’exportent en entier.',
        },
        safety: {
          title: 'Les préjudices les plus graves d’abord',
          body: 'Images d’abus connues bloquées à l’envoi ; images intimes partagées sans consentement retirées sous 48 heures.',
        },
      },
    },
    compare: {
      title: 'Une confiance vérifiable.',
      lede: 'Sécurité et honnêteté reposent sur des règles lisibles, pas sur l’humeur du moment.',
      today: 'Aujourd’hui',
      rezics: 'Sur REZICS',
      rows: {
        ratings: {
          today: 'Des contenus non classés présentés comme tout public',
          rezics: 'Non classé reste non classé avant évaluation',
        },
        ai: {
          today: 'Des textes d’IA présentés comme humains',
          rezics: 'Usage de l’IA déclaré et filtrable',
        },
        detectors: {
          today: 'Un détecteur d’IA pris pour preuve',
          rezics: 'Les humains décident, jamais les détecteurs',
        },
        appeals: {
          today: 'Des bannissements sans motif ni recours',
          rezics: 'Un motif par décision, un recours par dossier',
        },
      },
    },
    statement: {
      text: 'La sécurité n’est pas un réglage, elle porte chaque page.',
      body: 'Le serveur vérifie contenus, spoilers, confidentialité et blocages pour chaque page, recherche, notification et export. Il ne s’agit pas de masquer dans le navigateur.',
    },
    ledger: {
      title: 'La confiance sur REZICS',
    },
    cta: {
      title: 'Soyez prévenu à l’ouverture des inscriptions.',
      body: 'Laissez votre e-mail, nous vous écrirons une seule fois. Votre adresse et votre langue ne sont gardées que pour cela.',
    },
  },
  es: {
    meta: {
      title: 'Confianza en REZICS: contenidos, declaración de IA, seguridad y datos',
      description:
        'Opciones separadas para contenido adolescente, sexual y grotesco, IA declarada, reportes y apelaciones para todos, respuesta rápida al daño grave, sin rastreadores y con datos que te llevas.',
    },
    hero: {
      title: 'Tú decides qué ves. Tú conservas lo que creas.',
      lede: 'La adecuación del contenido se elige por separado, no se adivina. Se declara el uso de IA. Cualquiera puede reportar un problema y apelar cualquier decisión. Tus borradores, lecturas y biblioteca siguen siendo tuyos.',
    },
    story: {
      title: 'Qué pasa cuando algo va mal.',
      lede: 'Un reporte, desde que se envía hasta la decisión.',
      steps: {
        report: {
          title: 'Cualquiera puede reportar.',
          body: 'Con sesión o sin ella, desde cualquier página. Recibes un enlace privado para seguir el caso.',
        },
        review: {
          title: 'Una persona examina las pruebas.',
          body: 'Los controles automáticos pueden señalar problemas, pero una persona decide con el pasaje reportado delante.',
        },
        decide: {
          title: 'La decisión viene con su motivo.',
          body: 'Se explica a las personas implicadas qué regla se aplicó y qué cambió.',
        },
        appeal: {
          title: 'Toda decisión puede apelarse.',
          body: 'La apelación se revisa de nuevo y el resultado queda registrado en el caso.',
        },
      },
    },
    showcase: {
      title: 'Los compromisos que lo sostienen.',
      lede: 'Las reglas que REZICS se exige.',
      tiles: {
        suitability: {
          title: 'El contenido lo eliges tú',
          body: 'Contenido adolescente, sexual y grotesco por separado. Lo no clasificado nunca se muestra como apto para todos.',
        },
        ai: {
          title: 'Uso de IA declarado',
          body: 'Texto, arte y traducciones indican si intervino IA y si hubo revisión humana.',
        },
        training: {
          title: 'No son datos de entrenamiento',
          body: 'Los borradores privados y las lecturas no se usan para entrenar salvo que lo autorices expresamente.',
        },
        trackers: {
          title: 'Sin rastreadores',
          body: 'Sin rastreadores publicitarios ni analítica de terceros.',
        },
        export: {
          title: 'Tus datos se van contigo',
          body: 'Biblioteca, notas y borradores se exportan completos.',
        },
        safety: {
          title: 'Primero, los daños más graves',
          body: 'Imágenes de abuso conocidas bloqueadas al subir; imágenes íntimas compartidas sin consentimiento retiradas en 48 horas.',
        },
      },
    },
    compare: {
      title: 'Confianza que puedes comprobar.',
      lede: 'La seguridad y la honestidad son reglas que puedes leer, no decisiones según el humor.',
      today: 'Hoy',
      rezics: 'En REZICS',
      rows: {
        ratings: {
          today: 'Contenido sin clasificar mostrado como apto para todos',
          rezics: 'Lo no clasificado sigue así hasta evaluarse',
        },
        ai: {
          today: 'Textos de IA que se hacen pasar por humanos',
          rezics: 'Uso de IA declarado y filtrable',
        },
        detectors: {
          today: 'Un detector de IA tratado como prueba',
          rezics: 'Deciden las personas, nunca los detectores',
        },
        appeals: {
          today: 'Bloqueos sin motivo ni apelación',
          rezics: 'Un motivo por decisión, una apelación por caso',
        },
      },
    },
    statement: {
      text: 'La seguridad no es un ajuste: es cómo se sirve cada página.',
      body: 'El servidor comprueba adecuación, spoilers, privacidad y bloqueos en cada página, búsqueda, notificación y exportación; no se limita a ocultarlos en el navegador.',
    },
    ledger: {
      title: 'Confianza en REZICS',
    },
    cta: {
      title: 'Entérate cuando se abra el registro.',
      body: 'Deja tu correo y te escribiremos una sola vez. Guardamos tu dirección e idioma solo para eso.',
    },
  },
});
