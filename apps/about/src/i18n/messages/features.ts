import type { FeatureId } from '../../features.ts';
import { defineCopy } from '../define.ts';

/**
 * One statement per feature in `features.ts`; only post-launch features get a label, so a
 * sentence describes the product as it will work and never hedges. A title is a
 * short claim that can stand alone as a big statement; a body is one or two
 * sentences with a concrete scene.
 */
export type FeatureCopy = Record<FeatureId, { title: string; body: string }>;

export const featureCopy = defineCopy<FeatureCopy>({
  en: {
    // Home: why REZICS
    'native-multilingual': {
      title: 'Every story keeps its own language.',
      body: 'Titles, editions, translations and conversations stay in the language they were written in. Your interface language never decides what you read, and nothing is quietly swapped for English.',
    },
    'portable-data': {
      title: 'Your library is yours to take.',
      body: 'Export your library, notes, reviews and drafts whole, in formats other tools read, and import them back without losing a date, a reread or an edition.',
    },
    'sourced-knowledge': {
      title: 'Knowledge shows its sources.',
      body: 'Wiki facts cite the chapter they come from. Agents propose, people review, and every change can be traced and undone.',
    },
    'api-agent-first': {
      title: 'Everything you can do, your tools can do.',
      body: 'Every action on REZICS is an API operation first, so your apps, scripts and agents work with the same powers you have, and never more.',
    },
    'open-source': {
      title: 'Built in the open.',
      body: 'The code is public: read how REZICS works, run it yourself and help improve it.',
    },
    // Home: every language, the whole community, fans together, every kind
    'names-every-script': {
      title: 'Names in every script',
      body: 'Titles, people and characters carry their names in each language and script, with readings, so a work is found however you spell it and shown the way you read it.',
    },
    'shared-tags': {
      title: 'Tags in your language',
      body: 'Tags come from one shared vocabulary, translated once for everyone, so a tag applied in Japanese reads in English, 繁體中文 or any language it has a name in.',
    },
    'reviewed-translations': {
      title: 'Synopses translated by people',
      body: 'Readers propose translations of a synopsis or a description, and others review them like any change. Until one exists you see the original, marked as such, never a guess.',
    },
    'saved-lists': {
      title: 'Lists you shape',
      body: 'Keep lists of anything on REZICS and see them as a list, a table or a gallery, filtered your way, private or shared.',
    },
    'one-identity': {
      title: 'One identity, everywhere',
      body: 'One profile follows you across every Realm, every kind of story and every language, so what you write and what you are known for stays yours wherever you post.',
    },
    'works-across-platforms': {
      title: 'Every version, one story',
      body: 'The web serial, the light novel, the manga, the anime and the game are linked as one story, each with its own releases, so fans who met it in different places arrive on the same page.',
    },
    'every-kind': {
      title: 'A complete page for every kind',
      body: 'Every kind of work gets a full page from the same parts: cover, names in every language, facts, relations, ratings, reviews, discussion, wiki, lists and sources. A new kind opens as configuration, not code.',
    },
    // Reading
    'portable-library': {
      title: 'A library that knows the edition',
      body: 'Shelve the paperback, the ebook and the translation as copies of one story, with the one you are reading marked.',
    },
    'reading-sessions': {
      title: 'Reading as it really happens',
      body: 'Rereads, pauses, books you set down and books you switch format halfway through, each recorded once, in pages, percent or minutes.',
    },
    'library-import': {
      title: 'Bring your history',
      body: 'Import from Goodreads, StoryGraph or a spreadsheet. Each row is matched to the edition you read, you choose when two look alike, and you see what will not carry over before anything changes.',
    },
    'library-export': {
      title: 'Leave with everything',
      body: 'Export the whole library with dates, notes and editions intact, and import it into REZICS or anywhere else.',
    },
    'copies-loans': {
      title: 'Owned, borrowed, due back',
      body: 'Keep the copies you own apart from the ones you borrowed and when they are due, without touching what you have read.',
    },
    'review-targets': {
      title: 'Reviews that say what they judge',
      body: 'Rate the story, the translation or the narration on its own, so a clumsy translation never sinks a great book.',
    },
    'reading-notes': {
      title: 'Notes on the passage',
      body: 'Private notes tied to the edition and the exact passage, shared only if you choose.',
    },
    // Light novels
    'series-tracking': {
      title: 'The whole series on one page',
      body: 'Japanese originals, official translations and fan translations of every volume, lined up with what you own and what you have read.',
    },
    'edition-coverage': {
      title: 'Editions that never blur',
      body: 'Volumes, omnibuses, special editions and regional releases are separate records, never guessed from a matching title.',
    },
    'translation-availability': {
      title: 'The next volume in your language',
      body: 'Follow a series in the languages you read and see which volume comes next in each, with its date once it is known.',
    },
    'release-alerts': {
      title: 'Know the day it is out',
      body: 'One note when the next volume in your language is dated or released, and none about the languages you do not read.',
    },
    'translation-provenance': {
      title: 'Official, fan or machine, always clear',
      body: 'Every translation says who made it and how. Fan groups are credited, machine translation is labelled, and progress is shown.',
    },
    'light-novels-zone': {
      title: 'The Light Novels Zone',
      body: 'New volumes, finished translations and discussion in your languages, gathered over the same catalogue as every other Zone.',
    },
    // Serial fiction
    'serial-writing': {
      title: 'A manuscript that cannot vanish',
      body: 'Every save is a revision you can restore, and a chapter written offline waits safely on your device until you reconnect.',
    },
    'serial-scheduling': {
      title: 'Publish on your schedule',
      body: 'Schedule chapters in your own time zone and see exactly which revision readers will get, and when.',
    },
    'serial-reading': {
      title: 'Pick up mid-paragraph',
      body: 'Readers return to the exact paragraph they left, on any device, and the next chapter is always one tap away.',
    },
    'chapter-discussion': {
      title: 'Talk about the chapter you just read',
      body: 'Comments sit beside the chapter, anchored to its paragraphs, and never reveal what a reader has not reached.',
    },
    collaborators: {
      title: 'Bring in your editor',
      body: 'Invite a beta reader to read, an editor to suggest and a co-author to edit, while publishing stays in your hands.',
    },
    'author-backup': {
      title: 'A backup that is complete',
      body: 'Download the whole work with its revisions, notes and world, in open formats you can import again.',
    },
    // Visual novels, anime and manga
    'vn-releases': {
      title: 'The release you can actually play',
      body: 'Filter visual novels by language, platform and edition, and compare every release side by side.',
    },
    'release-provenance': {
      title: 'Translations with a paper trail',
      body: 'See who translated a release, from which version and how complete it is, before you give it a weekend.',
    },
    'anime-episodes': {
      title: 'Anime by the episode',
      body: 'Track seasons and episodes, split cours and specials included, and discuss an episode without spoiling the next.',
    },
    'one-list': {
      title: 'One list for all of it',
      body: 'Anime, manga, novels and games on the same list, each counted in its own units: episodes, chapters, volumes or routes.',
    },
    'spoiler-position': {
      title: 'Spoilers stop where you are',
      body: 'Discussion, tags and wiki pages hold back whatever lies past the episode or chapter you have reached.',
    },
    'acgn-zone': {
      title: 'The ACGN Zone',
      body: 'This season, new releases and adaptations of the stories you follow, for people who watch, read and play.',
    },
    // Wikis and worldbuilding
    'realm-wikis': {
      title: 'A wiki for every Work',
      body: 'Characters, places, factions and events, each on its own page with an infobox, links, backlinks and discussion.',
    },
    'chapter-citations': {
      title: 'Facts that cite the chapter',
      body: 'Every statement points to the chapter and edition it comes from, so readers can check it and editors can fix it.',
    },
    'spoiler-safe-wiki': {
      title: 'Read the wiki at your chapter',
      body: 'Tell the wiki how far you have read, and every page, search result and infobox shows only what the story has revealed by then.',
    },
    'wiki-builder': {
      title: 'The wiki builder',
      body: 'Agents read licensed and author-supplied text chapter by chapter and propose sourced facts; reviewers publish them. Each Realm decides whether agents may draft for it.',
    },
    'world-bible': {
      title: 'A world bible beside the manuscript',
      body: 'Authors keep characters, places and lore privately next to the draft, then publish the pages they choose as the Work’s wiki.',
    },
    'world-visuals': {
      title: 'Maps, relationships and timelines',
      body: 'Pin places on your own map, draw relationships and set events on invented calendars, each with a readable list beside it.',
    },
    'wiki-history': {
      title: 'Every edit reviewed and reversible',
      body: 'History, diffs, review and restore on every page, and the whole wiki exports in one piece, never behind a paywall.',
    },
    // Agents
    'contribution-protocol': {
      title: 'One open protocol',
      body: 'Official and third-party agents submit the same proposals: the exact change, the evidence behind it and a confidence they must stand behind. Nothing applies without review.',
    },
    'spam-review': {
      title: 'Spam and advertising review',
      body: 'Built on TypeSafe’s Jev: typed, confidence-aware decisions that quote the passages behind them, with a person who can overrule every one.',
    },
    'auto-tagging': {
      title: 'Tags that keep up',
      body: 'Posts and books get suggested tags from the shared vocabulary, each with the reason it applies and the spoiler level it carries.',
    },
    'relation-maintenance': {
      title: 'Relations kept current',
      body: 'When a new character, person or place appears, an agent proposes it into the Works and entities it belongs to.',
    },
    normalisation: {
      title: 'Free-form posts, structured',
      body: 'A recipe written as a chatty post is proposed back to its author as a recipe with ingredients and steps.',
    },
    'migration-assistant': {
      title: 'The migration assistant',
      body: 'Brings a library over from another site, resolves editions with you and reports every row it could not match.',
    },
    'bring-your-own-agent': {
      title: 'Bring your own agent',
      body: 'Connect the agent you trust through the API or MCP. It runs on your compute, with scoped credentials and a budget you set.',
    },
    'agent-disclosure': {
      title: 'Automation always says so',
      body: 'Every agent action names the agent, who runs it and who reviewed it. REZICS never fakes reviews, votes or community members.',
    },
    // Communities
    realms: {
      title: 'Realms',
      body: 'Communities around one story, one language or one idea, each with its own rules, wiki and moderators.',
    },
    'follow-join': {
      title: 'Follow or join',
      body: 'Follow a Realm to read along; join it to take part. You always know which one you chose.',
    },
    'community-rules': {
      title: 'Rules in every language',
      body: 'A Realm states its rules once per language, and moderators apply the same rules to everyone.',
    },
    'newcomer-trust': {
      title: 'Room for newcomers, none for spam',
      body: 'New members start with gentle limits that lift as they take part, so a Realm can welcome people without welcoming bots.',
    },
    'moderation-cases': {
      title: 'Moderation you can follow',
      body: 'A report becomes a case with a decision, a stated reason and an appeal, visible to the people involved.',
    },
    recognition: {
      title: 'Recognition for real help',
      body: 'Levels in each Realm come from accepted contributions such as helpful reviews, corrections and translations, never from streaks.',
    },
    // Distribution
    'sell-books-games': {
      title: 'Books and games, sold directly',
      body: 'Contracted creators sell rights-cleared books, small games and visual novels on REZICS, with samples, updates and refunds.',
    },
    'drm-free': {
      title: 'Files that stay yours',
      body: 'DRM-free EPUB and PDF books and game builds, downloadable again from your library whenever you want them.',
    },
    'clear-statements': {
      title: 'Every deduction on the statement',
      body: 'Creators see tax, payment fees and refunds line by line, and exactly what reaches them.',
    },
    'edition-storefront': {
      title: 'Buy the exact edition',
      body: 'Readers choose the language and edition they want, and a translated edition credits its translator on the page.',
    },
    'rights-declarations': {
      title: 'Rights, stated plainly',
      body: 'Each Work says who made it, who translated it and what readers may do with it.',
    },
    'connected-store': {
      title: 'The book, its Realm and its wiki together',
      body: 'A purchase lives beside the discussion and the wiki of its Work, not in a separate store.',
    },
    // Developers
    'open-api': {
      title: 'The whole product as an API',
      body: 'Every operation a person can perform is documented, with outcomes your code can read and requests it can safely retry.',
    },
    'scoped-credentials': {
      title: 'Credentials scoped to the job',
      body: 'Give a tool exactly the access it needs, on exactly the resources it needs, and revoke it in one place.',
    },
    'actionable-errors': {
      title: 'Errors your code can act on',
      body: 'Standard problem details that say what went wrong and what to do next, from a denied scope to a stale revision.',
    },
    'event-stream': {
      title: 'Events you can resume',
      body: 'Follow changes with a durable cursor and pick up exactly where you left off after a disconnect.',
    },
    'typescript-sdk': {
      title: 'A TypeScript SDK',
      body: 'Typed clients generated from the same definitions as the API.',
    },
    'developer-portal': {
      title: 'Docs that cannot drift',
      body: 'Reference, quick starts and the list of capabilities are generated from the registry the API itself runs on.',
    },
    // Trust
    'suitability-gates': {
      title: 'Suitability you control',
      body: 'General, teen, sexual and grotesque material are separate choices, and anything unrated is treated as unrated, never as general.',
    },
    'ai-disclosure': {
      title: 'AI use, declared',
      body: 'Prose, art and translations state whether AI was used and whether a person reviewed it, and you can filter by it.',
    },
    'no-training': {
      title: 'Your drafts and reading are not training data',
      body: 'REZICS does not train on your private drafts or reading records unless you opt in, and never treats an AI detector as a verdict.',
    },
    'no-trackers': {
      title: 'No trackers',
      body: 'This site has no advertising trackers and no third-party analytics. Two cookies remember your language and theme.',
    },
    'reporting-appeals': {
      title: 'Report anything, appeal any decision',
      body: 'Anyone can report, signed in or not. Every decision comes with its reason and a way to appeal.',
    },
    'safety-response': {
      title: 'The worst harms handled first',
      body: 'Known child-abuse imagery is blocked at upload, and intimate images shared without consent come down within 48 hours of a valid report.',
    },
  },
  'zh-Hant': {
    'native-multilingual': {
      title: '每個故事，都保留自己的語言。',
      body: '書名、版本、翻譯與對話，都保留寫下時的語言。介面語言不會決定你讀什麼，也不會悄悄換成英文。',
    },
    'portable-data': {
      title: '你的書庫，隨時帶得走。',
      body: '書庫、筆記、評論與草稿都能完整匯出，格式可供其他工具讀取；再匯入時，日期、重讀與版本一樣都不漏。',
    },
    'sourced-knowledge': {
      title: '知識，拿得出來源。',
      body: 'Wiki 資訊引用出處章節。代理程式提案，由人審核，每次變更都可追溯、可撤銷。',
    },
    'api-agent-first': {
      title: '你做得到的，工具也做得到。',
      body: 'REZICS 的每項操作都先有 API，讓 App、腳本與代理程式和你擁有相同能力，但絕不超出你的權限。',
    },
    'open-source': {
      title: '公開打造，一起改進。',
      body: '程式碼公開：看看 REZICS 如何運作、自己架設，也能一起改進。',
    },
    'names-every-script': {
      title: '各種文字，都有自己的名字',
      body: '作品、人物與角色收錄各種語言、文字與讀音的名稱。不論怎麼寫，都找得到作品；顯示時，也用你閱讀的方式呈現。',
    },
    'shared-tags': {
      title: '用你的語言看標籤',
      body: '標籤來自共用詞彙表，譯一次，大家都能用。用日文標的標籤，也能顯示成英文、繁體中文，或任何已有對應名稱的語言。',
    },
    'reviewed-translations': {
      title: '由人翻譯的簡介',
      body: '讀者可以提出簡介或說明的翻譯，再由他人如同一般編輯那樣審核。尚無譯文時，就明確標示並顯示原文，不會憑空猜譯。',
    },
    'saved-lists': {
      title: '清單，由你安排',
      body: 'REZICS 上的各種內容都能列入清單，以列表、表格或圖庫檢視，依需要篩選，選擇私藏或分享。',
    },
    'one-identity': {
      title: '同一個身分，走到哪都能用',
      body: '同一份個人檔案跨越社群、故事類型與語言。不論在哪裡發文，你寫過的內容與累積的名聲都跟著你。',
    },
    'works-across-platforms': {
      title: '各種版本，同一個故事',
      body: '網路連載、輕小說、漫畫、動畫與遊戲連成同一個故事，各自保留發行版本。從不同地方入坑的同好，最後相遇在同一個頁面。',
    },
    'every-kind': {
      title: '每種創作，都有完整頁面',
      body: '每種作品都用同一套元素建立完整頁面：封面、各語言名稱、資訊、關係、評分、評論、討論、Wiki、清單與來源。新增類型靠設定，不必另寫程式。',
    },
    'portable-library': {
      title: '懂版本的書庫',
      body: '紙本、電子書與譯本，作為同一個故事的不同書本上架，並標明你正讀哪一本。',
    },
    'reading-sessions': {
      title: '如實記錄閱讀',
      body: '重讀、暫停、先擱著，或中途換個形式繼續讀，都只記一次，以頁數、百分比或分鐘記進度。',
    },
    'library-import': {
      title: '帶著閱讀歷程搬家',
      body: '從 Goodreads、StoryGraph 或試算表匯入，逐筆比對實際閱讀的版本。候選版本相似時由你選擇，變更前也會先列出無法帶入的資料。',
    },
    'library-export': {
      title: '全部帶走',
      body: '日期、筆記與版本都完整匯出，再匯入 REZICS 或其他地方。',
    },
    'copies-loans': {
      title: '藏書、借書、還書日',
      body: '藏書、借來的書與還書日期分開管理，不影響已讀紀錄。',
    },
    'review-targets': {
      title: '評論，說清楚評的是什麼',
      body: '故事、翻譯與旁白分開評，精彩的書不會因為拙劣譯文被拖累。',
    },
    'reading-notes': {
      title: '寫在段落上的筆記',
      body: '私人筆記連到確切版本與段落，只有你選擇分享時才公開。',
    },
    'series-tracking': {
      title: '整個系列，一頁看清',
      body: '各集日文原版、官方譯本與同好翻譯並排呈現，一起標出已收藏與已讀。',
    },
    'edition-coverage': {
      title: '版本，再也不混淆',
      body: '分冊、合訂本、特裝版與地區發行各有獨立紀錄，不會只憑同名猜測版本。',
    },
    'translation-availability': {
      title: '你閱讀語言的下一集',
      body: '依你閱讀的語言追蹤系列，看各語言下一集是哪本，日期公布就會顯示。',
    },
    'release-alerts': {
      title: '發售當天，就知道',
      body: '你閱讀語言的下一集公布日期或正式發售時，收到一次通知；不讀的語言不打擾。',
    },
    'translation-provenance': {
      title: '官方、同好或機翻，清楚標示',
      body: '每個譯本都交代譯者與翻譯方式；同好團隊具名署名，機器翻譯明確標示，也顯示完成進度。',
    },
    'light-novels-zone': {
      title: '輕小說 Zone',
      body: '新書、完譯消息與你閱讀語言的討論，從與其他 Zone 相同的作品目錄中匯聚。',
    },
    'serial-writing': {
      title: '不怕遺失的稿件',
      body: '每次儲存都是可還原的修訂版，離線寫的章節會安全保存在裝置上，直到重新連線。',
    },
    'serial-scheduling': {
      title: '照自己的時間發布',
      body: '以自己的時區安排章節，清楚看到讀者會收到哪個修訂版、何時收到。',
    },
    'serial-reading': {
      title: '從段落中間接著讀',
      body: '不論哪個裝置，都能回到上次讀到的段落；下一章，也只要點一下。',
    },
    'chapter-discussion': {
      title: '聊剛讀完的這一章',
      body: '留言就在章節旁，對應確切段落，不會揭露讀者尚未讀到的內容。',
    },
    collaborators: {
      title: '邀編輯一起加入',
      body: '邀試讀者閱讀、編輯提建議、共同作者編修；發布權始終由你掌握。',
    },
    'author-backup': {
      title: '完整的備份',
      body: '整部作品連同修訂紀錄、筆記與世界設定一起下載，使用可重新匯入的開放格式。',
    },
    'vn-releases': {
      title: '真正能玩的版本',
      body: '依語言、平台與版本篩選視覺小說，所有發行版本並排比較。',
    },
    'release-provenance': {
      title: '翻譯來源，有跡可循',
      body: '準備投入一整個週末之前，先看清楚誰翻譯、依據哪個版本，以及翻譯完成度。',
    },
    'anime-episodes': {
      title: '動畫，逐集追蹤',
      body: '記錄季度與集數，分割季度與特別篇也不漏；討論這一集，不暴雷下一集。',
    },
    'one-list': {
      title: '一份清單，全部收好',
      body: '動畫、漫畫、小說與遊戲放在同一份清單，按各自的集、話、冊或路線計算。',
    },
    'spoiler-position': {
      title: '暴雷，到你的進度為止',
      body: '討論、標籤與 Wiki，會隱藏超過你目前集數或章節的內容。',
    },
    'acgn-zone': {
      title: 'ACGN Zone',
      body: '本季新番、最新發行與追蹤故事的改編作品，給追番、看書、玩遊戲的你。',
    },
    'realm-wikis': {
      title: '每部作品，都有 Wiki',
      body: '人物、地點、陣營與事件各有頁面，附資訊框、連結、反向連結與討論。',
    },
    'chapter-citations': {
      title: '每條資訊，都引用章節',
      body: '每項敘述都指向出處章節與版本，讀者能查證，編輯也能修正。',
    },
    'spoiler-safe-wiki': {
      title: '照閱讀進度看 Wiki',
      body: '告訴 Wiki 你讀到哪裡，每頁、搜尋結果與資訊框就只顯示當時已揭曉的內容。',
    },
    'wiki-builder': {
      title: 'Wiki 建構助手',
      body: '代理程式逐章閱讀已授權、由作者提供的文本，提出有來源的資訊，由審核者發布。各社群自行決定是否允許代理程式擬稿。',
    },
    'world-bible': {
      title: '稿件旁的世界觀設定集',
      body: '作者可在草稿旁私密保存人物、地點與設定，再挑選頁面公開為作品 Wiki。',
    },
    'world-visuals': {
      title: '地圖、關係與時間線',
      body: '在自製地圖標記地點、描繪關係、用架空曆法安排事件，每種圖旁都有可閱讀的清單。',
    },
    'wiki-history': {
      title: '每次編輯，都能審核與還原',
      body: '每頁都有歷史、差異比對、審核與還原，整個 Wiki 能一次完整匯出，絕不設付費門檻。',
    },
    'contribution-protocol': {
      title: '共用一個開放協定',
      body: '官方與第三方代理程式提交相同格式的提案：確切變更、佐證，以及必須接受檢驗的信心程度。未經審核，什麼都不會套用。',
    },
    'spam-review': {
      title: '垃圾訊息與廣告審查',
      body: '以 TypeSafe 的 Jev 為基礎：判斷有明確型別與信心程度，引用依據段落，每項決定都可由人推翻。',
    },
    'auto-tagging': {
      title: '跟得上內容的標籤',
      body: '從共用詞彙表為貼文與書籍提出標籤，逐項附上適用理由與暴雷程度。',
    },
    'relation-maintenance': {
      title: '關係，持續更新',
      body: '新角色、人物或地點出現時，代理程式提議將它連到相關作品與實體。',
    },
    normalisation: {
      title: '自由書寫，也能整理成結構',
      body: '把閒聊式食譜整理成食材與步驟，再向原作者提出建議。',
    },
    'migration-assistant': {
      title: '搬家助手',
      body: '從其他網站帶入書庫，與你一同確認版本，回報每筆無法比對的資料。',
    },
    'bring-your-own-agent': {
      title: '帶上自己的代理程式',
      body: '透過 API 或 MCP 連接你信任的代理程式，用你的運算資源執行，憑證權限有限，預算由你設定。',
    },
    'agent-disclosure': {
      title: '自動化操作，一定明說',
      body: '每次代理操作都記明代理程式、執行者與審核者。REZICS 絕不偽造評論、投票或社群成員。',
    },
    realms: {
      title: '社群',
      body: '圍繞一個故事、一種語言或一個想法的社群，各有自己的規則、Wiki 與管理員。',
    },
    'follow-join': {
      title: '追蹤或加入',
      body: '追蹤社群看動態，加入社群來參與。你選的是哪一種，始終看得清楚。',
    },
    'community-rules': {
      title: '每種語言，都有規則',
      body: '社群以每種語言各列一份規則，管理員對所有人套用相同標準。',
    },
    'newcomer-trust': {
      title: '歡迎新人，不歡迎垃圾訊息',
      body: '新成員從適度限制開始，隨參與逐步解除，讓社群迎接新人，也擋住機器人灌水。',
    },
    'moderation-cases': {
      title: '看得明白的管理',
      body: '檢舉成為案件，當事人可查看決定、明確理由與申訴管道。',
    },
    recognition: {
      title: '肯定真正有幫助的貢獻',
      body: '社群等級來自被採納的實質貢獻，例如有幫助的評論、修正與翻譯，不靠連續簽到。',
    },
    'sell-books-games': {
      title: '書籍與遊戲，直接販售',
      body: '簽約創作者在 REZICS 販售權利已確認的書籍、小型遊戲與視覺小說，提供試閱、更新與退款。',
    },
    'drm-free': {
      title: '檔案，始終在你手裡',
      body: '無 DRM 的 EPUB、PDF 與遊戲檔案，隨時都能從書庫重新下載。',
    },
    'clear-statements': {
      title: '每筆扣款，都列在結算單上',
      body: '創作者逐筆看到稅款、支付手續費與退款，也清楚知道實際入帳多少。',
    },
    'edition-storefront': {
      title: '買到你要的版本',
      body: '讀者選擇需要的語言與版本，翻譯版的頁面也清楚署名譯者。',
    },
    'rights-declarations': {
      title: '權利，說清楚',
      body: '每部作品都說明創作者、譯者，以及讀者可如何使用。',
    },
    'connected-store': {
      title: '書、社群與 Wiki，在同一處',
      body: '購買就在作品的討論與 Wiki 旁，不必跳到另一個商店。',
    },
    'open-api': {
      title: '完整產品，都能透過 API 使用',
      body: '每項人能執行的操作都有文件，結果可由程式判讀，請求也能安全重試。',
    },
    'scoped-credentials': {
      title: '憑證權限，剛好夠用',
      body: '只授予工具所需資源上的必要權限，並能集中撤銷。',
    },
    'actionable-errors': {
      title: '程式能處理的錯誤',
      body: '標準錯誤詳情會說明問題與下一步，從權限遭拒，到修訂版本過舊，都能處理。',
    },
    'event-stream': {
      title: '事件，斷線也能接續',
      body: '用持久游標追蹤變更，斷線後精確回到上次位置。',
    },
    'typescript-sdk': {
      title: 'TypeScript SDK',
      body: '與 API 使用同一份定義，產生具型別的用戶端。',
    },
    'developer-portal': {
      title: '與實作同步的文件',
      body: '參考文件、快速入門與能力清單，都從 API 本身使用的登錄表產生。',
    },
    'suitability-gates': {
      title: '內容尺度，自己掌握',
      body: '普遍、青少年、性與獵奇內容各自選擇；未分級就是未分級，絕不當作普遍級。',
    },
    'ai-disclosure': {
      title: 'AI 使用，明確揭露',
      body: '文字、圖像與翻譯都標明是否使用 AI、是否經人工審核，也能依此篩選。',
    },
    'no-training': {
      title: '你的草稿與閱讀紀錄，不是訓練資料',
      body: '除非你主動同意，REZICS 不會用私人草稿或閱讀紀錄訓練，也絕不把 AI 偵測器的結果當作裁決。',
    },
    'no-trackers': {
      title: '沒有追蹤器',
      body: '本站沒有廣告追蹤器或第三方分析工具，只用兩個 Cookie 記住語言與主題。',
    },
    'reporting-appeals': {
      title: '任何問題都能檢舉，任何決定都能申訴',
      body: '不論是否登入，任何人都能檢舉。每項決定都附上理由與申訴方式。',
    },
    'safety-response': {
      title: '優先處理最嚴重的傷害',
      body: '已知兒童虐待影像在上傳時攔截；未經同意散布的私密影像，收到有效檢舉後 48 小時內移除。',
    },
  },
  'zh-Hans': {
    'native-multilingual': {
      title: '每个故事，都保留自己的语言。',
      body: '书名、版本、翻译与对话，都保留写下时的语言。界面语言不会决定你读什么，也不会悄悄换成英语。',
    },
    'portable-data': {
      title: '你的书库，随时带得走。',
      body: '书库、笔记、评论与草稿都能完整导出，格式可供其他工具读取；再导入时，日期、重读与版本一样都不漏。',
    },
    'sourced-knowledge': {
      title: '知识，拿得出来源。',
      body: 'Wiki 信息引用出处章节。智能体提案，由人审核，每次变更都可追溯、可撤销。',
    },
    'api-agent-first': {
      title: '你做得到的，工具也做得到。',
      body: 'REZICS 的每项操作都先有 API，让 App、脚本与智能体和你拥有相同能力，但绝不超出你的权限。',
    },
    'open-source': {
      title: '公开打造，一起改进。',
      body: '代码公开：看看 REZICS 如何运行、自己部署，也能一起改进。',
    },
    'names-every-script': {
      title: '各种文字，都有自己的名字',
      body: '作品、人物与角色收录各种语言、文字与读音的名称。不论怎么写，都找得到作品；显示时，也用你阅读的方式呈现。',
    },
    'shared-tags': {
      title: '用你的语言看标签',
      body: '标签来自共享词表，翻译一次，大家都能用。用日文标的标签，也能显示成英语、繁体中文，或任何已有对应名称的语言。',
    },
    'reviewed-translations': {
      title: '由人翻译的简介',
      body: '读者可以提出简介或说明的翻译，再由他人像审核其他编辑一样审核。尚无译文时，就明确标注并显示原文，不会凭空猜译。',
    },
    'saved-lists': {
      title: '清单，由你安排',
      body: 'REZICS 上的各种内容都能列入清单，以列表、表格或画廊查看，按需要筛选，选择私藏或分享。',
    },
    'one-identity': {
      title: '同一个身份，走到哪都能用',
      body: '同一份个人资料跨越社区、故事类型与语言。无论在哪里发帖，你写过的内容与积累的声誉都跟着你。',
    },
    'works-across-platforms': {
      title: '各种版本，同一个故事',
      body: '网络连载、轻小说、漫画、动画与游戏连成同一个故事，各自保留发行版本。从不同地方入坑的同好，最后相遇在同一个页面。',
    },
    'every-kind': {
      title: '每种创作，都有完整页面',
      body: '每种作品都用同一套元素建立完整页面：封面、各语言名称、信息、关系、评分、评论、讨论、Wiki、清单与来源。新增类型靠配置，不必另写代码。',
    },
    'portable-library': {
      title: '懂版本的书库',
      body: '纸书、电子书与译本，作为同一个故事的不同书本上架，并标明你正读哪一本。',
    },
    'reading-sessions': {
      title: '如实记录阅读',
      body: '重读、暂停、先搁着，或中途换个形式继续读，都只记一次，以页数、百分比或分钟记进度。',
    },
    'library-import': {
      title: '带着阅读历程搬家',
      body: '从 Goodreads、StoryGraph 或电子表格导入，逐条匹配实际阅读的版本。候选版本相似时由你选择，变更前也会先列出无法带入的数据。',
    },
    'library-export': {
      title: '全部带走',
      body: '日期、笔记与版本都完整导出，再导入 REZICS 或其他地方。',
    },
    'copies-loans': {
      title: '藏书、借书、还书日',
      body: '藏书、借来的书与还书日期分开管理，不影响已读记录。',
    },
    'review-targets': {
      title: '评论，说清楚评的是什么',
      body: '故事、翻译与旁白分开评，精彩的书不会因为拙劣译文被拖累。',
    },
    'reading-notes': {
      title: '写在段落上的笔记',
      body: '私人笔记连到准确版本与段落，只有你选择分享时才公开。',
    },
    'series-tracking': {
      title: '整个系列，一页看清',
      body: '各卷日文原版、官方译本与同好翻译并排展示，一起标出已收藏与已读。',
    },
    'edition-coverage': {
      title: '版本，再也不混淆',
      body: '分册、合订本、特别版与地区发行各有独立记录，不会只凭同名猜测版本。',
    },
    'translation-availability': {
      title: '你阅读语言的下一卷',
      body: '按你阅读的语言追踪系列，看各语言下一卷是哪本，日期公布就会显示。',
    },
    'release-alerts': {
      title: '发售当天，就知道',
      body: '你阅读语言的下一卷公布日期或正式发售时，收到一次通知；不读的语言不打扰。',
    },
    'translation-provenance': {
      title: '官方、同好或机翻，清楚标明',
      body: '每个译本都说明译者与翻译方式；同好团队具名署名，机器翻译明确标注，也显示完成进度。',
    },
    'light-novels-zone': {
      title: '轻小说 Zone',
      body: '新书、完译消息与你阅读语言的讨论，从与其他 Zone 相同的作品目录中汇聚。',
    },
    'serial-writing': {
      title: '不怕丢失的稿件',
      body: '每次保存都是可恢复的修订版，离线写的章节会安全保存在设备上，直到重新联网。',
    },
    'serial-scheduling': {
      title: '按自己的时间发布',
      body: '用自己的时区安排章节，清楚看到读者会收到哪个修订版、何时收到。',
    },
    'serial-reading': {
      title: '从段落中间接着读',
      body: '无论哪个设备，都能回到上次读到的段落；下一章，也只需点一下。',
    },
    'chapter-discussion': {
      title: '聊刚读完的这一章',
      body: '评论就在章节旁，对应准确段落，不会透露读者尚未读到的内容。',
    },
    collaborators: {
      title: '邀编辑一起加入',
      body: '邀试读者阅读、编辑提建议、共同作者修改；发布权始终由你掌握。',
    },
    'author-backup': {
      title: '完整的备份',
      body: '整部作品连同修订记录、笔记与世界设定一起下载，使用可重新导入的开放格式。',
    },
    'vn-releases': {
      title: '真正能玩的版本',
      body: '按语言、平台与版本筛选视觉小说，所有发行版本并排比较。',
    },
    'release-provenance': {
      title: '翻译来源，有迹可循',
      body: '准备投入一整个周末之前，先看清楚谁翻译、依据哪个版本，以及翻译完成度。',
    },
    'anime-episodes': {
      title: '动画，逐集追踪',
      body: '记录季度与集数，分割季度与特别篇也不漏；讨论这一集，不剧透下一集。',
    },
    'one-list': {
      title: '一份清单，全部收好',
      body: '动画、漫画、小说与游戏放在同一份清单，按各自的集、话、卷或路线计算。',
    },
    'spoiler-position': {
      title: '剧透，到你的进度为止',
      body: '讨论、标签与 Wiki，会隐藏超过你当前集数或章节的内容。',
    },
    'acgn-zone': {
      title: 'ACGN Zone',
      body: '本季新番、最新发行与追踪故事的改编作品，给追番、看书、玩游戏的你。',
    },
    'realm-wikis': {
      title: '每部作品，都有 Wiki',
      body: '人物、地点、阵营与事件各有页面，附信息框、链接、反向链接与讨论。',
    },
    'chapter-citations': {
      title: '每条信息，都引用章节',
      body: '每项陈述都指向出处章节与版本，读者能查证，编辑也能修正。',
    },
    'spoiler-safe-wiki': {
      title: '按阅读进度看 Wiki',
      body: '告诉 Wiki 你读到哪里，每页、搜索结果与信息框就只显示当时已揭晓的内容。',
    },
    'wiki-builder': {
      title: 'Wiki 构建助手',
      body: '智能体逐章阅读已授权、由作者提供的文本，提出有来源的信息，由审核者发布。各社区自行决定是否允许智能体起草。',
    },
    'world-bible': {
      title: '稿件旁的世界观设定集',
      body: '作者可在草稿旁私密保存人物、地点与设定，再挑选页面公开为作品 Wiki。',
    },
    'world-visuals': {
      title: '地图、关系与时间线',
      body: '在自制地图标记地点、描绘关系、用架空历法安排事件，每种图旁都有可阅读的清单。',
    },
    'wiki-history': {
      title: '每次编辑，都能审核与恢复',
      body: '每页都有历史、差异对比、审核与恢复，整个 Wiki 能一次完整导出，绝不设付费门槛。',
    },
    'contribution-protocol': {
      title: '共用一个开放协议',
      body: '官方与第三方智能体提交相同格式的提案：准确变更、佐证，以及必须接受检验的置信度。未经审核，什么都不会应用。',
    },
    'spam-review': {
      title: '垃圾信息与广告审核',
      body: '基于 TypeSafe 的 Jev：判断有明确类型与置信度，引用依据段落，每项决定都可由人推翻。',
    },
    'auto-tagging': {
      title: '跟得上内容的标签',
      body: '从共享词表为帖子与书籍提出标签，逐项附上适用理由与剧透程度。',
    },
    'relation-maintenance': {
      title: '关系，持续更新',
      body: '新角色、人物或地点出现时，智能体提议将它连到相关作品与实体。',
    },
    normalisation: {
      title: '自由书写，也能整理成结构',
      body: '把闲聊式食谱整理成食材与步骤，再向原作者提出建议。',
    },
    'migration-assistant': {
      title: '迁移助手',
      body: '从其他网站带入书库，与你一同确认版本，报告每条无法匹配的数据。',
    },
    'bring-your-own-agent': {
      title: '带上自己的智能体',
      body: '通过 API 或 MCP 连接你信任的智能体，用你的计算资源运行，凭证权限有限，预算由你设置。',
    },
    'agent-disclosure': {
      title: '自动化操作，一定明说',
      body: '每次智能体操作都记明智能体、运行者与审核者。REZICS 绝不伪造评论、投票或社区成员。',
    },
    realms: {
      title: '社区',
      body: '围绕一个故事、一种语言或一个想法的社区，各有自己的规则、Wiki 与管理员。',
    },
    'follow-join': {
      title: '关注或加入',
      body: '关注社区看动态，加入社区来参与。你选的是哪一种，始终看得清楚。',
    },
    'community-rules': {
      title: '每种语言，都有规则',
      body: '社区用每种语言各列一份规则，管理员对所有人采用相同标准。',
    },
    'newcomer-trust': {
      title: '欢迎新人，不欢迎垃圾信息',
      body: '新成员从适度限制开始，随参与逐步解除，让社区迎接新人，也挡住机器人灌水。',
    },
    'moderation-cases': {
      title: '看得明白的管理',
      body: '举报成为案件，当事人可查看决定、明确理由与申诉渠道。',
    },
    recognition: {
      title: '肯定真正有帮助的贡献',
      body: '社区等级来自被采纳的实质贡献，例如有帮助的评论、修正与翻译，不靠连续签到。',
    },
    'sell-books-games': {
      title: '图书与游戏，直接销售',
      body: '签约创作者在 REZICS 销售权利已确认的图书、小型游戏与视觉小说，提供试阅、更新与退款。',
    },
    'drm-free': {
      title: '文件，始终在你手里',
      body: '无 DRM 的 EPUB、PDF 与游戏文件，随时都能从书库重新下载。',
    },
    'clear-statements': {
      title: '每笔扣款，都列在结算单上',
      body: '创作者逐笔看到税款、支付手续费与退款，也清楚知道实际到账多少。',
    },
    'edition-storefront': {
      title: '买到你要的版本',
      body: '读者选择需要的语言与版本，翻译版的页面也清楚署名译者。',
    },
    'rights-declarations': {
      title: '权利，说清楚',
      body: '每部作品都说明创作者、译者，以及读者可如何使用。',
    },
    'connected-store': {
      title: '书、社区与 Wiki，在同一处',
      body: '购买就在作品的讨论与 Wiki 旁，不必跳到另一个商店。',
    },
    'open-api': {
      title: '完整产品，都能通过 API 使用',
      body: '每项人能执行的操作都有文档，结果可由程序读取，请求也能安全重试。',
    },
    'scoped-credentials': {
      title: '凭证权限，刚好够用',
      body: '只授予工具所需资源上的必要权限，并能集中撤销。',
    },
    'actionable-errors': {
      title: '程序能处理的错误',
      body: '标准错误详情会说明问题与下一步，从权限被拒，到修订版本过旧，都能处理。',
    },
    'event-stream': {
      title: '事件，断线也能续接',
      body: '用持久游标追踪变更，断线后准确回到上次位置。',
    },
    'typescript-sdk': {
      title: 'TypeScript SDK',
      body: '与 API 使用同一份定义，生成有类型的客户端。',
    },
    'developer-portal': {
      title: '与实现同步的文档',
      body: '参考文档、快速入门与能力列表，都从 API 本身使用的注册表生成。',
    },
    'suitability-gates': {
      title: '内容尺度，自己掌握',
      body: '全年龄、青少年、性与猎奇内容分别选择；未分级就是未分级，绝不当作全年龄内容。',
    },
    'ai-disclosure': {
      title: 'AI 使用，明确披露',
      body: '文字、图像与翻译都注明是否使用 AI、是否经人工审核，也能据此筛选。',
    },
    'no-training': {
      title: '你的草稿与阅读记录，不是训练数据。',
      body: '除非你主动同意，REZICS 不会用私人草稿或阅读记录训练，也绝不把 AI 检测器的结果当作裁决。',
    },
    'no-trackers': {
      title: '没有跟踪器',
      body: '本站没有广告跟踪器或第三方分析工具，只用两个 Cookie 记住语言与主题。',
    },
    'reporting-appeals': {
      title: '任何问题都能举报，任何决定都能申诉',
      body: '无论是否登录，任何人都能举报。每项决定都附上理由与申诉方式。',
    },
    'safety-response': {
      title: '优先处理最严重的伤害',
      body: '已知儿童虐待影像在上传时拦截；未经同意传播的私密影像，收到有效举报后 48 小时内移除。',
    },
  },
  ja: {
    'native-multilingual': {
      title: '物語には、その物語の言語を。',
      body: 'タイトル、版、翻訳、会話は書かれた言語のまま。画面の言語で読む内容を決めたり、黙って英語に差し替えたりしません。',
    },
    'portable-data': {
      title: 'ライブラリは、持ち出せるあなたのもの。',
      body: 'ライブラリ、メモ、レビュー、草稿をほかのツールで読める形式で丸ごと書き出し。再取り込みしても、日付も再読も版も失いません。',
    },
    'sourced-knowledge': {
      title: '知識には、出典を。',
      body: 'Wikiの情報には出典の章を記載。エージェントが提案し、人が確認し、どの変更も経緯をたどって取り消せます。',
    },
    'api-agent-first': {
      title: 'あなたにできることは、道具にも。',
      body: 'REZICSの操作はすべてAPIから。アプリ、スクリプト、エージェントもあなたと同じことができ、その権限を越えることはありません。',
    },
    'open-source': {
      title: '開かれた開発。',
      body: 'コードは公開されています。仕組みを読み、自分で動かし、改善に参加できます。',
    },
    'names-every-script': {
      title: 'どの文字でも、名前を探せる',
      body: '作品や人物、キャラクターの名前を、各言語・文字と読みで保持。どの表記でも探せて、読み慣れた形で表示できます。',
    },
    'shared-tags': {
      title: 'タグも、読める言語で',
      body: '共通の語彙を翻訳して、みんなで使います。日本語で付けたタグも、英語、繁体字中国語など、名前が用意された言語で読めます。',
    },
    'reviewed-translations': {
      title: '人の手で訳すあらすじ',
      body: '読者があらすじや説明の訳を提案し、ほかの変更と同様に人が確認します。訳がなければ原文と明示して表示し、推測で埋めません。',
    },
    'saved-lists': {
      title: '自分で組み立てるリスト',
      body: 'REZICSのどんな内容もリストに。リスト・表・ギャラリーで表示し、自分なりに絞り込んで、非公開にも共有にもできます。',
    },
    'one-identity': {
      title: 'どこでも、ひとつのプロフィール',
      body: 'どのコミュニティ、作品の種類、言語でも同じプロフィール。投稿した場所が変わっても、書いたものや積み上げた信頼はあなたについてきます。',
    },
    'works-across-platforms': {
      title: 'さまざまな版、ひとつの物語',
      body: 'Web連載、ライトノベル、マンガ、アニメ、ゲームがひとつの物語としてつながり、各々の発売情報も保持。出会った場所が違うファンも同じページに集まります。',
    },
    'every-kind': {
      title: 'どの種類にも、充実したページ',
      body: '表紙、各言語の名前、情報、関係、評価、レビュー、議論、Wiki、リスト、出典。同じ部品でどの作品にも完全なページを用意し、新しい種類はコードではなく設定で追加できます。',
    },
    'portable-library': {
      title: '版までわかるライブラリ',
      body: '紙の本、電子書籍、翻訳を同じ物語の別の本として並べ、読んでいる1冊を示します。',
    },
    'reading-sessions': {
      title: '読書を、ありのままに',
      body: '再読も休憩も中断も、途中で形式を変えた読書も重複なく記録。ページ、割合、分数で進捗を残せます。',
    },
    'library-import': {
      title: '読書履歴と一緒に',
      body: 'Goodreads、StoryGraph、表計算から取り込み、読んだ版に行ごとに照合。候補が似ていれば自分で選び、反映前に引き継げない内容を確認できます。',
    },
    'library-export': {
      title: 'すべて持ち出せる',
      body: '日付、メモ、版を保ったままライブラリを書き出し、REZICSにもほかの場所にも取り込めます。',
    },
    'copies-loans': {
      title: '蔵書、借りた本、返却期限',
      body: '蔵書と借りた本、返却期限を分けて管理。読書履歴は変わりません。',
    },
    'review-targets': {
      title: '何を評価したかがわかるレビュー',
      body: '物語、翻訳、朗読を別々に評価。すぐれた本が、翻訳の出来だけで低評価にならないように。',
    },
    'reading-notes': {
      title: 'あの一節に、メモを',
      body: '版と正確な一節に結びつく非公開メモ。共有するかどうかは自分で選べます。',
    },
    'series-tracking': {
      title: '全巻をひとつのページに',
      body: '各巻の日本語原版、公式翻訳、ファン翻訳を並べ、持っている巻と読んだ巻を表示します。',
    },
    'edition-coverage': {
      title: '版を混同しない',
      body: '単巻、合本、特装版、地域ごとの発売は別々に記録。タイトルの一致だけでは推測しません。',
    },
    'translation-availability': {
      title: '読む言語の次巻を',
      body: '読む言語でシリーズを追い、それぞれの次巻と、わかり次第その発売日を確認できます。',
    },
    'release-alerts': {
      title: '発売を、その日に知る',
      body: '読む言語の次巻に日付が付いた時や発売時に1通通知。読まない言語の案内は送りません。',
    },
    'translation-provenance': {
      title: '公式・ファン・機械翻訳を明確に',
      body: '誰がどう訳したかを表示。ファン翻訳はチーム名、機械翻訳はその旨を明記し、進捗も示します。',
    },
    'light-novels-zone': {
      title: 'ライトノベルZone',
      body: '新刊、翻訳完了、読む言語での議論を、ほかのZoneと同じカタログから集めます。',
    },
    'serial-writing': {
      title: '消えない原稿',
      body: '保存のたびに戻せる版を残し、オフラインで書いた章は再接続まで端末に安全に保管します。',
    },
    'serial-scheduling': {
      title: '自分の予定で公開',
      body: '自分のタイムゾーンで章を予約し、読者に届く版と時刻を正確に確認できます。',
    },
    'serial-reading': {
      title: '段落の途中から続きを',
      body: 'どの端末でも前回の段落に戻れ、次の章はいつでもワンタップで開けます。',
    },
    'chapter-discussion': {
      title: '読み終えた章を語る',
      body: '章のそばにあるコメントは段落に紐づき、まだ読んでいない展開を明かしません。',
    },
    collaborators: {
      title: '編集者を迎える',
      body: '試読者には読む権限、編集者には提案、共著者には編集を。公開の判断はあなたに残ります。',
    },
    'author-backup': {
      title: '丸ごと残せるバックアップ',
      body: '作品全体を改稿履歴、メモ、世界設定ごと、再取り込みできるオープンな形式でダウンロード。',
    },
    'vn-releases': {
      title: '実際に遊べる版を',
      body: '言語、対応機種、版でビジュアルノベルを絞り込み、各発売版を並べて比較できます。',
    },
    'release-provenance': {
      title: '翻訳の来歴をたどれる',
      body: '週末をまるごと使う前に、訳者、翻訳元の版、完成度を確かめられます。',
    },
    'anime-episodes': {
      title: 'アニメを1話ずつ記録',
      body: '分割クールや特別編も含め、シーズンと話数を記録。次の話をネタバレせずに語れます。',
    },
    'one-list': {
      title: '全部をひとつのリストに',
      body: 'アニメ、マンガ、小説、ゲームを同じリストに。話、章、巻、ルートと、それぞれの単位で記録します。',
    },
    'spoiler-position': {
      title: 'ネタバレは、進んだ先に出さない',
      body: '議論、タグ、Wikiは、読んだ章や観た話より先の内容を伏せます。',
    },
    'acgn-zone': {
      title: 'ACGN Zone',
      body: '今期の作品、新たな発売、追っている物語のメディア展開を、観る・読む・遊ぶ人へ。',
    },
    'realm-wikis': {
      title: '作品ごとにWikiを',
      body: '人物、場所、勢力、出来事にそれぞれページを用意。情報欄、リンク、被リンク、議論を備えます。',
    },
    'chapter-citations': {
      title: '章を示す出典',
      body: '記述ごとに出典の章と版を示し、読者が確認し、編集者が訂正できます。',
    },
    'spoiler-safe-wiki': {
      title: '読んだ章までのWikiを読む',
      body: 'どこまで読んだかを指定すると、ページも検索結果も情報欄も、そこまでに明かされたことだけを表示します。',
    },
    'wiki-builder': {
      title: 'Wiki作成エージェント',
      body: '許諾を得たテキストや作者提供の本文を一章ずつ読み、出典つきの情報を提案。公開は確認者が行い、下書きを任せるかは各コミュニティが決めます。',
    },
    'world-bible': {
      title: '原稿の隣に世界設定集',
      body: '人物、場所、伝承を草稿の隣に非公開で保管し、選んだページだけ作品のWikiとして公開できます。',
    },
    'world-visuals': {
      title: '地図・関係図・年表',
      body: '自作の地図に場所を置き、関係を描き、架空の暦に出来事を配置。どの図にも読める一覧がつきます。',
    },
    'wiki-history': {
      title: 'すべての編集を確認し、元に戻せる',
      body: 'すべてのページに履歴・差分・確認・復元を用意。Wiki全体の書き出しを有料機能にはしません。',
    },
    'contribution-protocol': {
      title: 'ひとつの公開プロトコル',
      body: '公式も外部のエージェントも、具体的な変更、根拠、検証される確信度を同じ提案形式で提出。確認なしには反映しません。',
    },
    'spam-review': {
      title: 'スパム・広告の確認',
      body: 'TypeSafeのJevが基盤。型と確信度を持つ判断に根拠の一節を添え、人はどの判断も覆せます。',
    },
    'auto-tagging': {
      title: '内容に追いつくタグ',
      body: '投稿と本に共通語彙からタグを提案し、適用理由とネタバレ範囲をそれぞれ示します。',
    },
    'relation-maintenance': {
      title: '関係を最新に保つ',
      body: '新たなキャラクター、人物、場所が現れたら、関連する作品や項目につなぐ提案をします。',
    },
    normalisation: {
      title: '自由な投稿に、構造を',
      body: 'おしゃべりのようなレシピ投稿を材料と手順に整理し、作者に提案します。',
    },
    'migration-assistant': {
      title: '移行アシスタント',
      body: 'ほかのサイトからライブラリを移し、版の確認を手伝い、照合できない行をすべて報告します。',
    },
    'bring-your-own-agent': {
      title: '自分のエージェントをつなぐ',
      body: '信頼するエージェントをAPIやMCPで接続。自分の計算資源で、限定した権限と決めた予算の範囲で動かします。',
    },
    'agent-disclosure': {
      title: '自動化は必ず明示',
      body: '操作ごとにエージェント、運用者、確認者を明記。REZICSはレビュー、投票、メンバーを捏造しません。',
    },
    realms: {
      title: 'コミュニティ',
      body: '物語、言語、考えを中心とするコミュニティに、それぞれのルール、Wiki、モデレーターを。',
    },
    'follow-join': {
      title: 'フォローか、加入か',
      body: '読むならフォロー、参加するなら加入。どちらを選んだかが常にわかります。',
    },
    'community-rules': {
      title: '各言語で読めるルール',
      body: '言語ごとにルールを示し、モデレーターは全員に同じルールを適用します。',
    },
    'newcomer-trust': {
      title: '新しい仲間を迎え、スパムを防ぐ',
      body: '新規メンバーには軽い制限を設け、参加に応じて解除。人を歓迎しながらボットを防げます。',
    },
    'moderation-cases': {
      title: '経緯がわかるモデレーション',
      body: '通報は案件として扱い、判断、理由、異議申し立ての手段を当事者に示します。',
    },
    recognition: {
      title: '役に立つ貢献に、評価を',
      body: '役立つレビュー、訂正、翻訳など、採用された貢献でコミュニティ内のレベルが上がります。連続ログインでは上がりません。',
    },
    'sell-books-games': {
      title: '本とゲームを直接届ける',
      body: '契約クリエイターが権利処理済みの本、小規模ゲーム、ビジュアルノベルを販売。サンプル、更新、返金にも対応します。',
    },
    'drm-free': {
      title: '手元に残るファイル',
      body: 'DRMなしのEPUB・PDFの本とゲームを、いつでもライブラリから再ダウンロードできます。',
    },
    'clear-statements': {
      title: '控除はすべて明細に',
      body: '税金、決済手数料、返金を1行ずつ確認でき、手元に届く金額も正確にわかります。',
    },
    'edition-storefront': {
      title: '欲しい版を買う',
      body: '読みたい言語と版を選べ、翻訳版には訳者名をページに記載します。',
    },
    'rights-declarations': {
      title: '権利を、明確に',
      body: '作品ごとに作者、訳者、読者に許される利用を明記します。',
    },
    'connected-store': {
      title: '本、コミュニティ、Wikiが一緒に',
      body: '購入は作品の議論やWikiの隣にあり、別のストアに切り離されません。',
    },
    'open-api': {
      title: '製品全体をAPIで',
      body: '人ができる操作はすべて文書化。結果はコードで読め、リクエストを安全に再試行できます。',
    },
    'scoped-credentials': {
      title: '仕事に合わせた認証情報',
      body: '必要な資源への必要な権限だけを道具に与え、ひとつの場所で取り消せます。',
    },
    'actionable-errors': {
      title: 'コードで対処できるエラー',
      body: '権限不足から古い版まで、標準のエラー詳細が原因と次の対処を示します。',
    },
    'event-stream': {
      title: '再開できるイベント',
      body: '永続カーソルで変更を追い、切断後も前回の位置から正確に再開します。',
    },
    'typescript-sdk': {
      title: 'TypeScript SDK',
      body: 'APIと同じ定義から型付きクライアントを生成します。',
    },
    'developer-portal': {
      title: '実装とずれないドキュメント',
      body: 'リファレンス、クイックスタート、機能一覧を、API自身が使うレジストリから生成します。',
    },
    'suitability-gates': {
      title: '見る内容を自分で選ぶ',
      body: '全年齢向け、青少年向け、性的、グロテスクな内容を別々に選択。未分類を全年齢向けとみなしません。',
    },
    'ai-disclosure': {
      title: 'AI利用を明記',
      body: '文章、絵、翻訳のAI利用と人による確認の有無を示し、それで絞り込めます。',
    },
    'no-training': {
      title: '草稿と読書履歴は、学習データではない',
      body: '明示的な同意なしに非公開の草稿や読書履歴を学習に使わず、AI検出器の結果を判決扱いしません。',
    },
    'no-trackers': {
      title: 'トラッカーなし',
      body: '広告トラッカーも第三者解析も使いません。2つのCookieで言語とテーマを覚えます。',
    },
    'reporting-appeals': {
      title: '何でも通報でき、どの判断にも異議を申し立てられる',
      body: 'ログインしていなくても通報でき、すべての判断に理由と異議申し立ての方法を添えます。',
    },
    'safety-response': {
      title: '深刻な被害に優先対応',
      body: '既知の児童虐待画像はアップロード時に遮断。同意なく共有された私的な性的画像は、有効な通報から48時間以内に削除します。',
    },
  },
  ko: {
    'native-multilingual': {
      title: '모든 이야기는 자신의 언어를 지킵니다.',
      body: '제목, 판본, 번역, 대화는 쓰인 언어 그대로 남습니다. 인터페이스 언어가 읽을 내용을 정하지 않고, 몰래 영어로 바꾸지도 않습니다.',
    },
    'portable-data': {
      title: '내 서재는 언제든 가져갈 수 있어요.',
      body: '서재, 메모, 리뷰, 초고를 다른 도구에서 읽을 수 있는 형식으로 통째로 내보내고, 날짜·재독·판본 하나 잃지 않고 다시 가져옵니다.',
    },
    'sourced-knowledge': {
      title: '지식에는 출처가 있습니다.',
      body: '위키 정보는 출처 장을 인용합니다. 에이전트가 제안하고 사람이 검토하며, 모든 변경은 추적하고 되돌릴 수 있습니다.',
    },
    'api-agent-first': {
      title: '내가 할 수 있는 일은 도구도 할 수 있어요.',
      body: '모든 REZICS 작업은 API에서 시작합니다. 앱, 스크립트, 에이전트는 나와 같은 권한으로 일하며 그 이상은 할 수 없습니다.',
    },
    'open-source': {
      title: '공개적으로 만듭니다.',
      body: '코드를 공개합니다. REZICS의 작동 방식을 살펴보고, 직접 운영하고, 개선에 참여하세요.',
    },
    'names-every-script': {
      title: '모든 문자로 담는 이름',
      body: '작품과 인물, 캐릭터의 이름을 언어·문자·발음별로 보관합니다. 어떤 표기로든 찾고 읽기 익숙한 이름으로 볼 수 있습니다.',
    },
    'shared-tags': {
      title: '내 언어로 보는 태그',
      body: '태그는 한 번 번역해 함께 쓰는 공통 어휘에서 나옵니다. 일본어로 붙인 태그도 영어, 번체 중국어 등 이름이 있는 언어로 읽을 수 있습니다.',
    },
    'reviewed-translations': {
      title: '사람이 번역한 줄거리',
      body: '독자가 줄거리나 설명의 번역을 제안하면 다른 수정처럼 검토를 받습니다. 번역이 없을 때는 원문임을 표시해 보여 주며 추측으로 채우지 않습니다.',
    },
    'saved-lists': {
      title: '내 방식으로 만드는 목록',
      body: 'REZICS의 무엇이든 목록으로 모아 리스트, 표, 갤러리로 보세요. 원하는 대로 필터링하고 비공개로 두거나 공유할 수 있습니다.',
    },
    'one-identity': {
      title: '어디서나 하나의 프로필',
      body: '하나의 프로필이 모든 커뮤니티, 이야기 유형, 언어를 함께합니다. 어디에 글을 쓰든 작성한 내용과 쌓아 온 평판은 내 것으로 남습니다.',
    },
    'works-across-platforms': {
      title: '여러 버전, 하나의 이야기',
      body: '웹 연재, 라이트 노벨, 만화, 애니메이션, 게임을 한 이야기로 연결하고 각각의 출시 정보를 보관합니다. 다른 곳에서 만난 팬들도 같은 페이지에 모입니다.',
    },
    'every-kind': {
      title: '모든 유형에 완전한 페이지',
      body: '표지, 언어별 이름, 정보, 관계, 평점, 리뷰, 토론, 위키, 목록, 출처까지 같은 구성 요소로 완전한 페이지를 만듭니다. 새 유형은 코드 대신 설정으로 추가합니다.',
    },
    'portable-library': {
      title: '판본을 아는 서재',
      body: '종이책, 전자책, 번역본을 한 이야기의 서로 다른 책으로 꽂고 읽는 판본을 표시합니다.',
    },
    'reading-sessions': {
      title: '독서를 있는 그대로',
      body: '재독, 휴식, 잠시 내려놓기, 중간에 형식 바꾸기까지 중복 없이 기록하고 페이지·퍼센트·분으로 진도를 남깁니다.',
    },
    'library-import': {
      title: '독서 이력 가져오기',
      body: 'Goodreads, StoryGraph, 스프레드시트에서 가져와 읽은 판본과 행별로 맞춥니다. 비슷한 후보는 직접 고르고, 변경 전에 옮기지 못할 정보를 확인합니다.',
    },
    'library-export': {
      title: '모두 가져가세요',
      body: '날짜, 메모, 판본을 온전히 내보내 REZICS나 다른 곳으로 가져갈 수 있습니다.',
    },
    'copies-loans': {
      title: '소장, 대출, 반납일',
      body: '소장본, 빌린 책, 반납일을 구분해 관리하며 독서 기록에는 영향을 주지 않습니다.',
    },
    'review-targets': {
      title: '평가 대상을 분명히 하는 리뷰',
      body: '이야기, 번역, 낭독을 각각 평가해 서툰 번역이 좋은 책의 평가를 떨어뜨리지 않게 합니다.',
    },
    'reading-notes': {
      title: '구절에 남기는 메모',
      body: '판본의 정확한 구절에 비공개 메모를 남기고, 원할 때만 공유합니다.',
    },
    'series-tracking': {
      title: '시리즈 전체를 한 페이지에',
      body: '각 권의 일본어 원서, 정식 번역, 팬 번역을 나란히 놓고 소장·읽음 상태를 표시합니다.',
    },
    'edition-coverage': {
      title: '판본을 혼동하지 않게',
      body: '단권, 합본, 특별판, 지역별 출시는 각각 기록하며 같은 제목만으로 추측하지 않습니다.',
    },
    'translation-availability': {
      title: '읽는 언어의 다음 권',
      body: '읽는 언어로 시리즈를 팔로우하고 각 언어의 다음 권과 발표된 날짜를 확인합니다.',
    },
    'release-alerts': {
      title: '발매 당일에 알기',
      body: '읽는 언어의 다음 권 발매일이 정해지거나 출시되면 한 번 알려 드립니다. 읽지 않는 언어는 알리지 않습니다.',
    },
    'translation-provenance': {
      title: '정식·팬·기계 번역을 분명하게',
      body: '번역자와 번역 방식을 밝힙니다. 팬 팀은 이름을 표시하고 기계 번역은 명시하며 진행 상황도 보여 줍니다.',
    },
    'light-novels-zone': {
      title: '라이트 노벨 Zone',
      body: '신간, 완역 소식, 읽는 언어의 토론을 다른 Zone과 같은 작품 목록에서 모읍니다.',
    },
    'serial-writing': {
      title: '사라지지 않는 원고',
      body: '저장할 때마다 복원 가능한 수정본을 남기고, 오프라인에서 쓴 원고는 재연결까지 기기에 안전하게 보관합니다.',
    },
    'serial-scheduling': {
      title: '내 일정대로 발행',
      body: '내 시간대에 맞춰 예약하고 독자가 어떤 수정본을 언제 받을지 정확히 확인합니다.',
    },
    'serial-reading': {
      title: '읽던 문단에서 이어 읽기',
      body: '어떤 기기에서든 멈췄던 문단으로 돌아가고 다음 화를 한 번만 눌러 엽니다.',
    },
    'chapter-discussion': {
      title: '방금 읽은 화 이야기하기',
      body: '댓글은 해당 화 곁에서 문단에 연결되며 아직 읽지 않은 내용을 드러내지 않습니다.',
    },
    collaborators: {
      title: '편집자와 함께',
      body: '베타 리더는 읽고 편집자는 제안하고 공동 작가는 수정하도록 초대하세요. 발행 권한은 직접 갖습니다.',
    },
    'author-backup': {
      title: '빠짐없는 백업',
      body: '작품 전체를 수정 이력, 메모, 세계관과 함께 다시 가져올 수 있는 개방형 형식으로 내려받습니다.',
    },
    'vn-releases': {
      title: '실제로 플레이할 수 있는 버전',
      body: '언어, 플랫폼, 판본으로 비주얼 노벨을 필터링하고 모든 출시 버전을 나란히 비교합니다.',
    },
    'release-provenance': {
      title: '이력이 있는 번역',
      body: '주말을 통째로 쓰기 전에 번역자, 원본 버전, 번역 완성도를 확인하세요.',
    },
    'anime-episodes': {
      title: '애니를 에피소드별로',
      body: '분할 방영과 특별편까지 시즌과 에피소드를 기록하고 다음 화 스포일러 없이 이야기합니다.',
    },
    'one-list': {
      title: '하나의 목록에 모두',
      body: '애니, 만화, 소설, 게임을 한 목록에서 에피소드, 화, 권, 루트 등 각자의 단위로 셉니다.',
    },
    'spoiler-position': {
      title: '스포일러는 내 진도에서 멈춤',
      body: '토론, 태그, 위키는 도달한 에피소드나 장 뒤의 내용을 숨깁니다.',
    },
    'acgn-zone': {
      title: 'ACGN Zone',
      body: '이번 시즌, 새 출시, 팔로우하는 이야기의 각색 소식을 보고 읽고 플레이하는 사람들에게 전합니다.',
    },
    'realm-wikis': {
      title: '작품마다 위키',
      body: '인물, 장소, 세력, 사건마다 정보 상자, 링크, 역링크, 토론을 갖춘 페이지를 둡니다.',
    },
    'chapter-citations': {
      title: '출처 장이 있는 정보',
      body: '모든 서술에 출처 장과 판본을 연결해 독자는 확인하고 편집자는 고칠 수 있습니다.',
    },
    'spoiler-safe-wiki': {
      title: '읽은 장에 맞춰 보는 위키',
      body: '읽은 지점을 알려 주면 모든 페이지, 검색 결과, 정보 상자가 그때까지 밝혀진 내용만 보여 줍니다.',
    },
    'wiki-builder': {
      title: '위키 작성 도우미',
      body: '허가받은 텍스트와 작가가 제공한 원문을 한 장씩 읽고 출처 있는 정보를 제안합니다. 검토자가 공개하고, 초안 허용 여부는 각 커뮤니티가 정합니다.',
    },
    'world-bible': {
      title: '원고 곁의 세계관 설정집',
      body: '작가는 초고 곁에 인물, 장소, 설정을 비공개로 두고 고른 페이지만 작품 위키로 공개합니다.',
    },
    'world-visuals': {
      title: '지도, 관계, 연표',
      body: '내 지도에 장소를 찍고 관계를 그리고 가상 달력에 사건을 배치합니다. 각 시각 자료 곁에 읽을 수 있는 목록도 둡니다.',
    },
    'wiki-history': {
      title: '모든 편집을 검토하고 되돌리기',
      body: '모든 페이지에서 이력, 비교, 검토, 복원을 제공하고 위키 전체를 한 번에 내보냅니다. 내보내기는 유료로 막지 않습니다.',
    },
    'contribution-protocol': {
      title: '하나의 개방형 프로토콜',
      body: '공식·외부 에이전트 모두 정확한 변경, 근거, 검증받을 신뢰도를 같은 제안 형식으로 제출합니다. 검토 없이는 적용하지 않습니다.',
    },
    'spam-review': {
      title: '스팸·광고 검토',
      body: 'TypeSafe의 Jev를 기반으로 타입과 신뢰도를 갖춘 판단에 근거 구절을 인용합니다. 사람은 모든 결정을 뒤집을 수 있습니다.',
    },
    'auto-tagging': {
      title: '내용에 맞춰가는 태그',
      body: '게시물과 책에 공통 어휘의 태그를 제안하고 각 이유와 스포일러 수준을 표시합니다.',
    },
    'relation-maintenance': {
      title: '관계를 최신으로',
      body: '새 캐릭터, 인물, 장소가 등장하면 에이전트가 관련 작품과 항목에 연결하도록 제안합니다.',
    },
    normalisation: {
      title: '자유로운 글을 구조화',
      body: '이야기하듯 쓴 레시피를 재료와 순서로 정리해 원작자에게 제안합니다.',
    },
    'migration-assistant': {
      title: '이전 도우미',
      body: '다른 사이트의 서재를 가져와 함께 판본을 확인하고 맞추지 못한 모든 행을 보고합니다.',
    },
    'bring-your-own-agent': {
      title: '내 에이전트 연결하기',
      body: '신뢰하는 에이전트를 API나 MCP로 연결하세요. 내 컴퓨팅 자원에서 제한된 인증 범위와 직접 정한 예산으로 실행합니다.',
    },
    'agent-disclosure': {
      title: '자동화는 반드시 공개',
      body: '모든 에이전트 작업에 에이전트, 운영자, 검토자를 명시합니다. REZICS는 리뷰, 투표, 회원을 꾸며내지 않습니다.',
    },
    realms: {
      title: '커뮤니티',
      body: '이야기, 언어, 생각을 중심으로 모이며 각자 규칙, 위키, 운영자를 둡니다.',
    },
    'follow-join': {
      title: '팔로우 또는 가입',
      body: '소식을 읽으려면 팔로우하고, 참여하려면 가입하세요. 어떤 상태를 선택했는지 항상 알 수 있습니다.',
    },
    'community-rules': {
      title: '모든 언어로 된 규칙',
      body: '커뮤니티는 언어별로 규칙을 명시하고 운영자는 모두에게 같은 규칙을 적용합니다.',
    },
    'newcomer-trust': {
      title: '새 회원은 환영하고 스팸은 막기',
      body: '새 회원은 가벼운 제한으로 시작해 참여하면서 풀립니다. 사람을 맞이하면서 스팸 봇은 막습니다.',
    },
    'moderation-cases': {
      title: '과정을 알 수 있는 운영',
      body: '신고를 사건으로 처리하며 결정, 명시된 이유, 이의 제기 절차를 당사자가 볼 수 있습니다.',
    },
    recognition: {
      title: '실질적인 도움에 주는 인정',
      body: '커뮤니티 등급은 유용한 리뷰, 정정, 번역 등 채택된 기여로 올립니다. 연속 출석으로는 오르지 않습니다.',
    },
    'sell-books-games': {
      title: '책과 게임 직접 판매',
      body: '계약 창작자가 권리를 확보한 책, 소규모 게임, 비주얼 노벨을 판매하며 샘플, 업데이트, 환불을 제공합니다.',
    },
    'drm-free': {
      title: '계속 내 것으로 남는 파일',
      body: 'DRM 없는 EPUB, PDF 책과 게임을 원할 때 서재에서 다시 내려받습니다.',
    },
    'clear-statements': {
      title: '모든 공제를 정산서에',
      body: '창작자는 세금, 결제 수수료, 환불을 항목별로 보고 실제 받는 금액을 정확히 확인합니다.',
    },
    'edition-storefront': {
      title: '원하는 판본 구매',
      body: '독자는 원하는 언어와 판본을 고르고 번역판 페이지에서 번역자를 확인합니다.',
    },
    'rights-declarations': {
      title: '권리를 명확하게',
      body: '작품마다 창작자, 번역자, 독자가 할 수 있는 이용을 명시합니다.',
    },
    'connected-store': {
      title: '책, 커뮤니티, 위키를 함께',
      body: '구매는 별도 상점이 아니라 작품의 토론과 위키 곁에 있습니다.',
    },
    'open-api': {
      title: '제품 전체를 API로',
      body: '사람이 수행할 수 있는 모든 작업을 문서화하고, 코드로 읽을 수 있는 결과와 안전한 재시도를 제공합니다.',
    },
    'scoped-credentials': {
      title: '작업에 맞춘 인증 정보',
      body: '도구에 필요한 리소스의 필요한 권한만 부여하고 한곳에서 철회합니다.',
    },
    'actionable-errors': {
      title: '코드로 대응할 수 있는 오류',
      body: '권한 거부부터 오래된 수정본까지, 표준 문제 상세 정보가 원인과 다음 조치를 알려 줍니다.',
    },
    'event-stream': {
      title: '재개할 수 있는 이벤트',
      body: '영속 커서로 변경을 따라가고 연결이 끊겨도 정확한 위치에서 재개합니다.',
    },
    'typescript-sdk': {
      title: 'TypeScript SDK',
      body: 'API와 같은 정의에서 타입이 있는 클라이언트를 생성합니다.',
    },
    'developer-portal': {
      title: '실제 동작과 어긋나지 않는 문서',
      body: '참조 문서, 빠른 시작, 기능 목록을 API 자체가 쓰는 레지스트리에서 생성합니다.',
    },
    'suitability-gates': {
      title: '콘텐츠 범위를 직접 설정',
      body: '일반, 청소년, 성적, 혐오감을 주는 콘텐츠를 각각 선택합니다. 미분류는 일반이 아닌 미분류로 취급합니다.',
    },
    'ai-disclosure': {
      title: 'AI 사용 공개',
      body: '글, 그림, 번역의 AI 사용과 사람 검토 여부를 표시하고 그에 따라 필터링할 수 있습니다.',
    },
    'no-training': {
      title: '초고와 독서는 학습 데이터가 아닙니다',
      body: '직접 동의하지 않으면 비공개 초고나 독서 기록으로 학습하지 않으며, AI 탐지 결과를 판결처럼 쓰지 않습니다.',
    },
    'no-trackers': {
      title: '추적기 없음',
      body: '광고 추적기와 외부 분석 도구가 없습니다. 쿠키 두 개로 언어와 테마만 기억합니다.',
    },
    'reporting-appeals': {
      title: '무엇이든 신고하고 모든 결정에 이의 제기',
      body: '로그인 여부와 관계없이 누구나 신고할 수 있습니다. 모든 결정에 이유와 이의 제기 방법이 따릅니다.',
    },
    'safety-response': {
      title: '가장 심각한 피해부터 처리',
      body: '알려진 아동 학대 이미지는 업로드 시 차단하고, 동의 없이 공유된 사적 성적 이미지는 유효한 신고 후 48시간 이내에 삭제합니다.',
    },
  },
  de: {
    'native-multilingual': {
      title: 'Jede Geschichte behält ihre Sprache.',
      body: 'Titel, Ausgaben, Übersetzungen und Gespräche bleiben in ihrer ursprünglichen Sprache. Die Oberflächensprache bestimmt nicht deine Lektüre; nichts wird stillschweigend durch Englisch ersetzt.',
    },
    'portable-data': {
      title: 'Deine Bibliothek gehört dir, auch zum Mitnehmen.',
      body: 'Exportiere Bibliothek, Notizen, Rezensionen und Entwürfe vollständig in lesbaren Formaten für andere Tools. Beim Rückimport gehen weder Datum noch erneutes Lesen noch Ausgabe verloren.',
    },
    'sourced-knowledge': {
      title: 'Wissen zeigt seine Quellen.',
      body: 'Wiki-Fakten nennen ihr Kapitel. Agenten schlagen vor, Menschen prüfen. Jede Änderung ist nachvollziehbar und rücknehmbar.',
    },
    'api-agent-first': {
      title: 'Was du kannst, können auch deine Tools.',
      body: 'Jede Aktion ist zuerst eine API-Operation. Apps, Skripte und Agenten haben dieselben Möglichkeiten wie du, niemals mehr.',
    },
    'open-source': {
      title: 'Offen entwickelt.',
      body: 'Der Code ist öffentlich: verstehen, selbst betreiben und verbessern.',
    },
    'names-every-script': {
      title: 'Namen in jeder Schrift',
      body: 'Werke, Personen und Figuren tragen Namen in jeder Sprache und Schrift samt Lesung. So findest du sie unter jeder Schreibweise und siehst sie in deiner vertrauten Form.',
    },
    'shared-tags': {
      title: 'Tags in deiner Sprache',
      body: 'Tags stammen aus einem gemeinsamen, einmal übersetzten Vokabular. Ein japanisch gesetztes Tag erscheint auf Englisch, traditionellem Chinesisch oder in jeder Sprache mit vorhandenem Namen.',
    },
    'reviewed-translations': {
      title: 'Von Menschen übersetzte Inhaltsangaben',
      body: 'Leser schlagen Übersetzungen von Inhaltsangaben und Beschreibungen vor, andere prüfen sie. Fehlt eine Übersetzung, siehst du das gekennzeichnete Original, keine Vermutung.',
    },
    'saved-lists': {
      title: 'Listen nach deinem Geschmack',
      body: 'Alles auf REZICS sammeln, als Liste, Tabelle oder Galerie ansehen, selbst filtern und privat halten oder teilen.',
    },
    'one-identity': {
      title: 'Eine Identität, überall',
      body: 'Ein Profil begleitet dich durch Communitys, Werkarten und Sprachen. Was du schreibst und wofür du bekannt bist, bleibt überall mit dir verbunden.',
    },
    'works-across-platforms': {
      title: 'Alle Fassungen, eine Geschichte',
      body: 'Webroman, Light Novel, Manga, Anime und Spiel sind als eine Geschichte verbunden, mit eigenen Veröffentlichungen. Fans finden aus verschiedenen Orten auf dieselbe Seite.',
    },
    'every-kind': {
      title: 'Eine vollständige Seite für jede Art',
      body: 'Jede Werkart bekommt dieselben Bausteine: Cover, Namen, Fakten, Beziehungen, Bewertungen, Rezensionen, Diskussionen, Wiki, Listen und Quellen. Neue Arten entstehen per Konfiguration statt Code.',
    },
    'portable-library': {
      title: 'Eine Bibliothek, die Ausgaben kennt',
      body: 'Taschenbuch, E-Book und Übersetzung als Exemplare einer Geschichte ablegen, die aktuelle Lektüre markiert.',
    },
    'reading-sessions': {
      title: 'Lesen, wie es wirklich ist',
      body: 'Erneutes Lesen, Pausen, beiseitegelegte Bücher und Formatwechsel mittendrin, jeweils einmal erfasst in Seiten, Prozent oder Minuten.',
    },
    'library-import': {
      title: 'Deinen Verlauf mitbringen',
      body: 'Importiere aus Goodreads, StoryGraph oder Tabellen. Jede Zeile wird der gelesenen Ausgabe zugeordnet; Zweifelsfälle entscheidest du. Fehlende Übernahmen siehst du vor jeder Änderung.',
    },
    'library-export': {
      title: 'Alles mitnehmen',
      body: 'Exportiere die ganze Bibliothek mit Daten, Notizen und Ausgaben und importiere sie in REZICS oder anderswo.',
    },
    'copies-loans': {
      title: 'Besitz, Ausleihe, Rückgabe',
      body: 'Eigene Exemplare, Ausleihen und Fristen getrennt verwalten, ohne den Leseverlauf zu verändern.',
    },
    'review-targets': {
      title: 'Bewertungen mit klarem Bezug',
      body: 'Geschichte, Übersetzung und Lesung getrennt bewerten, damit eine schlechte Übersetzung kein großartiges Buch herunterzieht.',
    },
    'reading-notes': {
      title: 'Notizen zur Textstelle',
      body: 'Private Notizen zur genauen Textstelle und Ausgabe, nur auf deinen Wunsch geteilt.',
    },
    'series-tracking': {
      title: 'Die ganze Reihe auf einer Seite',
      body: 'Japanische Originale, offizielle und Fanübersetzungen aller Bände, neben Besitz und Lesestand.',
    },
    'edition-coverage': {
      title: 'Ausgaben klar auseinanderhalten',
      body: 'Bände, Sammel- und Sonderausgaben sowie regionale Veröffentlichungen bleiben getrennt. Gleiche Titel sind kein Zuordnungsbeleg.',
    },
    'translation-availability': {
      title: 'Der nächste Band in deiner Sprache',
      body: 'Folge Reihen in deinen Lesesprachen und sieh jeweils den nächsten Band samt Termin, sobald er feststeht.',
    },
    'release-alerts': {
      title: 'Am Erscheinungstag Bescheid wissen',
      body: 'Eine Nachricht, wenn der nächste Band in deiner Sprache datiert wird oder erscheint. Keine für Sprachen, die du nicht liest.',
    },
    'translation-provenance': {
      title: 'Offiziell, von Fans oder maschinell',
      body: 'Jede Übersetzung nennt Urheber und Methode. Fangruppen werden gewürdigt, maschinelle Übersetzungen gekennzeichnet und der Fortschritt angezeigt.',
    },
    'light-novels-zone': {
      title: 'Die Light-Novels-Zone',
      body: 'Neue Bände, fertige Übersetzungen und Diskussionen in deinen Sprachen, gesammelt aus dem gemeinsamen Katalog aller Zones.',
    },
    'serial-writing': {
      title: 'Ein Manuskript, das nicht verschwindet',
      body: 'Jedes Speichern erzeugt eine wiederherstellbare Fassung. Offline geschriebene Kapitel bleiben bis zur Verbindung sicher auf deinem Gerät.',
    },
    'serial-scheduling': {
      title: 'Nach deinem Zeitplan veröffentlichen',
      body: 'Plane Kapitel in deiner Zeitzone und sieh genau, welche Fassung Leser wann erhalten.',
    },
    'serial-reading': {
      title: 'Mitten im Absatz weiterlesen',
      body: 'Auf jedem Gerät zum genauen Absatz zurückkehren. Das nächste Kapitel ist immer nur einen Tipp entfernt.',
    },
    'chapter-discussion': {
      title: 'Über das gerade gelesene Kapitel reden',
      body: 'Kommentare stehen am Kapitel, an Absätze gebunden, und verraten nie Ungelesenes.',
    },
    collaborators: {
      title: 'Hol deine Redaktion dazu',
      body: 'Lade Testleser zum Lesen, Lektoren zum Vorschlagen und Mitautoren zum Bearbeiten ein. Das Veröffentlichen bleibt bei dir.',
    },
    'author-backup': {
      title: 'Ein vollständiges Backup',
      body: 'Lade das ganze Werk samt Fassungen, Notizen und Welt in offenen, wieder importierbaren Formaten herunter.',
    },
    'vn-releases': {
      title: 'Die wirklich spielbare Fassung',
      body: 'Filtere Visual Novels nach Sprache, Plattform und Ausgabe und vergleiche Veröffentlichungen nebeneinander.',
    },
    'release-provenance': {
      title: 'Übersetzungen mit Herkunftsnachweis',
      body: 'Bevor du ein Wochenende investierst, siehst du Übersetzer, Ausgangsversion und Vollständigkeit.',
    },
    'anime-episodes': {
      title: 'Anime Folge für Folge',
      body: 'Staffeln und Folgen einschließlich geteilter Cours und Specials verfolgen und ohne Spoiler zur nächsten Folge diskutieren.',
    },
    'one-list': {
      title: 'Eine Liste für alles',
      body: 'Anime, Manga, Romane und Spiele auf einer Liste, jeweils in Folgen, Kapiteln, Bänden oder Routen gezählt.',
    },
    'spoiler-position': {
      title: 'Spoiler enden bei deinem Stand',
      body: 'Diskussionen, Tags und Wikis halten alles nach deiner Folge oder deinem Kapitel zurück.',
    },
    'acgn-zone': {
      title: 'Die ACGN-Zone',
      body: 'Aktuelle Saison, Neuerscheinungen und Adaptionen deiner Geschichten, für alle, die schauen, lesen und spielen.',
    },
    'realm-wikis': {
      title: 'Ein Wiki für jedes Werk',
      body: 'Figuren, Orte, Fraktionen und Ereignisse mit eigener Seite, Infobox, Links, Rückverweisen und Diskussion.',
    },
    'chapter-citations': {
      title: 'Fakten mit Kapitelbelegen',
      body: 'Jede Aussage verweist auf Kapitel und Ausgabe, damit Leser nachprüfen und Redakteure korrigieren können.',
    },
    'spoiler-safe-wiki': {
      title: 'Das Wiki auf deinem Lesestand',
      body: 'Gib deinen Lesestand an. Seiten, Suchergebnisse und Infoboxen zeigen nur, was bis dahin bekannt ist.',
    },
    'wiki-builder': {
      title: 'Der Wiki-Aufbauhelfer',
      body: 'Agenten lesen lizenzierte und von Autoren bereitgestellte Texte kapitelweise und schlagen belegte Fakten vor. Prüfer veröffentlichen. Jede Community entscheidet über Agentenentwürfe.',
    },
    'world-bible': {
      title: 'Die Weltensammlung neben dem Manuskript',
      body: 'Autoren halten Figuren, Orte und Hintergründe privat am Entwurf und veröffentlichen ausgewählte Seiten als Werk-Wiki.',
    },
    'world-visuals': {
      title: 'Karten, Beziehungen und Zeitlinien',
      body: 'Orte auf eigener Karte markieren, Beziehungen zeichnen, Ereignisse in erfundenen Kalendern anordnen, jeweils mit lesbarer Liste.',
    },
    'wiki-history': {
      title: 'Jede Änderung geprüft und rücknehmbar',
      body: 'Historie, Vergleich, Prüfung und Wiederherstellung auf jeder Seite. Das ganze Wiki lässt sich am Stück exportieren, nie hinter einer Bezahlschranke.',
    },
    'contribution-protocol': {
      title: 'Ein offenes Protokoll',
      body: 'Offizielle und externe Agenten reichen dieselben Vorschläge ein: genaue Änderung, Belege und eine überprüfbare Konfidenz. Ohne Prüfung wird nichts angewandt.',
    },
    'spam-review': {
      title: 'Spam- und Werbeprüfung',
      body: 'Auf TypeSafes Jev aufgebaut: typisierte Entscheidungen mit Konfidenz und zitierten Belegen, jede durch Menschen überstimmbar.',
    },
    'auto-tagging': {
      title: 'Tags, die Schritt halten',
      body: 'Beiträge und Bücher erhalten Tag-Vorschläge aus dem gemeinsamen Vokabular, jeweils mit Begründung und Spoilergrad.',
    },
    'relation-maintenance': {
      title: 'Beziehungen aktuell halten',
      body: 'Neue Figuren, Personen oder Orte schlägt ein Agent für ihre zugehörigen Werke und Einträge vor.',
    },
    normalisation: {
      title: 'Freie Beiträge strukturieren',
      body: 'Ein plauderndes Rezept wird seinem Autor als strukturierte Zutatenliste mit Schritten vorgeschlagen.',
    },
    'migration-assistant': {
      title: 'Der Umzugsassistent',
      body: 'Holt Bibliotheken von anderen Seiten, klärt Ausgaben mit dir und meldet jede nicht zugeordnete Zeile.',
    },
    'bring-your-own-agent': {
      title: 'Den eigenen Agenten mitbringen',
      body: 'Verbinde deinen vertrauten Agenten per API oder MCP. Er läuft auf deiner Infrastruktur mit begrenzten Rechten und deinem Budget.',
    },
    'agent-disclosure': {
      title: 'Automatisierung immer gekennzeichnet',
      body: 'Jede Aktion nennt Agent, Betreiber und Prüfer. REZICS erfindet niemals Rezensionen, Stimmen oder Mitglieder.',
    },
    realms: {
      title: 'Communitys',
      body: 'Communitys um Geschichten, Sprachen oder Ideen, mit eigenen Regeln, Wikis und Moderatoren.',
    },
    'follow-join': {
      title: 'Folgen oder beitreten',
      body: 'Folge zum Mitlesen, tritt zum Mitmachen bei. Du weißt stets, was du gewählt hast.',
    },
    'community-rules': {
      title: 'Regeln in jeder Sprache',
      body: 'Die Community formuliert Regeln je Sprache. Die Moderation wendet sie auf alle gleich an.',
    },
    'newcomer-trust': {
      title: 'Platz für Neue, nicht für Spam',
      body: 'Neue Mitglieder beginnen mit sanften Grenzen, die durch Teilnahme fallen. So heißt die Community Menschen willkommen, keine Spam-Bots.',
    },
    'moderation-cases': {
      title: 'Nachvollziehbare Moderation',
      body: 'Eine Meldung wird zum Fall mit Entscheidung, Begründung und Einspruch, sichtbar für Beteiligte.',
    },
    recognition: {
      title: 'Anerkennung für echte Hilfe',
      body: 'Level in jeder Community kommen aus angenommenen hilfreichen Rezensionen, Korrekturen und Übersetzungen, nie aus täglichen Serien.',
    },
    'sell-books-games': {
      title: 'Bücher und Spiele direkt verkaufen',
      body: 'Vertragspartner verkaufen rechtegeklärte Bücher, kleine Spiele und Visual Novels mit Leseproben, Updates und Erstattungen.',
    },
    'drm-free': {
      title: 'Dateien, die dir bleiben',
      body: 'Bücher als EPUB und PDF sowie Spiele-Builds ohne DRM, jederzeit erneut aus deiner Bibliothek herunterladbar.',
    },
    'clear-statements': {
      title: 'Jede Abgabe auf der Abrechnung',
      body: 'Kreative sehen Steuern, Zahlungsgebühren und Erstattungen einzeln und genau, was bei ihnen ankommt.',
    },
    'edition-storefront': {
      title: 'Genau die richtige Ausgabe kaufen',
      body: 'Leser wählen Sprache und Ausgabe. Übersetzte Ausgaben nennen den Übersetzer auf der Seite.',
    },
    'rights-declarations': {
      title: 'Rechte, klar benannt',
      body: 'Jedes Werk nennt Urheber, Übersetzer und erlaubte Nutzungen.',
    },
    'connected-store': {
      title: 'Buch, Community und Wiki zusammen',
      body: 'Der Kauf steht neben Diskussion und Wiki des Werks, nicht in einem getrennten Shop.',
    },
    'open-api': {
      title: 'Das ganze Produkt als API',
      body: 'Jede menschlich ausführbare Operation ist dokumentiert, mit maschinenlesbaren Ergebnissen und sicher wiederholbaren Anfragen.',
    },
    'scoped-credentials': {
      title: 'Zugriff passend zur Aufgabe',
      body: 'Gib einem Tool genau den nötigen Zugriff auf die nötigen Ressourcen und widerrufe ihn zentral.',
    },
    'actionable-errors': {
      title: 'Fehler, auf die Code reagieren kann',
      body: 'Standardisierte Problemdetails erklären Fehler und nächste Schritte, von fehlenden Rechten bis zu veralteten Fassungen.',
    },
    'event-stream': {
      title: 'Ereignisse zum Fortsetzen',
      body: 'Änderungen mit dauerhaftem Cursor verfolgen und nach Abbruch genau an der letzten Stelle fortsetzen.',
    },
    'typescript-sdk': {
      title: 'Ein SDK für TypeScript',
      body: 'Typisierte Clients, erzeugt aus denselben Definitionen wie die API.',
    },
    'developer-portal': {
      title: 'Dokumentation, die aktuell bleibt',
      body: 'Referenz, Schnellstarts und Funktionsliste entstehen aus der Registry, auf der die API selbst läuft.',
    },
    'suitability-gates': {
      title: 'Inhalte selbst auswählen',
      body: 'Allgemeine, jugendliche, sexuelle und groteske Inhalte getrennt wählen. Unbewertet bleibt unbewertet, niemals allgemein geeignet.',
    },
    'ai-disclosure': {
      title: 'KI-Nutzung offenlegen',
      body: 'Texte, Bilder und Übersetzungen geben KI-Nutzung und menschliche Prüfung an, danach kannst du filtern.',
    },
    'no-training': {
      title: 'Entwürfe und Leseverlauf sind keine Trainingsdaten',
      body: 'REZICS trainiert ohne dein ausdrückliches Einverständnis nicht mit privaten Entwürfen oder Leseverläufen und behandelt KI-Detektoren nie als Urteil.',
    },
    'no-trackers': {
      title: 'Keine Tracker',
      body: 'Keine Werbetracker oder Drittanbieteranalyse. Zwei Cookies merken sich Sprache und Darstellung.',
    },
    'reporting-appeals': {
      title: 'Alles melden, jede Entscheidung anfechten',
      body: 'Jeder kann melden, mit oder ohne Anmeldung. Jede Entscheidung enthält Grund und Einspruchsmöglichkeit.',
    },
    'safety-response': {
      title: 'Die schwersten Schäden zuerst angehen',
      body: 'Bekannte Kindesmissbrauchsbilder werden beim Upload blockiert. Ohne Einwilligung geteilte intime Bilder verschwinden binnen 48 Stunden nach gültiger Meldung.',
    },
  },
  fr: {
    'native-multilingual': {
      title: 'Chaque histoire garde sa langue.',
      body: 'Titres, éditions, traductions et échanges gardent leur langue d’origine. La langue de l’interface ne décide pas de vos lectures, et rien n’est remplacé discrètement par l’anglais.',
    },
    'portable-data': {
      title: 'Votre bibliothèque vous appartient, emportez-la.',
      body: 'Exportez bibliothèque, notes, critiques et brouillons dans des formats lisibles ailleurs, puis réimportez sans perdre de date, relecture ni édition.',
    },
    'sourced-knowledge': {
      title: 'Le savoir montre ses sources.',
      body: 'Les faits du wiki citent leur chapitre. Les agents proposent, les humains relisent, chaque modification se retrace et s’annule.',
    },
    'api-agent-first': {
      title: 'Ce que vous pouvez faire, vos outils aussi.',
      body: 'Chaque action est d’abord une opération API. Applications, scripts et agents disposent des mêmes pouvoirs que vous, jamais davantage.',
    },
    'open-source': {
      title: 'Développé au grand jour.',
      body: 'Le code est public : découvrez le fonctionnement, hébergez REZICS et contribuez à l’améliorer.',
    },
    'names-every-script': {
      title: 'Des noms dans toutes les écritures',
      body: 'Œuvres, personnes et personnages portent leurs noms dans chaque langue et écriture, avec la prononciation. Retrouvez-les sous toute graphie et lisez-les sous celle qui vous convient.',
    },
    'shared-tags': {
      title: 'Des tags dans votre langue',
      body: 'Un vocabulaire commun, traduit une fois pour tous : un tag posé en japonais se lit en anglais, chinois traditionnel ou toute langue où il a un nom.',
    },
    'reviewed-translations': {
      title: 'Des résumés traduits par des personnes',
      body: 'Les lecteurs proposent des traductions de résumés ou descriptions, relues comme toute modification. En attendant, l’original est affiché et identifié, jamais remplacé par une supposition.',
    },
    'saved-lists': {
      title: 'Des listes à votre façon',
      body: 'Listez tout contenu de REZICS, affichez-le en liste, tableau ou galerie, filtrez à votre façon, gardez-le privé ou partagez-le.',
    },
    'one-identity': {
      title: 'Un même profil partout',
      body: 'Un profil vous suit entre communautés, types d’œuvres et langues. Vos écrits et votre réputation restent les vôtres partout.',
    },
    'works-across-platforms': {
      title: 'Toutes les versions, une histoire',
      body: 'Feuilleton web, light novel, manga, anime et jeu sont reliés en une histoire, chacun avec ses sorties. Les fans venus d’ailleurs arrivent sur la même page.',
    },
    'every-kind': {
      title: 'Une page complète pour chaque type',
      body: 'Chaque type réunit couverture, noms multilingues, faits, relations, notes, critiques, discussions, wiki, listes et sources. Un nouveau type s’ajoute par configuration, sans nouveau code.',
    },
    'portable-library': {
      title: 'Une bibliothèque attentive aux éditions',
      body: 'Rangez poche, ebook et traduction comme exemplaires d’une histoire, en marquant celui que vous lisez.',
    },
    'reading-sessions': {
      title: 'La lecture telle qu’elle se vit',
      body: 'Relectures, pauses, livres mis de côté et changements de format : chaque lecture comptée une fois, en pages, pourcentage ou minutes.',
    },
    'library-import': {
      title: 'Apportez votre historique',
      body: 'Importez depuis Goodreads, StoryGraph ou un tableur. Chaque ligne retrouve son édition ; vous tranchez les ambiguïtés et voyez ce qui manque avant toute modification.',
    },
    'library-export': {
      title: 'Tout emporter',
      body: 'Exportez toute la bibliothèque avec dates, notes et éditions intactes, puis importez-la sur REZICS ou ailleurs.',
    },
    'copies-loans': {
      title: 'Achats, emprunts, retours',
      body: 'Distinguez vos exemplaires des emprunts et de leurs échéances, sans toucher à vos lectures.',
    },
    'review-targets': {
      title: 'Des avis qui précisent leur sujet',
      body: 'Notez histoire, traduction ou narration séparément, pour qu’une traduction maladroite ne pénalise pas un grand livre.',
    },
    'reading-notes': {
      title: 'Des notes au fil du texte',
      body: 'Des notes privées liées à l’édition et au passage exact, partagées uniquement si vous le choisissez.',
    },
    'series-tracking': {
      title: 'Toute la série sur une page',
      body: 'Originaux japonais, traductions officielles et de fans de chaque tome, avec vos achats et lectures.',
    },
    'edition-coverage': {
      title: 'Des éditions sans confusion',
      body: 'Tomes, intégrales, éditions spéciales et régionales ont des fiches distinctes, jamais déduites d’un titre identique.',
    },
    'translation-availability': {
      title: 'Le prochain tome dans votre langue',
      body: 'Suivez une série dans vos langues et voyez le prochain tome de chacune, avec sa date dès qu’elle est connue.',
    },
    'release-alerts': {
      title: 'Être informé dès la sortie',
      body: 'Un message quand le prochain tome dans votre langue est daté ou sort, aucun pour les langues que vous ne lisez pas.',
    },
    'translation-provenance': {
      title: 'Officielle, de fans ou automatique',
      body: 'Chaque traduction précise qui l’a faite et comment : équipes créditées, traduction automatique signalée, avancement affiché.',
    },
    'light-novels-zone': {
      title: 'La Zone Light novels',
      body: 'Nouveaux tomes, traductions achevées et discussions dans vos langues, réunis depuis le catalogue commun aux Zones.',
    },
    'serial-writing': {
      title: 'Un manuscrit à l’abri',
      body: 'Chaque sauvegarde est restaurable. Un chapitre écrit hors ligne reste en sécurité sur votre appareil jusqu’à la reconnexion.',
    },
    'serial-scheduling': {
      title: 'Publiez selon votre calendrier',
      body: 'Programmez les chapitres dans votre fuseau et voyez quelle version sera reçue, à quel moment.',
    },
    'serial-reading': {
      title: 'Reprenez au milieu du paragraphe',
      body: 'Retrouvez le paragraphe quitté sur tout appareil ; le chapitre suivant reste à portée de doigt.',
    },
    'chapter-discussion': {
      title: 'Parlez du chapitre tout juste lu',
      body: 'Les commentaires sont près du chapitre, ancrés aux paragraphes, sans révéler ce qui n’a pas été lu.',
    },
    collaborators: {
      title: 'Invitez votre équipe éditoriale',
      body: 'Invitez les bêta-lecteurs à lire, les éditeurs à suggérer, les coauteurs à modifier. Vous gardez la publication.',
    },
    'author-backup': {
      title: 'Une sauvegarde complète',
      body: 'Téléchargez l’œuvre entière avec versions, notes et univers dans des formats ouverts réimportables.',
    },
    'vn-releases': {
      title: 'La version à laquelle vous pouvez jouer',
      body: 'Filtrez les visual novels par langue, plateforme et édition, puis comparez leurs versions côte à côte.',
    },
    'release-provenance': {
      title: 'Des traductions traçables',
      body: 'Avant d’y consacrer un week-end, voyez qui a traduit, depuis quelle version et jusqu’où.',
    },
    'anime-episodes': {
      title: 'Les anime, épisode par épisode',
      body: 'Suivez saisons et épisodes, y compris saisons en plusieurs parties et spéciaux, et discutez sans révéler le suivant.',
    },
    'one-list': {
      title: 'Une liste pour tout',
      body: 'Anime, manga, romans et jeux sur une liste, chacun compté en épisodes, chapitres, tomes ou routes.',
    },
    'spoiler-position': {
      title: 'Les spoilers s’arrêtent à votre progression',
      body: 'Discussions, tags et wikis masquent ce qui dépasse l’épisode ou le chapitre atteint.',
    },
    'acgn-zone': {
      title: 'La Zone ACGN',
      body: 'Saison en cours, nouveautés et adaptations des histoires suivies, pour ceux qui regardent, lisent et jouent.',
    },
    'realm-wikis': {
      title: 'Un wiki pour chaque œuvre',
      body: 'Personnages, lieux, factions et événements ont leur page avec infobox, liens, liens entrants et discussions.',
    },
    'chapter-citations': {
      title: 'Des faits sourcés par chapitre',
      body: 'Chaque affirmation renvoie au chapitre et à l’édition, pour être vérifiée ou corrigée.',
    },
    'spoiler-safe-wiki': {
      title: 'Le wiki au fil de votre lecture',
      body: 'Indiquez votre progression : pages, résultats et infoboxes ne montrent que ce qui a été révélé jusque-là.',
    },
    'wiki-builder': {
      title: 'L’assistant wiki',
      body: 'Les agents lisent des textes sous licence et fournis par les auteurs, puis proposent des faits sourcés. Des humains publient. Chaque communauté autorise ou non ces brouillons.',
    },
    'world-bible': {
      title: 'Une bible d’univers près du manuscrit',
      body: 'Les auteurs gardent personnages, lieux et univers en privé près du brouillon, puis publient les pages choisies en wiki.',
    },
    'world-visuals': {
      title: 'Cartes, relations et chronologies',
      body: 'Placez des lieux sur votre carte, tracez les relations et datez les événements selon vos calendriers, avec une liste lisible à côté.',
    },
    'wiki-history': {
      title: 'Chaque modification vérifiable et réversible',
      body: 'Historique, différences, révision et restauration partout. Le wiki s’exporte en entier, jamais derrière un péage.',
    },
    'contribution-protocol': {
      title: 'Un protocole ouvert commun',
      body: 'Agents officiels et tiers soumettent les mêmes propositions : changement exact, preuves et degré de confiance à justifier. Rien ne s’applique sans révision.',
    },
    'spam-review': {
      title: 'Vérification du spam et des publicités',
      body: 'Fondé sur Jev de TypeSafe : décisions typées avec degré de confiance et passages cités, toujours révocables par un humain.',
    },
    'auto-tagging': {
      title: 'Des tags à jour',
      body: 'Publications et livres reçoivent des tags du vocabulaire commun, avec justification et niveau de spoiler.',
    },
    'relation-maintenance': {
      title: 'Des relations à jour',
      body: 'À l’apparition d’un personnage, d’une personne ou d’un lieu, l’agent propose ses liens aux œuvres et entités concernées.',
    },
    normalisation: {
      title: 'Structurer les textes libres',
      body: 'Une recette racontée librement revient à l’auteur sous forme d’ingrédients et d’étapes, à valider.',
    },
    'migration-assistant': {
      title: 'L’assistant de migration',
      body: 'Récupère une bibliothèque ailleurs, résout les éditions avec vous et signale chaque ligne sans correspondance.',
    },
    'bring-your-own-agent': {
      title: 'Venez avec votre agent',
      body: 'Connectez l’agent de confiance par API ou MCP. Il tourne sur vos ressources, avec des accès limités et votre budget.',
    },
    'agent-disclosure': {
      title: 'L’automatisation toujours signalée',
      body: 'Chaque action nomme l’agent, son opérateur et son réviseur. REZICS ne fabrique jamais d’avis, de votes ni de membres.',
    },
    realms: {
      title: 'Communautés',
      body: 'Des communautés autour d’une histoire, langue ou idée, chacune avec règles, wiki et modération.',
    },
    'follow-join': {
      title: 'Suivre ou rejoindre',
      body: 'Suivez pour lire, rejoignez pour participer. Vous savez toujours ce que vous avez choisi.',
    },
    'community-rules': {
      title: 'Des règles dans chaque langue',
      body: 'La communauté énonce ses règles par langue et les applique à tous de la même façon.',
    },
    'newcomer-trust': {
      title: 'Une place aux nouveaux, pas au spam',
      body: 'Les nouveaux commencent avec des limites légères, levées à mesure qu’ils participent, pour accueillir les personnes sans accueillir les bots.',
    },
    'moderation-cases': {
      title: 'Une modération compréhensible',
      body: 'Un signalement devient un dossier avec décision, motif et recours, visibles des personnes concernées.',
    },
    recognition: {
      title: 'Reconnaître les contributions utiles',
      body: 'Les niveaux viennent des contributions acceptées : critiques utiles, corrections, traductions, jamais de connexions en série.',
    },
    'sell-books-games': {
      title: 'Livres et jeux en vente directe',
      body: 'Des créateurs sous contrat vendent livres, petits jeux et visual novels aux droits vérifiés, avec extraits, mises à jour et remboursements.',
    },
    'drm-free': {
      title: 'Des fichiers qui restent à vous',
      body: 'Livres EPUB et PDF, jeux sans DRM, retéléchargeables depuis votre bibliothèque quand vous voulez.',
    },
    'clear-statements': {
      title: 'Chaque retenue sur le relevé',
      body: 'Les créateurs voient taxes, frais et remboursements ligne par ligne, puis le montant exact qu’ils touchent.',
    },
    'edition-storefront': {
      title: 'Achetez la bonne édition',
      body: 'Les lecteurs choisissent langue et édition ; la version traduite crédite son traducteur sur la page.',
    },
    'rights-declarations': {
      title: 'Des droits clairement énoncés',
      body: 'Chaque œuvre dit qui l’a créée, traduite et ce que les lecteurs peuvent en faire.',
    },
    'connected-store': {
      title: 'Livre, communauté et wiki réunis',
      body: 'L’achat se fait près des discussions et du wiki, sans boutique séparée.',
    },
    'open-api': {
      title: 'Tout le produit en API',
      body: 'Toute opération humaine est documentée, avec résultats lisibles par le code et requêtes sûres à relancer.',
    },
    'scoped-credentials': {
      title: 'Des accès adaptés à la tâche',
      body: 'Accordez uniquement les accès et ressources nécessaires à un outil, révocables en un seul endroit.',
    },
    'actionable-errors': {
      title: 'Des erreurs exploitables par le code',
      body: 'Des détails standard précisent l’erreur et la marche à suivre, du périmètre refusé à la version périmée.',
    },
    'event-stream': {
      title: 'Des événements reprenables',
      body: 'Suivez les changements avec un curseur persistant et reprenez exactement après une déconnexion.',
    },
    'typescript-sdk': {
      title: 'Un SDK TypeScript',
      body: 'Des clients typés générés depuis les mêmes définitions que l’API.',
    },
    'developer-portal': {
      title: 'Une documentation qui reste juste',
      body: 'Référence, démarrage rapide et liste des fonctions proviennent du registre utilisé par l’API.',
    },
    'suitability-gates': {
      title: 'Des contenus selon vos choix',
      body: 'Contenus généraux, ados, sexuels et dérangeants séparés. Non classé reste non classé, jamais tout public.',
    },
    'ai-disclosure': {
      title: 'L’usage de l’IA déclaré',
      body: 'Textes, images et traductions déclarent l’usage de l’IA et la révision humaine, avec filtres correspondants.',
    },
    'no-training': {
      title: 'Vos brouillons et lectures ne sont pas des données d’entraînement',
      body: 'REZICS n’entraîne pas sur vos brouillons privés ou lectures sans votre accord et ne prend jamais un détecteur d’IA pour un verdict.',
    },
    'no-trackers': {
      title: 'Aucun traceur',
      body: 'Aucun traceur publicitaire ni analyse tierce. Deux cookies retiennent langue et thème.',
    },
    'reporting-appeals': {
      title: 'Tout signaler, toute décision contester',
      body: 'Chacun peut signaler, connecté ou non. Toute décision donne son motif et une voie de recours.',
    },
    'safety-response': {
      title: 'Traiter d’abord les préjudices les plus graves',
      body: 'Les images d’abus d’enfants connues sont bloquées à l’envoi. Les images intimes diffusées sans consentement sont retirées sous 48 heures après un signalement valide.',
    },
  },
  es: {
    'native-multilingual': {
      title: 'Cada historia conserva su idioma.',
      body: 'Títulos, ediciones, traducciones y conversaciones conservan su idioma. La lengua de la interfaz no decide qué lees y nada se sustituye en silencio por inglés.',
    },
    'portable-data': {
      title: 'Tu biblioteca es tuya para llevártela.',
      body: 'Exporta biblioteca, notas, reseñas y borradores en formatos que otros programas lean y vuelve a importarlos sin perder fechas, relecturas ni ediciones.',
    },
    'sourced-knowledge': {
      title: 'El conocimiento muestra sus fuentes.',
      body: 'Los datos del wiki citan su capítulo. Los agentes proponen, las personas revisan y cada cambio se puede rastrear y deshacer.',
    },
    'api-agent-first': {
      title: 'Lo que puedes hacer, tus herramientas también.',
      body: 'Cada acción es primero una operación API. Tus apps, scripts y agentes tienen las mismas capacidades que tú, nunca más.',
    },
    'open-source': {
      title: 'Desarrollado en abierto.',
      body: 'El código es público: descubre cómo funciona, ejecútalo por tu cuenta y ayuda a mejorarlo.',
    },
    'names-every-script': {
      title: 'Nombres en todas las escrituras',
      body: 'Obras, personas y personajes guardan nombres en cada idioma y escritura, con su lectura. Encuentras una obra con cualquier grafía y la ves como la lees.',
    },
    'shared-tags': {
      title: 'Etiquetas en tu idioma',
      body: 'Las etiquetas comparten un vocabulario traducido para todos. Una etiqueta puesta en japonés se lee en inglés, chino tradicional o cualquier idioma en que tenga nombre.',
    },
    'reviewed-translations': {
      title: 'Sinopsis traducidas por personas',
      body: 'Los lectores proponen traducciones de sinopsis o descripciones y otros las revisan. Mientras no exista una, se muestra el original identificado, nunca una conjetura.',
    },
    'saved-lists': {
      title: 'Listas a tu medida',
      body: 'Haz listas de cualquier contenido de REZICS, míralas como lista, tabla o galería, aplica tus filtros y guárdalas en privado o compártelas.',
    },
    'one-identity': {
      title: 'Una identidad en todas partes',
      body: 'Un perfil te acompaña por comunidades, tipos de historias e idiomas. Lo que escribes y la reputación que ganas siguen siendo tuyos donde publiques.',
    },
    'works-across-platforms': {
      title: 'Todas las versiones, una historia',
      body: 'Serial web, novela ligera, manga, anime y juego se conectan como una historia, cada uno con sus lanzamientos. Fans de distintos lugares llegan a la misma página.',
    },
    'every-kind': {
      title: 'Una página completa para cada tipo',
      body: 'Cada tipo reúne portada, nombres multilingües, datos, relaciones, valoraciones, reseñas, debates, wiki, listas y fuentes. Un tipo nuevo se añade por configuración, sin código nuevo.',
    },
    'portable-library': {
      title: 'Una biblioteca que conoce la edición',
      body: 'Coloca el papel, el ebook y la traducción como ejemplares de una historia, marcando el que lees.',
    },
    'reading-sessions': {
      title: 'La lectura tal como ocurre',
      body: 'Relecturas, pausas, libros aparcados y cambios de formato se registran una vez, en páginas, porcentaje o minutos.',
    },
    'library-import': {
      title: 'Trae tu historial',
      body: 'Importa desde Goodreads, StoryGraph o una hoja de cálculo. Cada fila se vincula a tu edición; eliges ante dudas y ves qué no se trasladará antes de cambiar nada.',
    },
    'library-export': {
      title: 'Llévatelo todo',
      body: 'Exporta toda la biblioteca con fechas, notas y ediciones intactas e impórtala en REZICS o en otro lugar.',
    },
    'copies-loans': {
      title: 'En propiedad, prestado, por devolver',
      body: 'Separa lo que tienes de lo prestado y sus plazos, sin modificar lo que has leído.',
    },
    'review-targets': {
      title: 'Reseñas que aclaran qué valoran',
      body: 'Valora historia, traducción y narración por separado para que una mala traducción no hunda un gran libro.',
    },
    'reading-notes': {
      title: 'Notas sobre el pasaje',
      body: 'Notas privadas ligadas a la edición y al pasaje exacto, compartidas solo si lo eliges.',
    },
    'series-tracking': {
      title: 'Toda la serie en una página',
      body: 'Originales japoneses y traducciones oficiales y de fans de cada volumen, junto a lo que tienes y has leído.',
    },
    'edition-coverage': {
      title: 'Ediciones sin confusión',
      body: 'Volúmenes, integrales, ediciones especiales y regionales tienen registros distintos, nunca supuestos por compartir título.',
    },
    'translation-availability': {
      title: 'El siguiente volumen en tu idioma',
      body: 'Sigue la serie en tus idiomas y consulta el siguiente volumen en cada uno, con su fecha en cuanto se conozca.',
    },
    'release-alerts': {
      title: 'Entérate el día que sale',
      body: 'Un aviso cuando se feche o salga el siguiente volumen en tu idioma, ninguno para los que no lees.',
    },
    'translation-provenance': {
      title: 'Oficial, de fans o automática',
      body: 'Cada traducción indica quién la hizo y cómo. Se acredita a los grupos, se identifica la traducción automática y se muestra el progreso.',
    },
    'light-novels-zone': {
      title: 'La Zone de novelas ligeras',
      body: 'Nuevos volúmenes, traducciones terminadas y debates en tus idiomas, reunidos desde el catálogo común de las Zones.',
    },
    'serial-writing': {
      title: 'Un manuscrito que no desaparece',
      body: 'Cada guardado crea una revisión recuperable. Lo escrito sin conexión queda a salvo en tu dispositivo hasta reconectarte.',
    },
    'serial-scheduling': {
      title: 'Publica a tu ritmo',
      body: 'Programa capítulos en tu zona horaria y ve qué revisión recibirán los lectores y cuándo.',
    },
    'serial-reading': {
      title: 'Retoma en mitad del párrafo',
      body: 'Vuelve al párrafo exacto desde cualquier dispositivo, con el siguiente capítulo a un toque.',
    },
    'chapter-discussion': {
      title: 'Comenta el capítulo que acabas de leer',
      body: 'Los comentarios acompañan al capítulo, anclados a sus párrafos, sin revelar lo que aún no se ha leído.',
    },
    collaborators: {
      title: 'Invita a tu equipo editorial',
      body: 'Invita a lectores beta a leer, a editores a sugerir y a coautores a editar. Publicar sigue en tus manos.',
    },
    'author-backup': {
      title: 'Una copia de seguridad completa',
      body: 'Descarga la obra entera con revisiones, notas y mundo en formatos abiertos que puedes volver a importar.',
    },
    'vn-releases': {
      title: 'La versión que puedes jugar de verdad',
      body: 'Filtra novelas visuales por idioma, plataforma y edición, y compara todos los lanzamientos lado a lado.',
    },
    'release-provenance': {
      title: 'Traducciones con procedencia',
      body: 'Antes de dedicarle un fin de semana, consulta quién tradujo, desde qué versión y cuánto está terminado.',
    },
    'anime-episodes': {
      title: 'Anime por episodios',
      body: 'Registra temporadas y episodios, incluidas temporadas divididas y especiales, y comenta sin destripar el siguiente.',
    },
    'one-list': {
      title: 'Una lista para todo',
      body: 'Anime, manga, novelas y juegos en una lista, contados en episodios, capítulos, volúmenes o rutas.',
    },
    'spoiler-position': {
      title: 'Los spoilers se detienen donde vas',
      body: 'Debates, etiquetas y wikis ocultan lo posterior al episodio o capítulo que has alcanzado.',
    },
    'acgn-zone': {
      title: 'La Zone ACGN',
      body: 'Temporada actual, novedades y adaptaciones de las historias que sigues, para quienes ven, leen y juegan.',
    },
    'realm-wikis': {
      title: 'Un wiki para cada obra',
      body: 'Personajes, lugares, facciones y eventos tienen su página con ficha, enlaces, enlaces entrantes y debate.',
    },
    'chapter-citations': {
      title: 'Datos con su capítulo de origen',
      body: 'Cada afirmación apunta a capítulo y edición para que lectores comprueben y editores corrijan.',
    },
    'spoiler-safe-wiki': {
      title: 'El wiki al ritmo de tu lectura',
      body: 'Indica hasta dónde has leído y páginas, resultados y fichas mostrarán solo lo revelado hasta entonces.',
    },
    'wiki-builder': {
      title: 'El asistente de wikis',
      body: 'Los agentes leen textos autorizados y aportados por autores, proponen datos con fuentes y los revisores publican. Cada comunidad decide si permite esos borradores.',
    },
    'world-bible': {
      title: 'La biblia del mundo junto al manuscrito',
      body: 'Los autores guardan personajes, lugares y trasfondo en privado junto al borrador y publican las páginas elegidas como wiki.',
    },
    'world-visuals': {
      title: 'Mapas, relaciones y cronologías',
      body: 'Marca lugares en tu mapa, dibuja relaciones y sitúa eventos en calendarios inventados, cada uno con una lista legible.',
    },
    'wiki-history': {
      title: 'Cada edición revisable y reversible',
      body: 'Historial, diferencias, revisión y restauración en cada página. Todo el wiki se exporta de una vez, nunca tras un muro de pago.',
    },
    'contribution-protocol': {
      title: 'Un protocolo abierto común',
      body: 'Agentes oficiales y externos presentan lo mismo: cambio exacto, pruebas y confianza de la que responder. Nada se aplica sin revisión.',
    },
    'spam-review': {
      title: 'Revisión de spam y publicidad',
      body: 'Basado en Jev de TypeSafe: decisiones tipadas con confianza y pasajes citados, todas revocables por una persona.',
    },
    'auto-tagging': {
      title: 'Etiquetas al día',
      body: 'Publicaciones y libros reciben etiquetas del vocabulario común, con motivo y nivel de spoiler.',
    },
    'relation-maintenance': {
      title: 'Relaciones al día',
      body: 'Cuando aparece un personaje, persona o lugar, un agente propone vincularlo a sus obras y entidades.',
    },
    normalisation: {
      title: 'Estructura para publicaciones libres',
      body: 'Una receta contada de forma informal se propone al autor con ingredientes y pasos estructurados.',
    },
    'migration-assistant': {
      title: 'El asistente de migración',
      body: 'Trae bibliotecas de otros sitios, resuelve contigo las ediciones e informa de cada fila sin correspondencia.',
    },
    'bring-your-own-agent': {
      title: 'Trae tu propio agente',
      body: 'Conecta el agente en que confías por API o MCP. Usa tus recursos, credenciales limitadas y el presupuesto que fijes.',
    },
    'agent-disclosure': {
      title: 'La automatización siempre se declara',
      body: 'Cada acción identifica al agente, su operador y su revisor. REZICS nunca inventa reseñas, votos ni miembros.',
    },
    realms: {
      title: 'Comunidades',
      body: 'Comunidades en torno a una historia, idioma o idea, cada una con reglas, wiki y moderadores propios.',
    },
    'follow-join': {
      title: 'Seguir o unirse',
      body: 'Sigue para leer, únete para participar. Siempre sabes qué has elegido.',
    },
    'community-rules': {
      title: 'Reglas en todos los idiomas',
      body: 'La comunidad expone reglas en cada idioma y la moderación las aplica igual a todos.',
    },
    'newcomer-trust': {
      title: 'Sitio para nuevos miembros, no para spam',
      body: 'Los nuevos empiezan con límites suaves que se levantan al participar, para recibir personas sin dar paso a bots.',
    },
    'moderation-cases': {
      title: 'Moderación que puedes seguir',
      body: 'Un reporte pasa a ser un caso con decisión, motivo y apelación, visible para los implicados.',
    },
    recognition: {
      title: 'Reconocimiento por ayudar de verdad',
      body: 'Los niveles de cada comunidad vienen de reseñas útiles, correcciones y traducciones aceptadas, nunca de rachas diarias.',
    },
    'sell-books-games': {
      title: 'Libros y juegos en venta directa',
      body: 'Creadores con contrato venden libros, juegos pequeños y novelas visuales con derechos autorizados, muestras, actualizaciones y reembolsos.',
    },
    'drm-free': {
      title: 'Archivos que siguen siendo tuyos',
      body: 'Libros EPUB y PDF y juegos sin DRM, descargables de nuevo desde tu biblioteca cuando quieras.',
    },
    'clear-statements': {
      title: 'Cada deducción en la liquidación',
      body: 'Los creadores ven impuestos, comisiones y reembolsos línea a línea, y exactamente cuánto reciben.',
    },
    'edition-storefront': {
      title: 'Compra la edición exacta',
      body: 'El lector elige idioma y edición; las ediciones traducidas acreditan al traductor en su página.',
    },
    'rights-declarations': {
      title: 'Derechos claros',
      body: 'Cada obra indica quién la creó, quién la tradujo y qué pueden hacer con ella los lectores.',
    },
    'connected-store': {
      title: 'El libro, su comunidad y su wiki juntos',
      body: 'La compra convive con los debates y el wiki de la obra, no en una tienda aparte.',
    },
    'open-api': {
      title: 'Todo el producto como API',
      body: 'Toda operación que una persona puede hacer está documentada, con resultados procesables y peticiones que pueden reintentarse sin riesgo.',
    },
    'scoped-credentials': {
      title: 'Credenciales ajustadas a la tarea',
      body: 'Da a la herramienta solo el acceso y los recursos necesarios, y revócalos desde un lugar.',
    },
    'actionable-errors': {
      title: 'Errores ante los que tu código puede actuar',
      body: 'Detalles estándar explican el fallo y el siguiente paso, desde permisos denegados hasta revisiones obsoletas.',
    },
    'event-stream': {
      title: 'Eventos reanudables',
      body: 'Sigue cambios con un cursor persistente y retoma exactamente donde paraste tras desconectarte.',
    },
    'typescript-sdk': {
      title: 'Un SDK de TypeScript',
      body: 'Clientes tipados generados desde las mismas definiciones que la API.',
    },
    'developer-portal': {
      title: 'Documentación que no se desfasa',
      body: 'Referencia, guías rápidas y lista de capacidades se generan desde el registro de la propia API.',
    },
    'suitability-gates': {
      title: 'El contenido lo eliges tú',
      body: 'Contenido general, adolescente, sexual y grotesco por separado. Lo no clasificado se trata como tal, nunca como general.',
    },
    'ai-disclosure': {
      title: 'Uso de IA declarado',
      body: 'Texto, arte y traducciones declaran uso de IA y revisión humana, y puedes filtrar por ello.',
    },
    'no-training': {
      title: 'Tus borradores y lecturas no son datos de entrenamiento',
      body: 'REZICS no entrena con borradores privados ni lecturas sin tu consentimiento y nunca toma un detector de IA como veredicto.',
    },
    'no-trackers': {
      title: 'Sin rastreadores',
      body: 'Sin rastreadores publicitarios ni analítica externa. Dos cookies recuerdan idioma y tema.',
    },
    'reporting-appeals': {
      title: 'Reporta cualquier problema y apela cualquier decisión',
      body: 'Cualquiera puede reportar, con sesión o sin ella. Cada decisión incluye motivo y vía de apelación.',
    },
    'safety-response': {
      title: 'Atender primero los daños más graves',
      body: 'Las imágenes conocidas de abuso infantil se bloquean al subir. Las imágenes íntimas sin consentimiento se retiran en 48 horas tras un reporte válido.',
    },
  },
});
