import type { QuestionLabelHistory } from '@rezics/client';

export type ManagementQuestion = {
  id: string;
  realmId: string;
  meaning: string;
  canonicalLabel: string;
  label: string;
  labelRevision: number;
  revision: number;
  grain: 'work' | 'release' | 'episode' | 'character';
  scale: { min: number; max: number; displayStep: number };
  lifecycle: { state: 'active' | 'retired'; revision: number };
};

export type QuestionManagementPageData = {
  viewer: { accountId: string };
  realmId: string;
  directory: { ratingQuestions: ManagementQuestion[]; next: string | null };
  actions: { create: { method: 'POST'; href: string } | null };
  selected: {
    question: ManagementQuestion;
    readback: string;
    history: string;
    actions: {
      caption: { method: 'PUT'; href: string; expectedLabelRevision: number } | null;
      lifecycle: { method: 'POST'; href: string; expectedLifecycleRevision: number } | null;
    };
  } | null;
};

export type QuestionManagementAddress = {
  realmId: string;
  selectedQuestionId: string | null;
  cursor: string | null;
};

export type QuestionManagementVisit = QuestionManagementAddress & {
  locale: string;
  viewer: string | null;
  credentialEpisode: string | null;
  csrfEpisode: string | null;
  state: 'preparing' | 'signed-out' | 'invalid-address' | 'unavailable';
};

export type QuestionManagementRead =
  | (QuestionManagementAddress & {
      locale: string;
      viewer: string;
      credentialEpisode: string;
      csrfEpisode: string;
      state: 'ready';
      page: QuestionManagementPageData;
    })
  | (QuestionManagementAddress & {
      locale: string;
      viewer: string | null;
      state: 'signed-out' | 'denied' | 'concealed' | 'stale-cursor' | 'retired' | 'unavailable' | 'invalid-address';
    });

export type QuestionDefinitionInput = {
  meaning: string;
  label: string;
  grain: ManagementQuestion['grain'];
  scale: { min: number; max: number; displayStep: number };
};

export type QuestionCaptionInput = { expectedLabelRevision: number; label: string };
export type QuestionLifecycleInput = { expectedLifecycleRevision: number };
export type QuestionManagementAction = 'create' | 'caption' | 'retire' | 'restore';

type IntentBinding = {
  viewer: string;
  realmId: string;
  locale: string;
  credentialEpisode: string;
  csrfEpisode: string;
  csrfToken: string;
  sourceObservation: string;
  key: string;
  href: string;
  serializedBody: string;
};

export type QuestionManagementIntent = Readonly<
  | (IntentBinding & { action: 'create'; questionId: null; body: QuestionDefinitionInput })
  | (IntentBinding & { action: 'caption'; questionId: string; body: QuestionCaptionInput })
  | (IntentBinding & { action: 'retire' | 'restore'; questionId: string; body: QuestionLifecycleInput })
>;

export type QuestionManagementCommandResult =
  | { kind: 'acknowledged'; questionId: string | null }
  | { kind: 'stale' | 'denied' | 'invalid' | 'unavailable' | 'uncertain' };

export type QuestionManagementHistoryRead =
  | { state: 'ready'; questionId: string; cursor: string | null; page: QuestionLabelHistory }
  | { state: 'loading' | 'stale-cursor' | 'unavailable'; questionId: string; cursor: string | null };

export type QuestionManagementActionState =
  | 'idle'
  | 'sending'
  | 'uncertain'
  | 'stale'
  | 'denied'
  | 'invalid'
  | 'unavailable';

export type QuestionManagementFocusTicket = Readonly<{
  id: number;
  questionId: string;
  focusEpoch: number;
  afterRead: number;
}>;
