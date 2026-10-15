#!/usr/bin/env python3
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor,as_completed
import hashlib,json,os,time,urllib.request,urllib.error
root=Path(__file__).resolve().parent
meta=json.loads((root/'m7-native-dispatch.json').read_text());assert meta['runStatus']=='completed' and meta['runConclusion']=='success'
tag=meta['tag'];out=root/'release-download';out.mkdir(exist_ok=True)
parts=root/'release-ranges';parts.mkdir(exist_ok=True)
proxy={'https':'http://127.0.0.1:7897'}
def opener():return urllib.request.build_opener(urllib.request.ProxyHandler(proxy))
req=urllib.request.Request('https://api.github.com/repos/MisterBowie/omp-desktop/releases/tags/'+tag,headers={'User-Agent':'omp-local-release-audit','Accept':'application/vnd.github+json'})
with opener().open(req,timeout=40) as response:release=json.load(response)
assert release['tag_name']==tag and release['prerelease'] and not release['draft']
assert len(release['assets'])==15
prefix='OMP-Desktop-0.15.3-m7.1-'+tag+'-'
suffixes=['macos-arm64.dmg','macos-arm64.zip','windows-x64-setup.exe','windows-x64-portable.exe','linux-x64.AppImage','linux-x64.deb','linux-x64.rpm','darwin-arm64-validation.json.gz','win32-x64-validation.json.gz','linux-x64-validation.json.gz','darwin-arm64-maintenance.json.gz','win32-x64-maintenance.json.gz','linux-x64-maintenance.json.gz']
assert {a['name'] for a in release['assets']}=={prefix+s for s in suffixes}|{'BUILD-RECORD.json','SHA256SUMS.txt'}
for asset in release['assets']:
 assert asset['browser_download_url']=='https://github.com/MisterBowie/omp-desktop/releases/download/'+tag+'/'+asset['name']
 assert type(asset['size']) is int and 0<asset['size']<=1024*1024*1024

(root/'release-public-metadata.json').write_text(json.dumps(release,ensure_ascii=False,indent=2)+'\n')
chunk=8*1024*1024;tasks=[];assets=release['assets'];started=time.monotonic()
def sha(path):
 h=hashlib.sha256()
 with path.open('rb') as f:
  for b in iter(lambda:f.read(1024*1024),b''):h.update(b)
 return h.hexdigest()
for a in assets:
 assert a['digest'].startswith('sha256:') and '/releases/download/'+tag+'/' in a['browser_download_url']
 target=out/a['name']
 if target.exists() and target.stat().st_size==a['size'] and 'sha256:'+sha(target)==a['digest']:
  print('Already verified '+a['name'],flush=True);continue
 d=parts/a['name'];d.mkdir(exist_ok=True)
 # Reuse complete ranges already received by the owned sequential downloader.
 previous=target.with_name(target.name+'.partial')
 for start in range(0,a['size'],chunk):
  end=min(start+chunk,a['size'])-1;part=d/str(start)
  if not part.exists() and previous.exists() and previous.stat().st_size>=end+1:
   with previous.open('rb') as src,part.open('wb') as dest:
    src.seek(start);dest.write(src.read(end-start+1))
  if part.exists() and part.stat().st_size==end-start+1:continue
  tasks.append((a,start,end,part))
tasks.sort(key=lambda task: (0 if task[0]['name'].endswith('macos-arm64.dmg') else 1, task[0]['name'], task[1]))
print('Missing ranges '+str(len(tasks))+'; 16 bounded connections; complete received ranges retained.',flush=True)
def get(task):
 a,start,end,part=task;size=end-start+1
 for attempt in range(6):
  try:
   temporary=part.with_suffix('.receiving')
   received=temporary.stat().st_size if temporary.exists() else 0
   assert received<=size
   if received==size:
    temporary.replace(part);return 0
   offset=start+received
   request=urllib.request.Request(a['browser_download_url'],headers={'User-Agent':'omp-local-release-audit','Range':f'bytes={offset}-{end}'})
   with opener().open(request,timeout=120) as response,temporary.open('ab') as stream:
    assert response.status==206 and response.headers.get('Content-Range')==f'bytes {offset}-{end}/{a["size"]}'
    remaining=size-received
    while remaining:
     data=response.read(min(1024*1024,remaining));assert data,'truncated range'
     stream.write(data);remaining-=len(data)
    assert not response.read(1),'range exceeded declared size'
   assert temporary.stat().st_size==size;temporary.replace(part)
   return size
  except Exception as error:
   if attempt==5:raise RuntimeError(f'Range {a["name"]} {start}-{end} failed: {type(error).__name__}') from None
   time.sleep(min(2**attempt,15))
completed=0;received=0;failures=[]
with ThreadPoolExecutor(max_workers=16) as pool:
 for f in as_completed([pool.submit(get,t) for t in tasks]):
  try:received+=f.result()
  except Exception as error:
   failures.append(str(error));print(str(error),flush=True)
   (root/'range-download-failures.json').write_text(json.dumps(failures,indent=2)+'\n')
  completed+=1
  (root/'range-download-progress.json').write_text(json.dumps({'completedRanges':completed,'totalRanges':len(tasks),'newBytes':received,'seconds':round(time.monotonic()-started,1)})+'\n')
  if completed%8==0 or completed==len(tasks):print(f'Ranges {completed}/{len(tasks)}, new {received/1e6:.1f} MB in {time.monotonic()-started:.1f}s',flush=True)
if failures:raise SystemExit('Some ranges remain unavailable; complete data retained for resume.')
for a in assets:
 target=out/a['name']
 if target.exists() and target.stat().st_size==a['size'] and 'sha256:'+sha(target)==a['digest']:continue
 assembled=target.with_name(target.name+'.assembled')
 with assembled.open('wb') as dest:
  for start in range(0,a['size'],chunk):
   with (parts/a['name']/str(start)).open('rb') as src:
    for data in iter(lambda:src.read(1024*1024),b''):dest.write(data)
 assert assembled.stat().st_size==a['size'] and 'sha256:'+sha(assembled)==a['digest'],a['name']+' digest mismatch'
 assembled.replace(target);print('Verified '+a['name'],flush=True)
print('All fifteen assets received and GitHub digest-verified; run full source/CI/record/checksum audit next.',flush=True)
