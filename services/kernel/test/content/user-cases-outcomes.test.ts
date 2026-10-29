// The native driver consumes OPENSEARCH_URL for subject.search.
process.env.CONTENT_USER_CASES_DRIVER = new URL('./user-cases-driver.ts', import.meta.url).href;
await import('../../../../specs/content-user-cases-outcomes.test.ts');
