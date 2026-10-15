"""Repair only ranges already reported terminal; active downloader never revisits them."""
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
import json,re,time,urllib.request,hashlib
r=Path(__file__).resolve().parent;release=json.loads((r/'release-public-metadata.json').read_text());by={a['name']:a for a in release['assets']};failures=json.loads((r/'range-download-failures.json').read_text());tasks=[]
for failure in failures:
 m=re.fullmatch(r'Range ([A-Za-z0-9._-]+) (\d+)-(\d+) failed: [A-Za-z]+',failure);assert m
 name,start,end=m[1],int(m[2]),int(m[3]);assert name in by
 tasks.append((by[name],start,end))
def get(task):
 a,start,end=task;part=r/'release-ranges'/a['name']/str(start);temporary=part.with_suffix('.receiving');size=end-start+1
 if part.exists() and part.stat().st_size==size:return a['name']+':'+str(start)
 for attempt in range(6):
  try:
   received=temporary.stat().st_size if temporary.exists() else 0;assert received<=size
   if received<size:
    op=urllib.request.build_opener(urllib.request.ProxyHandler({'https':'http://127.0.0.1:7897'}));offset=start+received
    with op.open(urllib.request.Request(a['browser_download_url'],headers={'User-Agent':'omp-local-release-audit','Range':f'bytes={offset}-{end}'}),timeout=50) as s,temporary.open('ab') as stream:
     assert s.status==206 and s.headers.get('Content-Range')==f'bytes {offset}-{end}/{a["size"]}'
     remaining=size-received
     while remaining:
      data=s.read(min(1024*1024,remaining));assert data;stream.write(data);remaining-=len(data)
     assert not s.read(1)
   assert temporary.stat().st_size==size;temporary.replace(part);return a['name']+':'+str(start)
  except Exception as e:
   if attempt==5:raise RuntimeError(f'{a["name"]}:{start}: {type(e).__name__}') from None
   time.sleep(min(2**attempt,10))
for name in ThreadPoolExecutor(max_workers=2).map(get,tasks):print('Repaired '+name,flush=True)
a=next(a for a in release['assets'] if a['name'].endswith('macos-arm64.dmg'));out=r/'public-macos-input';out.mkdir(exist_ok=True);target=out/a['name'];h=hashlib.sha256()
with target.open('wb') as dest:
 for start in range(0,a['size'],8*1024*1024):
  part=r/'release-ranges'/a['name']/str(start)
  assert part.stat().st_size==min(8*1024*1024,a['size']-start)
  with part.open('rb') as src:
   for data in iter(lambda:src.read(1024*1024),b''):dest.write(data);h.update(data)
assert target.stat().st_size==a['size'] and 'sha256:'+h.hexdigest()==a['digest']
print('Public Mac DMG assembled and GitHub digest verified: '+h.hexdigest(),flush=True)
