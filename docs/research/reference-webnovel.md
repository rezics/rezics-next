# Web-novel platforms for readers and authors

Observed 2026-09-28 on public pages, signed out. No account was created and no
form was submitted. Writer dashboards that redirect to login were left there;
the author-side notes below come from the public help and release pages named
with them. Local REZICS (`web` on port 3000) was opened the same day in a fresh
signed-out browser and in the existing local session as Daniel Chen.

Screenshots from the fresh browser are under `.temp/research/webnovel/` in the
worktree. They are local evidence and are not part of the git tree. Headless
Chrome was stopped by a login modal on the Qidian chapter and by Cloudflare on
Webnovel, so those two views were kept from the interactive browser only.

Findings are what a page showed. Deductions combine those pages with the
current REZICS reader, Studio and [frontend plan](../plan/frontend.md). The
adoption list is a hypothesis for later tasks, not a decision already taken.

## 起点中文网

Best at a finished serial's public face: status, length, a volume table, and
many rankings that mean different things.

- Book, [《诡秘之主》](https://www.qidian.com/book/1010868264/), shot
  `qidian-book.png`. Status line 完本 · 签约 · VIP · 玄幻 · 异世大陆 · 轻小说.
  446.77万字, 3724.57万 total recommendations, 4118 recommendations this week.
  Last update 2022-11-25. Author card: 9 works, 2479万 characters, 4067 writing
  days. Monthly tickets 40327, rank 16. The interactive table of contents groups
  chapters into named volumes (小丑, 无面人, 旅行家, and later volumes), each
  with a chapter count and a free or VIP mark, plus reverse order. The work
  claims 1418 chapters.
- Rank index, [人气榜单](https://www.qidian.com/rank/), shot `qidian-rank.png`,
  labelled updated 2026-09-28 18:40. Side by side: 月票榜, 畅销榜, 留存榜,
  潜力榜, 追读榜, 签约新书榜, 未签约新书榜, and others (推荐, 收藏, 更新,
  阅读指数, 书友, VIP收藏). Category chips sit above the lists.
- Chapter reader, opened interactively at the first chapter. The page said the
  chapter had 37345 paragraph comments, with a per-paragraph count. Settings
  offered theme, 黑体/宋体/楷体, size, width presets, chapter-turn or scroll,
  and a switch for 本章说. The chapter ended with 作家说; on this chapter the
  visible note was a support line, not a craft note. Toolbar: contents, details,
  shelf, vote, night, settings.
- New-book rank rules, public help
  [qId=6](https://help.yuewen.com/helpcenter/pc/menu?siteId=0&cateId=1&qId=6):
  the signed new-book list uses reading scale and retention; inclusion includes
  a length cap, a recent signing window, and a recent update. The unsigned list
  uses a reading index.
- Writer tools. The writer home sends the dashboard to login. Public release
  notes at [write.qq.com/portal/version](https://write.qq.com/portal/version)
  record 定时发布 (including cancel, and a standing time), a 请假条 page, draft
  formatting, a writing calendar, and management of book comments and paragraph
  comments. That is a changelog, not a live dashboard.

The bookshelf update badge was not visible signed out.

## 晋江文学城

Best at typed discovery and a contents row that tells you what a chapter is
before you open it.

- Book, [《难哄》](https://www.jjwxc.net/onebook.php?novelid=4001734), shot
  `jjwxc-book.png`. Header search already filters by scope, originality,
  orientation, point of view, era, type, and a long tag list, and can target
  the work, author, leads, or id. The book shows 文案, content tags, a one-line
  pitch, 立意, type 原创-言情-近代现代-爱情, 女主 viewpoint, series, 完结,
  389931 characters, signed, and an 18+ notice. 霸王票 rank 173.
- Interactive chapter and score. 完结评分 9.7 from 17666 raters, with the rule
  that a finished VIP work is scored by readers who bought the unlocked VIP
  chapters, and that the high-score list needs more than 200 raters. Contents
  columns: chapter, title, 内容提要, character count, clicks, update time.
  A control shows 作话. Comment kinds include flowers, chat, typo reports
  (捉虫), and negative bricks that spend a currency. The first chapter's 作话
  area was an empty author promo, not a long note.
- Author help, public
  [请假条](https://www.jjwxc.net/sp/author_questions/index.php?id=38): a signed
  work's leave is capped, and a long gap requires an update before another
  leave. The same FAQ lists comment management and author promos. The author
  backend itself was not entered. Volumes and scheduled publish were not in
  the feature list that was open.

## KadoKado

Best at the catalogue card: cover, one-line hook, and an update promise the
reader can see without opening the book. This is already the Fiction zone's
reference in the frontend plan.

- Rankings, [排行榜](https://www.kadokado.com.tw/charts), shot
  `kadokado-charts.png`. Tabs 热门, 收藏, 畅销, 18禁, then genre chips and a
  daily hot list. Cards show the hook plus favorite and read counts.
- Book, [《SCP研究員的社畜日常》](https://www.kadokado.com.tw/book/26113), shot
  `kadokado-book.png`. Tabs 簡介, 章節, 資訊, 評分. Illustrator credit beside
  the author. Counts 85 / 360 / 5 of 5. The blurb states the schedule
  (每週五晚上6:00更新). Tags sit on the book.
- Chapter, opened interactively. Signed out, the reader showed the end card
  for the latest chapter ("收藏作品便可接收更新通知") rather than the prose.
  Page data included a word count, like and comment counts, and a listing
  window whose end is year 9000, meaning the chapter stays listed. The reading
  settings control was present and disabled before the body settled. The
  creator center was not opened.

## Royal Road

Best at a fiction page that separates follow, favorite, and read-later, and at
reviews that say how far the reviewer had read.

- Fiction, [Mother of Learning](https://www.royalroad.com/fiction/21220/mother-of-learning),
  shot `royalroad-fiction.png`. Completed, 109 chapters in the interactive
  view. Actions: Start Reading, not interested, Follow, Favorite, Read Later,
  Follow Author. Tags. Scores split into Overall, Style, Story, Grammar, and
  Character (Overall 4.83). Stats on the page included total views, average
  views, followers, favorites, ratings, and pages. The contents table is
  chapter name and release date. Reviews name the chapter they were written
  after, with a spoiler reveal. Lists in the header family: Best Rated,
  Trending, Ongoing, Complete, Popular this week, Latest Updates, Newest.
- Chapter, shot `royalroad-chapter.png`, also opened interactively. Reader
  preferences: size, width, family, color, indent, paragraph spacing, and
  several color schemes. An author-note portlet was present; its text was a
  store promo. Comments sort by top, newest, and oldest. Next, previous, and
  the fiction index sit with the chapter.
- Author tools. The dashboard redirects to login. The public knowledge base
  [Drafts, schedule, and volumes](https://www.royalroad.com/support/knowledgebase/83)
  says a chapter can be scheduled in the author's timezone and removed, drafts
  show a clock, volumes organize the fiction page and can show covers, and a
  public schedule tells readers when the next chapter is due. The same page
  says volumes do not reorder the fiction, carry their own summary, or show
  their own stats. Richer analytics graphs were only seen as a search lead
  (knowledge base 110) and were not re-read.

## Webnovel

Best at paragraph comments on a long original, and at a catalogue split into
volumes. Studied in the interactive browser.
[ranking/hot](https://www.webnovel.com/ranking/hot) is the live rank URL;
`/ranking` returned 404.

- [Shadow Slave](https://www.webnovel.com/book/22196546206090805): original,
  fantasy, thousands of chapters, a view count, a single star score, a power
  rank, tags with a follow mark, fans, gifts, and reviews that can reveal a
  spoiler. Read and add to library.
- The catalogue groups chapters into named volumes (Auxiliary, Child of
  Shadows, Demon of Change, and later volumes). Some later chapters show a
  lock. Chapter times are relative ("4 years ago").
- The first chapter shows a progress percentage and a count beside paragraphs
  (including 99+). Vote and send-gift sit with the chapter. Display options
  exist. This chapter had no author-note label. Power is the rank currency
  (a vote on the book). The Inkstone author site was not opened.

## Wattpad

Best at a part list with dates, a vote on the part, and a comment count on
the paragraph, on a story that is a sequence of parts rather than volumes.

- Romance browse, [stories/romance](https://www.wattpad.com/stories/romance):
  cover rails, one tag on a cover, then a hot list of cover, title, author,
  reads, parts, and tags.
- Story, [Strip for the Devil](https://www.wattpad.com/story/356139381-strip-for-the-devil),
  shot `wattpad-story.png`. Reads, votes, and parts, a long tag list, Summary
  and Parts, Start reading, and add to a list. Parts carry a title and a date.
- Chapter, shot `wattpad-chapter.png`. Header counts on this capture: 417K
  reads, 3.9K votes, 3.1K comments, plus Vote. Below the header, the
  interactive reader put a count button on many paragraphs and a comment
  thread at the end of the part. The writers link goes to
  [creators.wattpad.com](https://creators.wattpad.com/), a programs and Story
  School site, not the writing desk. The desk is behind Log in.

## What REZICS already does as well or better

Signed-out shots: `rezics-home.png`, `rezics-work.png`, `rezics-fiction.png`.
The work is 雨夜书店 · 连载小说.

- Home is a feed with Continue owed to the next chapter, not a ticket board.
  Signed out, Home leads with communities and a Best feed. Signed in as
  Daniel, Continue names the next chapter and a "new" count. That is the
  bookshelf badge.
- The Fiction zone is cover-first, with a one-line hook, featured picks, and
  Latest split into new chapters, newly added, and completed, plus the latest
  chapter. Signed in, the zone also offers today, this week, and this month.
  That matches the plan: rankings, categories, and update lists, without a
  second visual language.
- The work page has the cover, the hook, the author, one score (4.67 from 6
  ratings and 4 reviews), who is reading, ongoing status, Start reading, Want
  to read, and tabs for overview, contents, versions, discussion, and history.
  Versions and a public decision behind a zone pick are ahead of these sites.
- Reader settings already cover size, measure, typeface, indent, theme, and
  CJK spacing (`apps/web/features/work-page/reader-settings.ts`). The reading
  surface stays free of ads and auto-subscribe. The signed-in chapter offered
  Reading settings and Mark chapter as read.
- Contents can open a part as its own level
  (`apps/web/features/work-page/contents.tsx`). The serial fixture's contents
  are three chapters with no parts, so the volume pattern is not what that
  page shows yet.
- Concepts and facets are the right generalisation of 晋江's typed filters and
  Wattpad's tags. A second flat tag vocabulary would fight
  [queries](../contracts/queries.md).
- Studio, signed in, lists all works, drafts, published, and in review.
  Drafts exist. This account's works are not a serial, so the chapter desk
  was not exercised here.
- Comments and citations are already required to keep the revision and the
  selector ([creation](../contracts/creation.md)). The sites' paragraph
  threads have no revision.

## What REZICS should adopt

Ordered. Each item names the surface, the change, why, and whether Main needs
new data.

1. **Reader.** Show a count on a paragraph and open that paragraph's thread,
   with a hide control, bound to the revision and selector the creation
   contract already requires. 起点's 本章说, Webnovel, and Wattpad are the
   evidence; it is the largest reader gap. Main needs the selector stored on
   the comment. The reader does not show it today. No new Work field.
2. **Reader and Studio.** A chapter-end author note, separate from the
   chapter body, with a show-notes control (起点 作家说, 晋江 作话, Royal Road's
   author note). On the chapters opened here the note was often a promo; the
   slot still matters because readers look for it. Main needs a note on the
   chapter publication so editing the note does not rewrite the chapter.
3. **Studio, Work page, Fiction zone.** Schedule a chapter in the author's
   timezone, allow cancel, list it on drafts, and show the next planned
   update on the work (Royal Road's public schedule, 起点's 定时发布, KadoKado's
   listing window). Main needs a publish-at time. Drafts already exist.
4. **Studio and Work page.** A leave notice with an end date, shown on the
   work and in the Fiction update list, so a pause is not read as abandonment
   (起点 and 晋江 both ship a 请假条). Main needs that notice. Copy the notice,
   not 晋江's punishment for a long gap.
5. **Work contents.** When the work has parts, show them as volumes: name,
   chapter count, and whether the part is public or limited, with reverse
   order. 起点, Webnovel, and Royal Road all do this. Parts already exist in
   contents, so grouping is presentation. A volume blurb or cover would be
   new part metadata; Royal Road's own help says their volumes have neither
   a summary nor their own stats, so that extra metadata can wait.
6. **Work page.** An update cadence the reader can see ("Fridays at 18:00").
   KadoKado puts it in the blurb, which needs no new field. A structured next
   date arrives with item 3.
7. **Studio, private.** Per-chapter reads, finished readings, and comment
   counts for the author. 晋江 prints raw clicks on the public contents row;
   leave public click counts off the contents. Royal Road puts richer graphs
   behind a paid tier; a small honest set needs no paywall. Main needs those
   per-chapter aggregates, visible to the author.
8. **Library.** A "new chapters" mark on a shelf row. Home Continue already
   does this job from progress plus the latest chapter, so a Library badge is
   the same comparison. No new data.
9. **Work discussion, later.** Royal Road's review names the chapter it was
   written after, and splits the score into style, story, grammar, and
   character. 晋江's completion score is interesting as a population of
   readers who finished; the VIP-purchase gate is not. Main would need extra
   rating dimensions and a chapter anchor. The single score on the work page
   can stand until then.

## Leave behind

Purchasable monthly tickets, Power Stones, and 推荐票 as rank currency.
Negative comments that cost a currency. Auto-subscribe of the next paid
chapter. Ads in the reader. Public per-chapter click counts. Punishment rules
tied to a missed leave. A flat tag enum beside Concepts. Writer FAQ pages that
are search spam rather than the product (起点's public release notes were
used; an unrelated ask board was not).
