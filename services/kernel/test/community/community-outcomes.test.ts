process.env.COMMUNITY_DRIVER = new URL('./community-driver.ts', import.meta.url).href;

await import('../../../../specs/community-outcomes.test.ts');
