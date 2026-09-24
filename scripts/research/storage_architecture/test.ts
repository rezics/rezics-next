const args=process.argv.slice(2);
if(!args.some(arg=>!arg.startsWith('-')&& /\.(test|spec)\.[cm]?[jt]sx?$/.test(arg)))throw new Error('Provide explicit test file paths; full-suite execution belongs to yarn qa.');
const child=Bun.spawn(['bun','test',...args],{stdout:'inherit',stderr:'inherit'});
process.exit(await child.exited);
export {};
