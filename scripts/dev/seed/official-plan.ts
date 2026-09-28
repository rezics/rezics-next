import { stableId } from './state.ts';
import { ZONE_PRESETS, type ZonePresentation }
  from '../../../services/main/src/modules/zone/presentation-format.ts';

// What the official Zones publish in the local demo: the Fiction Zone as a
// serial publication in the spirit of KadoKado (picks, latest chapters,
// charts, editors' lists, reader quotes and decisions), and a lighter,
// never-empty front page for Books, Mods, AI Workshop, Software and Kitchen.
// The stories in apps/web/features/zones/fixtures.ts show the same catalogue.

export type OfficialRealmId = 'fiction' | 'books' | 'mods' | 'ai-workshop' | 'software' | 'kitchen';
type Language = 'en' | 'zh-Hans';

/** A pen name one demo person writes under. Works are created as the pen name, so it is their author. */
export interface PenName { id: string; owner: string; displayName: string; handle: string; bio: string;
  bioLanguage: Language }

export const penNames: readonly PenName[] = [
  { id: 'beidao', owner: 'an', displayName: '北岛听风', handle: 'beidao_tingfeng', bioLanguage: 'zh-Hans',
    bio: '写宇宙尽头的旅店和会倒着走的钟。白天是程序员，夜里写科幻。' },
  { id: 'chen-xiaoyu', owner: 'an', displayName: '陈小渔', handle: 'chen_xiaoyu', bioLanguage: 'zh-Hans',
    bio: '海边长大，写灯塔、渔船和记忆。' },
  { id: 'sujiu', owner: 'sophie', displayName: '苏九', handle: 'su_jiu', bioLanguage: 'zh-Hans',
    bio: '武侠与江南。慢慢写，写完为止。' },
  { id: 'june', owner: 'sophie', displayName: 'June Hartley', handle: 'june_hartley', bioLanguage: 'en',
    bio: 'Coastal romances and quarrelsome lighthouse keepers.' },
  { id: 'juzi', owner: 'jun', displayName: '橘子汽水', handle: 'juzi_qishui', bioLanguage: 'zh-Hans',
    bio: '轻松日常推理。委托费一律收糖。' },
  { id: 'maren', owner: 'jun', displayName: 'Maren Osei', handle: 'maren_osei', bioLanguage: 'en',
    bio: 'Surveyor by training; writes maps that move.' },
  { id: 'yehang', owner: 'aria', displayName: '夜航船', handle: 'yehangchuan', bioLanguage: 'zh-Hans',
    bio: '玄门志怪，小道士和他的城隍爷。' },
  { id: 'mobei', owner: 'aria', displayName: '墨北', handle: 'mo_bei', bioLanguage: 'zh-Hans',
    bio: '都市奇幻，一碗面一个故事。' },
  { id: 'sangeng', owner: 'leo', displayName: '三更灯', handle: 'sangengdeng', bioLanguage: 'zh-Hans',
    bio: '纸鹤、雷雨和寄往云端的信。' },
  { id: 'zhishang', owner: 'leo', displayName: '纸上飞鱼', handle: 'zhishang_feiyu', bioLanguage: 'zh-Hans',
    bio: '异世界里开书店的人。更新靠读者的催更。' },
  { id: 'theo', owner: 'leo', displayName: 'Theo Arkwright', handle: 'theo_arkwright', bioLanguage: 'en',
    bio: 'Libraries, ferries and things that must be returned before dawn.' },
];

export interface OfficialChapter { title: string; body: string }
/** A serial the Fiction Zone publishes: its hook, its opening as public text, and its chapters. */
export interface FictionWork {
  id: string; title: string; language: Language; author: string; tagline: string;
  /** The name its idempotency keys use, when the plan renamed a Work a stack already has. Defaults to `id`. */
  seedName?: string;
  completionStatus: 'ongoing' | 'completed' | 'hiatus';
  /** The Work's own public text: its prologue. */
  opening: string;
  chapters: readonly OfficialChapter[];
  /** How many demo readers read it this week, so the charts differ (0–7). */
  readers: number;
}

const zh = (title: string, author: string, tagline: string, completionStatus: FictionWork['completionStatus'],
  readers: number, opening: string, chapters: [string, string][]): Omit<FictionWork, 'id'> => ({
  title, language: 'zh-Hans', author, tagline, completionStatus, readers, opening,
  chapters: chapters.map(([chapterTitle, body]) => ({ title: chapterTitle, body })) });
const en = (title: string, author: string, tagline: string, completionStatus: FictionWork['completionStatus'],
  readers: number, opening: string, chapters: [string, string][]): Omit<FictionWork, 'id'> => ({
  ...zh(title, author, tagline, completionStatus, readers, opening, chapters), language: 'en' });

export const fictionWorks: readonly FictionWork[] = Object.entries({
  inn: zh('星河旅店', 'beidao', '宇宙尽头的旅店只收一种房费：一个没说出口的秘密。', 'ongoing', 6,
    '楔子\n星河旅店开在所有航线的尽头。前台的铜铃响过三次，就会有一位客人从不存在的方向走进来。', [
      ['第一章 第三声铃', '铃响第三声的时候，阿澄正在擦一只没有底的杯子。门外站着一个穿宇航服的老人，他说他是来退房的，可他从来没有入住过。'],
      ['第二章 房费', '“房费是一个秘密。”阿澄把登记簿推过去。老人想了很久，写下一行字：我把回家的航线弄丢了，故意的。'],
      ['第三章 无人的走廊', '走廊尽头的房间亮着灯，那是旅店从不出租的一间。阿澄听见里面有人在数星星，数到一千零一，又从头开始。'],
    ]),
  'sword-tea': zh('剑与茶', 'sujiu', '退隐的剑客开了间茶馆，来喝茶的全是当年的仇家。', 'completed', 5,
    '楔子\n江湖上最后一次听到“沈无锋”这个名字，是十年前的雪夜。十年后，城南多了一间只卖清茶的小馆。', [
      ['第一章 一壶龙井', '第一位客人进门时带着刀。沈无锋替他斟了一杯龙井：“刀放桌上，茶要趁热。”'],
      ['第二章 旧账', '客人们一个接一个来，每个人都记得他欠下的账。沈无锋只记得每个人爱喝什么茶。'],
      ['终章 雪夜', '又一个雪夜，茶馆坐满了人，没有一把刀出鞘。有人问他，当年为什么收剑。他说：因为茶凉了。'],
    ]),
  cat: zh('猫咖的第七位客人', 'juzi', '每晚十一点，总有一位客人点一杯不存在的咖啡。', 'ongoing', 4,
    '楔子\n“七号桌，一杯月光拿铁。”店员小满翻遍菜单，也没找到这款咖啡。可七号桌的客人每晚都来。', [
      ['第一章 月光拿铁', '小满试着把牛奶打得像月光一样轻。客人喝了一口，说：比上次的好，但还差一点雨声。'],
      ['第二章 店里的第七只猫', '猫咖只有六只猫。可每到十一点，窗台上总会多出一只灰猫，安安静静地陪着七号桌。'],
    ]),
  moon: zh('月下签语', 'moonlight', '抽中下下签的少女，决定改写整座城的命运。', 'ongoing', 5,
    '楔子\n城隍庙的签筒一百年只出过一次下下签。今年上元节，它落在了阿禾手里。', [
      ['第一回 下下签', '解签的老人看了一眼签文，便把铺子关了。阿禾追出去问：下下签写的是我，还是这座城？'],
      ['第二回 月下的人', '月亮升到庙檐的时候，签上的字开始自己改写。有人在月下替她答了第一个问题。'],
      ['第三回 改签', '阿禾找到了那个人。他说：签可以改，但每改一个字，就要有人替你记住一件事。'],
    ]),
  shop: zh('我在异世界开书店', 'zhishang', '魔王想买一本《如何被勇者打败》，我只好现写。', 'ongoing', 7,
    '楔子\n穿越之后，我唯一的技能是开书店。好在这个世界的人都识字，坏在他们想读的书都还没人写。', [
      ['第一章 第一位客人', '魔王穿着斗篷走进来，压低声音问：有没有一本教人体面输掉的书？我说有，明天来取。'],
      ['第二章 连夜赶稿', '我写到第三章才发现，魔王想输给的那个勇者，是他失散多年的弟弟。'],
      ['第三章 书评', '魔王看完书，留下一句书评：结局太温柔，但我接受。'],
    ]),
  light: zh('灯塔守望者', 'chen-xiaoyu', '海雾里的灯塔每闪一次，就有一段记忆回到岸上。', 'completed', 3,
    '楔子\n岛上的灯塔已经没有船需要它了。守塔人老周还是每晚点灯，因为雾里总有东西要回来。', [
      ['第一章 雾', '第一次闪光之后，海滩上多了一只旧皮鞋。那是老周父亲出海那天穿的。'],
      ['终章 最后一次点灯', '灯塔最后一次亮起时，整座岛的人都来了。雾散了，他们记起了所有忘掉的名字。'],
    ]),
  crane: zh('纸鹤与雷雨', 'sangeng', '他们用纸鹤传信，直到其中一只飞进了雷雨云。', 'ongoing', 3,
    '楔子\n两栋楼之间隔着一条巷子。她在窗口放飞纸鹤，他在对面接住，七年没有断过。', [
      ['第一章 第一千只', '第一千只纸鹤没有飞到对面。它被风卷起，钻进了那天傍晚的雷雨云。'],
      ['第二章 回信', '三天后，一只湿透的纸鹤落在她的窗台上。展开来，是一封不是他写的回信。'],
    ]),
  chef: zh('深夜食堂的魔法师', 'mobei', '用一碗面治好失眠的人，是这座城最后的魔法师。', 'ongoing', 4,
    '楔子\n凌晨一点，巷口的面馆总是亮着。老板从不看菜单，他看的是客人的眼睛。', [
      ['第一章 失眠的人', '年轻的会计已经三个月没睡着了。老板给他煮了一碗阳春面，汤里放了一点点月色。'],
      ['第二章 魔法的代价', '会计那晚睡得很好。第二天，老板的头发白了一缕。'],
    ]),
  taoist: zh('玄门小道士', 'yehang', '下山第一天，小道士就被城隍爷拉去查一桩旧案。', 'ongoing', 7,
    '楔子\n师父说，下山之后，先别急着捉妖，先学会问路。清风下山第一天，问路问到了城隍庙。', [
      ['第一章 城隍爷', '城隍爷是个爱喝茶的老头。他说：有个案子压了三十年，你来得正好。'],
      ['第二章 旧案', '三十年前，城里的钟楼一夜之间停了。所有人都忘了那一夜发生过什么，除了一只猫。'],
      ['第三章 问猫', '清风蹲在墙根问了一下午。猫终于开口：你师父当年也来问过，他没问对问题。'],
    ]),
  metro: zh('末班地铁', 'mei', '末班地铁多出一站，站名是她童年的家。', 'hiatus', 2,
    '楔子\n十一点四十七分的末班车，本该在终点站前停十二次。今晚，它停了第十三次。', [
      ['第一章 第十三站', '车门打开，站台上的站牌写着“梧桐里”。那是她六岁以前住过的地方，早就拆掉了。'],
    ]),
  heron: zh('白鹭洲', 'sujiu', '一部写给江南水乡的长信，从外婆的渡船说起。', 'completed', 2,
    '楔子\n外婆的渡船从白鹭洲划到对岸，一趟要唱完三支歌。', [
      ['第一章 渡船', '我第一次坐外婆的船，是在五岁那年的清明。雨很细，歌很长。'],
      ['终章 对岸', '后来桥修好了，渡船停在芦苇里。我替外婆唱完了最后一支歌。'],
    ]),
  candy: zh('糖果屋侦探社', 'juzi', '委托费是一颗糖，案子却一桩比一桩离奇。', 'ongoing', 5,
    '楔子\n糖果屋侦探社只有两个成员：十二岁的社长，和一只会记账的鹦鹉。', [
      ['第一章 失踪的橡皮', '第一桩委托是同桌丢了一块橡皮。社长收下一颗橘子糖，说：这不是普通的橡皮。'],
      ['第二章 鹦鹉的账本', '鹦鹉在账本上写下：橘子糖一颗，线索三条，嫌疑人——校长。'],
    ]),
  bell: zh('燃烧的钟楼', 'beidao', '钟楼每烧一次，时间就往回退一天。', 'ongoing', 3,
    '楔子\n小城的钟楼在周二夜里起火。周三早上，大家醒来发现，今天又是周二。', [
      ['第一章 又是周二', '消防员林远第三次冲进火场时，终于看清了钟楼顶上的人影。'],
    ]),
  tides: en('The Cartographer of Tides', 'maren', 'A surveyor maps a delta that redraws itself every full moon.',
    'ongoing', 4, 'Prologue\nThe delta has no fixed shape. The city pays Ada Mensah to map it anyway.', [
      ['Chapter 1: Low Water', 'The tide went out at four and took the eastern bank with it. Ada wrote down what was left.'],
      ['Chapter 2: The Surveyor’s Chain', 'She set the chain across the mud and counted the links aloud. By evening the ledger disagreed with the city again.'],
    ]),
  salt: en('Salt and Starlight', 'june', 'Two rival lighthouse keepers, one storm, and a letter neither will send.',
    'completed', 2, 'Prologue\nTwo lighthouses face each other across a mile of water. Their keepers have not spoken in six years.', [
      ['Chapter 1: Signals', 'Every night Nell dims her lamp twice at nine. Every night, across the water, Tom pretends not to notice.'],
      ['Chapter 2: The Storm', 'When the storm took out Tom’s lamp, Nell rowed across with oil, a lantern and the letter she never sent.'],
    ]),
  ferry: en('The Night Ferry Library', 'theo', 'Books borrowed on the midnight ferry must be returned before dawn.',
    'ongoing', 3, 'Prologue\nThe midnight ferry carries no cars and very few passengers. It does carry a library.', [
      ['Chapter 1: The Lending Rule', 'The librarian stamps each card with the time of sunrise. Nobody asks what happens if you are late.'],
      ['Chapter 2: Overdue', 'Iris was late once. She has been riding the ferry every night since, trying to return the book.'],
    ]),
}).map(([id, work]) => ({ id, ...work,
  // First seeded as `tea`, which is also the base plan's ginger tea recipe.
  ...id === 'sword-tea' ? { seedName: 'tea' } : {} }));

/** Readers quoting Fiction serials; each quote is a reply the Fiction editors approved. */
export const fictionQuotes: readonly { work: string; reader: string; body: string }[] = [
  { work: 'shop', reader: 'daniel', body: '魔王的书评笑死我了，结局太温柔但我接受——这句话我要当作今年的座右铭。' },
  { work: 'taoist', reader: 'sophie', body: '本来不喜欢仙侠，但小道士查案的节奏太爽了，蹲墙根问猫那一段写得太妙，一口气追到最新。' },
  { work: 'tides', reader: 'leo', body: 'The delta chapters read like a map you can hear. Slow, strange and worth every page.' },
  { work: 'sword-tea', reader: 'jun', body: '“因为茶凉了”这个结尾我反复看了三遍。十年恩怨，一壶龙井就放下了，写得真干净。' },
];

/** Recipes, classics and guides for the lighter Zones, as public texts on Works the base plan already created. */
export const publicTexts: Readonly<Record<string, { language: Language; text: string; tagline?: string;
  completionStatus?: 'completed' }>> = {
  pride: { language: 'en', completionStatus: 'completed',
    text: 'Reading note\nThe Bennet sisters face a narrow set of choices, while Elizabeth and Darcy learn how easily judgment can outrun understanding.' },
  alice: { language: 'en', completionStatus: 'completed',
    text: 'Reading note\nAlice follows a white rabbit into a world where size, language, and ordinary rules refuse to stay put.' },
  'jane-eyre': { language: 'en', completionStatus: 'completed',
    tagline: 'An orphan governess, a house with a locked attic, and a love she will not buy with her freedom.',
    text: 'Reading note\nJane grows from a lonely child into a governess determined to keep her independence, even when love asks her to compromise it.' },
  frankenstein: { language: 'en', completionStatus: 'completed',
    tagline: 'A young scientist builds a life, then runs from what he made.',
    text: 'Reading note\nVictor brings a creature to life and abandons him. Their pursuit across Europe raises questions about care and responsibility.' },
  'little-women': { language: 'en', completionStatus: 'completed',
    tagline: 'Four sisters, one hard winter, and the plays they stage to get through it.',
    text: 'Reading note\nMeg, Jo, Beth, and Amy grow up with different ambitions, held together by family work, friendship, and loss.' },
  'secret-garden': { language: 'en', completionStatus: 'completed',
    tagline: 'A lonely girl finds a locked garden, and a key, and a reason to stay.',
    text: 'Reading note\nMary discovers a neglected garden at Misselthwaite Manor and finds that tending it changes her and the people around her.' },
  sherlock: { language: 'en', completionStatus: 'completed',
    tagline: 'Twelve cases, one detective, and the woman who outwitted him.',
    text: 'Reading note\nHolmes and Watson investigate a series of puzzles, from a threatened royal secret to mysteries in familiar London streets.' },
  'sherlock-scandal': { language: 'en', completionStatus: 'completed',
    text: 'Reading note\nA king asks Holmes to recover a photograph, but Irene Adler has plans of her own.' },
  'journey-west': { language: 'zh-Hans', completionStatus: 'completed',
    text: '导读\n孙悟空随唐僧西行取经，一路上的妖怪与考验，也让师徒四人不断重新理解彼此。' },
  'red-chamber': { language: 'zh-Hans', completionStatus: 'completed',
    text: '导读\n贾府的繁华与衰落交织在宝玉、黛玉和众多人物的日常生活里。' },
  'strange-tales': { language: 'zh-Hans', completionStatus: 'completed',
    text: '导读\n鬼狐故事写尽人情，有时最难辨认的并非妖怪，而是人心。' },
  'painted-skin': { language: 'zh-Hans', completionStatus: 'completed',
    text: '导读\n一张画出的皮相遮住真实面目，也把轻信与欲望推到故事中央。' },
  'three-kingdoms': { language: 'zh-Hans', completionStatus: 'completed',
    text: '导读\n群雄争战与结盟的故事，围绕汉末乱世中的权力、谋略与忠义展开。' },
  'water-margin': { language: 'zh-Hans', completionStatus: 'completed',
    text: '导读\n梁山好汉的聚散与抉择，让反抗、义气和招安之间的张力贯穿全书。' },
  dumplings: { language: 'zh-Hans', tagline: '过年的味道：韭菜鸡蛋馅，一次包一百个。',
    text: '韭菜鸡蛋饺子\n韭菜洗净沥干切碎，鸡蛋炒散晾凉，加盐和香油拌匀。包好后水开下锅，点三次凉水即熟。' },
  noodles: { language: 'zh-Hans', tagline: '十分钟一碗，番茄炒出沙，鸡蛋要嫩。',
    text: '番茄鸡蛋面\n番茄切块炒出沙，加水烧开下面条；鸡蛋打散淋入锅中，关火前撒葱花和一点盐。' },
  pancakes: { language: 'en', tagline: 'Fluffy weekend pancakes from a batter you mix the night before.',
    text: 'Weekend buttermilk pancakes\nWhisk flour, sugar, baking powder and salt. Add buttermilk, egg and melted butter; rest the batter, then cook on a hot griddle until bubbles set.' },
  tea: { language: 'en', tagline: 'A warm mug for cold evenings: ginger, lemon and a spoon of honey.',
    text: 'Ginger lemon tea\nSimmer sliced ginger for ten minutes. Pour over lemon slices and stir in honey to taste.' },
};

/** New Works that give the smaller Zones more than one pick; created by a demo person, not a pen name. */
export const extraWorks: readonly { id: string; realm: OfficialRealmId; owner: string; title: string;
  type: 'document' | 'mod' | 'prompt' | 'skill-package'; language: Language; tagline: string; text: string }[] = [
  { id: 'stardew-farm', realm: 'mods', owner: 'jun', title: '星露谷物语 · 春季农场整合包', type: 'document',
    language: 'zh-Hans', tagline: '二十个模组，一个存档就能用的春季农场。',
    text: '安装顺序\n先装 SMAPI，再装内容补丁，最后放入农场地图。每一步都备份存档。' },
  { id: 'shader-guide', realm: 'mods', owner: 'jun', title: 'Minecraft shaders: a gentle first setup', type: 'document',
    language: 'en', tagline: 'Pick one shader pack, tune three settings, keep your frame rate.',
    text: 'Start small\nInstall one shader loader and one pack. Lower shadow distance first, then clouds, before touching anything else.' },
  { id: 'glossary-prompt', realm: 'ai-workshop', owner: 'aria', title: '双语术语表 · 翻译提示词', type: 'document',
    language: 'zh-Hans', tagline: '先定术语，再译全文：让模型每次都用同一个译名。',
    text: '用法\n先列出原文里的专有名词和你想要的译名，再让模型翻译，并在结尾列出它没把握的词。' },
  { id: 'club-notes', realm: 'ai-workshop', owner: 'aria', title: 'Book club notes assistant', type: 'document',
    language: 'en', tagline: 'Turn a messy discussion into three questions for next week.',
    text: 'How to use it\nPaste the notes. Ask for the three questions the group disagreed on, with one quote each.' },
  { id: 'lumen-fabric', realm: 'mods', owner: 'jun', title: 'Lumen Lanterns', type: 'mod', language: 'en',
    tagline: 'Warm lantern light for Minecraft 1.21.1 on Fabric.',
    text: 'Lumen Lanterns 1.3.0\nInstall the matching Fabric loader and keep a backup of your world before adding mods.' },
  { id: 'weaver-forge', realm: 'mods', owner: 'jun', title: 'Chunk Weaver', type: 'mod', language: 'en',
    tagline: 'Prepare nearby Minecraft chunks before you explore on Forge.',
    text: 'Chunk Weaver 1.4.2\nTest in a copy of your world before changing the server mod set.' },
  { id: 'tidy-fabric', realm: 'mods', owner: 'jun', title: 'Tidy Inventory', type: 'mod', language: 'en',
    tagline: 'Sort chests with one key on Minecraft 1.21.1 with Fabric.',
    text: 'Tidy Inventory 2.0.1\nInstall with a matching Fabric loader and test your key bindings.' },
  { id: 'quiet-forge', realm: 'mods', owner: 'jun', title: 'Quiet Villagers', type: 'mod', language: 'en',
    tagline: 'Quieter trading sounds for Minecraft 1.21.1 with Forge.',
    text: 'Quiet Villagers 1.0.2\nInstall on the client and test sound settings after updating.' },
  { id: 'club-prompt-v1', realm: 'ai-workshop', owner: 'aria', title: 'Book club discussion prompt',
    type: 'prompt', language: 'en', tagline: 'Find the questions readers actually disagree about.',
    text: 'Use the published prompt to turn notes into discussion questions.' },
  { id: 'glossary-prompt-v1', realm: 'ai-workshop', owner: 'aria', title: 'Bilingual glossary prompt',
    type: 'prompt', language: 'en', tagline: 'Set translation terms before drafting the full text.',
    text: 'Use the published prompt to keep a glossary beside a translation.' },
  { id: 'recipe-skill-v1', realm: 'ai-workshop', owner: 'aria', title: 'Recipe scaling skill',
    type: 'skill-package', language: 'en', tagline: 'Scale ingredient amounts and flag judgment calls.',
    text: 'The published Skill asks for servings and scales quantities.' },
  { id: 'reading-skill-v1', realm: 'ai-workshop', owner: 'aria', title: 'Reading notes skill',
    type: 'skill-package', language: 'en', tagline: 'Turn reading notes into a short recap and open questions.',
    text: 'The published Skill groups notes by theme and marks uncertain claims.' },
];

/** Local, fictional Minecraft packages. Native captures come from the same Fabric/Forge
 * manifest surfaces exercised by the mod provider fixtures. */
export const officialMods = [
  { id: 'lumen-fabric', ecosystem: 'fabric', nativeId: 'lumenlanterns', release: '1.3.0' },
  { id: 'weaver-forge', ecosystem: 'forge', nativeId: 'chunkweaver', release: '1.4.2' },
  { id: 'tidy-fabric', ecosystem: 'fabric', nativeId: 'tidyinventory', release: '2.0.1' },
  { id: 'quiet-forge', ecosystem: 'forge', nativeId: 'quietvillagers', release: '1.0.2' },
] as const;

/** The captured Fabric API the later Fabric releases need, so their captures resolve. */
export const fabricApi = { id: 'fabric-api', version: '0.102.0' } as const;

/**
 * Releases bound after each mod's first, in order: what a mod page lists under
 * Versions, with the dependencies its manifest declares and the owner's notes.
 */
export const laterModReleases: readonly { mod: (typeof officialMods)[number]['id']; release: string;
  gameVersion: string; environment?: 'client' | 'server'; depends?: Record<string, string>;
  recommends?: Record<string, string>; breaks?: Record<string, string>; changelog: string }[] = [
  { mod: 'lumen-fabric', release: '1.3.1', gameVersion: '1.21.1', environment: 'client',
    depends: { 'fabric-api': '>=0.100.0' }, recommends: { modmenu: '*' }, breaks: { optifabric: '*' },
    changelog: 'Lanterns glow warmer at night.\nFixes flicker next to water.' },
  { mod: 'lumen-fabric', release: '1.3.1', gameVersion: '1.20.1', environment: 'client',
    depends: { 'fabric-api': '>=0.90.0' }, changelog: 'The same lanterns, backported to Minecraft 1.20.1.' },
  { mod: 'tidy-fabric', release: '2.1.0', gameVersion: '1.21.1',
    depends: { 'fabric-api': '*' }, recommends: { 'cloth-config': '>=15' },
    changelog: 'Sorting works on servers too: install it on both sides to sort shared chests.' },
];

export const officialHubItems = [
  { id: 'club-prompt-v1', kind: 'prompt', name: 'book-club-discussion',
    content: 'Read the following book club notes. List three questions the group disagreed on. For each, quote a short phrase from the notes and explain both views. If the notes do not support three disagreements, say how many you found.\n\nNotes: {{notes}}' },
  { id: 'glossary-prompt-v1', kind: 'prompt', name: 'bilingual-glossary',
    content: 'Read the source text below. List names and specialist terms with proposed translations before translating. Use each chosen term consistently. At the end, list terms whose meaning remains uncertain.\n\nSource text: {{notes}}' },
  { id: 'recipe-skill-v1', kind: 'skill-package', name: 'recipe-scaling',
    content: 'Ask for the original and desired number of servings. Scale measured ingredients by the ratio. Keep cooking times separate and flag ingredients such as salt and spices for a taste check.' },
  { id: 'reading-skill-v1', kind: 'skill-package', name: 'reading-notes',
    content: 'Ask for the reader’s notes. Group the notes by theme, write a short recap, and list open questions. Do not add events or quotations absent from the notes.' },
] as const;

/** Which public Works each official Realm adopts, and the editors' lists its Zone shows. */
export const zoneContent: Record<OfficialRealmId, { adopt: readonly string[];
  lists: readonly { id: string; name: string; works: readonly string[] }[] }> = {
  fiction: {
    // New adoptions lead the Zone's picks, so the serials adopted last open the page.
    adopt: ['journey-west', 'red-chamber', 'ferry', 'salt', 'bell', 'heron', 'metro', 'crane', 'light', 'cat',
      'candy', 'chef', 'moon', 'tides', 'inn', 'sword-tea', 'serial', 'taoist', 'shop'],
    lists: [
      { id: 'rainy-day', name: '【雨天限定】适合下雨天读的故事', works: ['serial', 'metro', 'light', 'crane', 'ferry', 'cat'] },
      { id: 'weekend', name: '周末一口气读完：完结好书', works: ['sword-tea', 'light', 'heron', 'salt', 'journey-west', 'red-chamber'] },
    ],
  },
  books: { adopt: ['pride', 'alice', 'jane-eyre', 'frankenstein', 'little-women', 'secret-garden', 'sherlock'],
    lists: [{ id: 'start-here', name: 'Classics to start with · 从这里开始读经典',
      works: ['pride', 'jane-eyre', 'little-women', 'secret-garden', 'alice', 'frankenstein'] }] },
  mods: { adopt: ['mod-guide', 'stardew-farm', 'shader-guide',
    'lumen-fabric', 'weaver-forge', 'tidy-fabric', 'quiet-forge'],
    lists: [{ id: 'first-mods', name: 'First mods · 第一次装模组',
      works: ['lumen-fabric', 'weaver-forge', 'tidy-fabric', 'quiet-forge'] }] },
  'ai-workshop': { adopt: ['club-prompt-v1', 'glossary-prompt-v1', 'recipe-skill-v1', 'reading-skill-v1'],
    lists: [
      { id: 'reading-prompts', name: 'Prompts for readers · 读书人的提示词',
        works: ['club-prompt-v1', 'reading-skill-v1'] },
      { id: 'writing-prompts', name: 'Writing and translation · 写作与翻译',
        works: ['glossary-prompt-v1', 'recipe-skill-v1'] },
    ] },
  software: { adopt: ['bun', 'elysia', 'react', 'typescript'],
    lists: [{ id: 'web-stack', name: 'A small web stack · 一套小而全的 Web 技术栈',
      works: ['typescript', 'bun', 'elysia', 'react'] }] },
  kitchen: { adopt: ['dumplings', 'noodles', 'pancakes', 'tea'],
    lists: [{ id: 'weeknight', name: 'Weeknight dinners · 下班后的晚饭', works: ['noodles', 'dumplings', 'pancakes', 'tea'] }] },
};

/** An editors' list Collection: a native IRI the seed chooses, so the presentation can name it up front. */
export const editorList = (realm: OfficialRealmId, list: string) =>
  `https://rezics.com/id/${stableId(`official-list:${realm}:${list}`)}`;

export const packagedZone = (realm: OfficialRealmId) =>
  realm === 'fiction' || realm === 'books' || realm === 'mods' || realm === 'ai-workshop';

export const officialTheme = (realm: OfficialRealmId) =>
  `https://rezics.com/id/${stableId(`official-theme:${realm}`)}`;

type Bilingual = { en: string; 'zh-CN': string };
/** Each official Realm's public profile: what it is, its rules and who moderates it (demo person ids). */
export const realmProfiles: Record<OfficialRealmId, { name: Bilingual; description: Bilingual;
  rules: readonly { id: string; title: Bilingual; body: Bilingual }[]; moderators: readonly string[] }> = {
  fiction: {
    name: { en: 'Fiction', 'zh-CN': '小说' },
    description: {
      en: 'Web serials, light novels and originals, picked in public by the Fiction editors. Every pick here is a public decision you can read.',
      'zh-CN': '网络连载、轻小说与原创作品，由小说编辑部公开甄选。这里的每一部推荐都来自一项可以查阅的公开决定。' },
    rules: [
      { id: 'hook', title: { en: 'Every pick gets a one-line hook', 'zh-CN': '每部推荐都有一句话简介' },
        body: { en: 'Editors write the line shown under the cover. It sells the story without spoiling it.',
          'zh-CN': '编辑为封面下的那一句简介负责：写出故事的魅力，但不剧透。' } },
      { id: 'credit', title: { en: 'Authors and translators are credited', 'zh-CN': '署名作者与译者' },
        body: { en: 'A serial names its author; a translation names its translator and links the original.',
          'zh-CN': '连载要署作者名；译作要署译者名，并链接原作。' } },
      { id: 'spoilers', title: { en: 'Mark spoilers in discussions', 'zh-CN': '讨论时标注剧透' },
        body: { en: 'Say which chapter you are talking about before you give anything away.',
          'zh-CN': '讨论剧情前，先说明你读到第几章。' } },
    ],
    moderators: ['daniel', 'mei', 'an'],
  },
  books: {
    name: { en: 'Books', 'zh-CN': '图书' },
    description: { en: 'Public-domain classics and the editions worth reading, in English and Chinese.',
      'zh-CN': '公版经典和值得读的版本，中英文都有。' },
    rules: [{ id: 'editions', title: { en: 'Name the edition', 'zh-CN': '注明版本' },
      body: { en: 'Say which edition or translation you read when you recommend a book.',
        'zh-CN': '推荐一本书时，说明你读的是哪个版本或译本。' } }],
    moderators: ['an'],
  },
  mods: {
    name: { en: 'Mods', 'zh-CN': '模组' },
    description: { en: 'Game mods, load orders and setup guides that keep your saves safe.',
      'zh-CN': '游戏模组、加载顺序和不会弄坏存档的安装指南。' },
    rules: [{ id: 'versions', title: { en: 'State game and mod versions', 'zh-CN': '写明游戏与模组版本' },
      body: { en: 'Every guide names the game version and the mods it was tested with.',
        'zh-CN': '每份指南都要写明游戏版本和测试过的模组。' } }],
    moderators: ['sophie'],
  },
  'ai-workshop': {
    name: { en: 'AI Workshop', 'zh-CN': 'AI 工作坊' },
    description: { en: 'Prompts, skills and small tools for reading and writing with AI.',
      'zh-CN': '用 AI 读书和写作的提示词、技能与小工具。' },
    rules: [{ id: 'show-output', title: { en: 'Show a sample output', 'zh-CN': '附上示例输出' },
      body: { en: 'Share one real result with every prompt, and say which model produced it.',
        'zh-CN': '每条提示词附一个真实结果，并说明用的是哪个模型。' } }],
    moderators: ['jun'],
  },
  software: {
    name: { en: 'Software', 'zh-CN': '软件' },
    description: { en: 'Runtimes, frameworks and libraries, explained with a small first step.',
      'zh-CN': '运行时、框架和库，从一个小小的第一步讲起。' },
    rules: [{ id: 'small-step', title: { en: 'Start with a small example', 'zh-CN': '从小例子开始' },
      body: { en: 'Guides open with the smallest example that runs.', 'zh-CN': '指南以能运行的最小示例开头。' } }],
    moderators: ['aria'],
  },
  kitchen: {
    name: { en: 'Kitchen', 'zh-CN': '厨房' },
    description: { en: 'Home cooking from everyday kitchens: weeknight dinners, holiday dumplings and warm drinks.',
      'zh-CN': '家常菜：下班后的晚饭、过年的饺子和一杯热饮。' },
    rules: [{ id: 'quantities', title: { en: 'Give quantities and times', 'zh-CN': '写清用量和时间' },
      body: { en: 'A recipe lists its quantities and how long each step takes.', 'zh-CN': '菜谱要写清用量和每一步的时间。' } }],
    moderators: ['leo'],
  },
};

type Titles = { en: string; 'zh-Hant': string; 'zh-Hans': string; ja: string; ko: string; de: string; fr: string; es: string };
const titled = (titles: Titles) => ({ title: titles.en, titles });
// A fresh copy each time: presentations are sent and compared, never shared.
const labelled = (labels: Titles) => ({ label: labels.en, labels: { ...labels } });
const newlyAdded: Titles = { en: 'Newly added', 'zh-Hant': '新收錄', 'zh-Hans': '新收录', ja: '新着作品', ko: '새로 추가된 작품',
  de: 'Neu hinzugefügt', fr: 'Ajouts récents', es: 'Nuevas incorporaciones' };
const completed: Titles = { en: 'Completed', 'zh-Hant': '完結作品', 'zh-Hans': '完结作品', ja: '完結済み', ko: '완결',
  de: 'Abgeschlossen', fr: 'Terminées', es: 'Terminadas' };
const feed = (block: string) => ({ kind: 'query-block' as const, block });

/**
 * A Zone's layout. Fiction reads like a serial publication; the other Zones
 * open with their picks, what is new, one editors' list and their decisions.
 * Modules with nothing to show yet stay off the page.
 */
export function officialPresentation(realm: OfficialRealmId, preset: ZonePresentation['preset'],
  modContext?: string): ZonePresentation {
  const lists = zoneContent[realm].lists.map(list => ({ id: list.id,
    source: { kind: 'collection' as const, collection: editorList(realm, list.id) } }));
  const [first, ...more] = lists;
  const editors = first ? [{ id: 'editors', type: 'editorial-list' as const,
    ...titled({ en: 'Editors’ picks', 'zh-Hant': '編輯推薦', 'zh-Hans': '编辑推荐', ja: '編集者のおすすめ',
      ko: '편집자 추천', de: 'Empfehlungen der Redaktion', fr: 'Choix de la rédaction', es: 'Selección editorial' }), source: first.source,
    ...more.length ? { tabs: more.map(list => ({ id: list.id, label: list.id, source: list.source })) } : {},
    options: { layout: 'rows' as const, limit: 2 } }] : [];
  const decisions = { id: 'decisions', type: 'decision-log' as const,
    ...titled({ en: 'Recent decisions', 'zh-Hant': '近期決策', 'zh-Hans': '最近的决定', ja: '最近の決定', ko: '최근 결정',
      de: 'Aktuelle Entscheidungen', fr: 'Décisions récentes', es: 'Decisiones recientes' }),
    source: feed('recent-decisions'), options: { rail: true, limit: 6 } };
  const base = { profile: 'zone-presentation-v1' as const, preset, tokens: ZONE_PRESETS[preset],
    navigation: [], banners: [], ...(packagedZone(realm) ? { official: { theme: officialTheme(realm) } } : {}) };
  if (realm !== 'fiction') {
    const special = realm === 'mods' ? [
      ...modContext ? [{ id: 'games', type: 'chip-nav' as const,
        ...titled({ en: 'Games and loaders', 'zh-Hant': '遊戲與載入器', 'zh-Hans': '游戏与加载器', ja: 'ゲームとローダー',
          ko: '게임과 로더', de: 'Spiele und Loader', fr: 'Jeux et chargeurs', es: 'Juegos y cargadores' }),
        source: { kind: 'context' as const, context: modContext } }] : [],
      { id: 'trending', type: 'ranking' as const,
        ...titled({ en: 'Trending', 'zh-Hant': '熱門趨勢', 'zh-Hans': '热门趋势', ja: '人気上昇中', ko: '인기 급상승',
          de: 'Im Trend', fr: 'Tendances', es: 'Tendencias' }),
        source: feed('rankings'), options: { metric: 'reads' as const, interval: 'week' as const } },
    ] : realm === 'books' ? [
      { id: 'authors', type: 'people' as const,
        ...titled({ en: 'Authors to follow', 'zh-Hant': '值得關注的作者', 'zh-Hans': '值得关注的作者', ja: 'フォローしたい作家',
          ko: '팔로우할 작가', de: 'Autorinnen und Autoren zum Folgen', fr: 'Auteurs à suivre', es: 'Autores para seguir' }),
        source: feed('new-adoptions') },
    ] : [];
    return { ...base, modules: [
      { id: 'picks', type: 'hero-carousel', ...titled({ en: 'Featured', 'zh-Hant': '精選', 'zh-Hans': '精选', ja: 'おすすめ',
        ko: '추천', de: 'Highlights', fr: 'À la une', es: 'Destacados' }),
        source: feed('new-adoptions'), options: { limit: 4 } },
      ...special,
      { id: 'latest', type: 'shelf', ...titled({ en: 'Latest', 'zh-Hant': '最新收錄', 'zh-Hans': '最新收录', ja: '最新作品',
        ko: '최신 작품', de: 'Neueste Werke', fr: 'Nouveautés', es: 'Novedades' }),
        source: feed('new-adoptions'), tabs: [
          { id: 'adopted', ...labelled(newlyAdded), source: feed('new-adoptions') },
          { id: 'completed', ...labelled(completed), source: feed('recently-completed') }] },
      ...editors, decisions,
    ] };
  }
  return { ...base, modules: [
    { id: 'picks', type: 'hero-carousel', ...titled({ en: 'Featured', 'zh-Hant': '精選', 'zh-Hans': '精选', ja: 'おすすめ',
      ko: '추천', de: 'Highlights', fr: 'À la une', es: 'Destacados' }),
      source: feed('new-adoptions'), options: { limit: 5 } },
    { id: 'contest', type: 'announcement', ...titled({
      en: 'Autumn serial contest: entries open until October 31',
      'zh-Hant': '秋季連載徵文開放投稿，十月三十一日截止', 'zh-Hans': '秋季连载征文开放投稿，十月三十一日截止',
      ja: '秋の連載小説コンテスト：10月31日まで応募受付', ko: '가을 연재 공모전: 10월 31일까지 응모',
      de: 'Herbstlicher Serienwettbewerb: Beiträge bis 31. Oktober',
      fr: 'Concours de feuilletons d’automne : candidatures jusqu’au 31 octobre',
      es: 'Concurso otoñal de seriales: participa hasta el 31 de octubre' }), source: feed('recent-decisions') },
    { id: 'latest', type: 'shelf', ...titled({ en: 'Latest', 'zh-Hant': '最新連載', 'zh-Hans': '最新连载', ja: '最新の連載',
      ko: '최신 연재', de: 'Neueste Serien', fr: 'Séries récentes', es: 'Series recientes' }),
      source: feed('latest-chapters'), tabs: [
        { id: 'chapters', ...labelled({ en: 'New chapters', 'zh-Hant': '最新章節', 'zh-Hans': '最新章节', ja: '新着エピソード',
          ko: '새 회차', de: 'Neue Kapitel', fr: 'Nouveaux chapitres', es: 'Capítulos nuevos' }),
          source: feed('latest-chapters') },
        { id: 'adopted', ...labelled(newlyAdded), source: feed('new-adoptions') },
        { id: 'completed', ...labelled(completed), source: feed('recently-completed') }] },
    { id: 'charts', type: 'ranking', ...titled({ en: 'Charts', 'zh-Hant': '熱門排行', 'zh-Hans': '热门排行', ja: 'ランキング',
      ko: '인기 순위', de: 'Ranglisten', fr: 'Classements', es: 'Clasificaciones' }),
      source: feed('rankings'), options: { metric: 'reads', interval: 'week' } },
    ...editors,
    { id: 'quotes', type: 'quote-stream', ...titled({ en: 'Fresh from readers', 'zh-Hant': '新鮮書評', 'zh-Hans': '新鲜书评',
      ja: '読者の声', ko: '독자들의 한마디', de: 'Stimmen aus der Leserschaft', fr: 'Voix des lecteurs', es: 'Voces de lectores' }),
      source: feed('reader-quotes'), options: { limit: 3 } },
    { id: 'rising', type: 'rising', ...titled({ en: 'New and rising', 'zh-Hant': '潛力新作', 'zh-Hans': '潜力新作',
      ja: '新登場・急上昇', ko: '새롭게 주목받는 작품', de: 'Neu und im Aufwind', fr: 'Nouveautés en hausse', es: 'Novedades en alza' }),
      source: feed('rising'), options: { rail: true, limit: 5 } },
    decisions,
  ] };
}

/** The same layout with each tab's default label only, for a Main that predates localized tab labels. */
export function withoutTabLabels(presentation: ZonePresentation): ZonePresentation {
  return { ...presentation, modules: presentation.modules.map(module => module.tabs
    ? { ...module, tabs: module.tabs.map(({ labels: _, ...tab }) => tab) } : module) };
}
