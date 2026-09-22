from compare import *
import threading
REPORT={}
for cls in [Native,Spice,FGA,Fluree]:
 reader=cls(); writer=cls()
 if isinstance(reader,FGA):
  st=json.loads((ROOT/'lab/fga-state.json').read_text())
  for b in (reader,writer): b.store=st['store'];b.model=st['model']
 ban=('wiki','w','blocked_principal','realm','bad','')
 change=[('grant','root','enabled','subject','*',''),('realm','bad','member','subject','p_alice','')]
 reader.write([ban])
 assert reader.check('wiki','w','excluded_principal','p_alice') and reader.check('wiki','w','granted','alice')
 state={'enabled':True,'writes':0,'error':None}; stop=threading.Event(); started=threading.Event()
 def mutate():
  try:
   for i in range(400):
    if stop.is_set(): break
    target=not state['enabled']
    if isinstance(writer,Native):
     with writer.conn.transaction(): writer.write(change,delete=not target)
    else: writer.write(change,delete=not target)
    state['enabled']=target; state['writes']+=1; started.set()
  except Exception as exc: state['error']=repr(exc);started.set()
 th=threading.Thread(target=mutate); th.start();started.wait(5)
 allowed=[]; errors=[]
 try:
  for i in range(150):
   try:
    vals=reader.bulk(facts())
    if combine(vals): allowed.append({'iteration':i,'flags':vals})
   except Exception as exc: errors.append(str(exc)[:300])
 finally:
  stop.set();th.join(timeout=20)
  if th.is_alive(): raise RuntimeError('writer did not stop')
  if not state['enabled']: reader.write(change)
  reader.write([ban],delete=True)
 REPORT[reader.name]={'reads':150,'atomic_writes':state['writes'],'invalid_allows':len(allowed),'examples':allowed[:5],'read_errors':errors[:3],'writer_error':state['error']}
 (ROOT/'lab/coherence-result.json').write_text(json.dumps(REPORT,indent=2))
 print(reader.name,REPORT[reader.name],flush=True)
