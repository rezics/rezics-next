from compare import *
backends=[Native(),Spice(),FGA(),Fluree()]
st=json.loads((ROOT/'lab/fga-state.json').read_text());backends[2].store=st['store'];backends[2].model=st['model']
report={b.name:{'rounds':[],'batch_rounds_ms':[]} for b in backends}
for round_id in range(3):
 order=backends[round_id:]+backends[:round_id]
 for b in order:
  report[b.name]['rounds'].append(timings(b,100))
  rows=[('wiki',f'page_{i}','granted','alice') for i in range(50)]
  for _ in range(5):
   start=time.perf_counter_ns();result=b.bulk(rows);elapsed=(time.perf_counter_ns()-start)/1e6
   assert all(result) and len(result)==50
   report[b.name]['batch_rounds_ms'].append(elapsed)
summary={}
for name,v in report.items():
 samples=sorted(x for r in v['rounds'] for x in r['samples_ms'])
 summary[name]={'reads':len(samples),'p50_ms':round(statistics.median(samples),3),'p95_ms':round(samples[int(.95*len(samples))],3),'max_ms':round(max(samples),3),'batch_50_median_ms':round(statistics.median(v['batch_rounds_ms']),3)}
report['summary']=summary
report['scope']='Local synthetic five-predicate decision frame, 12k unrelated edges; reused connections; no security transport, admission/effect protocol, production workload, or storage-durability qualification. All services on same host, /tmp tmpfs. Native PostgreSQL uses repeatable-read pipeline; SpiceDB uses gRPC fully-consistent bulk; OpenFGA uses HTTP higher-consistency batch; Fluree uses HTTP shared-snapshot multi-query and optimized direct-root/dependent-grant query.'
(ROOT/'lab/final-measurement.json').write_text(json.dumps(report,indent=2))
print(json.dumps(summary,indent=2))
