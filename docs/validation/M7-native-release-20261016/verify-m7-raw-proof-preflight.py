from pathlib import Path
from datetime import datetime
import json,hashlib,re
root=Path(__file__).resolve().parent
repo=Path('/Users/vv/Documents/对话/omp-desktop-local-m7')
meta=json.loads((root/'m7-native-dispatch.json').read_text())
sha=meta['candidate'];destination=root/'proof-preflight'
record=json.loads((destination/'BUILD-RECORD.json').read_text())
assert record['revision']==sha and record['tag']==meta['tag']
version=json.loads((repo/'app/apps/desktop/package.json').read_text())['version']
assert record['version']==version
platforms=record['platforms'];assert len(platforms)==3
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

(root/'m7-raw-proof-preflight.json').write_text(json.dumps({'verified':True,'scope':'Raw public proof preflight only; full installer byte audit remains required','installed':installed,'maintenance':maintenance},indent=2)+'\n')
print('All three public installed and maintenance proofs independently re-read; full asset audit still required.')
