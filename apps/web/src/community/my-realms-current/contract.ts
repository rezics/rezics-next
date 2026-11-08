import type { KernelClient } from '@rezics/client';

export type MyRealmsNativePage = NonNullable<Awaited<ReturnType<KernelClient['me']['realms']['get']>>['data']>;
export type MyRealmsNativeItem = MyRealmsNativePage['items'][number];
export type MyRealmsCurrent = MyRealmsNativeItem['current'];
export type MyRealmsCurrentActionName = 'enter' | 'manage' | 'leave';
export type MyRealmsCurrentAdvice = MyRealmsCurrent['actions'][MyRealmsCurrentActionName];
export type MyRealmsCurrentImage = MyRealmsCurrent['avatar'];
export type MyRealmsEpisode = Readonly<{
  since: string;
  reservationId: string;
  transactionId: string;
}>;
export type MyRealmsCurrentRow = Readonly<{
  realmId: string;
  name: string;
  current: MyRealmsCurrent;
}>;
export type MyRealmsCurrentPage = Readonly<{
  realms: readonly MyRealmsCurrentRow[];
  next: MyRealmsNativePage['next'];
}>;

export type MyRealmsLeavePhase = 'review' | 'submitting' | 'pending' | 'uncertain' | 'refused' | 'blocked';
export type MyRealmsStanding = 'loading' | 'member' | 'none' | 'pending' | 'banned' | 'unavailable';
export type MyRealmsLeaveReviewState = Readonly<{
  row: MyRealmsCurrentRow;
  phase: MyRealmsLeavePhase;
  standing: MyRealmsStanding;
  workflowId?: string;
  ownerReason?: 'last-owner' | 'unavailable';
  retryAllowed: boolean;
}>;
export type MyRealmsCurrentController = Readonly<{
  ready: boolean;
  review: MyRealmsLeaveReviewState | null;
  select(row: MyRealmsCurrentRow): void;
  cancel(): void;
  confirm(): void;
  retry(): void;
  refresh(): void;
  discard(): void;
}>;
