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
