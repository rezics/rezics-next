import { describe, expect, test } from 'bun:test';
import { materializeData } from 'native-i18n';
import { communityText } from '../features/communities/messages.ts';
import { postText } from '../features/post-composer/messages.ts';
import { messages as searchMessages } from '../features/search/messages.ts';
import { navigation } from '../features/shell/navigation.ts';
import { languageName } from '../features/work-page/format.ts';
import { strings as fictionStrings } from '../zones/official/fiction/strings.ts';

describe('per-locale catalogs keep the previous English and zh-Hans text', () => {
  test('community and post adapters keep English, Chinese and Japanese', () => {
    expect(communityText.title.en).toBe('Communities');
    expect(communityText.title['zh-Hans']).toBe('社区');
    expect(communityText.title.ja).toBe('コミュニティ');
    expect(communityText.agentNeeded['zh-Hans']).toBe('请先选择个人资料，再创建社区。');
    expect(postText.title.en).toBe('Create a post');
    expect(postText.title['zh-Hans']).toBe('发布帖子');
    expect(postText.createWork['zh-Hans']).toBe('创建作品');
    expect(postText.createWork.de).toBe('Werk erstellen');
    expect(postText.createWork.ja).toBe('作品を作成');
  });

  test('shell navigation, search conditions, unknown languages and fiction intervals moved intact', () => {
    const home = navigation.find(item => item.href === '/')!;
    const library = navigation.find(item => item.href === '/library')!;
    expect(home.label.en).toBe('Home');
    expect(home.label['zh-Hans']).toBe('首页');
    expect(home.label.ja).toBe('ホーム');
    expect(library.bottomLabel?.fr).toBe('Livres');
    expect(library.label.de).toBe('Bibliothek');

    const searchEn = materializeData(searchMessages.en, { locale: 'en' });
    const searchZh = materializeData(searchMessages['zh-Hans'], { locale: 'zh-Hans' });
    expect(searchEn.include).toBe('Include');
    expect(searchZh.conditionSearch).toBe('搜索标签');
    expect(searchZh.conditionRemove({ name: '科幻' })).toBe('移除科幻');
    expect(searchEn.conditionFull({ count: '8' })).toBe('Choose up to 8 tags here.');
    expect(searchMessages.ja.conditionHeading).toBe('条件');

    expect(languageName('und', 'en')).toBe('Unknown language');
    expect(languageName('und', 'zh-Hans')).toBe('未知语言');
    expect(languageName('und', 'ja')).toBe('不明な言語');

    expect(fictionStrings('en').day).toBe('Today');
    expect(fictionStrings('zh-Hans').week).toBe('周榜');
    expect(fictionStrings('fr').month).toBe('Ce mois-ci');
    expect(fictionStrings('ko').day).toBe('오늘');
  });
});
