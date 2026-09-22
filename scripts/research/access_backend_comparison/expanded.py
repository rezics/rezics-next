from compare import *
from concurrent.futures import ThreadPoolExecutor


def load_noise(b,n=2000):
 edges=[]
 for i in range(n):
  a='noise_'+str(i); g='noise_g_'+str(i); w='noise_w_'+str(i)
  edges += [('actor',a,'reader','subject','noise_p_'+str(i),''),('realm','large','member','subject','noise_p_'+str(i),''),('grant',g,'holder','subject',a,''),('grant',g,'enabled','subject','*',''),('grant',g,'root','subject','*',''),('wiki',w,'grants','grant',g,'')]
 for i in range(0,len(edges),90): b.write(edges[i:i+90])
 if isinstance(b,Native): b.conn.execute('ANALYZE edge')
 return len(edges)

def depths(b):
 out={}
 for depth in [1,2,4,8,16]:
  nodes=[]
  for j in range(depth):
   cur=f'd{depth}_{j}'
   nodes.append(('actor',cur,'reader','subject' if j==depth-1 else 'actor','p_deep' if j==depth-1 else f'd{depth}_{j+1}','' if j==depth-1 else 'reader'))
  b.write(nodes)
  try:
   s=[]
   for _ in range(15):
    st=time.perf_counter_ns(); allowed=b.check('actor',f'd{depth}_0','reader','p_deep'); s.append((time.perf_counter_ns()-st)/1e6)
    assert allowed
   out[str(depth)]={'allow':True,'median_ms':round(statistics.median(s),3)}
  except Exception as ex: out[str(depth)]={'error':str(ex)[:900]}
 return out

def batch_targets(b):
 rows=[]
 for i in range(50): rows.append(('wiki',f'page_{i}','grants','grant','root',''))
 b.write(rows)
 items=[('wiki',f'page_{i}','granted','alice') for i in range(50)]
 st=time.perf_counter_ns(); result=b.bulk(items); elapsed=(time.perf_counter_ns()-st)/1e6
 assert all(result) and len(result)==50
 return {'targets':50,'elapsed_ms':round(elapsed,3),'all_allowed':True}

report={}
for cls in [Native,Spice,FGA,Fluree]:
 b=cls(); print('START',b.name,flush=True)
 if isinstance(b,FGA):
  st=json.loads((ROOT/'lab/fga-state.json').read_text()); b.store=st['store']; b.model=st['model']
 try:
  n=load_noise(b); print('SEEDED',b.name,n,flush=True)
  data={'noise_edges':n,'after_noise_timing':timings(b,100),'depth':depths(b),'batch':batch_targets(b)}
  report[b.name]=data
 except Exception as exc: report[b.name]={'error':repr(exc)}
 (ROOT/'lab/expanded-result.json').write_text(json.dumps(report,indent=2))
 print('DONE',b.name,flush=True)
print(json.dumps({k:{'error':v.get('error'),'timing':{x:y for x,y in v.get('after_noise_timing',{}).items() if x!='samples_ms'},'depth':v.get('depth'),'batch':v.get('batch')} for k,v in report.items()},indent=2))
