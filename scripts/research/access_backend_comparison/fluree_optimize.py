from compare import *
f=Fluree();mark='<'+f.iri('subject','*')+'>'
results={}
for actor in ['alice','bob']:
 gbase=f'<{f.iri("wiki","w")}> e:grants ?g . ?g e:holder <{f.iri("subject",actor)}> . '
 options={
 'naive_nested':gbase+f'''?g e:parent* ?root . ?root e:root {mark} . FILTER NOT EXISTS {{ ?g e:parent* ?ancestor . FILTER NOT EXISTS {{ ?ancestor e:enabled {mark} }} }} FILTER NOT EXISTS {{ ?g e:parent+ ?parent . FILTER NOT EXISTS {{ ?parent e:can_delegate {mark} }} }}''',
 'direct_root_or_chain':gbase+f'''?g e:enabled {mark} . {{ ?g e:root {mark} }} UNION {{ ?g e:parent+ ?root . ?root e:root {mark} . FILTER NOT EXISTS {{ ?g e:parent+ ?ancestor . FILTER NOT EXISTS {{ ?ancestor e:enabled {mark} ; e:can_delegate {mark} }} }} }}''',
 'proof_rows':gbase+' ?g e:parent* ?ancestor . ?ancestor ?property ?value .',
 'candidate_only':gbase}
 for name,body in options.items():
  q='PREFIX e: <'+PREFIX+'relation/> '+(('SELECT ?g ?ancestor ?property ?value WHERE' if name=='proof_rows' else 'ASK')+' { '+body+' }')
  samples=[]; output=None
  for _ in range(15):
   start=time.perf_counter_ns();r=f.http.post('/query/access-lab',content=q,headers={'Content-Type':'application/sparql-query','Accept':'application/sparql-results+json'});r.raise_for_status();output=r.json();samples.append((time.perf_counter_ns()-start)/1e6)
  results[actor+':'+name]={'median_ms':round(statistics.median(samples),3),'result':output}
(ROOT/'lab/fluree-optimization-result.json').write_text(json.dumps(results,indent=2))
print(json.dumps({k:{'median_ms':v['median_ms'],'result_rows':len(v['result'].get('results',{}).get('bindings',[])),'boolean':v['result'].get('boolean')} for k,v in results.items()},indent=2))
