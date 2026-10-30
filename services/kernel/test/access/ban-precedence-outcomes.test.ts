process.env.BAN_PRECEDENCE_DRIVER = new URL('./ban-precedence-outcomes-driver.ts', import.meta.url).href;
await import('../../../../specs/ban-precedence-outcomes.test.ts');
