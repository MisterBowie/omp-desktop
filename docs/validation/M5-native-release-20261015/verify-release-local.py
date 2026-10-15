#!/usr/bin/env python3
"""Audit the exact completed native release using public reads from this Mac."""
from pathlib import Path
from datetime import datetime,timezone
from concurrent.futures import ThreadPoolExecutor
import hashlib,json,re,subprocess,urllib.request,urllib.error

root=Path(__file__).resolve().parent
meta=json.loads((root/'native-ci-dispatch.json').read_text())
assert meta['pushed'] and meta.get('runId')
repo=Path('/Users/vv/Documents/对话/omp-desktop-local-m5-windows')
sha=meta['candidate'];tag=meta['tag'];run_id=meta['runId']
opener=urllib.request.build_opener(urllib.request.ProxyHandler({'https':'http://127.0.0.1:7897'}))
def api(path):
    request=urllib.request.Request('https://api.github.com/repos/MisterBowie/omp-desktop/'+path,
                                  headers={'Accept':'application/vnd.github+json','User-Agent':'omp-local-goal-review'})
    with opener.open(request,timeout=40) as response:return json.load(response)
run=api('actions/runs/'+str(run_id))
assert run['status']=='completed' and run['conclusion']=='success','Native run not successful; do not audit as delivered'
assert run['head_sha']==sha and run['head_branch']==tag
jobs=api('actions/runs/'+str(run_id)+'/jobs?per_page=100')['jobs']
assert {j['name'] for j in jobs}=={'Bind the run to the reviewed tag','Package macOS arm64','Package Windows x64','Package Linux x64','Publish the test prerelease'}
assert all(j['conclusion']=='success' and j['status']=='completed' for j in jobs)
ref=subprocess.check_output(['git','-C',str(repo),'ls-remote','origin','refs/tags/'+tag],text=True).strip()
assert ref.split()[0]==sha
release=api('releases/tags/'+tag)
assert release['tag_name']==tag and release['prerelease'] and not release['draft']
try:
    latest=api('releases/latest');assert latest['tag_name']!=tag
except urllib.error.HTTPError as error:
    if error.code!=404:raise
version=json.loads((repo/'app/apps/desktop/package.json').read_text())['version']
prefix='OMP-Desktop-'+version+'-'+tag+'-'
payload={prefix+s for s in ['macos-arm64.dmg','macos-arm64.zip','windows-x64-setup.exe','windows-x64-portable.exe','linux-x64.AppImage','linux-x64.deb','linux-x64.rpm']}
names=payload|{'BUILD-RECORD.json','SHA256SUMS.txt'}
assets=release['assets'];assert len(assets)==9 and {a['name'] for a in assets}==names
destination=root/'release-download';destination.mkdir(exist_ok=True)
def digest(path):
    h=hashlib.sha256()
    with path.open('rb') as stream:
        for part in iter(lambda:stream.read(1024*1024),b''):h.update(part)
    return h.hexdigest()
def download(asset):
    target=destination/asset['name'];assert asset['size']>0
    assert '/releases/download/'+tag+'/' in asset['browser_download_url']
    if not target.exists() or target.stat().st_size!=asset['size']:
        partial=target.with_name(target.name+'.partial')
        request=urllib.request.Request(asset['browser_download_url'],headers={'User-Agent':'omp-local-goal-review'})
        print('Downloading '+asset['name']+' ('+str(asset['size'])+' bytes)',flush=True)
        with opener.open(request,timeout=120) as response,partial.open('wb') as stream:
            for part in iter(lambda:response.read(1024*1024),b''):stream.write(part)
        assert partial.stat().st_size==asset['size'];partial.replace(target)
    value=digest(target)
    if asset.get('digest'):assert asset['digest']=='sha256:'+value
    print('Verified '+asset['name']+' sha256 '+value,flush=True)
    return {'name':asset['name'],'bytes':target.stat().st_size,'sha256':value,'url':asset['browser_download_url']}
with ThreadPoolExecutor(max_workers=2) as pool:downloaded=list(pool.map(download,assets))
hashes={x['name']:x['sha256'] for x in downloaded};sums={}
for line in (destination/'SHA256SUMS.txt').read_text().splitlines():
    match=re.fullmatch(r'([0-9a-f]{64})  (.+)',line);assert match and match[2] not in sums;sums[match[2]]=match[1]
assert set(sums)==payload and all(hashes[name]==value for name,value in sums.items())
record=json.loads((destination/'BUILD-RECORD.json').read_text())
assert record['tag']==tag and record['revision']==sha and record['version']==version
assert record['run']['url']==run['html_url']
manifest=json.loads((repo/'app/patches/oh-my-pi/manifest.json').read_text())
for field,value in {'forkCommit':manifest['fork']['commit'],'forkTree':manifest['fork']['tree'],'baseSha':manifest['base']['sha'],'baseVersion':manifest['base']['version'],'patchLevel':manifest['patchLevel']}.items():
    assert record['pins'][field]==value
platforms=record['platforms'];assert len(platforms)==3
assert {(p['platform'],p['arch']) for p in platforms}=={('darwin','arm64'),('win32','x64'),('linux','x64')}
assert {a['name'] for p in platforms for a in p['assets']}==payload
by_name={x['name']:x for x in downloaded}
for platform in platforms:
    assert str(platform['run']['id'])==str(run_id) and platform['run']['url']==run['html_url']
    acceptance=platform['packagedRuntime']['acceptance']
    assert acceptance['protocolVersion']==2 and acceptance['getState'] and acceptance['gateLoadControl']=='refused'
    assert acceptance['leftoverRuns']==0 and all(acceptance['stop'][key] for key in ['stopped','reaped','cleaned'])
    counts=platform['planGoalRegression'];assert counts['pass']==15 and counts['fail']==counts['skipped']==0
    provenance=platform['packagedRuntime']['provenance']
    assert provenance['forkCommit']==manifest['fork']['commit'] and provenance['patchLevel']==manifest['patchLevel']
    assert provenance['platform']==platform['platform'] and provenance['arch']==platform['arch']
    assert provenance['ompVersion']==manifest['base']['version'] and provenance['desktopVersion']==version
    for asset in platform['assets']:
        assert asset['sha256']==by_name[asset['name']]['sha256'] and asset['bytes']==by_name[asset['name']]['bytes']
result={'verified':True,'observedAt':datetime.now(timezone.utc).isoformat(),'candidate':sha,'tag':tag,'runId':run_id,
        'runUrl':run['html_url'],'releaseUrl':release['html_url'],'assets':downloaded,
        'platforms':[{'platform':p['platform'],'arch':p['arch'],'counts':p['planGoalRegression']} for p in platforms],
        'scope':'Actual native M5 test-package release. Records checked against source/CI and every public asset downloaded/hash checked; installed Electron workflows/M6/M7 remain.'}
(root/'release-audit.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
print(json.dumps(result,ensure_ascii=False,indent=2),flush=True)
