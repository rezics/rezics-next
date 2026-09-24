for (const cmd of [['python3','-B','-m','unittest','discover','-s','scripts/documentation','-p','test_*.py'],['python3','-B','scripts/documentation/check_docs.py']]) {
  const child=Bun.spawn(cmd,{stdout:'inherit',stderr:'inherit'});
  const code=await child.exited;
  if(code!==0)process.exit(code);
}
export {};
