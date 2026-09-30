import { defineCopy } from '../define.ts';
import type { LinePageCopy } from './page.ts';

export const serialFiction = defineCopy<LinePageCopy>({
  en: {
    meta: {
      title: 'Serial fiction on REZICS: write chapter by chapter, read without losing your place',
      description:
        'Drafts that cannot vanish, chapters scheduled in your time zone, readers who return to the exact paragraph and discussion that never spoils what comes next.',
    },
    hero: {
      title: 'Write it chapter by chapter. Read it without losing your place.',
      lede: 'A home for stories that keep growing. Authors get a manuscript that cannot vanish and a schedule they control; readers return to the exact paragraph they left and talk about the chapter they just finished, without spoilers from the ones ahead.',
    },
    story: {
      title: 'From draft to Friday night.',
      lede: 'One chapter, from the author’s desk to a reader’s phone.',
      steps: {
        draft: {
          title: 'Write without fear.',
          body: 'Every save is a revision you can restore. Write on the train with no signal, and the chapter waits safely on your device until you reconnect.',
        },
        schedule: {
          title: 'Schedule it in your time zone.',
          body: 'Pick Friday at 20:00 where you live. You see the exact revision that will go out and when each reader will get it.',
        },
        resume: {
          title: 'Readers pick up mid-paragraph.',
          body: 'A reader who stopped halfway on their laptop opens their phone at the same paragraph, with the next chapter one tap away.',
        },
        discuss: {
          title: 'Talk about this chapter, not the next.',
          body: 'Comments anchor to paragraphs, and nobody sees a remark about a chapter they have not reached.',
        },
      },
    },
    showcase: {
      title: 'Everything a serial needs, nothing it does not.',
      lede: 'Tools for the long haul of a story told in parts.',
      tiles: {
        collaborators: {
          title: 'Bring in your editor',
          body: 'Beta readers read, editors suggest, co-authors edit; you publish.',
        },
        backup: {
          title: 'A backup that is complete',
          body: 'Revisions, notes and world, in open formats you can import again.',
        },
        ai: {
          title: 'AI use, declared honestly',
          body: 'Say whether AI helped and how, with enough levels to be true.',
        },
        world: {
          title: 'Your world beside the draft',
          body: 'Characters and places a click from the chapter that needs them.',
        },
        languages: {
          title: 'Every language, including yours',
          body: 'Write in any language; translations stay linked to the original.',
        },
      },
    },
    compare: {
      title: 'A calmer place to write and read serials.',
      lede: 'Serials are a long relationship between an author and readers. Neither should have to fight the tools.',
      today: 'Today',
      rezics: 'On REZICS',
      rows: {
        lost: {
          today: 'A lost connection, a lost chapter',
          rezics: 'Every save a revision you can restore',
        },
        schedule: {
          today: 'Publishing at midnight in someone else’s time zone',
          rezics: 'Your schedule, in your time zone',
        },
        place: {
          today: 'Scrolling to find where you stopped',
          rezics: 'Back to the exact paragraph',
        },
        spoilers: {
          today: 'Comments that spoil the next arc',
          rezics: 'Discussion that stops where you are',
        },
      },
    },
    statement: {
      text: 'Your manuscript is safe here. Your readers always know where they are.',
      body: 'Serial fiction is one of the four first scenarios: dependable drafting and scheduling for authors, calm reading and discussion for readers.',
    },
    ledger: {
      title: 'Serial fiction on REZICS',
    },
    cta: {
      title: 'Publish your first chapter on day one.',
      body: 'Leave your email and we will write once, when registration opens.',
    },
  },
  'zh-Hant': {
    meta: {
      title: 'REZICS 小說連載：一章章寫，接著上次讀',
      description:
        '不怕遺失的草稿、依自己時區排程的章節、精確回到上次段落的續讀，以及不會暴雷後續劇情的討論。',
    },
    hero: {
      title: '一章章寫下去，隨時接著讀。',
      lede: '讓故事持續生長的家。作者有不怕遺失的稿件，也能掌握發布排程；讀者回到上次讀到的確切段落，聊剛看完的章節，不被後面的劇情暴雷。',
    },
    story: {
      title: '從初稿，到週五晚上的更新。',
      lede: '一個章節，從作者書桌走到讀者手機。',
      steps: {
        draft: {
          title: '放心寫。',
          body: '每次儲存都是可還原的修訂版。在火車上沒訊號也能寫，章節會安全保存在裝置上，等你重新連線。',
        },
        schedule: {
          title: '照自己的時區排程。',
          body: '選擇你所在地的週五 20:00，就能看清楚將發布的確切版本，以及各地讀者會在什麼時間收到。',
        },
        resume: {
          title: '回到上次讀到的段落。',
          body: '筆電上讀到一半，拿起手機就能回到同一段，下一章也只要點一下。',
        },
        discuss: {
          title: '聊這一章，不暴雷下一章。',
          body: '留言對應到段落，還沒讀到的章節評論不會出現。',
        },
      },
    },
    showcase: {
      title: '連載需要的，都在這裡。',
      lede: '陪你走完長篇連載的工具。',
      tiles: {
        collaborators: {
          title: '邀編輯一起加入',
          body: '試讀者閱讀、編輯提建議、共同作者編修，發布仍由你決定。',
        },
        backup: {
          title: '完整的備份',
          body: '修訂紀錄、筆記與世界設定，以開放格式備份，也能重新匯入。',
        },
        ai: {
          title: 'AI 怎麼用，如實說明',
          body: '是否使用 AI、用在哪裡，都有足夠細緻的選項，讓你如實標示。',
        },
        world: {
          title: '草稿旁，就是你的世界',
          body: '寫到需要的角色與地點，點一下就能查閱。',
        },
        languages: {
          title: '每種語言，都包括你的',
          body: '用任何語言寫作，翻譯版本始終連著原作。',
        },
      },
    },
    compare: {
      title: '寫連載、追更新，都能更安心。',
      lede: '連載是作者與讀者的長期陪伴，不該讓工具成為雙方的負擔。',
      today: '目前的做法',
      rezics: '在 REZICS',
      rows: {
        lost: {
          today: '一斷線，整章就沒了',
          rezics: '每次儲存，都有可還原的版本',
        },
        schedule: {
          today: '配合別人的時區，半夜起床發布',
          rezics: '自己的時區，自己的排程',
        },
        place: {
          today: '一直滑動，找上次讀到哪裡',
          rezics: '直接回到同一段',
        },
        spoilers: {
          today: '留言直接暴雷下個篇章',
          rezics: '討論跟著你的進度走',
        },
      },
    },
    statement: {
      text: '稿件在這裡安心保存，讀者也永遠找得到接續的位置。',
      body: '小說連載是最初四項使用情境之一：讓作者可靠地寫作與排程，讓讀者安心閱讀與討論。',
    },
    ledger: {
      title: 'REZICS 小說連載',
    },
    cta: {
      title: '開放第一天，發布你的第一章。',
      body: '留下電子郵件，我們會在開放註冊時通知你一次。',
    },
  },
  'zh-Hans': {
    meta: {
      title: 'REZICS 小说连载：一章章写，接着上次读',
      description:
        '不怕丢失的草稿、按自己时区定时发布的章节、精确回到上次段落的续读，以及不会剧透后续剧情的讨论。',
    },
    hero: {
      title: '一章章写下去，随时接着读。',
      lede: '让故事持续生长的家。作者有不怕丢失的稿件，也能掌握发布计划；读者回到上次读到的准确段落，聊刚看完的章节，不被后面的剧情剧透。',
    },
    story: {
      title: '从初稿，到周五晚上的更新。',
      lede: '一个章节，从作者书桌走到读者手机。',
      steps: {
        draft: {
          title: '放心写。',
          body: '每次保存都是可恢复的修订版。在火车上没信号也能写，章节会安全保存在设备上，等你重新联网。',
        },
        schedule: {
          title: '按自己的时区定时发布。',
          body: '选择你所在地的周五 20:00，就能看清楚将发布的准确版本，以及各地读者会在什么时间收到。',
        },
        resume: {
          title: '回到上次读到的段落。',
          body: '电脑上读到一半，拿起手机就能回到同一段，下一章也只需点一下。',
        },
        discuss: {
          title: '聊这一章，不剧透下一章。',
          body: '评论对应到段落，还没读到的章节评论不会出现。',
        },
      },
    },
    showcase: {
      title: '连载需要的，都在这里。',
      lede: '陪你走完长篇连载的工具。',
      tiles: {
        collaborators: {
          title: '邀编辑一起加入',
          body: '试读者阅读、编辑提建议、共同作者修改，发布仍由你决定。',
        },
        backup: {
          title: '完整的备份',
          body: '修订记录、笔记与世界设定，以开放格式备份，也能重新导入。',
        },
        ai: {
          title: 'AI 怎么用，如实说明',
          body: '是否使用 AI、用在哪里，都有足够细致的选项，让你如实标注。',
        },
        world: {
          title: '草稿旁，就是你的世界',
          body: '写到需要的角色与地点，点一下就能查阅。',
        },
        languages: {
          title: '每种语言，都包括你的',
          body: '用任何语言写作，翻译版本始终连着原作。',
        },
      },
    },
    compare: {
      title: '写连载、追更，都能更安心。',
      lede: '连载是作者与读者的长期陪伴，不该让工具成为双方的负担。',
      today: '目前的做法',
      rezics: '在 REZICS',
      rows: {
        lost: {
          today: '一断网，整章就没了',
          rezics: '每次保存，都有可恢复的版本',
        },
        schedule: {
          today: '配合别人的时区，半夜起来发布',
          rezics: '自己的时区，自己的计划',
        },
        place: {
          today: '一直滚动，找上次读到哪里',
          rezics: '直接回到同一段',
        },
        spoilers: {
          today: '评论直接剧透下个篇章',
          rezics: '讨论跟着你的进度走',
        },
      },
    },
    statement: {
      text: '稿件在这里安心保存，读者也永远找得到接续的位置。',
      body: '小说连载是最初四项使用场景之一：让作者可靠地写作与定时发布，让读者安心阅读与讨论。',
    },
    ledger: {
      title: 'REZICS 小说连载',
    },
    cta: {
      title: '开放第一天，发布你的第一章。',
      body: '留下电子邮箱，我们会在开放注册时通知你一次。',
    },
  },
  ja: {
    meta: {
      title: 'REZICSの小説連載：一章ずつ書く。続きから読める。',
      description:
        '消えない草稿、自分のタイムゾーンでの予約投稿。読者は前回の段落から読み進め、その先をネタバレされずに話せます。',
    },
    hero: {
      title: '一章ずつ書く。いつでも続きから読める。',
      lede: '育ち続ける物語のための場所。書き手には消えない原稿と、自分で決められる公開予定を。読者には前回の段落に戻れる読書と、先の展開を知らされずに読み終えた章を語れる場を。',
    },
    story: {
      title: '下書きから、金曜夜の更新まで。',
      lede: 'ひとつの章が、書き手の机から読者のスマホへ。',
      steps: {
        draft: {
          title: '安心して書ける。',
          body: '保存するたびに、戻せる版が残ります。電波のない電車でも執筆でき、章は再接続まで端末に安全に保管されます。',
        },
        schedule: {
          title: '自分のタイムゾーンで予約。',
          body: '自分の場所の金曜20時を選択。公開される版と、各地の読者に届く時刻を正確に確認できます。',
        },
        resume: {
          title: '段落の途中から、続きを。',
          body: 'パソコンで途中まで読んだ人がスマホを開くと、同じ段落へ。次の章もワンタップで開けます。',
        },
        discuss: {
          title: 'この章の話を、先のネタバレなしで。',
          body: 'コメントは段落に紐づき、まだ読んでいない章の話は表示されません。',
        },
      },
    },
    showcase: {
      title: '連載に必要なものを、必要なだけ。',
      lede: '長く続く物語を支える道具。',
      tiles: {
        collaborators: {
          title: '編集者を迎える',
          body: '試読者は読み、編集者は提案し、共著者は編集。公開はあなたの手に。',
        },
        backup: {
          title: '丸ごと残せるバックアップ',
          body: '改稿履歴、メモ、世界設定を、再取り込みできるオープンな形式で保存。',
        },
        ai: {
          title: 'AIの利用を、正直に伝える',
          body: 'AIを使ったか、どう使ったか。実態に合う細かな区分で表示できます。',
        },
        world: {
          title: '原稿の隣に、世界設定を',
          body: '章に必要な人物や場所の設定へ、ワンクリック。',
        },
        languages: {
          title: 'あなたの言語も、どの言語も',
          body: 'どの言語でも書けます。翻訳は原作につながったまま。',
        },
      },
    },
    compare: {
      title: '書く人にも、追いかける人にも、落ち着ける場所を。',
      lede: '連載は書き手と読者の長い付き合い。どちらも、道具に振り回されるべきではありません。',
      today: '今のやり方',
      rezics: 'REZICSなら',
      rows: {
        lost: {
          today: '接続が切れると、章も消える',
          rezics: '保存するたび、戻せる版が残る',
        },
        schedule: {
          today: '別の地域の時刻に合わせて深夜に投稿',
          rezics: '自分の時刻で、自分の予定を',
        },
        place: {
          today: '前の位置を探してスクロール',
          rezics: '同じ段落へ、そのまま戻る',
        },
        spoilers: {
          today: 'コメントで次の展開を知ってしまう',
          rezics: '読んだところまでの議論',
        },
      },
    },
    statement: {
      text: '原稿は安全に。読者はいつも、続きがわかる。',
      body: '小説連載は最初の4つの利用シーンのひとつ。書き手には頼れる執筆と予約投稿を、読者には落ち着いて読んで話せる場を届けます。',
    },
    ledger: {
      title: 'REZICSの小説連載',
    },
    cta: {
      title: '初日から、最初の章を公開。',
      body: 'メールアドレスを残していただければ、登録開始時に一度だけお知らせします。',
    },
  },
  ko: {
    meta: {
      title: 'REZICS 웹소설: 한 화씩 쓰고, 읽던 곳에서 이어 읽기',
      description:
        '사라지지 않는 초고, 내 시간대에 맞춘 예약 발행, 읽던 문단으로 돌아가는 이어 읽기, 다음 내용을 스포일러하지 않는 토론까지.',
    },
    hero: {
      title: '한 화씩 쓰고, 읽던 곳에서 이어 읽으세요.',
      lede: '계속 자라는 이야기를 위한 공간. 작가는 원고를 잃을 걱정 없이 발행 일정을 정하고, 독자는 멈췄던 문단으로 돌아와 방금 읽은 화를 이야기합니다. 뒤에 나올 내용의 스포일러는 없이요.',
    },
    story: {
      title: '초고에서 금요일 밤의 새 화까지.',
      lede: '한 화가 작가의 책상에서 독자의 휴대폰으로 갑니다.',
      steps: {
        draft: {
          title: '안심하고 쓰세요.',
          body: '저장할 때마다 복원할 수 있는 수정본이 남습니다. 신호 없는 기차에서도 쓰세요. 다시 연결될 때까지 원고는 기기에 안전하게 보관됩니다.',
        },
        schedule: {
          title: '내 시간대에 맞춰 예약하세요.',
          body: '사는 곳의 금요일 20시로 정하세요. 발행될 정확한 수정본과 각 독자가 받게 될 시간을 확인할 수 있습니다.',
        },
        resume: {
          title: '읽던 문단에서 바로 이어 읽기.',
          body: '노트북에서 읽다 멈춰도 휴대폰을 열면 같은 문단으로 돌아갑니다. 다음 화도 한 번만 누르면 됩니다.',
        },
        discuss: {
          title: '이번 화를 이야기하고, 다음 화는 지켜 주세요.',
          body: '댓글은 문단에 연결되며, 아직 읽지 않은 화에 관한 댓글은 보이지 않습니다.',
        },
      },
    },
    showcase: {
      title: '연재에 필요한 것만, 빠짐없이.',
      lede: '긴 연재를 끝까지 함께할 도구들.',
      tiles: {
        collaborators: {
          title: '편집자와 함께',
          body: '베타 리더는 읽고, 편집자는 제안하고, 공동 작가는 수정합니다. 발행은 직접 결정합니다.',
        },
        backup: {
          title: '빠짐없는 백업',
          body: '수정 이력, 메모, 세계관을 다시 가져올 수 있는 개방형 형식으로 보관합니다.',
        },
        ai: {
          title: 'AI 사용을 솔직하게',
          body: 'AI의 도움을 받았는지, 어떻게 썼는지 사실대로 밝힐 수 있도록 세분화된 선택지를 제공합니다.',
        },
        world: {
          title: '초고 곁에 두는 세계관',
          body: '필요한 인물과 장소를 원고에서 한 번만 눌러 확인합니다.',
        },
        languages: {
          title: '내 언어를 포함한 모든 언어',
          body: '어떤 언어로든 쓰세요. 번역은 원작과 연결되어 있습니다.',
        },
      },
    },
    compare: {
      title: '쓰는 사람도, 정주행하는 사람도 편안하게.',
      lede: '연재는 작가와 독자가 오래 함께하는 일입니다. 어느 쪽도 도구와 씨름할 필요는 없어야 합니다.',
      today: '지금은',
      rezics: 'REZICS에서는',
      rows: {
        lost: {
          today: '연결이 끊기면 원고도 사라짐',
          rezics: '저장할 때마다 복원 가능한 수정본',
        },
        schedule: {
          today: '다른 시간대에 맞춰 한밤중에 발행',
          rezics: '내 시간대, 내 일정',
        },
        place: {
          today: '읽던 곳을 찾느라 계속 스크롤',
          rezics: '정확히 같은 문단으로 복귀',
        },
        spoilers: {
          today: '다음 에피소드를 스포일러하는 댓글',
          rezics: '읽은 지점까지만 보이는 토론',
        },
      },
    },
    statement: {
      text: '원고는 안전하게, 독자는 읽던 곳을 잃지 않게.',
      body: '웹소설은 첫 네 가지 사용 흐름 중 하나입니다. 작가에게는 믿을 수 있는 집필과 예약 발행을, 독자에게는 편안한 독서와 토론을 제공합니다.',
    },
    ledger: {
      title: 'REZICS 웹소설',
    },
    cta: {
      title: '첫날에 첫 화를 발행하세요.',
      body: '이메일을 남겨 주시면 가입이 열릴 때 한 번만 알려 드립니다.',
    },
  },
  de: {
    meta: {
      title: 'Fortsetzungsromane auf REZICS: Kapitel schreiben, nahtlos weiterlesen',
      description:
        'Sichere Entwürfe, Kapitel nach deiner Zeitzone planen, beim richtigen Absatz weiterlesen und ohne Spoiler über das Gelesene sprechen.',
    },
    hero: {
      title: 'Kapitel für Kapitel schreiben. Nahtlos weiterlesen.',
      lede: 'Ein Zuhause für Geschichten, die weiterwachsen. Schreibende bekommen sichere Manuskripte und ihren eigenen Zeitplan. Leser kehren zum genauen Absatz zurück und besprechen das gerade beendete Kapitel, ohne Spoiler aus späteren.',
    },
    story: {
      title: 'Vom Entwurf zum Freitagabend.',
      lede: 'Ein Kapitel, vom Schreibtisch aufs Handy der Leser.',
      steps: {
        draft: {
          title: 'Unbesorgt schreiben.',
          body: 'Jedes Speichern legt eine wiederherstellbare Fassung an. Schreib im Zug ohne Empfang; das Kapitel wartet sicher auf deinem Gerät bis zur nächsten Verbindung.',
        },
        schedule: {
          title: 'In deiner Zeitzone planen.',
          body: 'Wähle Freitag um 20 Uhr an deinem Wohnort. Du siehst genau, welche Fassung erscheint und wann sie jeden Leser erreicht.',
        },
        resume: {
          title: 'Mitten im Absatz weiterlesen.',
          body: 'Am Laptop aufgehört, am Handy denselben Absatz öffnen. Das nächste Kapitel ist nur einen Tipp entfernt.',
        },
        discuss: {
          title: 'Über dieses Kapitel reden, ohne das nächste zu verraten.',
          body: 'Kommentare hängen am Absatz. Niemand sieht Bemerkungen zu noch nicht gelesenen Kapiteln.',
        },
      },
    },
    showcase: {
      title: 'Alles, was ein Fortsetzungsroman braucht.',
      lede: 'Werkzeuge für den langen Atem einer Geschichte in Teilen.',
      tiles: {
        collaborators: {
          title: 'Hol deine Redaktion dazu',
          body: 'Testleser lesen, Lektoren schlagen vor, Mitautoren bearbeiten. Du veröffentlichst.',
        },
        backup: {
          title: 'Ein vollständiges Backup',
          body: 'Fassungen, Notizen und Welt in offenen Formaten, die sich wieder importieren lassen.',
        },
        ai: {
          title: 'KI-Nutzung ehrlich angeben',
          body: 'Gib an, ob und wie KI geholfen hat, mit Abstufungen, die der Wirklichkeit entsprechen.',
        },
        world: {
          title: 'Deine Welt neben dem Entwurf',
          body: 'Figuren und Orte nur einen Klick vom Kapitel entfernt.',
        },
        languages: {
          title: 'Jede Sprache, auch deine',
          body: 'Schreib in jeder Sprache. Übersetzungen bleiben mit dem Original verbunden.',
        },
      },
    },
    compare: {
      title: 'In Ruhe schreiben und weiterlesen.',
      lede: 'Fortsetzungsromane verbinden Schreibende und Lesende lange. Niemand sollte dabei mit den Werkzeugen kämpfen müssen.',
      today: 'Heute',
      rezics: 'Auf REZICS',
      rows: {
        lost: {
          today: 'Verbindung weg, Kapitel weg',
          rezics: 'Jede Speicherung wiederherstellbar',
        },
        schedule: {
          today: 'Nach fremder Zeitzone um Mitternacht veröffentlichen',
          rezics: 'Dein Zeitplan, deine Zeitzone',
        },
        place: {
          today: 'Die letzte Stelle mühsam suchen',
          rezics: 'Zum genauen Absatz zurück',
        },
        spoilers: {
          today: 'Kommentare verraten den nächsten Handlungsbogen',
          rezics: 'Diskussionen bis zu deinem Lesestand',
        },
      },
    },
    statement: {
      text: 'Dein Manuskript ist sicher. Deine Leser finden immer zurück.',
      body: 'Fortsetzungsromane gehören zu den ersten vier Szenarien: verlässlich schreiben und planen, in Ruhe lesen und diskutieren.',
    },
    ledger: {
      title: 'Fortsetzungsromane auf REZICS',
    },
    cta: {
      title: 'Veröffentliche dein erstes Kapitel zum Start.',
      body: 'Hinterlasse deine E-Mail-Adresse. Wir schreiben dir einmal, wenn die Registrierung öffnet.',
    },
  },
  fr: {
    meta: {
      title: 'Feuilletons sur REZICS : écrire par chapitres, lire sans perdre le fil',
      description:
        'Des brouillons à l’abri, des chapitres programmés dans votre fuseau, une reprise au bon paragraphe et des discussions sans divulgâcher la suite.',
    },
    hero: {
      title: 'Écrire chapitre par chapitre. Lire sans perdre le fil.',
      lede: 'Un lieu pour les histoires qui grandissent. Les auteurs gardent leurs manuscrits et maîtrisent leur calendrier. Les lecteurs retrouvent le paragraphe quitté et discutent du chapitre terminé sans apprendre la suite.',
    },
    story: {
      title: 'Du brouillon au rendez-vous du vendredi soir.',
      lede: 'Un chapitre, du bureau de l’auteur au téléphone du lecteur.',
      steps: {
        draft: {
          title: 'Écrivez l’esprit tranquille.',
          body: 'Chaque sauvegarde crée une version restaurable. Écrivez dans le train sans réseau : le chapitre reste en sécurité sur votre appareil jusqu’à la reconnexion.',
        },
        schedule: {
          title: 'Programmez dans votre fuseau horaire.',
          body: 'Choisissez vendredi à 20 h chez vous. Vous voyez la version exacte qui sera publiée et quand chaque lecteur la recevra.',
        },
        resume: {
          title: 'Reprenez au milieu du paragraphe.',
          body: 'Après une pause sur ordinateur, ouvrez votre téléphone au même paragraphe. Le chapitre suivant est à portée de doigt.',
        },
        discuss: {
          title: 'Parlez de ce chapitre, sans révéler le suivant.',
          body: 'Les commentaires sont ancrés aux paragraphes. Personne ne voit ceux d’un chapitre pas encore atteint.',
        },
      },
    },
    showcase: {
      title: 'Tout ce qu’il faut pour un feuilleton.',
      lede: 'Des outils pour tenir la distance, chapitre après chapitre.',
      tiles: {
        collaborators: {
          title: 'Invitez votre équipe éditoriale',
          body: 'Les bêta-lecteurs lisent, les éditeurs suggèrent, les coauteurs modifient. Vous publiez.',
        },
        backup: {
          title: 'Une sauvegarde complète',
          body: 'Versions, notes et univers dans des formats ouverts, réimportables.',
        },
        ai: {
          title: 'L’usage de l’IA, déclaré honnêtement',
          body: 'Précisez si l’IA a aidé et comment, avec des degrés assez fins pour être justes.',
        },
        world: {
          title: 'Votre univers à côté du brouillon',
          body: 'Personnages et lieux à un clic du chapitre qui en a besoin.',
        },
        languages: {
          title: 'Toutes les langues, y compris la vôtre',
          body: 'Écrivez dans n’importe quelle langue ; les traductions restent liées à l’original.',
        },
      },
    },
    compare: {
      title: 'Un lieu plus serein pour écrire et suivre un feuilleton.',
      lede: 'Un feuilleton est une relation durable entre auteur et lecteurs. Aucun ne devrait lutter contre ses outils.',
      today: 'Aujourd’hui',
      rezics: 'Sur REZICS',
      rows: {
        lost: {
          today: 'Une coupure, un chapitre perdu',
          rezics: 'Chaque sauvegarde peut être restaurée',
        },
        schedule: {
          today: 'Publier à minuit selon le fuseau d’un autre',
          rezics: 'Votre calendrier, votre fuseau',
        },
        place: {
          today: 'Faire défiler pour retrouver sa place',
          rezics: 'Retour au paragraphe exact',
        },
        spoilers: {
          today: 'Des commentaires qui révèlent l’arc suivant',
          rezics: 'Des discussions à votre progression',
        },
      },
    },
    statement: {
      text: 'Votre manuscrit est à l’abri. Vos lecteurs gardent le fil.',
      body: 'Le feuilleton fait partie des quatre premiers parcours : rédaction et programmation fiables pour les auteurs, lecture et discussions sereines pour les lecteurs.',
    },
    ledger: {
      title: 'Les feuilletons sur REZICS',
    },
    cta: {
      title: 'Publiez votre premier chapitre dès l’ouverture.',
      body: 'Laissez votre adresse e-mail. Nous vous écrirons une seule fois, à l’ouverture des inscriptions.',
    },
  },
  es: {
    meta: {
      title: 'Ficción por entregas en REZICS: escribe por capítulos, lee sin perder el hilo',
      description:
        'Borradores a salvo, capítulos programados en tu zona horaria, lectura que vuelve al párrafo exacto y debates sin spoilers de lo que viene.',
    },
    hero: {
      title: 'Escribe capítulo a capítulo. Lee sin perder el hilo.',
      lede: 'Un hogar para historias que siguen creciendo. Los autores tienen manuscritos a salvo y controlan su calendario; los lectores vuelven al párrafo exacto y comentan el capítulo terminado sin spoilers de los siguientes.',
    },
    story: {
      title: 'Del borrador a la cita del viernes.',
      lede: 'Un capítulo, del escritorio del autor al móvil del lector.',
      steps: {
        draft: {
          title: 'Escribe con tranquilidad.',
          body: 'Cada guardado crea una revisión recuperable. Escribe en el tren sin cobertura: el capítulo espera a salvo en tu dispositivo hasta que te reconectes.',
        },
        schedule: {
          title: 'Programa en tu zona horaria.',
          body: 'Elige el viernes a las 20:00 de donde vives. Ves la revisión exacta que se publicará y cuándo la recibirá cada lector.',
        },
        resume: {
          title: 'Retoma en mitad del párrafo.',
          body: 'Si paraste a mitad en el portátil, abres el móvil en el mismo párrafo. El siguiente capítulo está a un toque.',
        },
        discuss: {
          title: 'Comenta este capítulo sin destripar el siguiente.',
          body: 'Los comentarios se anclan a párrafos y nadie ve los de capítulos que aún no ha alcanzado.',
        },
      },
    },
    showcase: {
      title: 'Todo lo que necesita una historia por entregas.',
      lede: 'Herramientas para el largo recorrido de una historia por entregas.',
      tiles: {
        collaborators: {
          title: 'Invita a tu equipo editorial',
          body: 'Los lectores beta leen, los editores sugieren y los coautores editan. Tú publicas.',
        },
        backup: {
          title: 'Una copia de seguridad completa',
          body: 'Revisiones, notas y mundo en formatos abiertos que puedes volver a importar.',
        },
        ai: {
          title: 'El uso de IA, declarado con honestidad',
          body: 'Indica si la IA ayudó y de qué modo, con niveles suficientes para describirlo con precisión.',
        },
        world: {
          title: 'Tu mundo junto al borrador',
          body: 'Personajes y lugares a un clic del capítulo que los necesita.',
        },
        languages: {
          title: 'Todos los idiomas, también el tuyo',
          body: 'Escribe en cualquier idioma; las traducciones siguen vinculadas al original.',
        },
      },
    },
    compare: {
      title: 'Un lugar más tranquilo para escribir y leer por entregas.',
      lede: 'Una historia por entregas crea una relación larga entre autor y lectores. Ninguno debería pelearse con las herramientas.',
      today: 'Hoy',
      rezics: 'En REZICS',
      rows: {
        lost: {
          today: 'Se pierde la conexión y se pierde el capítulo',
          rezics: 'Cada guardado es una revisión recuperable',
        },
        schedule: {
          today: 'Publicar a medianoche según un horario ajeno',
          rezics: 'Tu calendario, tu zona horaria',
        },
        place: {
          today: 'Desplazarte hasta encontrar dónde paraste',
          rezics: 'Volver al párrafo exacto',
        },
        spoilers: {
          today: 'Comentarios que destripan el siguiente arco',
          rezics: 'Debates que llegan hasta donde vas',
        },
      },
    },
    statement: {
      text: 'Tu manuscrito está a salvo. Tus lectores siempre encuentran su sitio.',
      body: 'La ficción por entregas es uno de los cuatro primeros recorridos: escritura y programación fiables para autores, lectura y debates tranquilos para lectores.',
    },
    ledger: {
      title: 'Ficción por entregas en REZICS',
    },
    cta: {
      title: 'Publica tu primer capítulo desde el primer día.',
      body: 'Deja tu correo y te escribiremos una sola vez, cuando se abra el registro.',
    },
  },
});
