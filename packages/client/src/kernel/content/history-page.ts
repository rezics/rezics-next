import type { CoverCredit } from '@rezics/definitions/media-import';
import type { BoardView } from './model.ts';

type HistorySection<T> = { state: 'current' | 'unavailable'; retryable: boolean; items: T[] };
type HistoryThumbnail = {
  media: string;
  width: number;
  height: number;
  placeholder: { thumbhash: string; color: string };
  variants: { format: 'avif' | 'webp'; width: number }[];
  focalPoint: { x: number; y: number } | null;
};
type HistoryAvatar = (HistoryThumbnail & { credit: null }) | null;
type HistoryAuthor =
  | { id: string; state: 'available'; displayName: string | null; handle: string | null; avatar: HistoryAvatar }
  | { id: string; state: 'concealed' };
type HistoryMention = { id: string; state: 'available'; handle: string } | { id: string; state: 'concealed' };
type HistoryCover = (HistoryThumbnail & { credit: CoverCredit | null }) | null;
type HistorySubject =
  | {
      id: string;
      state: 'available';
      summary: {
        id: string;
        type: string;
        types: string[];
        label: { value: string; language: string } | null;
        creativeWork: boolean;
        cover: HistoryCover;
      };
    }
  | { id: string; state: 'concealed'; summary: null };
type HistoryQuestion = {
  id: string;
  revision: number;
  label: string;
  grain: 'work' | 'release' | 'episode' | 'character';
  scale: { min: number; max: number; displayStep: number };
  realmId?: string;
  meaning?: string;
  canonicalLabel?: string;
  labelRevision?: number;
  lifecycle?: { state: 'active' | 'retired'; revision: number };
};
type HistoryReviewScore =
  | {
      revisionId: string;
      state: 'available';
      citation: { questionId: string; units: number; revision: number };
      question: HistoryQuestion;
    }
  | { revisionId: string; state: 'unavailable'; citation: null; question: null };
type HistoryImage = {
  id: string;
  containerId: string;
  digest: string;
  width: number;
  height: number;
  variants: { format: 'avif' | 'webp'; width: number; height: number }[];
  placeholder: { thumbhash: string; color: string } | null;
  focalPoint: { x: number; y: number } | null;
  credit: CoverCredit | null;
};
type HistoryMediaItem = { id: string; state: 'available'; image: HistoryImage } | { id: string; state: 'concealed' };
type HistoryOperation = {
  action: string;
  operationId: string;
  state: 'available' | 'denied' | 'sign_in_required' | 'unavailable' | 'not_applicable';
};
type HistoryActionReference =
  | { type: 'content.thread'; id: string; state: 'current' | 'withheld'; operations: HistoryOperation[] }
  | {
      type: 'content.post';
      id: string;
      sourceRevisionId: string;
      state: 'current' | 'withheld';
      operations: HistoryOperation[];
    };

/** Full native history context returned with each revision page. */
export type PostHistoryPage = {
  viewer: { kind: 'account'; id: string } | { kind: 'anonymous' };
  conversation: {
    id: string;
    kind: 'discussion' | 'review';
    title: string | null;
    authorId: string;
    boardId: string;
    subjectIds: string[];
    createdAt: string;
  };
  board: BoardView;
  place: { kind: 'global' | 'realm'; id: string };
  head: {
    postId: string;
    revisionId: string | null;
    state: 'current' | 'erased';
    authorId: string | null;
    createdAt: string | null;
    revisedAt: string | null;
  };
  authors: HistorySection<HistoryAuthor>;
  mentions: HistorySection<HistoryMention>;
  subjects: HistorySection<HistorySubject> & { limit: 4 };
  reviewScores: HistorySection<HistoryReviewScore>;
  media: HistorySection<HistoryMediaItem>;
  actions: { state: 'current' | 'unavailable'; retryable: boolean; references: HistoryActionReference[] };
  navigation: {
    exact: { postId: string; revisionId: string }[];
    compareToHead: { postId: string; fromRevisionId: string; toRevisionId: string }[];
  };
  currentness: {
    source: 'current';
    conversation: 'current';
    board: 'current';
    place: 'current';
    head: 'current';
    authors: 'current' | 'unavailable';
    mentions: 'current' | 'unavailable';
    subjects: 'current' | 'unavailable';
    reviewScores: 'current' | 'unavailable';
    media: 'current' | 'unavailable';
    actions: 'current' | 'unavailable';
  };
  retry: { state: 'same_cursor'; cursor: string | null } | { state: 'none' };
};
