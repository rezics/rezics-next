// Reviews on Work pages: each stands on its author's five-star rating, which
// the seed sets first, and some readers mark others' reviews helpful. Long and
// short, generous and grudging, in the reader's own language.

export interface PlannedReview { reader: string; work: string; rating: 1 | 2 | 3 | 4 | 5;
  language: 'en' | 'zh-Hans' | 'ja'; text: string; spoiler?: boolean;
  /** Readers who mark the review helpful. */
  helpful?: readonly string[] }

export const reviews: readonly PlannedReview[] = [
  // Pride and Prejudice
  { reader: 'aria', work: 'pride', rating: 5, language: 'en', helpful: ['priya', 'daniel', 'nora', 'hana'],
    text: 'My fourth time through, and it still surprises me. The first volume is a comedy of manners; the second is a quiet study of how a clever person misreads everything because she enjoys her own cleverness. Elizabeth is not punished for her prejudice, she is educated out of it, and Austen trusts the reader to notice that Darcy gets the same education a few chapters later. Read it slowly and read the dialogue aloud.' },
  { reader: 'priya', work: 'pride', rating: 5, language: 'en', helpful: ['aria', 'sophie'],
    text: 'The best-built novel I know. Every early scene is quietly setting up the letter in chapter 35, and the book rewards you for going back.' },
  { reader: 'daniel', work: 'pride', rating: 5, language: 'en', helpful: ['priya'],
    text: 'I expected a romance and got the funniest book I read this year. Mr Bennet alone is worth it.' },
  { reader: 'leo', work: 'pride', rating: 4, language: 'en',
    text: 'Wonderful once it gets going. The first ten chapters are a lot of balls and visits, but it pays off.' },
  { reader: 'nora', work: 'pride', rating: 4, language: 'en', helpful: ['hana'],
    text: 'Read it with our circle over a month. Discussing it chapter by chapter made the irony land in a way it never did when I read it alone at school.' },
  { reader: 'an', work: 'pride', rating: 4, language: 'zh-Hans',
    text: '先读的中译本，又对照英文读了一遍。伊丽莎白的机智在原文里更锋利，推荐有余力的朋友读原文。' },
  // Other classics
  { reader: 'aria', work: 'jane-eyre', rating: 5, language: 'en', helpful: ['nora', 'priya'],
    text: 'Jane says “I am no bird; and no net ensnares me” and the whole novel keeps that promise. It is a love story in which the heroine walks away from love when it would cost her self-respect, and the book is braver for it. The Lowood chapters are hard going, and they matter.' },
  { reader: 'priya', work: 'jane-eyre', rating: 5, language: 'en',
    text: 'Gothic, furious and tender. Better on a second read, when you know what is in the attic and can watch how Brontë hides it.' },
  { reader: 'leo', work: 'frankenstein', rating: 5, language: 'en', helpful: ['an', 'hana'],
    text: 'Nothing like the films. The creature is the most eloquent person in the book, and Victor is a man who runs away from every consequence. Short, strange and still unsettling.' },
  { reader: 'priya', work: 'frankenstein', rating: 4, language: 'en',
    text: 'The frame story with the Arctic expedition is the part people forget, and it is the key to the whole book.' },
  { reader: 'nora', work: 'frankenstein', rating: 3, language: 'en',
    text: 'I admire it more than I enjoyed it. The middle drags, but the creature’s account of learning to speak is extraordinary.' },
  { reader: 'sophie', work: 'little-women', rating: 4, language: 'en',
    text: 'Warm without being sweet. I argued with Jo the whole way through, which is probably the point.' },
  { reader: 'priya', work: 'little-women', rating: 3, language: 'en', helpful: ['sophie'],
    text: 'The first half is lovely and the second half hurries. I wanted more of the March sisters as adults, and less moralising in between.' },
  { reader: 'mei', work: 'secret-garden', rating: 4, language: 'en',
    text: 'A comfort read that is honest about how unpleasant lonely children can be. The garden grows back and so do they.' },
  // Chinese classics
  { reader: 'an', work: 'red-chamber', rating: 5, language: 'zh-Hans', helpful: ['wei', 'leo'],
    text: '读了三个月，终于读完前八十回。第一次读只看宝黛的感情，这次才注意到大观园里每个丫鬟都有自己的命运。建议准备一张人物关系表，第五回的判词先不急着看懂，读完再回头看，会有一种一切早已写好的震撼。' },
  { reader: 'wei', work: 'journey-west', rating: 5, language: 'zh-Hans',
    text: '比电视剧好看一百倍。孙悟空的每一次“不服”都有原因，取经路其实是一群人慢慢学会一起走路。' },
  // 雨夜书店 and other serials
  { reader: 'wei', work: 'serial', rating: 5, language: 'zh-Hans', helpful: ['an', 'daniel', 'hana', 'sophie'],
    text: '今年追得最安心的一部连载。没有大起大落，雨、书店、一封没有地址的信，就把人牢牢抓住了。作者很会写“停顿”：一句话写完，雨声接着响。每周更新一章的节奏也刚好，读书会一章一帖，讨论得很热闹。强烈推荐给喜欢安静悬疑的朋友。' },
  { reader: 'daniel', work: 'serial', rating: 5, language: 'zh-Hans', helpful: ['wei'],
    text: '每周最期待的更新。第一章结尾那封信让我一口气读到了最新。' },
  { reader: 'leo', work: 'serial', rating: 5, language: 'en', spoiler: true, helpful: ['sophie'],
    text: 'The ticket in chapter two is dated the year the bookshop opened, and its destination is the last bus of chapter three. I am now fairly sure the letter was never meant for Lin Mei at all.' },
  { reader: 'hana', work: 'serial', rating: 4, language: 'ja',
    text: '中国語の勉強に読み始めましたが、雨の夜の描写がきれいで、辞書を引きながらでも続きが気になります。' },
  { reader: 'wei', work: 'shop', rating: 4, language: 'zh-Hans',
    text: '轻松好笑的异世界日常。魔王来买书那段太好笑了，后面稍微有点注水，但整体很下饭。' },
  { reader: 'hana', work: 'shop', rating: 5, language: 'ja', helpful: ['wei'],
    text: '日本のラノベが好きな人にぜひ。魔王が「勇者に倒される方法」の本を買いに来る話で大笑いしました。中国語も比較的やさしいです。' },
  // Mods
  { reader: 'max', work: 'lumen-fabric', rating: 5, language: 'en', helpful: ['daniel', 'leo', 'sophie'],
    text: 'The best lighting mod on Fabric right now. Lanterns hang, sway a little in the wind and cast light that actually fits vanilla. It is light on performance (I measured under 1 ms per tick in a busy base), the config is sane, and the author fixes compatibility issues quickly. Pair it with Iris 1.7.2 or later if you use shaders.' },
  { reader: 'sophie', work: 'lumen-fabric', rating: 5, language: 'en',
    text: 'Makes every build look warmer. Installed it for one lantern and ended up relighting my whole village.' },
  { reader: 'daniel', work: 'lumen-fabric', rating: 4, language: 'en',
    text: 'Lovely once I updated Iris; see the Modding Help thread if your lanterns render black.' },
  { reader: 'max', work: 'weaver-forge', rating: 3, language: 'en', helpful: ['leo'],
    text: 'Does what it says and chunk loading is smoother, but it conflicts with two of my performance mods. Test it on a copy of your world first.' },
  { reader: 'leo', work: 'quiet-forge', rating: 4, language: 'en',
    text: 'Villagers finally stop shouting. Turn on memory migration once for old worlds and it is flawless.' },
  { reader: 'max', work: 'mod-guide', rating: 5, language: 'en',
    text: 'Short and right. I send this to everyone who asks why their save stopped loading.' },
  // Games: demo readers' own opinions, distinct from a publisher or Steam review aggregate.
  { reader: 'daniel', work: 'game-stardew', rating: 5, language: 'en',
    text: 'I came for the farming and stayed for the town. The daily rhythm makes it easy to return after a break.' },
  { reader: 'sophie', work: 'game-stardew', rating: 4, language: 'en',
    text: 'A gentle game with a surprising amount to plan. I like having a farm goal without a deadline.' },
  { reader: 'leo', work: 'game-hades', rating: 5, language: 'en',
    text: 'Each escape attempt taught me something new about a weapon or a character. The short runs fit my evenings.' },
  { reader: 'aria', work: 'game-celeste', rating: 5, language: 'en',
    text: 'The climb is demanding, but each room is small enough that trying again feels inviting.' },
  // Prompts, skills and guides
  { reader: 'priya', work: 'club-prompt-v1', rating: 5, language: 'en', helpful: ['nora', 'aria'],
    text: 'Turned our messiest discussion notes into three questions we argued about for an hour. Exactly what a book club needs.' },
  { reader: 'hana', work: 'glossary-prompt-v1', rating: 5, language: 'ja',
    text: '日本語と中国語の用語集づくりに使っています。「固有名詞は原文のまま」と一行足すと完璧です。' },
  { reader: 'nora', work: 'reading-skill-v1', rating: 4, language: 'en',
    text: 'Keeps notes organised by theme and asks good open questions. Give it the real text, not a summary, or it will invent quotes.' },
  { reader: 'max', work: 'recipe-skill-v1', rating: 3, language: 'en',
    text: 'Scales well, but it mixed grams and cups for me. Say which units you want and it is fine.' },
  { reader: 'jun', work: 'prompt', rating: 5, language: 'en',
    text: 'Simple and it works in any language our club reads.' },
  { reader: 'nora', work: 'shader-guide', rating: 5, language: 'en',
    text: 'Got shaders running on a five-year-old laptop at 45 fps. The low preset is the real gem.' },
];
