import { createElement, type ComponentType, type ReactElement } from 'react';
import type { Meta, StoryContext, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import entryMeta, * as entryStories from '../realm/entry-page.stories.tsx';
import membershipMeta, * as membershipStories from '../realm/realm-membership-recorded.stories.tsx';
import directoryMeta, * as directoryStories from '../communities/realm-directory.stories.tsx';
import creationMeta, * as creationStories from '../communities/realm-create-recorded.stories.tsx';
import teamMeta, * as teamStories from '../manage/realm-team-recorded.stories.tsx';
import rulesMeta, * as rulesStories from '../manage/realm-rules-recorded.stories.tsx';
import moderationMeta, * as moderationStories from '../realm-appeal/realm-moderation-recorded.stories.tsx';
import rosterMeta, * as rosterStories from '../manage/closed-roster.stories.tsx';
import discussionsMeta, * as discussionsStories from '../realm/discussion-page.stories.tsx';
import threadMeta, * as threadStories from '../realm/thread-view.stories.tsx';
import rankingMeta, * as rankingStories from '../realm/ranking.stories.tsx';
import tabsMeta, * as tabsStories from '../realm/realm-tabs.stories.tsx';
import homeMeta, * as homeStories from '../zones/zone-home-recorded.stories.tsx';
import siteMeta, * as siteStories from '../zones/zone-site-recorded.stories.tsx';
import zoneEditorMeta, * as zoneEditorStories from '../zone-editor/zone-navigation-theme-recorded.stories.tsx';
import attachedMeta, * as attachedStories from '../zones/zone-discussion-recorded.stories.tsx';
import zonePageMeta, * as zonePageStories from '../zones/zone-page.stories.tsx';
import { reviewText } from '../realm-appeal/review-messages.ts';

const meta = { title: 'Review/Realm and Zone pages', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
type Source = { args?: object; parameters?: object; render?: unknown; component?: unknown; beforeEach?: unknown };

// Replay the existing production page and its selected recorded answers. This
// matrix changes only the viewing conditions; the source stories own behavior.
function review(page: Source, state: Source, locale: 'en' | 'ja', width: 'phone' | 'desktop1440', loading = false): Story {
  return {
    globals: { locale, viewport: { value: width } },
    parameters: { ...page.parameters, ...state.parameters },
    beforeEach: state.beforeEach as Story['beforeEach'],
    render: (_args, context) => {
      const args = { ...page.args, ...state.args, locale };
      const render = (state.render ?? page.render) as ((args: object, context: StoryContext) => ReactElement) | undefined;
      return render ? render(args, context) : createElement(page.component as ComponentType<object>, args);
    },
    async play({ canvasElement }) {
      await waitFor(() => {
        expect(canvasElement.textContent).not.toMatch(/Unmatched recorded request|Recorded management session has no acting Person/);
        if (loading) expect(canvasElement.querySelector('[aria-busy="true"]')).not.toBeNull();
        else {
          expect(canvasElement.querySelector('[aria-busy="true"]')).toBeNull();
          expect(canvasElement.querySelector('h1, h2, [role="alert"]')).not.toBeNull();
        }
      }, { timeout: 10_000 });
      if (page === moderationMeta && state === moderationStories.OwnerPopulated) {
        const canvas = within(canvasElement);
        await userEvent.click(canvas.getByRole('button', { name: new RegExp(reviewText[locale].title) }));
        await expect(await canvas.findByRole('heading', { name: reviewText[locale].title })).toBeVisible();
      }
    },
  };
}
export const DirectoryEnglishPhone = review(directoryMeta, directoryStories.Visitor, 'en', 'phone');
export const DirectoryEnglishDesktop = review(directoryMeta, directoryStories.Visitor, 'en', 'desktop1440');
export const DirectoryJapanesePhone = review(directoryMeta, directoryStories.Visitor, 'ja', 'phone');
export const DirectoryJapaneseDesktop = review(directoryMeta, directoryStories.Visitor, 'ja', 'desktop1440');
export const DirectoryEmptyEnglishPhone = review(directoryMeta, directoryStories.Empty, 'en', 'phone');
export const DirectoryEmptyEnglishDesktop = review(directoryMeta, directoryStories.Empty, 'en', 'desktop1440');
export const DirectoryEmptyJapanesePhone = review(directoryMeta, directoryStories.Empty, 'ja', 'phone');
export const DirectoryEmptyJapaneseDesktop = review(directoryMeta, directoryStories.Empty, 'ja', 'desktop1440');
export const DirectoryErrorEnglishPhone = review(directoryMeta, directoryStories.Unavailable, 'en', 'phone');
export const DirectoryErrorEnglishDesktop = review(directoryMeta, directoryStories.Unavailable, 'en', 'desktop1440');
export const DirectoryErrorJapanesePhone = review(directoryMeta, directoryStories.Unavailable, 'ja', 'phone');
export const DirectoryErrorJapaneseDesktop = review(directoryMeta, directoryStories.Unavailable, 'ja', 'desktop1440');
export const CreationEnglishPhone = review(creationMeta, creationStories.Stranger, 'en', 'phone');
export const CreationEnglishDesktop = review(creationMeta, creationStories.Stranger, 'en', 'desktop1440');
export const CreationJapanesePhone = review(creationMeta, creationStories.Stranger, 'ja', 'phone');
export const CreationJapaneseDesktop = review(creationMeta, creationStories.Stranger, 'ja', 'desktop1440');
export const PrivateEntryEnglishPhone = review(entryMeta, entryStories.VisitorLanding, 'en', 'phone');
export const PrivateEntryEnglishDesktop = review(entryMeta, entryStories.VisitorLanding, 'en', 'desktop1440');
export const PrivateEntryJapanesePhone = review(entryMeta, entryStories.VisitorLanding, 'ja', 'phone');
export const PrivateEntryJapaneseDesktop = review(entryMeta, entryStories.VisitorLanding, 'ja', 'desktop1440');
export const ClosedRealmEnglishPhone = review(entryMeta, entryStories.ClosedOwner, 'en', 'phone');
export const ClosedRealmEnglishDesktop = review(entryMeta, entryStories.ClosedOwner, 'en', 'desktop1440');
export const ClosedRealmJapanesePhone = review(entryMeta, entryStories.ClosedOwner, 'ja', 'phone');
export const ClosedRealmJapaneseDesktop = review(entryMeta, entryStories.ClosedOwner, 'ja', 'desktop1440');
export const RealmHomeEnglishPhone = review(membershipMeta, membershipStories.MemberJoined, 'en', 'phone');
export const RealmHomeEnglishDesktop = review(membershipMeta, membershipStories.MemberJoined, 'en', 'desktop1440');
export const RealmHomeJapanesePhone = review(membershipMeta, membershipStories.MemberJoined, 'ja', 'phone');
export const RealmHomeJapaneseDesktop = review(membershipMeta, membershipStories.MemberJoined, 'ja', 'desktop1440');
export const JoinRequestsEnglishPhone = review(membershipMeta, membershipStories.OwnerRequests, 'en', 'phone');
export const JoinRequestsEnglishDesktop = review(membershipMeta, membershipStories.OwnerRequests, 'en', 'desktop1440');
export const JoinRequestsJapanesePhone = review(membershipMeta, membershipStories.OwnerRequests, 'ja', 'phone');
export const JoinRequestsJapaneseDesktop = review(membershipMeta, membershipStories.OwnerRequests, 'ja', 'desktop1440');
export const RolesEnglishPhone = review(teamMeta, teamStories.PopulatedOwnerRolesDesktop, 'en', 'phone');
export const RolesEnglishDesktop = review(teamMeta, teamStories.PopulatedOwnerRolesDesktop, 'en', 'desktop1440');
export const RolesJapanesePhone = review(teamMeta, teamStories.PopulatedOwnerRolesDesktop, 'ja', 'phone');
export const RolesJapaneseDesktop = review(teamMeta, teamStories.PopulatedOwnerRolesDesktop, 'ja', 'desktop1440');
export const MembersEnglishPhone = review(teamMeta, teamStories.PopulatedOwnerMembersDesktop, 'en', 'phone');
export const MembersEnglishDesktop = review(teamMeta, teamStories.PopulatedOwnerMembersDesktop, 'en', 'desktop1440');
export const MembersJapanesePhone = review(teamMeta, teamStories.PopulatedOwnerMembersDesktop, 'ja', 'phone');
export const MembersJapaneseDesktop = review(teamMeta, teamStories.PopulatedOwnerMembersDesktop, 'ja', 'desktop1440');
export const RulesEnglishPhone = review(rulesMeta, rulesStories.ManagerOwnerDesktop, 'en', 'phone');
export const RulesEnglishDesktop = review(rulesMeta, rulesStories.ManagerOwnerDesktop, 'en', 'desktop1440');
export const RulesJapanesePhone = review(rulesMeta, rulesStories.ManagerOwnerDesktop, 'ja', 'phone');
export const RulesJapaneseDesktop = review(rulesMeta, rulesStories.ManagerOwnerDesktop, 'ja', 'desktop1440');
export const ModerationEnglishPhone = review(moderationMeta, moderationStories.OwnerPopulated, 'en', 'phone');
export const ModerationEnglishDesktop = review(moderationMeta, moderationStories.OwnerPopulated, 'en', 'desktop1440');
export const ModerationJapanesePhone = review(moderationMeta, moderationStories.OwnerPopulated, 'ja', 'phone');
export const ModerationJapaneseDesktop = review(moderationMeta, moderationStories.OwnerPopulated, 'ja', 'desktop1440');
export const ModerationRefusedEnglishPhone = review(moderationMeta, moderationStories.ModeratorRefused, 'en', 'phone');
export const ModerationRefusedEnglishDesktop = review(moderationMeta, moderationStories.ModeratorRefused, 'en', 'desktop1440');
export const ModerationRefusedJapanesePhone = review(moderationMeta, moderationStories.ModeratorRefused, 'ja', 'phone');
export const ModerationRefusedJapaneseDesktop = review(moderationMeta, moderationStories.ModeratorRefused, 'ja', 'desktop1440');
export const ClosedRosterEnglishPhone = review(rosterMeta, rosterStories.OwnerDesktop, 'en', 'phone');
export const ClosedRosterEnglishDesktop = review(rosterMeta, rosterStories.OwnerDesktop, 'en', 'desktop1440');
export const ClosedRosterJapanesePhone = review(rosterMeta, rosterStories.OwnerDesktop, 'ja', 'phone');
export const ClosedRosterJapaneseDesktop = review(rosterMeta, rosterStories.OwnerDesktop, 'ja', 'desktop1440');
export const BoardsEnglishPhone = review(discussionsMeta, discussionsStories.Populated, 'en', 'phone');
export const BoardsEnglishDesktop = review(discussionsMeta, discussionsStories.Populated, 'en', 'desktop1440');
export const BoardsJapanesePhone = review(discussionsMeta, discussionsStories.Populated, 'ja', 'phone');
export const BoardsJapaneseDesktop = review(discussionsMeta, discussionsStories.Populated, 'ja', 'desktop1440');
export const DiscussionEmptyEnglishPhone = review(discussionsMeta, discussionsStories.Empty, 'en', 'phone');
export const DiscussionEmptyEnglishDesktop = review(discussionsMeta, discussionsStories.Empty, 'en', 'desktop1440');
export const DiscussionEmptyJapanesePhone = review(discussionsMeta, discussionsStories.Empty, 'ja', 'phone');
export const DiscussionEmptyJapaneseDesktop = review(discussionsMeta, discussionsStories.Empty, 'ja', 'desktop1440');
export const DiscussionErrorEnglishPhone = review(discussionsMeta, discussionsStories.ServerError, 'en', 'phone');
export const DiscussionErrorEnglishDesktop = review(discussionsMeta, discussionsStories.ServerError, 'en', 'desktop1440');
export const DiscussionErrorJapanesePhone = review(discussionsMeta, discussionsStories.ServerError, 'ja', 'phone');
export const DiscussionErrorJapaneseDesktop = review(discussionsMeta, discussionsStories.ServerError, 'ja', 'desktop1440');
export const ThreadEnglishPhone = review(threadMeta, threadStories.Thread, 'en', 'phone');
export const ThreadEnglishDesktop = review(threadMeta, threadStories.Thread, 'en', 'desktop1440');
export const ThreadJapanesePhone = review(threadMeta, threadStories.Thread, 'ja', 'phone');
export const ThreadJapaneseDesktop = review(threadMeta, threadStories.Thread, 'ja', 'desktop1440');
export const ReplyComposerEnglishPhone = review(threadMeta, threadStories.SignedOut, 'en', 'phone');
export const ReplyComposerEnglishDesktop = review(threadMeta, threadStories.SignedOut, 'en', 'desktop1440');
export const ReplyComposerJapanesePhone = review(threadMeta, threadStories.SignedOut, 'ja', 'phone');
export const ReplyComposerJapaneseDesktop = review(threadMeta, threadStories.SignedOut, 'ja', 'desktop1440');
export const ThreadErrorEnglishPhone = review(discussionsMeta, discussionsStories.ThreadError, 'en', 'phone');
export const ThreadErrorEnglishDesktop = review(discussionsMeta, discussionsStories.ThreadError, 'en', 'desktop1440');
export const ThreadErrorJapanesePhone = review(discussionsMeta, discussionsStories.ThreadError, 'ja', 'phone');
export const ThreadErrorJapaneseDesktop = review(discussionsMeta, discussionsStories.ThreadError, 'ja', 'desktop1440');
export const RankingEnglishPhone = review(rankingMeta, rankingStories.VisitorDesktop, 'en', 'phone');
export const RankingEnglishDesktop = review(rankingMeta, rankingStories.VisitorDesktop, 'en', 'desktop1440');
export const RankingJapanesePhone = review(rankingMeta, rankingStories.VisitorDesktop, 'ja', 'phone');
export const RankingJapaneseDesktop = review(rankingMeta, rankingStories.VisitorDesktop, 'ja', 'desktop1440');
export const RankingEmptyEnglishPhone = review(rankingMeta, rankingStories.EmptyDesktop, 'en', 'phone');
export const RankingEmptyEnglishDesktop = review(rankingMeta, rankingStories.EmptyDesktop, 'en', 'desktop1440');
export const RankingEmptyJapanesePhone = review(rankingMeta, rankingStories.EmptyDesktop, 'ja', 'phone');
export const RankingEmptyJapaneseDesktop = review(rankingMeta, rankingStories.EmptyDesktop, 'ja', 'desktop1440');
export const AboutEnglishPhone = review(tabsMeta, tabsStories.About, 'en', 'phone');
export const AboutEnglishDesktop = review(tabsMeta, tabsStories.About, 'en', 'desktop1440');
export const AboutJapanesePhone = review(tabsMeta, tabsStories.About, 'ja', 'phone');
export const AboutJapaneseDesktop = review(tabsMeta, tabsStories.About, 'ja', 'desktop1440');
export const DecisionsEnglishPhone = review(tabsMeta, tabsStories.Decisions, 'en', 'phone');
export const DecisionsEnglishDesktop = review(tabsMeta, tabsStories.Decisions, 'en', 'desktop1440');
export const DecisionsJapanesePhone = review(tabsMeta, tabsStories.Decisions, 'ja', 'phone');
export const DecisionsJapaneseDesktop = review(tabsMeta, tabsStories.Decisions, 'ja', 'desktop1440');
export const PublicRosterEnglishPhone = review(tabsMeta, tabsStories.Members, 'en', 'phone');
export const PublicRosterEnglishDesktop = review(tabsMeta, tabsStories.Members, 'en', 'desktop1440');
export const PublicRosterJapanesePhone = review(tabsMeta, tabsStories.Members, 'ja', 'phone');
export const PublicRosterJapaneseDesktop = review(tabsMeta, tabsStories.Members, 'ja', 'desktop1440');
export const ZoneHomeEnglishPhone = review(homeMeta, homeStories.PopulatedVisitor, 'en', 'phone');
export const ZoneHomeEnglishDesktop = review(homeMeta, homeStories.PopulatedVisitor, 'en', 'desktop1440');
export const ZoneHomeJapanesePhone = review(homeMeta, homeStories.PopulatedVisitor, 'ja', 'phone');
export const ZoneHomeJapaneseDesktop = review(homeMeta, homeStories.PopulatedVisitor, 'ja', 'desktop1440');
export const ZoneHomeEmptyEnglishPhone = review(homeMeta, homeStories.EmptyVisitor, 'en', 'phone');
export const ZoneHomeEmptyEnglishDesktop = review(homeMeta, homeStories.EmptyVisitor, 'en', 'desktop1440');
export const ZoneHomeEmptyJapanesePhone = review(homeMeta, homeStories.EmptyVisitor, 'ja', 'phone');
export const ZoneHomeEmptyJapaneseDesktop = review(homeMeta, homeStories.EmptyVisitor, 'ja', 'desktop1440');
export const ZoneHomeMissingEnglishPhone = review(homeMeta, homeStories.ErrorVisitor, 'en', 'phone');
export const ZoneHomeMissingEnglishDesktop = review(homeMeta, homeStories.ErrorVisitor, 'en', 'desktop1440');
export const ZoneHomeMissingJapanesePhone = review(homeMeta, homeStories.ErrorVisitor, 'ja', 'phone');
export const ZoneHomeMissingJapaneseDesktop = review(homeMeta, homeStories.ErrorVisitor, 'ja', 'desktop1440');
export const ZonePageEnglishPhone = review(siteMeta, siteStories.PopulatedVisitorDesktop, 'en', 'phone');
export const ZonePageEnglishDesktop = review(siteMeta, siteStories.PopulatedVisitorDesktop, 'en', 'desktop1440');
export const ZonePageJapanesePhone = review(siteMeta, siteStories.PopulatedVisitorDesktop, 'ja', 'phone');
export const ZonePageJapaneseDesktop = review(siteMeta, siteStories.PopulatedVisitorDesktop, 'ja', 'desktop1440');
export const ZonePageMissingEnglishPhone = review(siteMeta, siteStories.RefusalVisitorDesktop, 'en', 'phone');
export const ZonePageMissingEnglishDesktop = review(siteMeta, siteStories.RefusalVisitorDesktop, 'en', 'desktop1440');
export const ZonePageMissingJapanesePhone = review(siteMeta, siteStories.RefusalVisitorDesktop, 'ja', 'phone');
export const ZonePageMissingJapaneseDesktop = review(siteMeta, siteStories.RefusalVisitorDesktop, 'ja', 'desktop1440');
export const ZoneNavigationEnglishPhone = review(zoneEditorMeta, zoneEditorStories.NavigationOwner, 'en', 'phone');
export const ZoneNavigationEnglishDesktop = review(zoneEditorMeta, zoneEditorStories.NavigationOwner, 'en', 'desktop1440');
export const ZoneNavigationJapanesePhone = review(zoneEditorMeta, zoneEditorStories.NavigationOwner, 'ja', 'phone');
export const ZoneNavigationJapaneseDesktop = review(zoneEditorMeta, zoneEditorStories.NavigationOwner, 'ja', 'desktop1440');
export const ZoneThemeEnglishPhone = review(zoneEditorMeta, zoneEditorStories.ThemeOwner, 'en', 'phone');
export const ZoneThemeEnglishDesktop = review(zoneEditorMeta, zoneEditorStories.ThemeOwner, 'en', 'desktop1440');
export const ZoneThemeJapanesePhone = review(zoneEditorMeta, zoneEditorStories.ThemeOwner, 'ja', 'phone');
export const ZoneThemeJapaneseDesktop = review(zoneEditorMeta, zoneEditorStories.ThemeOwner, 'ja', 'desktop1440');
export const AttachedDiscussionLoadingEnglishPhone = review(attachedMeta, attachedStories.LoadingStrangerDesktop, 'en', 'phone', true);
export const AttachedDiscussionLoadingEnglishDesktop = review(attachedMeta, attachedStories.LoadingStrangerDesktop, 'en', 'desktop1440', true);
export const AttachedDiscussionLoadingJapanesePhone = review(attachedMeta, attachedStories.LoadingStrangerDesktop, 'ja', 'phone', true);
export const AttachedDiscussionLoadingJapaneseDesktop = review(attachedMeta, attachedStories.LoadingStrangerDesktop, 'ja', 'desktop1440', true);
export const AttachedDiscussionEnglishPhone = review(attachedMeta, attachedStories.PopulatedStrangerDesktop, 'en', 'phone');
export const AttachedDiscussionEnglishDesktop = review(attachedMeta, attachedStories.PopulatedStrangerDesktop, 'en', 'desktop1440');
export const AttachedDiscussionJapanesePhone = review(attachedMeta, attachedStories.PopulatedStrangerDesktop, 'ja', 'phone');
export const AttachedDiscussionJapaneseDesktop = review(attachedMeta, attachedStories.PopulatedStrangerDesktop, 'ja', 'desktop1440');

export const PopulatedRealmHomeEnglishPhone = review(zonePageMeta, zonePageStories.CommunityRealm, 'en', 'phone');
export const PopulatedRealmHomeEnglishDesktop = review(zonePageMeta, zonePageStories.CommunityRealm, 'en', 'desktop1440');
export const PopulatedRealmHomeJapanesePhone = review(zonePageMeta, zonePageStories.CommunityRealm, 'ja', 'phone');
export const PopulatedRealmHomeJapaneseDesktop = review(zonePageMeta, zonePageStories.CommunityRealm, 'ja', 'desktop1440');
