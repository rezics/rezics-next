from compare import *
f=Fluree(); NS=PREFIX+'policy/'; F='https://ns.flur.ee/db#'
def update(obj):
 r=f.http.post('/update/access-lab',json=obj);r.raise_for_status();f.t=r.json()['t'];return f.t
def policy(name,allow=None,required=False,dynamic=False):
 p={'@id':NS+name,'@type':F+'AccessPolicy',F+'action':{'@id':F+'view'},F+'onProperty':[{'@id':NS+'body'}],F+'required':required}
 if dynamic:p[F+'query']=json.dumps({'where':{'@id':'?$identity',NS+'canRead':True}})
 else:p[F+'allow']=allow
 return p
def read(policies,at=None):
 q={'from':'access-lab'+('@t:'+str(at) if at else ''),'select':['?body'],'where':{'@id':NS+'document',NS+'body':'?body'},'opts':{'identity':NS+'principal','policy':policies,'default-allow':False}}
 r=f.http.post('/query',json=q);r.raise_for_status();return r.json()
t=update({'insert':[{'@id':NS+'principal',NS+'canRead':True},{'@id':NS+'document',NS+'body':'synthetic-private-body'}]})
allow=policy('allow',True); deny=policy('deny',False); required=policy('required',False,True); dyn=policy('condition',required=True,dynamic=True)
result={'initial_t':t,'allow_then_deny':read([allow,deny]),'deny_then_allow':read([deny,allow]),'required_deny':read([allow,required]),'dynamic_before_revocation':read([dyn])}
update({'where':{'@id':NS+'principal',NS+'canRead':True},'delete':{'@id':NS+'principal',NS+'canRead':True},'insert':{'@id':NS+'principal',NS+'canRead':False}})
result['current_after_revocation']=read([dyn]);result['historic_after_revocation']=read([dyn],t)
result['historic_with_current_deny']=read([required],t)
(ROOT/'lab/fluree-policy-result.json').write_text(json.dumps(result,indent=2));print(json.dumps(result,indent=2))
