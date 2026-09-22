from pathlib import Path
import json, signal, socket, subprocess, time, psycopg, os
ROOT=Path(os.environ['REZICS_ACCESS_LAB']).resolve()
ROOT.mkdir(parents=True,exist_ok=True)
LAB=ROOT/'lab'; LAB.mkdir(exist_ok=True)
BIN_SPICE=Path(os.environ['REZICS_SPICEDB_BIN']).resolve(strict=True)
BIN_FGA=Path(os.environ['REZICS_OPENFGA_BIN']).resolve(strict=True)
BIN_FLUREE=Path(os.environ['REZICS_FLUREE_BIN']).resolve(strict=True)
if (LAB/'pg').exists():
 raise SystemExit('Use a fresh REZICS_ACCESS_LAB directory; existing database directories are never reset')
children=[]; logs=[]
def port():
    with socket.socket() as s:
        s.bind(('127.0.0.1',0)); return s.getsockname()[1]
def run(args,cwd=LAB):
    r=subprocess.run([str(x) for x in args],cwd=cwd,capture_output=True,text=True,timeout=60)
    if r.returncode: raise RuntimeError((r.stdout+r.stderr)[-7000:])
    return r.stdout
def start(name,args,cwd=LAB):
    log=(LAB/(name+'.log')).open('w'); logs.append(log)
    p=subprocess.Popen([str(x) for x in args],cwd=cwd,stdout=log,stderr=subprocess.STDOUT)
    children.append(p); return p
try:
    pg_port,sp_port,fga_http,fga_grpc,fl_port=[port() for _ in range(5)]
    run(['initdb','-D',LAB/'pg','--username=probe','--no-locale','--encoding=UTF8','--auth=trust'])
    pg=start('postgres',['postgres','-D',LAB/'pg','-h','127.0.0.1','-p',pg_port,'-k',LAB,'-c','track_commit_timestamp=on','-c','shared_buffers=64MB','-c','max_connections=100'])
    uri=f'postgresql://probe@127.0.0.1:{pg_port}/postgres?sslmode=disable'
    for _ in range(100):
        try: conn=psycopg.connect(uri,autocommit=True); break
        except psycopg.OperationalError:
            if pg.poll() is not None: raise RuntimeError((LAB/'postgres.log').read_text())
            time.sleep(.05)
    else: raise RuntimeError('Postgres startup timeout')
    for name in ['native','spice','fga']: conn.execute('CREATE DATABASE '+name)
    conn.close()
    spice_uri=uri.replace('/postgres?','/spice?'); fga_uri=uri.replace('/postgres?','/fga?')
    run([BIN_SPICE,'datastore','migrate','head','--datastore-engine','postgres','--datastore-conn-uri',spice_uri,'--skip-release-check'])
    run([BIN_FGA,'migrate','--datastore-engine','postgres','--datastore-uri',fga_uri])
    start('spicedb',[BIN_SPICE,'serve','--datastore-engine','postgres','--datastore-conn-uri',spice_uri,'--grpc-addr',f'127.0.0.1:{sp_port}','--grpc-preshared-key','access-probe-only','--metrics-enabled=false','--telemetry-endpoint=','--skip-release-check','--log-level','warn'])
    start('openfga',[BIN_FGA,'run','--datastore-engine','postgres','--datastore-uri',fga_uri,'--http-addr',f'127.0.0.1:{fga_http}','--grpc-addr',f'127.0.0.1:{fga_grpc}','--metrics-enabled=false','--playground-enabled=false','--datastore-max-open-conns','15','--log-level','warn'])
    flroot=LAB/'fluree'; flroot.mkdir()
    run([BIN_FLUREE,'--direct','init'],flroot)
    run([BIN_FLUREE,'--direct','create','access-lab'],flroot)
    start('fluree',[BIN_FLUREE,'server','run','--listen-addr',f'127.0.0.1:{fl_port}','--storage-path',flroot/'.fluree/storage','--log-level','warn'],flroot)
    manifest={'root':str(ROOT),'lab':str(LAB),'postgres_uri':uri,'native_uri':uri.replace('/postgres?','/native?'),'spice_addr':f'127.0.0.1:{sp_port}','spice_key':'access-probe-only','fga_url':f'http://127.0.0.1:{fga_http}','fluree_url':f'http://127.0.0.1:{fl_port}/v1/fluree','pids':[p.pid for p in children]}
    (LAB/'manifest.json').write_text(json.dumps(manifest,indent=2))
    print('READY',json.dumps(manifest),flush=True)
    while True:
        for p in children:
            if p.poll() is not None: raise RuntimeError(f'child {p.pid} exited {p.returncode}')
        time.sleep(.5)
except KeyboardInterrupt:
    print('Stopping isolated lab',flush=True)
finally:
    for p in reversed(children):
        if p.poll() is None: p.terminate()
    for p in reversed(children):
        try: p.wait(timeout=12)
        except subprocess.TimeoutExpired: p.kill(); p.wait()
    for log in logs: log.close()
