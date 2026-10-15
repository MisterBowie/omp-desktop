#!/usr/bin/env python3
"""Observe the exact native run from this Mac; never dispatch/retry a run."""
from pathlib import Path
from datetime import datetime,timezone
import json,urllib.request

root=Path(__file__).resolve().parent
meta_path=root/'native-ci-dispatch.json'
meta=json.loads(meta_path.read_text());assert meta['pushed']
opener=urllib.request.build_opener(urllib.request.ProxyHandler({'https':'http://127.0.0.1:7897'}))
def api(path):
    request=urllib.request.Request('https://api.github.com/repos/MisterBowie/omp-desktop/'+path,
                                  headers={'Accept':'application/vnd.github+json','User-Agent':'omp-local-goal-review'})
    with opener.open(request,timeout=30) as response:
        result=json.load(response)
        meta['rateRemaining']=response.headers.get('X-RateLimit-Remaining')
        meta['rateReset']=response.headers.get('X-RateLimit-Reset')
        return result
if meta.get('runId'):
    run=api('actions/runs/'+str(meta['runId']))
else:
    runs=api('actions/runs?head_sha='+meta['candidate']+'&event=push&per_page=50')['workflow_runs']
    matches=[r for r in runs if r['head_branch']==meta['tag'] and r['path']=='.github/workflows/'+meta['workflow']]
    assert len(matches)<=1,'Inspect any duplicate runs before continuing'
    if not matches:
        print('Tag pushed; no matching run visible yet. No redispatch performed.')
        raise SystemExit(0)
    run=matches[0]
assert run['head_sha']==meta['candidate'] and run['head_branch']==meta['tag']
assert run['path']=='.github/workflows/'+meta['workflow']
jobs=api('actions/runs/'+str(run['id'])+'/jobs?per_page=100')['jobs']
raw={'observedAt':datetime.now(timezone.utc).isoformat(),'run':run,'jobs':jobs}
(root/'native-ci-latest.json').write_text(json.dumps(raw,ensure_ascii=False,indent=2)+'\n')
meta.update(runId=run['id'],runUrl=run['html_url'],runStatus=run['status'],runConclusion=run['conclusion'],lastObservedAt=raw['observedAt'])
meta_path.write_text(json.dumps(meta,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'observedAt':raw['observedAt'],'runId':run['id'],'url':run['html_url'],'status':run['status'],
                  'conclusion':run['conclusion'],'rateRemaining':meta['rateRemaining'],
                  'jobs':[{'name':j['name'],'id':j['id'],'status':j['status'],'conclusion':j['conclusion'],
                           'step':next((s['name'] for s in j['steps'] if s['status']=='in_progress'),None),
                           'failedSteps':[s['name'] for s in j['steps'] if s['conclusion']=='failure']} for j in jobs]},ensure_ascii=False,indent=2))
