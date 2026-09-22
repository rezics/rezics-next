"""Synthetic relation-probe adapters, not production Access implementations."""
from pathlib import Path
import json, time, statistics, argparse, os
import httpx, psycopg, grpc
from authzed.api.v1 import core_pb2 as core, permission_service_pb2 as perm, permission_service_pb2_grpc as perm_grpc, schema_service_pb2 as schema, schema_service_pb2_grpc as schema_grpc
ROOT=Path(os.environ['REZICS_ACCESS_LAB']).resolve()
M=json.loads((ROOT/'lab/manifest.json').read_text())
PREFIX='https://access-probe.example/'
SPICE_SCHEMA='''
definition subject {}
definition actor {
 relation reader: subject | actor#reader
 relation grant_reader: subject | actor#grant_reader
}
definition realm {
 relation member: subject
}
definition grant {
 relation holder: subject
 relation enabled: subject:*
 relation root: subject:*
 relation parent: grant
 relation can_delegate: subject:*
 permission live = enabled & (root + parent->delegatable)
 permission delegatable = live & can_delegate
 permission receiver = holder & live
}
definition wiki {
 relation grants: grant
 relation blocked_principal: realm
 relation blocked_actor: realm
 relation exception: subject
 permission granted = grants->receiver
 permission excluded_principal = blocked_principal->member
 permission excluded_actor = blocked_actor->member
}
'''
def direct(): return {'this':{}}
def computed(r): return {'computedUserset':{'relation':r}}
def arrow(t,r): return {'tupleToUserset':{'tupleset':{'relation':t},'computedUserset':{'relation':r}}}
def union(*nodes): return {'union':{'child':list(nodes)}}
def intersection(*nodes): return {'intersection':{'child':list(nodes)}}
def fga_type(name,rels,allowed):
    return {'type':name,'relations':rels,'metadata':{'relations':{r:{'directly_related_user_types':types} for r,types in allowed.items()}}}
FGA_MODEL={'schema_version':'1.1','type_definitions':[
 {'type':'subject'},
 fga_type('actor',{'reader':direct(),'grant_reader':direct()},{'reader':[{'type':'subject'},{'type':'actor','relation':'reader'}],'grant_reader':[{'type':'subject'},{'type':'actor','relation':'grant_reader'}]}),
 fga_type('realm',{'member':direct()},{'member':[{'type':'subject'}]}),
 fga_type('grant',{'holder':direct(),'enabled':direct(),'root':direct(),'parent':direct(),'can_delegate':direct(),'live':intersection(computed('enabled'),union(computed('root'),arrow('parent','delegatable'))),'delegatable':intersection(computed('live'),computed('can_delegate')),'receiver':intersection(computed('holder'),computed('live'))},{'holder':[{'type':'subject'}],'enabled':[{'type':'subject','wildcard':{}}],'root':[{'type':'subject','wildcard':{}}],'parent':[{'type':'grant'}],'can_delegate':[{'type':'subject','wildcard':{}}]}),
 fga_type('wiki',{'grants':direct(),'blocked_principal':direct(),'blocked_actor':direct(),'exception':direct(),'granted':arrow('grants','receiver'),'excluded_principal':arrow('blocked_principal','member'),'excluded_actor':arrow('blocked_actor','member')},{'grants':[{'type':'grant'}],'blocked_principal':[{'type':'realm'}],'blocked_actor':[{'type':'realm'}],'exception':[{'type':'subject'}]})]}
BASE_EDGES=[
 ('actor','alice','reader','subject','p_alice',''),('actor','alice','grant_reader','subject','p_alice',''),
 ('actor','alternate','reader','subject','p_alice',''),('actor','bob','reader','subject','p_bob',''),
 ('actor','nested','reader','actor','alice','reader'),
 ('realm','bad','member','subject','p_alice',''),('realm','bad','member','subject','alice',''),
 ('grant','root','holder','subject','alice',''),('grant','root','enabled','subject','*',''),('grant','root','root','subject','*',''),('grant','root','can_delegate','subject','*',''),
 ('grant','child','holder','subject','bob',''),('grant','child','enabled','subject','*',''),('grant','child','parent','grant','root',''),
 ('grant','alt','holder','subject','alternate',''),('grant','alt','enabled','subject','*',''),('grant','alt','root','subject','*',''),
 ('wiki','w','grants','grant','root',''),('wiki','w','grants','grant','child',''),('wiki','w','grants','grant','alt','')]
class Spice:
 name='spicedb_postgres'
 def __init__(self):
  self.ch=grpc.insecure_channel(M['spice_addr']); grpc.channel_ready_future(self.ch).result(timeout=10)
  self.api=perm_grpc.PermissionsServiceStub(self.ch); self.schemas=schema_grpc.SchemaServiceStub(self.ch)
  self.metadata=(('authorization','Bearer '+M['spice_key']),); self.token=None
 def init(self): self.schemas.WriteSchema(schema.WriteSchemaRequest(schema=SPICE_SCHEMA),metadata=self.metadata)
 def write(self,edges,delete=False):
  updates=[]
  for st,si,r,dt,di,dr in edges:
   rel=core.Relationship(resource=core.ObjectReference(object_type=st,object_id=si),relation=r,subject=core.SubjectReference(object=core.ObjectReference(object_type=dt,object_id=di),optional_relation=dr))
   updates.append(core.RelationshipUpdate(operation=core.RelationshipUpdate.OPERATION_DELETE if delete else core.RelationshipUpdate.OPERATION_TOUCH,relationship=rel))
  if updates: self.token=self.api.WriteRelationships(perm.WriteRelationshipsRequest(updates=updates),metadata=self.metadata).written_at
 def check(self,st,si,r,subject):
  response=self.api.CheckPermission(perm.CheckPermissionRequest(consistency=perm.Consistency(fully_consistent=True),resource=core.ObjectReference(object_type=st,object_id=si),permission=r,subject=core.SubjectReference(object=core.ObjectReference(object_type='subject',object_id=subject))),metadata=self.metadata)
  return response.permissionship==perm.CheckPermissionResponse.PERMISSIONSHIP_HAS_PERMISSION
 def bulk(self,items):
  req=perm.CheckBulkPermissionsRequest(consistency=perm.Consistency(fully_consistent=True),items=[perm.CheckBulkPermissionsRequestItem(resource=core.ObjectReference(object_type=st,object_id=si),permission=r,subject=core.SubjectReference(object=core.ObjectReference(object_type='subject',object_id=s))) for st,si,r,s in items])
  out=self.api.CheckBulkPermissions(req,metadata=self.metadata)
  result=[]
  for pair in out.pairs:
   if pair.HasField('error'): raise RuntimeError(str(pair.error))
   result.append(pair.item.permissionship==perm.CheckPermissionResponse.PERMISSIONSHIP_HAS_PERMISSION)
  return result
class FGA:
 name='openfga_postgres'
 def __init__(self): self.http=httpx.Client(base_url=M['fga_url'],timeout=10,trust_env=False); self.store=None; self.model=None
 def post(self,path,data):
  r=self.http.post(path,json=data); r.raise_for_status(); return r.json() if r.content else {}
 def init(self):
  self.store=self.post('/stores',{'name':'access-research'})['id']
  self.model=self.post(f'/stores/{self.store}/authorization-models',FGA_MODEL)['authorization_model_id']
 def write(self,edges,delete=False):
  rows=[{'object':st+':'+si,'relation':r,'user':dt+':'+di+('#'+dr if dr else '')} for st,si,r,dt,di,dr in edges]
  if rows: self.post(f'/stores/{self.store}/write',{'authorization_model_id':self.model,('deletes' if delete else 'writes'):{'tuple_keys':rows}})
 def check(self,st,si,r,subject):
  return self.post(f'/stores/{self.store}/check',{'authorization_model_id':self.model,'consistency':'HIGHER_CONSISTENCY','tuple_key':{'object':st+':'+si,'relation':r,'user':'subject:'+subject}})['allowed']
 def bulk(self,items):
  data=self.post(f'/stores/{self.store}/batch-check',{'authorization_model_id':self.model,'consistency':'HIGHER_CONSISTENCY','checks':[{'correlation_id':str(i),'tuple_key':{'object':st+':'+si,'relation':r,'user':'subject:'+s}} for i,(st,si,r,s) in enumerate(items)]})
  results=data['result']
  for item in results.values():
   if 'error' in item: raise RuntimeError(str(item))
  return [results[str(i)]['allowed'] for i in range(len(items))]
class Native:
 name='native_postgres'
 def __init__(self): self.conn=psycopg.connect(M['native_uri'],autocommit=True)
 def init(self):
  self.conn.execute('DROP TABLE IF EXISTS edge CASCADE; CREATE TABLE edge(st text,si text,r text,dt text,di text,dr text,PRIMARY KEY(st,si,r,dt,di,dr)); CREATE INDEX edge_inverse ON edge(dt,di,r,st,si)')
 def write(self,edges,delete=False):
  with self.conn.cursor() as c:
   if delete: c.executemany('DELETE FROM edge WHERE(st,si,r,dt,di,dr)=(%s,%s,%s,%s,%s,%s)',edges)
   else: c.executemany('INSERT INTO edge VALUES(%s,%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING',edges)
 def sql(self,st,si,r,subject):
  if st=='actor':
   return '''WITH RECURSIVE walk(t,id,visited) AS (
    SELECT dt,di,ARRAY[si] FROM edge WHERE st='actor' AND si=%s AND r=%s
    UNION ALL SELECT e.dt,e.di,w.visited||w.id FROM walk w JOIN edge e ON e.st='actor' AND e.si=w.id AND e.r=%s
      WHERE w.t='actor' AND NOT w.id=ANY(w.visited))
    SELECT EXISTS(SELECT 1 FROM walk WHERE t='subject' AND id=%s)''',(si,r,r,subject)
  if r=='granted':
   return '''WITH RECURSIVE walk(id,visited) AS (
     SELECT w.di,ARRAY[w.di] FROM edge w JOIN edge h ON h.st='grant' AND h.si=w.di AND h.r='holder' AND h.di=%s
     WHERE w.st='wiki' AND w.si=%s AND w.r='grants'
     AND EXISTS(SELECT 1 FROM edge a WHERE a.st='grant' AND a.si=w.di AND a.r='enabled')
     UNION ALL SELECT e.di,w.visited||e.di FROM walk w JOIN edge e ON e.st='grant' AND e.si=w.id AND e.r='parent'
     WHERE NOT e.di=ANY(w.visited)
     AND EXISTS(SELECT 1 FROM edge a WHERE a.st='grant' AND a.si=e.di AND a.r='enabled')
     AND EXISTS(SELECT 1 FROM edge a WHERE a.st='grant' AND a.si=e.di AND a.r='can_delegate'))
     SELECT EXISTS(SELECT 1 FROM walk w JOIN edge e ON e.st='grant' AND e.si=w.id AND e.r='root')''',(subject,si)
  if r in ('excluded_principal','excluded_actor'):
   rel='blocked_principal' if r=='excluded_principal' else 'blocked_actor'
   return "SELECT EXISTS(SELECT 1 FROM edge w JOIN edge m ON m.st='realm' AND m.si=w.di AND m.r='member' AND m.di=%s WHERE w.st='wiki' AND w.si=%s AND w.r=%s)",(subject,si,rel)
  return 'SELECT EXISTS(SELECT 1 FROM edge WHERE st=%s AND si=%s AND r=%s AND dt=\'subject\' AND di=%s)',(st,si,r,subject)
 def check(self,*item):
  sql,values=self.sql(*item); return self.conn.execute(sql,values).fetchone()[0]
 def bulk(self,items):
  # Same read snapshot, bounded pipeline; not a hand-optimized combined SQL query.
  with self.conn.transaction():
   self.conn.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
   with self.conn.pipeline():
    cursors=[self.conn.execute(*self.sql(*item)) for item in items]
   return [c.fetchone()[0] for c in cursors]
class Fluree:
 name='fluree_main'
 def __init__(self): self.http=httpx.Client(base_url=M['fluree_url'],timeout=15,trust_env=False); self.t=0
 def iri(self,t,i): return PREFIX+t+'/'+i
 def pred(self,r): return PREFIX+'relation/'+r
 def write(self,edges,delete=False):
  triples=[]
  for st,si,r,dt,di,dr in edges:
   triples.append({'@id':self.iri(st,si),self.pred(r):{'@id':self.iri(dt,di)}})
  if triples:
   out=self.http.post('/update/access-lab',json={('delete' if delete else 'insert'):triples})
   out.raise_for_status(); self.t=out.json()['t']
 def init(self): pass
 def ask(self,body,extra=None):
  query='PREFIX e: <'+PREFIX+'relation/> ASK { '+body+' }'
  out=self.http.post('/query/access-lab',content=query,headers={'Content-Type':'application/sparql-query','Accept':'application/sparql-results+json','Fluree-Min-T':str(self.t)})
  out.raise_for_status(); return out.json()['boolean']
 def pattern(self,st,si,r,subject):
  src='<'+self.iri(st,si)+'>'; dst='<'+self.iri('subject',subject)+'>'
  if st=='actor': return f'{src} e:{r}+ {dst} .'
  if r=='granted':
   return f"""{src} e:grants ?g . ?g e:holder {dst} ; e:enabled <{self.iri('subject','*')}> .
     {{ ?g e:root <{self.iri('subject','*')}> }} UNION {{
     ?g e:parent+ ?root . ?root e:root <{self.iri('subject','*')}> .
     FILTER NOT EXISTS {{ ?g e:parent+ ?ancestor . FILTER NOT EXISTS {{ ?ancestor e:enabled <{self.iri('subject','*')}> ; e:can_delegate <{self.iri('subject','*')}> }} }} }}"""
  if r in ('excluded_principal','excluded_actor'):
   rel='blocked_principal' if r=='excluded_principal' else 'blocked_actor'
   return f'{src} e:{rel} ?realm . ?realm e:member {dst} .'
  return f'{src} e:{r} {dst} .'
 def check(self,*item): return self.ask(self.pattern(*item))
 def bulk(self,items):
  queries={str(i):{'language':'sparql','query':'PREFIX e: <'+PREFIX+'relation/> ASK FROM <access-lab> { '+self.pattern(*item)+' }'} for i,item in enumerate(items)}
  out=self.http.post('/multi-query',json={'queries':queries,'opts':{'maxConcurrency':8}},headers={'Fluree-Min-T':str(self.t)})
  out.raise_for_status(); data=out.json()
  if data['status']!='ok': raise RuntimeError(data)
  return [data['results'][str(i)]['boolean'] for i in range(len(items))]

def facts(p='p_alice',a='alice',w='w'):
 return [('actor',a,'reader',p),('wiki',w,'exception',a),('wiki',w,'excluded_principal',p),('wiki',w,'excluded_actor',a),('wiki',w,'granted',a)]
def combine(values,order=('exception','principal','actor','grant')):
 rep,exc,bp,ba,gr=values
 if not rep: return False
 cond={'exception':(exc,True),'principal':(bp,False),'actor':(ba,False),'grant':(gr,True)}
 for name in order:
  if cond[name][0]: return cond[name][1]
 return False

def run_semantics(b):
 results=[]
 def expect(label,items,want,order=('exception','principal','actor','grant')):
  vals=b.bulk(items); got=combine(vals,order)
  if got!=want: raise AssertionError((b.name,label,vals,got,want))
  results.append({'case':label,'passed':True})
 b.init()
 for i in range(0,len(BASE_EDGES),90): b.write(BASE_EDGES[i:i+90])
 expect('author rights used by verified representative',facts(),True)
 expect('unrelated account cannot act as author',facts(p='p_bob'),False)
 expect('alternate identity remains separately authorized',facts(a='alternate'),True)
 assert b.check('actor','nested','reader','p_alice')
 results.append({'case':'nested representation resolves','passed':True})
 expect('dependent object grant valid',facts('p_bob','bob'),True)
 parent_enable=('grant','root','enabled','subject','*','')
 b.write([parent_enable],delete=True)
 expect('parent revocation immediately stops child',facts('p_bob','bob'),False)
 b.write([parent_enable])
 banp=('wiki','w','blocked_principal','realm','bad','')
 bana=('wiki','w','blocked_actor','realm','bad','')
 b.write([bana]); expect('actor member excluded',facts(),False)
 expect('actor exclusion permits distinct identity',facts(a='alternate'),True)
 b.write([bana],delete=True); b.write([banp])
 expect('principal exclusion survives identity switch',facts(a='alternate'),False)
 exception=('wiki','w','exception','subject','alice','')
 b.write([exception]); expect('earlier exception permits',facts(),True)
 expect('reordering exception below exclusion denies',facts(),False,order=('principal','actor','exception','grant'))
 b.write([exception,banp],delete=True)
 expect('removing exclusion restores eligible rights',facts(),True)
 return results

def timings(b,n=60):
 samples=[]
 items=facts()
 for _ in range(5): assert combine(b.bulk(items))
 for _ in range(n):
  start=time.perf_counter_ns(); assert combine(b.bulk(items)); samples.append((time.perf_counter_ns()-start)/1e6)
 s=sorted(samples)
 return {'n':n,'p50_ms':round(statistics.median(s),3),'p95_ms':round(s[min(len(s)-1,int(.95*len(s)))],3),'max_ms':round(max(s),3),'samples_ms':samples}
if __name__=='__main__':
 report={}
 for cls in [Native,Spice,FGA,Fluree]:
  b=cls(); print('START',b.name,flush=True)
  try:
   checks=run_semantics(b); print('PASS',b.name,len(checks),flush=True)
   report[b.name]={'checks':checks,'timing':timings(b)}
   if isinstance(b,FGA): (ROOT/'lab/fga-state.json').write_text(json.dumps({'store':b.store,'model':b.model}))
  except Exception as exc:
   report[b.name]={'error':repr(exc)}; print('ERROR',b.name,repr(exc),flush=True)
  (ROOT/'lab/compare-result.json').write_text(json.dumps(report,indent=2))
 print(json.dumps({k:{'passed':len(v.get('checks',[])),'timing':{x:y for x,y in v.get('timing',{}).items() if x!='samples_ms'},'error':v.get('error')} for k,v in report.items()},indent=2))
