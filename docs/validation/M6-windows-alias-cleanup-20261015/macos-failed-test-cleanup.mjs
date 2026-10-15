import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {InstalledApplication} from '/Users/vv/Documents/对话/omp-desktop-local-m6/app/scripts/e2e/installed-application.mjs';
const out='/Users/vv/Documents/对话/omp-local-m6-review-20261015/macos-failed-test-cleanup';
const app=InstalledApplication.prepare('/Users/vv/Documents/对话/omp-desktop-local-m6/app/apps/desktop/release/OMP-Desktop-0.15.2-arm64.dmg',out);
try{await app.start();}finally{await app.cleanup();if(app.clean)app.removeOwnedRoot();writeFileSync(out+'/cleanup.json',JSON.stringify({reports:app.reports,clean:app.clean,launches:app.launches},null,2)+'\n');}
assert.equal(app.clean,true);assert.equal(app.reports.filter(x=>x.label==='ordered-quit').length,1);assert(!app.reports.some(x=>/cleanup-SIG/.test(x.label)));console.log('Assertion-failure cleanup used ordered application quit; zero survivors and no emergency signals.');
