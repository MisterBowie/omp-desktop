import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {InstalledApplication,until} from '/Users/vv/Documents/对话/omp-desktop-local-m7/app/scripts/e2e/installed-application.mjs';
import {invoke,prompt,inspect} from '/Users/vv/Documents/对话/omp-desktop-local-m7/app/scripts/e2e/installed-workflow.mjs';
import {FakeProvider} from '/Users/vv/Documents/对话/omp-desktop-local-m7/app/experiments/omp-bridge/lib/provider.mjs';
const out='/Users/vv/Documents/对话/omp-local-m7-review-20261015/visibility-control-ready';mkdirSync(out,{recursive:true});const report={negativeControl:true};let app,provider,error;
const windowAction=action=>app.main.evaluate(`(()=>{const {BrowserWindow}=process.getBuiltinModule('module').createRequire(process.resourcesPath+'/app.asar/package.json')('electron');const w=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('app.asar/out/renderer/index.html')&&!w.webContents.getURL().includes('surface='));if(!w)throw new Error('Owned window missing');${action};return {visible:w.isVisible(),focused:w.isFocused()};})()`);
const visibility=()=>app.renderer.evaluate('({hidden:document.hidden,state:document.visibilityState,focus:document.hasFocus(),raf:globalThis.__visRafCount})');
try{
 app=InstalledApplication.prepare('/Users/vv/Documents/对话/omp-local-m7-review-20261015/public-macos-input/OMP-Desktop-0.15.3-m7.1-m7-test-20261015-46e7bf7-macos-arm64.dmg',out);await app.start();report.identity=app.identity;
 provider=await FakeProvider.start();provider.script([{text:'VISIBILITY_CONTROL_REPLY',finish:'stop',delayMs:1000}]);
 await invoke(app,'projectSet',[app.workspace]);const p=await invoke(app,'providersCreate',[{name:'Visibility fixture',vendorKey:'custom',type:'openai_compatible',protocol:'openai_compatible',baseUrl:provider.baseUrl,authKind:'api_key_and_base_url',defaultModelId:'local-model',secretValue:'fixture-key',apiStyle:'chat_completions'}]);
 const created=await invoke(app,'sessionCreate',[{title:'Visibility control',mode:'agent',engine:'omp',projectPath:app.workspace,providerId:p.provider.id,modelId:'local-model'}]);const id=created.session.id;
 await app.renderer.evaluate('window.__PI_DESKTOP__.refreshProviders()');await app.renderer.evaluate(`window.__PI_DESKTOP__.selectSession(${JSON.stringify(id)})`);report.initialWindow=await windowAction('w.show();w.focus()');report.initialVisibility=await visibility();
 await prompt(app,'VISIBILITY_CONTROL Ask for the fixed reply.');
 report.hiddenWindow=await windowAction('w.hide()');await app.renderer.evaluate('globalThis.__visRafCount=0;requestAnimationFrame(()=>{globalThis.__visRafCount++})');
 await until(async()=>{const s=await invoke(app,'agentGetStatus',[id]);const d=await invoke(app,'sessionGet',[id]);report.nativeSession=d.session;return !s.status.isRunning&&d.session.messages.some(m=>m.content==='VISIBILITY_CONTROL_REPLY');},'native completion while hidden');
 report.before={visibility:await visibility(),ui:await inspect(app),requests:provider.requests.length};
 report.shownWindow=await windowAction('w.show();w.focus()');await until(async()=>{const ui=await inspect(app);return !ui.stop&&ui.text.includes('VISIBILITY_CONTROL_REPLY');},'visible UI reaches already-completed reply');
 report.after={visibility:await visibility(),ui:await inspect(app),requests:provider.requests.length};assert.equal(report.after.requests,report.before.requests);await app.screenshot('visible-completed');await app.quit();report.passed=true;
}catch(e){error=e;report.failure=e.stack;}
finally{if(provider)await provider.close();if(app){try{await app.cleanup();report.cleaned=true;}catch(e){error??=e;report.cleanupFailure=String(e);}report.processReports=app.reports;writeFileSync(join(out,'application-output.txt'),app.output);if(app.clean)app.removeOwnedRoot();}writeFileSync(join(out,'report.json'),JSON.stringify(report,null,2)+'\n');}
if(error)throw error;console.log('Native completion, hidden DOM and restored foreground compared without model replay.');
