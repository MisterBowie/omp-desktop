#!/usr/bin/env python3
from pathlib import Path
import hashlib,json,plistlib,subprocess
root=Path(__file__).resolve().parent
audit=json.loads((root/'release-audit.json').read_text());assert audit['verified']
asset=next(x for x in audit['assets'] if x['name'].endswith('macos-arm64.zip'))
archive=root/'release-download'/asset['name']
h=hashlib.sha256()
with archive.open('rb') as stream:
 for data in iter(lambda:stream.read(1024*1024),b''):h.update(data)
assert h.hexdigest()==asset['sha256']
target=root/'macos-install-copy'/'Applications 中文 with spaces'
assert not target.exists(),'Never overwrite an existing application copy'
target.mkdir(parents=True)
subprocess.run(['/usr/bin/ditto','-xk',str(archive),str(target)],check=True)
app=target/'OMP Desktop.app'
info=plistlib.loads((app/'Contents/Info.plist').read_bytes())
assert info['CFBundleIdentifier']=='net.misterbowie.omp-desktop'
assert info['CFBundleDisplayName']=='OMP Desktop'
binary=app/'Contents/MacOS'/info['CFBundleExecutable']
arch=subprocess.check_output(['/usr/bin/lipo','-archs',str(binary)],text=True).strip();assert arch=='arm64'
resources=app/'Contents/Resources'
result={'app':str(app),'resources':str(resources),'sourceArchive':asset,'bundleId':info['CFBundleIdentifier'],
        'displayName':info['CFBundleDisplayName'],'executable':str(binary),'arch':arch,
        'appUpdate':(resources/'app-update.yml').read_text(),
        'scope':'Actual hash-verified Mac ZIP extracted to owned non-ASCII/spaced install-copy path; no Electron user workflow claimed.'}
(root/'macos-download-inventory.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
print(json.dumps(result,ensure_ascii=False,indent=2))
