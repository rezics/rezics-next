// Bootstrap gates only; the complete product QA facade remains Phase 0 work.
for(const cmd of [['bun','node_modules/typescript/bin/tsc','--project','services/main/tsconfig.json'],['bun','node_modules/typescript/bin/tsc','--project','services/account/tsconfig.json'],['bun','node_modules/typescript/bin/tsc','--project','packages/model/tsconfig.json'],['bun','node_modules/typescript/bin/tsc','--project','scripts/research/storage_architecture/tsconfig.json'],['yarn','gen:check'],['yarn','docs:check']]) {
  const child=Bun.spawn(cmd,{stdout:'inherit',stderr:'inherit'});
  const code=await child.exited;
  if(code!==0)process.exit(code);
}
export {};
