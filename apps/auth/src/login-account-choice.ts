import { canContinueAsCurrentAccount, type SignInPage, type SignInPageResult } from './signin-page';

type Review = { uncertain: boolean; previousViewer: string | null };
export type LoginAccountChoice =
  | { kind: 'loading' | 'unavailable' | 'uncertain'; review: Review }
  | {
      kind: 'ready';
      page: SignInPage;
      mode: 'current' | 'credentials';
      observation: 'initial' | 'reviewed' | 'changed' | 'signed-out';
      uncertain: boolean;
    };

export const initialLoginChoice = (): LoginAccountChoice => ({
  kind: 'loading',
  review: { uncertain: false, previousViewer: null },
});

export function loginReview(choice: LoginAccountChoice): Review {
  return choice.kind === 'ready'
    ? {
        uncertain: choice.uncertain,
        previousViewer: choice.page.viewer.kind === 'signed-in' ? choice.page.viewer.account_id : null,
      }
    : choice.review;
}

export function observedLoginChoice(
  result: SignInPageResult,
  review: Review,
  explicit: boolean,
  returned = false,
): LoginAccountChoice {
  if (result.kind === 'unavailable') return { kind: 'unavailable', review };
  const { page } = result;
  const viewer = page.viewer.kind === 'signed-in' ? page.viewer.account_id : null;
  return {
    kind: 'ready',
    page,
    mode: viewer ? 'current' : 'credentials',
    observation: !explicit
      ? 'initial'
      : !viewer
        ? 'signed-out'
        : returned
          ? 'reviewed'
          : viewer !== review.previousViewer
            ? 'changed'
            : 'reviewed',
    uncertain: review.uncertain,
  };
}

export function loginShowsCredentials(choice: LoginAccountChoice): boolean {
  return choice.kind === 'ready' && (choice.mode === 'credentials' || choice.page.continuation.requires_sign_in);
}

export function loginCanContinue(choice: LoginAccountChoice): boolean {
  return choice.kind === 'ready' && choice.mode === 'current' && canContinueAsCurrentAccount(choice.page);
}
