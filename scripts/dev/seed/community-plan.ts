import type { DemoPerson } from './plan.ts';

// A young but real REZICS next to the official Zones: four community Realms
// that people started themselves, with their own rules, moderators, members
// and discussions in the Realm's language. A discussion's first line is its
// title. A spoiler is the author's `spoiler` mark, not a prefix on that title.

/** People who came for a community rather than an official Zone. They sign up with the base plan's people. */
export const communityPeople: readonly DemoPerson[] = [
  { id: 'wei', handle: 'zhou_wei', name: '周伟', seedName: 'Zhou Wei 周伟', email: 'rezics-demo-wei@example.test', password: 'Rezics-demo-2026-wei' },
  { id: 'priya', handle: 'priya_raman', name: 'Priya Raman', email: 'rezics-demo-priya@example.test', password: 'Rezics-demo-2026-priya' },
  { id: 'max', handle: 'max_becker', name: 'Max Becker', email: 'rezics-demo-max@example.test', password: 'Rezics-demo-2026-max' },
  { id: 'hana', handle: 'hana_sato', name: '佐藤花', seedName: 'Hana Sato 佐藤花', email: 'rezics-demo-hana@example.test', password: 'Rezics-demo-2026-hana' },
  { id: 'nora', handle: 'nora_lindqvist', name: 'Nora Lindqvist', email: 'rezics-demo-nora@example.test', password: 'Rezics-demo-2026-nora' },
];

export type CommunityRealmId = 'web-novel-club' | 'mc-modding' | 'prompt-craft' | 'classics-circle';
type Bilingual = { en: string; 'zh-CN': string };

export interface CommunityRealm {
  id: CommunityRealmId; owner: string; moderators: readonly string[];
  /** Everyone who joins, the owner included; counts differ on purpose. */
  members: readonly string[];
  name: Bilingual; description: Bilingual;
  rules: readonly { id: string; title: Bilingual; body: Bilingual }[];
  /** Public Works the owner adopts: the Realm's Works and Discussions tabs list them. */
  adopt: readonly string[];
}

export const communityRealms: readonly CommunityRealm[] = [
  { id: 'web-novel-club', owner: 'wei', moderators: ['wei', 'an'],
    members: ['wei', 'an', 'mei', 'daniel', 'sophie', 'leo', 'jun', 'hana'],
    name: { en: 'Web Novel Book Club', 'zh-CN': '网文读书会' },
    description: {
      en: 'A slow read-along for Chinese web serials: one chapter a week, one thread per chapter. New readers are welcome to start with the pinned read-along.',
      'zh-CN': '每周一章，一章一帖，慢慢追中文连载。新朋友可以从置顶的共读帖开始。' },
    rules: [
      { id: 'chapter', title: { en: 'Say which chapter you are on', 'zh-CN': '先说读到第几章' },
        body: { en: 'Start every post with the chapter you have read up to.', 'zh-CN': '每个帖子开头写上你读到第几章。' } },
      { id: 'spoilers', title: { en: 'Mark spoilers', 'zh-CN': '标注剧透' },
        body: { en: 'Anything past this week’s chapter gets its own thread, marked as a spoiler.',
          'zh-CN': '超出本周章节的内容请另开一帖，并标记为剧透。' } },
      { id: 'kind', title: { en: 'Discuss the story, not the reader', 'zh-CN': '讨论作品，不评判读者' },
        body: { en: 'Disagree with readings, never with people. Authors read this club too.',
          'zh-CN': '可以不同意观点，但不要针对人。作者们也在这里看帖。' } },
    ],
    adopt: ['serial', 'shop', 'taoist', 'moonlight-story', 'journey-west', 'red-chamber'] },
  { id: 'mc-modding', owner: 'max', moderators: ['max', 'sophie'],
    members: ['max', 'sophie', 'jun', 'leo', 'daniel', 'hana', 'nora', 'an'],
    name: { en: 'Minecraft Modding Help', 'zh-CN': '我的世界模组互助' },
    description: {
      en: 'Crashes, load orders and loader choices for Minecraft mods. Post your versions and your log, and someone will help.',
      'zh-CN': '我的世界模组的崩溃、加载顺序和加载器选择。贴上版本和日志，总会有人帮你。' },
    rules: [
      { id: 'versions', title: { en: 'Post versions and a log', 'zh-CN': '贴出版本和日志' },
        body: { en: 'Name the Minecraft, loader and mod versions, and attach latest.log or the crash report.',
          'zh-CN': '写明游戏、加载器和模组版本，并附上 latest.log 或崩溃报告。' } },
      { id: 'one-problem', title: { en: 'One problem per thread', 'zh-CN': '一帖一个问题' },
        body: { en: 'Mark the thread solved and say what fixed it, so the next person finds the answer.',
          'zh-CN': '解决后请标注已解决并说明方法，方便后来的人。' } },
      { id: 'credit', title: { en: 'Link mods, never reupload them', 'zh-CN': '只给链接，不转载' },
        body: { en: 'Link to the mod’s page on REZICS or its author’s site.', 'zh-CN': '请链接到模组在 REZICS 或作者网站的页面。' } },
    ],
    adopt: ['lumen-fabric', 'tidy-fabric', 'weaver-forge', 'quiet-forge', 'shader-guide', 'mod-guide'] },
  { id: 'prompt-craft', owner: 'nora', moderators: ['nora', 'jun'],
    members: ['nora', 'jun', 'aria', 'mei', 'hana', 'priya', 'max', 'daniel', 'wei'],
    name: { en: 'Prompt Craft', 'zh-CN': '提示词工坊' },
    description: {
      en: 'Small, honest prompts and skills for reading and writing. Share what you ran, what came out and what you changed.',
      'zh-CN': '为读书和写作准备的小而实在的提示词与技能。分享你用了什么、得到了什么、又改了什么。' },
    rules: [
      { id: 'show-output', title: { en: 'Show a real output', 'zh-CN': '附上真实输出' },
        body: { en: 'Include one unedited result and the model that produced it.', 'zh-CN': '附上一个未经修改的结果，并写明所用模型。' } },
      { id: 'no-secrets', title: { en: 'No private text or keys', 'zh-CN': '不贴私密文本或密钥' },
        body: { en: 'Never paste API keys, private messages or text you have no right to share.',
          'zh-CN': '不要粘贴 API 密钥、私信或你无权分享的文本。' } },
    ],
    adopt: ['club-prompt-v1', 'glossary-prompt-v1', 'reading-skill-v1', 'recipe-skill-v1', 'prompt', 'skill'] },
  { id: 'classics-circle', owner: 'priya', moderators: ['priya', 'daniel'],
    members: ['priya', 'daniel', 'aria', 'sophie', 'leo', 'nora', 'hana', 'mei', 'an', 'wei'],
    name: { en: 'English Classics Reading Circle', 'zh-CN': '英文经典共读' },
    description: {
      en: 'We read one English classic a month, a dozen chapters a week, and meet in the threads on Sundays. First-time readers and fifth-time readers equally welcome.',
      'zh-CN': '每月共读一部英文经典，每周十来章，周日在帖子里见。第一次读和第五次读的朋友都欢迎。' },
    rules: [
      { id: 'schedule', title: { en: 'Stay within the week’s chapters', 'zh-CN': '只谈本周章节' },
        body: { en: 'The weekly thread covers the week’s chapters. Later chapters get their own thread, marked as a spoiler.',
          'zh-CN': '每周的帖子只讨论本周章节。之后的内容请另开一帖，并标记为剧透。' } },
      { id: 'edition', title: { en: 'Name your edition', 'zh-CN': '注明版本' },
        body: { en: 'Say which edition or translation you read when you quote.', 'zh-CN': '引用时说明你读的版本或译本。' } },
    ],
    adopt: ['pride', 'jane-eyre', 'frankenstein', 'little-women', 'secret-garden', 'alice', 'sherlock'] },
];

export interface CommunityReply { author: string; body: string; language?: string; votes?: number; spoiler?: boolean }
/** A discussion: a reply rooted on a public Work and placed in the Realm. Its first line is its title. */
export interface CommunityThread {
  id: string; realm: CommunityRealmId; author: string; work: string; language: string; body: string;
  /** The author's declaration. Absent leaves the words visible; the title never decides this. */
  spoiler?: boolean;
  /** How many of the Realm's other members vote it up, in member order; `down` of the rest vote it down. */
  votes: number; down?: number;
  replies: readonly CommunityReply[];
}

const zh = 'zh-Hans', en = 'en', ja = 'ja';

export const communityThreads: readonly CommunityThread[] = [
  // 网文读书会
  { id: 'rainy-ch1', realm: 'web-novel-club', author: 'wei', work: 'serial', language: zh, votes: 7,
    body: '【本周共读】《雨夜书店》第一章 雨夜\n这周我们读第一章。讨论第二章以后的内容请另开一帖，并标记为剧透。\n我最喜欢开头那句“雨停在书店打烊前”——一个人物还没出场，气氛已经立住了。读完第一章，你最想知道的是什么？',
    replies: [
      { author: 'an', votes: 3, body: '我最好奇那封没有地址的信是谁放的。林梅好像一点也不意外，她是不是早就在等？' },
      { author: 'hana', language: ja, votes: 2,
        body: '中国語を勉強中なので、ゆっくり読んでいます。「打烊」という言葉を初めて知りました。雨の夜の雰囲気がとても好きです。' },
      { author: 'daniel', body: '第一章很短，但每一句都在铺垫。我已经去追第二章了，剧透帖见。' },
    ] },
  { id: 'rainy-ch2-spoilers', realm: 'web-novel-club', author: 'sophie', work: 'serial', language: zh, votes: 6,
    spoiler: true,
    body: '《雨夜书店》第二章：那张旧车票\n还没读到第二章的朋友请先别往下看。\n信封里只有一张二十年前的车票。我的第一反应是：这是林梅母亲留下的。日期正好是书店开张那一年，作者肯定是故意的。有人注意到车票上的终点站吗？',
    replies: [
      { author: 'leo', votes: 3, spoiler: true, body: '注意到了！终点站就是第三章标题里的“最后一班车”。我猜这张票从来没有被用过。' },
      { author: 'hana', language: ja, votes: 1, spoiler: true,
        body: '終点が「最後の一班車」だと気づきました。母が残したものだと思います。' },
      { author: 'mei', votes: 5, body: '作者路过，不剧透，只说一句：车票的背面以后还会出现。' },
      { author: 'wei', votes: 1, body: '作者亲自下场了哈哈。已置顶。大家讨论剧情记得标记剧透。' },
    ] },
  { id: 'quiet-mysteries', realm: 'web-novel-club', author: 'daniel', work: 'serial', language: zh, votes: 5,
    body: '求推荐：和《雨夜书店》一样安静、带点悬疑的连载\n最近喜欢节奏慢、气氛好的故事，不要太多打斗。中文英文都可以。',
    replies: [
      { author: 'an', votes: 2, body: '《灯塔守望者》！已经完结，海雾、记忆、灯塔，整本书都是潮湿的。' },
      { author: 'jun', votes: 1, body: '《猫咖的第七位客人》也可以试试，每章一个小谜题，读起来很轻松。' },
      { author: 'sophie', votes: 2, body: '《月下书生 · 夜归人》，作者是林梅的笔名，风格很像。' },
    ] },
  { id: 'journey-edition', realm: 'web-novel-club', author: 'jun', work: 'journey-west', language: zh, votes: 4,
    body: '第一次读《西游记》原著，求版本建议\n小时候只看过电视剧，现在想读原著，但文白夹杂有点吃力。大家是直接读原文，还是先读白话版？有没有注释比较好的版本？',
    replies: [
      { author: 'wei', votes: 2, body: '建议直接读原文，找一本带注释的本子。前七回最难，过了大闹天宫就顺了。' },
      { author: 'an', body: '可以一天一回，读完在这里打个卡，我们陪你。' },
    ] },
  { id: 'red-chamber-names', realm: 'web-novel-club', author: 'leo', work: 'red-chamber', language: zh, votes: 6, down: 1,
    body: '《红楼梦》第三次弃坑……人物太多怎么办？\n每次读到第五回就放弃。有没有什么办法记住这么多人？',
    replies: [
      { author: 'sophie', votes: 2, body: '第五回的判词可以先跳过，读完前八十回再回来看，会恍然大悟。' },
      { author: 'wei', votes: 3, body: '画一张人物关系图贴在书旁边。读书会下个月开《红楼梦》共读，欢迎一起。' },
      { author: 'daniel', body: '我是听书入门的，配合原文一起看，人物一下就记住了。' },
    ] },
  { id: 'isekai-bookshop', realm: 'web-novel-club', author: 'hana', work: 'shop', language: ja, votes: 5,
    body: '『我在异世界开书店』、日本のラノベみたいで読みやすいです\n中国語の勉強のために読み始めましたが、魔王がお客さんとして来る第一話で笑いました。ほかに「日常系」の網文でおすすめはありますか？',
    replies: [
      { author: 'wei', language: zh, votes: 2, body: '欢迎！日常系可以看《深夜食堂的魔法师》，句子短，很适合练中文。' },
      { author: 'jun', language: zh, body: '《糖果屋侦探社》也很日常，每章都有一个小案子。' },
    ] },
  { id: 'taoist-update', realm: 'web-novel-club', author: 'an', work: 'taoist', language: zh, votes: 3,
    body: '《玄门小道士》这周更新了吗？\n上周停在城隍爷翻旧案那里，急死了。有没有一起追更的朋友？',
    replies: [
      { author: 'leo', votes: 1, body: '更了两章！不剧透，只说那只猫又出场了。' },
    ] },

  // Minecraft Modding Help
  { id: 'lumen-shaders', realm: 'mc-modding', author: 'daniel', work: 'lumen-fabric', language: en, votes: 6,
    body: '[Solved] Lumen Lanterns render as black cubes with shaders on\nMinecraft 1.20.1, Fabric Loader 0.15.11, Lumen Lanterns 1.3.0, Sodium 0.5.8 and Iris 1.7.0 with Complementary shaders. With shaders on, every lantern Lumen places renders as a black cube; with shaders off it is fine. latest.log shows no errors. Has anyone got these working together?',
    replies: [
      { author: 'max', votes: 4, body: 'Known issue with block entity rendering in Iris 1.7.0. Update Iris to 1.7.2 and turn “Block entity shadows” back on. If it still happens, post your latest.log.' },
      { author: 'jun', votes: 3, body: 'Lumen author here. 1.3.1 ships an Iris compatibility fix; until then Max’s workaround is the right one.' },
      { author: 'daniel', votes: 1, body: 'Updating Iris fixed it. Thank you both, marking this solved.' },
    ] },
  { id: 'fabric-or-neoforge', realm: 'mc-modding', author: 'hana', work: 'mod-guide', language: en, votes: 5,
    body: 'Starting a new pack: Fabric or NeoForge?\nFirst time building a modpack for friends, about 60 mods, mostly quality-of-life and decoration. Which loader would you pick today, and why?',
    replies: [
      { author: 'sophie', votes: 2, body: 'For a QoL-heavy pack, Fabric: faster startup, and most QoL mods ship there first.' },
      { author: 'max', votes: 3, body: 'Pick by your five must-have mods, not by the loader. If one of them is a big tech mod, that decides it.' },
      { author: 'leo', votes: 1, body: 'Whichever you pick, follow the mod setup checklist and back up your world before each batch.' },
    ] },
  { id: 'quiet-villagers-crash', realm: 'mc-modding', author: 'leo', work: 'quiet-forge', language: en, votes: 4,
    body: '[Solved] Crash on loading an old world after adding Quiet Villagers 1.0.2\nForge 47.2.0 on 1.20.1. New worlds are fine; my old survival world crashes on load. The crash report mentions VillagerBrain and a null memory.',
    replies: [
      { author: 'max', votes: 3, body: 'Old worlds keep villager memories from the vanilla AI. Open the world once with migrateMemories = true in config/quietvillagers.toml, save, then turn it off again.' },
      { author: 'jun', votes: 2, body: 'That is the fix. 1.0.3 migrates old villagers automatically.' },
    ] },
  { id: 'tidy-keybind', realm: 'mc-modding', author: 'sophie', work: 'tidy-fabric', language: en, votes: 3,
    body: 'Tip: Tidy Inventory’s sort key clashes with other sorting mods\nBoth default to the middle mouse button. Rebind Tidy’s sort to R and both work. Posting in case someone searches for it.',
    replies: [
      { author: 'hana', votes: 1, body: 'This saved me an hour. Thank you!' },
    ] },
  { id: 'old-laptop-shaders', realm: 'mc-modding', author: 'nora', work: 'shader-guide', language: en, votes: 4,
    body: 'The shader guide on a 2019 laptop: 45 fps\nIntegrated graphics and 8 GB of RAM. I used the guide’s low preset with render distance 8, and it is perfectly playable.',
    replies: [
      { author: 'max', votes: 2, body: 'Nice! Turn off volumetric clouds too; that is usually another 10 fps.' },
    ] },
  { id: 'backup-first', realm: 'mc-modding', author: 'an', work: 'mod-guide', language: zh, votes: 5,
    body: '【经验】装模组之前一定要备份存档\n上周一次往 1.20.1 整合包里加了二十个模组，结果存档打不开。后来按照“模组安装清单”一步步回退才救回来。建议大家一次只加几个模组，每次都先备份。',
    replies: [
      { author: 'max', language: en, votes: 2, body: 'Great advice. For English readers: back up your world before every batch of mods, and add a few at a time.' },
      { author: 'sophie', votes: 1, body: '同意，mods 文件夹和 config 文件夹也一起备份。' },
    ] },

  // Prompt Craft
  { id: 'invented-quotes', realm: 'prompt-craft', author: 'nora', work: 'reading-skill-v1', language: en, votes: 7,
    body: 'How do you stop a notes prompt from inventing quotes?\nWhen I give the reading notes skill a chapter summary instead of the text, it sometimes “quotes” lines that are not in the book. What works for you?',
    replies: [
      { author: 'jun', votes: 4, body: 'Tell it to quote only from text inside the source tags and to write “no quote available” otherwise. That took fabrication to nearly zero for me.' },
      { author: 'aria', votes: 3, body: 'Also ask for a paragraph number with every quote. If it cannot give one, it is usually making the quote up.' },
      { author: 'priya', votes: 2, body: 'For our classics circle I paste the actual passage. A summary invites paraphrase dressed up as quotation.' },
    ] },
  { id: 'glossary-ja-zh', realm: 'prompt-craft', author: 'hana', work: 'glossary-prompt-v1', language: ja, votes: 5,
    body: 'バイリンガル用語集プロンプトを日本語と中国語で試しました\n英語以外でもかなり使えます。ただ、人名や地名を勝手に訳してしまうことがあるので、「固有名詞は原文のまま」と一行足しました。結果はとても良いです。',
    replies: [
      { author: 'nora', language: en, votes: 2, body: 'Great tip. Could you share one before-and-after example?' },
      { author: 'hana', language: ja, votes: 1, body: '「雨夜书店」が「Rainy Night Bookstore」にならず、そのまま残りました。これが欲しかった結果です。' },
      { author: 'aria', language: en, votes: 2, body: 'I will fold that line into the next revision of the glossary prompt.' },
    ] },
  { id: 'club-prompt-night', realm: 'prompt-craft', author: 'priya', work: 'club-prompt-v1', language: en, votes: 6,
    body: 'The book club prompt on our Pride and Prejudice night\nIt turned forty minutes of messy notes into three good questions. The best one: “Is Elizabeth’s prejudice more forgivable than Darcy’s pride, and why do we think so?” We argued for an hour.',
    replies: [
      { author: 'mei', votes: 3, body: 'That question is better than anything in my original prompt. May I add it as an example?' },
      { author: 'priya', body: 'Please do!' },
    ] },
  { id: 'recipe-units', realm: 'prompt-craft', author: 'max', work: 'recipe-skill-v1', language: en, votes: 3,
    body: 'Recipe scaling skill mixes grams and cups\nI scaled the pancakes from 4 to 10 servings and got grams and cups in the same list. Is there a way to pin one unit system?',
    replies: [
      { author: 'aria', votes: 2, body: 'Add “Use metric units only” to your input. The next revision will ask which system you want.' },
    ] },
  { id: 'smallest-prompt', realm: 'prompt-craft', author: 'jun', work: 'prompt', language: en, votes: 8,
    body: 'Share your smallest useful prompt\nMine: “Ask me one question at a time until you can explain my problem back to me.” What is yours?',
    replies: [
      { author: 'nora', votes: 3, body: '“Before answering, list what you would need to know to be sure.”' },
      { author: 'wei', language: zh, votes: 2, body: '我的：“先用三句话总结，再告诉我你不确定的地方。”' },
      { author: 'hana', language: ja, votes: 2, body: '「結論を先に、理由は三つまで」。短いけれど効きます。' },
      { author: 'daniel', votes: 1, body: '“Explain it to me as if you were reviewing my pull request.”' },
    ] },
  { id: 'vertical-notes', realm: 'prompt-craft', author: 'hana', work: 'reading-skill-v1', language: ja, votes: 2,
    body: '縦書きの引用で「読書ノート」スキルの改行が崩れます\n日本語の読書会で使っていますが、縦書きの本から引用すると改行がおかしくなります。良い方法があれば教えてください。',
    replies: [
      { author: 'nora', language: en, votes: 1, body: 'I have not tried vertical text yet. Could you post a short sample? Happy to test it.' },
    ] },

  // English Classics Reading Circle
  { id: 'pride-week-one', realm: 'classics-circle', author: 'priya', work: 'pride', language: en, votes: 8,
    body: 'October read-along: Pride and Prejudice, chapters 1–12\nWelcome, everyone! Twelve chapters a week, and we meet here on Sundays. Start with the first line: do you believe it? Anything past chapter 12 goes in its own thread, marked as a spoiler.',
    replies: [
      { author: 'daniel', votes: 3, body: 'First read for me. I thought the first line was sincere until Mrs Bennet opened her mouth.' },
      { author: 'aria', votes: 4, body: 'Fourth read. Count how often Elizabeth is wrong in the first twelve chapters; it is fun once you know.' },
      { author: 'sophie', votes: 2, body: 'Reading a bilingual edition, so I will be a little slow. Mr Bennet is my favourite so far.' },
    ] },
  { id: 'darcy-letter', realm: 'classics-circle', author: 'aria', work: 'pride', language: en, votes: 6,
    spoiler: true,
    body: 'Chapter 35: Darcy’s letter\nOnly read on if you have finished volume two. Elizabeth rereads the letter and sees that her judgement of Wickham rested on one charming conversation. Did the letter change your mind about Darcy, or only about Elizabeth?',
    replies: [
      { author: 'priya', votes: 3, spoiler: true, body: 'About Elizabeth, mostly. “Till this moment I never knew myself” is the line the whole book turns on.' },
      { author: 'leo', votes: 2, spoiler: true, body: 'It changed my mind about Wickham first and Darcy second. Austen makes the reader share the misjudgement.' },
    ] },
  { id: 'jane-eyre-edition', realm: 'classics-circle', author: 'nora', work: 'jane-eyre', language: en, votes: 3,
    body: 'Which edition of Jane Eyre for a first read?\nIs there an annotated edition you would recommend? I keep running into references I do not understand.',
    replies: [
      { author: 'priya', votes: 2, body: 'Pick one with endnotes rather than footnotes, so the notes are there when you want them and out of the way when you do not.' },
      { author: 'daniel', votes: 1, body: 'Read it straight through first, then go back for the notes. The story carries you.' },
    ] },
  { id: 'frankenstein-halloween', realm: 'classics-circle', author: 'leo', work: 'frankenstein', language: en, votes: 5,
    body: 'Frankenstein for Halloween?\nThinking of a short side read for the end of October. It is shorter than I remembered. Anyone in?',
    replies: [
      { author: 'hana', votes: 2, body: 'Yes! I have only seen the films, so I am curious how different the creature is.' },
      { author: 'priya', votes: 3, body: 'Let’s do it: the letters and chapters 1–10 by the 24th, the rest by the 31st.' },
      { author: 'an', votes: 1, body: 'In. The ship in the Arctic surprised me the first time; I had no idea the story was framed.' },
    ] },
  { id: 'first-austen', realm: 'classics-circle', author: 'hana', work: 'pride', language: en, votes: 5,
    body: 'First time reading Austen in English: any tips?\nEnglish is my third language, and the sentences are long and ironic. Should I read with a dictionary or just keep going?',
    replies: [
      { author: 'priya', votes: 3, body: 'Keep going, and read the dialogue aloud. Austen’s irony is easier to hear than to see.' },
      { author: 'sophie', votes: 2, body: 'I read each chapter in Chinese first, then in English. It helped a lot.' },
    ] },
  { id: 'jo-or-amy', realm: 'classics-circle', author: 'sophie', work: 'little-women', language: en, votes: 4, down: 1,
    body: 'Little Women: Jo or Amy?\nI changed sides three times while reading. Where did you land, and did the ending change your answer?',
    replies: [
      { author: 'aria', votes: 2, body: 'Jo as a reader, Amy as an adult. The ending made me respect how clearly Amy sees.' },
      { author: 'wei', language: zh, votes: 1, body: '我一直站 Jo，但读到结尾也理解了 Amy。' },
    ] },
  { id: 'secret-garden-comfort', realm: 'classics-circle', author: 'mei', work: 'secret-garden', language: en, votes: 3,
    body: 'The Secret Garden as a comfort read\nI read it on the train this week. Mary Lennox might be the most honestly unpleasant child in fiction. Recommended for anyone who needs something gentle.',
    replies: [
      { author: 'priya', votes: 1, body: 'Adding it to our winter list.' },
    ] },
];
