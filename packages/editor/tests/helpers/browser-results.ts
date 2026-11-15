export type BrowserResults = {
  testResults: { assertionResults: { status: string; title: string; failureMessages: string[] }[] }[];
};

/** Preserve the reached assertion before temporary JSON reports are removed, including a nonzero Vitest exit. */
export function browserFailureDetails(result: BrowserResults, diagnostics = ''): string {
  const failures = result.testResults
    .flatMap((file) =>
      file.assertionResults
        .filter((assertion) => assertion.status === 'failed')
        .map((assertion) => `${assertion.title}: ${assertion.failureMessages.join('\n').slice(0, 2_000)}`),
    )
    .join('\n\n');
  return [failures, diagnostics].filter(Boolean).join('\n\n');
}
