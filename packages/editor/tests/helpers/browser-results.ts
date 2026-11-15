export type BrowserResults = {
  testResults: { assertionResults: { status: string; title: string; failureMessages: string[] }[] }[];
};

/** Preserve the reached assertion before temporary JSON reports are removed, including a nonzero Vitest exit. */
export function browserFailureDetails(result: BrowserResults): string {
  return result.testResults
    .flatMap((file) =>
      file.assertionResults
        .filter((assertion) => assertion.status === 'failed')
        .map((assertion) => `${assertion.title}: ${assertion.failureMessages.join('\n').slice(0, 2_000)}`),
    )
    .join('\n\n');
}
