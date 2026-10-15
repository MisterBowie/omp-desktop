#!/usr/bin/env python3
"""Audit the exact completed native release using public reads from this Mac."""
from pathlib import Path
from datetime import datetime,timezone
from concurrent.futures import ThreadPoolExecutor
import hashlib,json,re,subprocess,urllib.request,urllib.error

root=Path(__file__).resolve().parent
meta=json.loads((root/'m7-native-dispatch.json').read_text())
assert meta['pushed'] and meta.get('runId')
repo=Path('/Users/vv/Documents/对话/omp-desktop-local-m7')
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
assert {j['name'] for j in jobs}=={'Bind the run to the reviewed tag','Package macOS arm64','Package Windows x64','Package Linux x64','Publish the test prerelease','Native environment macos-15','Native environment windows-latest','Native environment ubuntu-22.04'}
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
payload|={prefix+s for s in ['darwin-arm64-validation.json.gz','win32-x64-validation.json.gz','linux-x64-validation.json.gz','darwin-arm64-maintenance.json.gz','win32-x64-maintenance.json.gz','linux-x64-maintenance.json.gz']}
names=payload|{'BUILD-RECORD.json','SHA256SUMS.txt'}
assets=release['assets'];assert len(assets)==15 and {a['name'] for a in assets}==names
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
# Re-open each public raw installed proof independently of the release summary.
import gzip,base64,io
installed=[]
for platform in platforms:
    proof=[a for a in platform['assets'] if a['kind']=='validation'];assert len(proof)==1
    compressed=(destination/proof[0]['name']).read_bytes();assert len(compressed)<=8*1024*1024
    raw=gzip.GzipFile(fileobj=io.BytesIO(compressed)).read(32*1024*1024+1);assert len(raw)<=32*1024*1024
    bundle=json.loads(raw);assert bundle['schema']=='omp-desktop.installed-evidence/1'
    report=bundle['report'];assert report['sourceRevision']==sha
    assert report['platform']==platform['platform'] and report['arch']==platform['arch']
    assert report['cleaned'] and report['bootAndOrderedQuit'] and not report.get('failure') and not report.get('cleanupFailure')
    steps=['project','deny','allowOnce','projectTest','stopTree','recoveryNoReplay','freshTurn','defaultIsolation']
    assert all(report['workflow']['steps'][key] is True for key in steps)
    assert len(report['launches'])==2
    quits=[x for x in report['processReports'] if x['label']=='ordered-quit']
    assert len(quits)==2 and all(x['noOwnedProcessesRemain'] for x in quits)
    assert report['processReports'][-1]['processes']==[]
    for i,event in enumerate(report['processReports']):
        if event['label']=='ordered-quit':assert i>0 and report['processReports'][i-1]['label']=='wait-exit' and report['processReports'][i-1]['processes']==[]
    files=bundle['files'];assert set(files)=={'01-installed-ready.png','02-deny-pending.png','03-approved-write.png','04-long-tool-before-stop.png','05-stopped.png','06-recovered-history.png','07-post-restart-turn.png','native-before-quit.jsonl','native-after-quit.jsonl','native-after-restart.jsonl','application-output.txt'}
    for name,file in files.items():
        value=base64.b64decode(file['base64'],validate=True)
        assert len(value)==file['bytes'] and hashlib.sha256(value).hexdigest()==file['sha256']
        if name.endswith('.png'):assert value[:8]==bytes([137,80,78,71,13,10,26,10])
    before=base64.b64decode(files['native-before-quit.jsonl']['base64'])
    closed=base64.b64decode(files['native-after-quit.jsonl']['base64'])
    resumed=base64.b64decode(files['native-after-restart.jsonl']['base64'])
    assert closed.startswith(before) and resumed==closed
    nativeInstaller=next(a for a in platform['assets'] if a['kind'] in ['dmg','nsis-setup','appimage'])
    assert report['installer']['sha256']==nativeInstaller['sha256'] and report['installer']['bytes']==nativeInstaller['bytes']
    assert report['payload']['licenses']['originalFiles']>0 and report['payload']['licenses']['rustComponents']>0
    installed.append({'platform':platform['platform'],'arch':platform['arch'],'steps':steps,'quits':len(quits),'remainingOwnedProcesses':0,'historyBytes':len(closed),'proof':proof[0]['name']})
# Independent reading of native maintenance bundles, in addition to production gates.
maintenance=[]
baseline=json.loads((repo/'app/scripts/e2e/fixtures/m6-upgrade-baseline.json').read_text())
for platform in platforms:
    proof=next(a for a in platform['assets'] if a['kind']=='maintenance')
    compressed=(destination/proof['name']).read_bytes();assert len(compressed)<=16*1024*1024
    raw=gzip.GzipFile(fileobj=io.BytesIO(compressed)).read(96*1024*1024+1);assert len(raw)<=96*1024*1024
    bundle=json.loads(raw);assert bundle['schema']=='omp-desktop.maintenance-evidence/1'
    daily=bundle['daily']['report'];upgrade=bundle['upgrade']['report']
    decoded={}
    for label,proofBody in [('daily',bundle['daily']),('upgrade',bundle['upgrade'])]:
        report=proofBody['report'];assert report['sourceRevision']==sha and report['platform']==platform['platform'] and report['arch']==platform['arch']
        assert report['cleaned'] and report['bootAndOrderedQuit'] and not report.get('failure') and not report.get('cleanupFailure')
        exits=[r for r in report['processReports'] if r['label']=='ordered-quit']
        assert len(exits)==(2 if label=='daily' else 3) and all(r['noOwnedProcessesRemain'] for r in exits)
        assert report['processReports'][-1]['processes']==[]
        for i,event in enumerate(report['processReports']):
            if event['label']=='ordered-quit':assert i>0 and report['processReports'][i-1]['label']=='wait-exit' and report['processReports'][i-1]['processes']==[]
        assert not any(re.match(r'cleanup-(?:SIG|pinned)',r['label']) for r in report['processReports'])
        installer=next(a for a in platform['assets'] if a['kind'] in ['dmg','nsis-setup','appimage'])
        assert report['installer']['sha256']==installer['sha256'] and report['installer']['bytes']==installer['bytes']
        decoded[label]={}
        for name,file in proofBody['files'].items():
            data=base64.b64decode(file['base64'],validate=True)
            assert len(data)==file['bytes'] and hashlib.sha256(data).hexdigest()==file['sha256']
            if name.endswith('.png'):assert data[:8]==bytes([137,80,78,71,13,10,26,10])
            decoded[label][name]=data
    flow=daily['workflow'];assert len(flow['steps'])==6 and all(flow['steps'].values())
    assert flow['longTurns']==40 and len(flow['timings'])==40 and len(flow['resources'])>=4
    assert flow['providerPostsBeforeReopen']==flow['providerPostsAfterReopen']
    assert sum(f['kind']=='connection-destroyed' for f in flow['httpFaults'])==2
    assert sum(f.get('status')==401 for f in flow['httpFaults'])==1
    for project in ['a','b']:
        before=decoded['daily'][f'm7-{project}-before-quit.jsonl'];closed=decoded['daily'][f'm7-{project}-closed.jsonl'];reopened=decoded['daily'][f'm7-{project}-reopened.jsonl']
        assert closed.startswith(before) and closed==reopened
        for phase,data in [('before',before),('closed',closed),('reopened',reopened)]:assert hashlib.sha256(data).hexdigest()==flow['historyRecovery'][project][phase+'Sha256']
    rows=[json.loads(l) for l in decoded['daily']['m7-a-closed.jsonl'].splitlines()]
    rowsB=[json.loads(l) for l in decoded['daily']['m7-b-closed.jsonl'].splitlines()]
    assistants=[r['message'] for r in rows if r.get('message',{}).get('role')=='assistant']
    for i in range(1,41):assert sum(f'M7_LONG_REPLY_{i:02d}' in json.dumps(m.get('content')) for m in assistants)==1
    assert any(m.get('stopReason')=='error' and 'M7_AUTH_TERMINAL' in m.get('errorMessage','') for m in assistants)
    assert any('M7_AFTER_AUTH_RECOVERED' in json.dumps(m.get('content')) for m in assistants)
    def toolspan(rows,name,fragment):
        calls=[(r,c) for r in rows for c in r.get('message',{}).get('content',[]) if isinstance(c,dict) and c.get('type')=='toolCall' and c.get('name')==name and fragment in json.dumps(c.get('arguments'))]
        assert len(calls)==1
        r,c=calls[0];results=[q for q in rows if q.get('message',{}).get('role')=='toolResult' and q['message'].get('toolCallId')==c['id']]
        assert len(results)==1 and not results[0]['message'].get('isError')
        return datetime.fromisoformat(r['timestamp'].replace('Z','+00:00')),datetime.fromisoformat(results[0]['timestamp'].replace('Z','+00:00'))
    a=toolspan(rows,'bash','hold.mjs');b=toolspan(rowsB,'bash','hold.mjs');w=toolspan(rows,'write','background-a.txt')
    assert a[0]<=b[0]<a[1]<=w[0]<=w[1]<=b[1]
    assert len(upgrade['steps'])==7 and all(upgrade['steps'].values())
    pinned=baseline['assets'][platform['platform']]
    for field in ['name','bytes','sha256','arch']:assert upgrade['baseline'][field]==pinned[field]
    assert [l['version'] for l in upgrade['launches']]==[baseline['version'],version,baseline['version']]
    assert upgrade['restore']['verified'] and upgrade['backupManifest']==upgrade['restore']['manifest']
    assert upgrade['projectNoteAfterRollback']=='upgraded\n'
    assert upgrade['noReplay']['baselinePosts']==upgrade['noReplay']['upgradeReadPosts']
    assert upgrade['noReplay']['rollbackPostsBefore']==upgrade['noReplay']['rollbackReadPosts']
    assert upgrade['noReplay']['finalPosts']==upgrade['noReplay']['rollbackReadPosts']+1
    initial=decoded['upgrade']['upgrade-baseline-closed.jsonl']
    assert initial==decoded['upgrade']['upgrade-current-reopened.jsonl']==decoded['upgrade']['upgrade-rollback-reopened.jsonl']
    assert decoded['upgrade']['upgrade-current-closed.jsonl'].startswith(initial)
    maintenance.append({'platform':platform['platform'],'arch':platform['arch'],'dailySteps':6,'upgradeSteps':7,'longTurns':40,'orderedQuits':5,'remainingOwnedProcesses':0,'baseline':pinned['sha256'],'profileBackupEntries':len(upgrade['backupManifest']['profile']),'dataBackupEntries':len(upgrade['backupManifest']['data']),'proof':proof['name']})
result={'verified':True,'observedAt':datetime.now(timezone.utc).isoformat(),'candidate':sha,'tag':tag,'runId':run_id,
        'runUrl':run['html_url'],'releaseUrl':release['html_url'],'assets':downloaded,
        'installedProofs':installed,'maintenanceProofs':maintenance,'platforms':[{'platform':p['platform'],'arch':p['arch'],'counts':p['planGoalRegression']} for p in platforms],
        'scope':'Actual native M7 test-package release: source/CI/pins, all 15 public asset bytes/checksums, installed and daily/upgrade raw proofs independently verified; unsigned test packages.'}
(root/'m7-release-audit.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
print(json.dumps(result,ensure_ascii=False,indent=2),flush=True)
