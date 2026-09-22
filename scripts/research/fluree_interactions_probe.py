"""Bounded Fluree 4.2.1 interaction probe; no application or capacity qualification.

Supply the official CLI binary with --fluree. All data and logs go into a new
system temporary directory. The loopback HTTP child is stopped after the probe.
"""
from pathlib import Path
import argparse
import concurrent.futures
import json
import socket
import subprocess
import tempfile
import time
import urllib.request
import urllib.error

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--fluree', required=True, type=Path, help='Path to the Fluree 4.2.1 CLI')
args = parser.parse_args()
BINARY = args.fluree.resolve(strict=True)
ROOT = Path(tempfile.mkdtemp(prefix='rezics-fluree-interactions-'))
version = subprocess.run([str(BINARY), '--version'], capture_output=True, text=True, check=True, timeout=10).stdout.strip()
if version != 'fluree 4.2.1':
    raise SystemExit(f'This probe targets Fluree 4.2.1; received {version}')
for command in [
    ['init'],
    ['create', 'interactions-probe'],
    ['insert', '-e', json.dumps({'@context': {'ex': 'https://example.test/'}, '@graph': [
        {'@id': 'ex:work1', '@type': 'ex:Work', 'ex:title': 'Alpha'},
        {'@id': 'ex:work2', '@type': 'ex:Work', 'ex:title': 'Beta'}
    ]})],
]:
    subprocess.run([str(BINARY), '--direct', '--no-color', *command], cwd=ROOT,
                   capture_output=True, text=True, check=True, timeout=30)
print('Isolated probe directory:', ROOT, flush=True)
LEDGER = 'interactions-probe'
CTX = {'ex':'https://example.test/'}
REPORT = {'version':'4.2.1','scope':'isolated local functionality; no policy, load, or capacity qualification','checks':[],'receipts':[]}
with socket.socket() as s:
    s.bind(('127.0.0.1',0)); port=s.getsockname()[1]
BASE=f'http://127.0.0.1:{port}/v1/fluree'

def request(route, body=None, headers=None):
    data=json.dumps(body).encode() if body is not None else None
    req=urllib.request.Request(BASE+route,data=data,headers={'Content-Type':'application/json',**(headers or {})})
    try:
        with urllib.request.urlopen(req,timeout=15) as response:
            return json.loads(response.read())
    except urllib.error.HTTPError as error:
        raise RuntimeError(f'{route}: {error.code}: {error.read().decode()}') from error

def update(body):
    result=request('/update/'+LEDGER,{'@context':CTX,**body})
    REPORT['receipts'].append(result)
    return result

def query(where,select,**extra):
    return request('/query/'+LEDGER,{'@context':CTX,'where':where,'select':select,**extra})

def create(key, edge, kind, target, operation):
    return {'where':[['optional',{'@id':'?existing','ex:key':key}],['filter','(not (bound ?existing))']],
      'insert':[{'@id':edge,'@type':'ex:Interaction','ex:key':key,'ex:actor':{'@id':'ex:actorA'},'ex:kind':kind,'ex:target':{'@id':target},'ex:context':{'@id':'ex:realm1'},'ex:active':True,'ex:version':1},
      {'@id':'ex:receipt-'+operation,'@type':'ex:Receipt','ex:edge':{'@id':edge},'ex:version':1},
      {'@id':'ex:event-'+operation,'@type':'ex:Outbox','ex:edge':{'@id':edge},'ex:active':True,'ex:version':1}]}

def change(edge,expected,old,value,operation):
    return {'where':{'@id':edge,'ex:version':expected,'ex:active':old},
      'delete':{'@id':edge,'ex:version':expected,'ex:active':old},
      'insert':[{'@id':edge,'ex:version':expected+1,'ex:active':value},
      {'@id':'ex:receipt-'+operation,'@type':'ex:Receipt','ex:edge':{'@id':edge},'ex:version':expected+1},
      {'@id':'ex:event-'+operation,'@type':'ex:Outbox','ex:edge':{'@id':edge},'ex:active':value,'ex:version':expected+1}]}

def check(label,actual,expected):
    assert actual==expected, (label,actual,expected)
    REPORT['checks'].append({'check':label,'passed':True})
    print('PASS',label,flush=True)

log=(ROOT/'server.log').open('w')
server=subprocess.Popen([str(BINARY),'--no-color','server','run','--listen-addr',f'127.0.0.1:{port}','--storage-path',str(ROOT/'.fluree/storage'),'--log-level','warn'],cwd=ROOT,stdout=log,stderr=subprocess.STDOUT)
try:
    for _ in range(100):
        if server.poll() is not None:
            raise RuntimeError((ROOT/'server.log').read_text())
        try:
            query({'@id':'?id','ex:title':'?title'},['?id','?title'])
            break
        except (OSError, RuntimeError):
            time.sleep(.1)
    else: raise RuntimeError('server did not become ready')
    first=update(create('actorA|like|work1|realm1','ex:edge1','like','ex:work1','like1'))
    fenced=request('/query/'+LEDGER,{'@context':CTX,'select':['?version'],'where':{'@id':'ex:edge1','ex:version':'?version'}},headers={'Fluree-Min-T':str(first['t'])})
    check('HTTP minimum transaction fence observes own write',fenced,[[1]])
    check('like creates one edge',query({'ex:key':'actorA|like|work1|realm1','ex:active':'?active','ex:version':'?version'},['?active','?version']),[[True,1]])
    update(create('actorA|like|work1|realm1','ex:duplicate','like','ex:work1','duplicate'))
    check('duplicate creation does not add a second edge',query({'@id':'?edge','ex:key':'actorA|like|work1|realm1'},['?edge']),[['ex:edge1']])
    check('guarded no-op inserts no literal receipt',query({'@id':'ex:receipt-duplicate','ex:version':'?version'},['?version']),[])
    update(change('ex:edge1',1,True,False,'unlike2'))
    update(create('actorA|like|work1|realm1','ex:duplicate','like','ex:work1','retry-old-like'))
    update(change('ex:edge1',1,True,True,'stale'))
    check('unlike and stale replay preserve withdrawn revision',query({'@id':'ex:edge1','ex:active':'?active','ex:version':'?version'},['?active','?version']),[[False,2]])
    check('stale CAS creates no event',query({'@id':'ex:event-stale','ex:version':'?version'},['?version']),[])
    update(change('ex:edge1',2,False,True,'relike3'))
    check('re-like uses existing identity and next revision',query({'@id':'ex:edge1','ex:active':'?active','ex:version':'?version'},['?active','?version']),[[True,3]])
    update(create('actorA|favorite|work1|realm1','ex:fav1','favorite','ex:work1','fav1'))
    update(create('actorA|favorite|work2|realm1','ex:fav2','favorite','ex:work2','fav2'))
    favorites=[{'@id':'?edge','ex:actor':{'@id':'ex:actorA'},'ex:kind':'favorite','ex:active':True,'ex:target':{'@id':'?work'}},{'@id':'?work','ex:title':'?title'}]
    check('favorites join content before sort and limit',query(favorites,['?title'],orderBy=['?title'],limit=1),[['Alpha']])
    check('target like count counts active edges',query({'ex:kind':'like','ex:target':{'@id':'ex:work1'},'ex:active':True,'@id':'?edge'},['(as (count ?edge) ?count)']),[[1]])
    jobs=[create('actorA|like|work2|realm1',f'ex:race{i}','like','ex:work2',f'race{i}') for i in range(12)]
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
        list(pool.map(update,jobs))
    check('12 concurrent HTTP creates admit one logical edge',query({'ex:key':'actorA|like|work2|realm1','@id':'?edge'},['(as (count ?edge) ?count)']),[[1]])
    # The server/CLI indexing command is exercised only after all writes quiesce.
finally:
    server.terminate()
    try: server.wait(timeout=10)
    except subprocess.TimeoutExpired:
        server.kill(); server.wait()
    log.close()

p=subprocess.run([str(BINARY),'--direct','index',LEDGER],cwd=ROOT,text=True,capture_output=True,timeout=60)
REPORT['index']={'returncode':p.returncode,'stdout':p.stdout,'stderr':p.stderr}
p.check_returncode()
q={'@context':CTX,'where':[{'@id':'?edge','ex:actor':{'@id':'ex:actorA'},'ex:kind':'favorite','ex:active':True,'ex:target':{'@id':'?work'}},{'@id':'?work','ex:title':'?title'}],'select':['?title'],'orderBy':['?title']}
p=subprocess.run([str(BINARY),'--direct','query','--format','json','-e',json.dumps(q)],cwd=ROOT,text=True,capture_output=True,timeout=30)
p.check_returncode()
check('indexed reload preserves favorite/content join',json.loads(p.stdout),[['Alpha'],['Beta']])
(ROOT/'result.json').write_text(json.dumps(REPORT,indent=2)+'\n')
print('Evidence:',ROOT/'result.json')
