process.env.BAN_PRECEDENCE_DRIVER = new URL('./ban-precedence-outcomes-driver.ts', import.meta.url).href;
await import(new URL('../../../../specs/ban-precedence-outcomes.test.ts', import.meta.url).href);
