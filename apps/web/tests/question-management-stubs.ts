import { createElement } from 'react';

// Process-wide stubs for the question-management test files. A module mock registered by one test file stays in place
// for every file that runs after it, so each mock below is the same factory in every file and only reads these handlers.
// A file sets its handlers in beforeEach and clears them in afterEach; without a handler, the real module answers.
type Handler = (input: any) => any;

export type QuestionStubs = {
  session?: { state: 'signed-in'; subject: string; csrfToken: string };
  prepare?: Handler;
  read?: Handler;
  history?: Handler;
  execute?: Handler;
  capture?: Handler;
  matchesPage?: () => boolean;
  validBody?: (action: string, value: unknown) => boolean;
  departure?: (props: unknown) => unknown;
};

export const stubs: QuestionStubs = {};

export function sessionMock(actual: { useSession: () => unknown } & Record<string, unknown>) {
  return { ...actual, useSession: () => stubs.session ?? actual.useSession() };
}

export function actionsMock(actual: Record<string, Handler>) {
  return {
    ...actual,
    prepareQuestionManagementVisit: (input: unknown) =>
      stubs.prepare ? stubs.prepare(input) : actual.prepareQuestionManagementVisit!(input),
    readQuestionManagementForViewer: (input: unknown) =>
      stubs.read ? stubs.read(input) : actual.readQuestionManagementForViewer!(input),
    readQuestionManagementHistory: (input: unknown) =>
      stubs.history ? stubs.history(input) : actual.readQuestionManagementHistory!(input),
    executeQuestionManagementIntent: (input: unknown) =>
      stubs.execute ? stubs.execute(input) : actual.executeQuestionManagementIntent!(input),
  };
}

export function intentMock(actual: Record<string, Handler>) {
  return {
    ...actual,
    captureQuestionManagementIntent: (input: unknown) =>
      stubs.capture ? stubs.capture(input) : actual.captureQuestionManagementIntent!(input),
    questionManagementIntentMatchesPage: (...args: unknown[]) =>
      stubs.matchesPage ? stubs.matchesPage() : actual.questionManagementIntentMatchesPage!(...args),
    validQuestionManagementBody: (action: string, value: unknown) =>
      stubs.validBody ? stubs.validBody(action, value) : actual.validQuestionManagementBody!(action, value),
  };
}

export function departureMock(actual: Record<string, unknown> & { OwnVotesDeparture: (props: any) => unknown }) {
  return {
    ...actual,
    OwnVotesDeparture: (props: any) =>
      stubs.departure ? stubs.departure(props) : createElement(actual.OwnVotesDeparture as never, props),
  };
}
