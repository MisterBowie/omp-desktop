import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {InstalledApplication} from '/Users/vv/Documents/对话/omp-desktop-local-m7/app/scripts/e2e/installed-application.mjs';
import {exerciseInstalledWorkflow,invoke,inspect} from '/Users/vv/Documents/对话/omp-desktop-local-m7/app/scripts/e2e/installed-workflow.mjs';
import {FakeProvider} from '/Users/vv/Documents/对话/omp-desktop-local-m7/app/experiments/omp-bridge/lib/provider.mjs';
const navigation=[];const out=process.argv[2];mkdirSync(out,{recursive:true});const snapshots=[];
const write=(name,value)=>writeFileSync(join(out,name),JSON.stringify(value,null,2)+'\n');
const start=InstalledApplication.prototype.start;
InstalledApplication.prototype.start=async function(...args){
 await start.apply(this,args);
 for(const event of ['Page.frameNavigated','Page.loadEventFired','Runtime.executionContextsCleared','Runtime.consoleAPICalled'])this.renderer.on(event,p=>{navigation.push({at:Date.now(),event,params:p});});
 const send=this.renderer.send.bind(this.renderer);this.renderer.send=async(method,...args)=>{if(method==='Page.reload')navigation.push({at:Date.now(),event:'reload-request'});const value=await send(method,...args);if(method==='Page.reload')navigation.push({at:Date.now(),event:'reload-reply'});return value;};
 const evaluate=this.renderer.evaluate.bind(this.renderer);
 this.renderer.evaluate=async expression=>{const kind=expression.includes('input.focus')?'prompt':expression.includes('data-sidebar-session-row')&&!expression.includes('innerText')?'sidebar':expression.includes('innerText')?'inspect':null;
  const wrapped=kind?`(() => { console.debug('OMP_RELOAD_OBSERVATION', ${JSON.stringify(kind)}, performance.timeOrigin, document.readyState); return (${expression}); })()`:expression;
  const value=await evaluate(wrapped);
  if(expression.includes('agentGetStatus')||expression.includes('document.body.innerText')){
   snapshots.push({at:new Date().toISOString(),kind:expression.includes('agentGetStatus')?'status':'ui',value});if(snapshots.length>80)snapshots.shift();
  }return value;};
};
const providerStart=FakeProvider.start;
FakeProvider.start=async function(...args){const p=await providerStart.apply(this,args);const close=p.close.bind(p);p.close=async()=>{write('provider-traffic.json',p.requests);return close();};return p;};
const report={sourceRevision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),diagnosticOnly:true};let app,error;
try{
 app=InstalledApplication.prepare('/Users/vv/Documents/对话/omp-local-m7-review-20261015/public-macos-input/OMP-Desktop-0.15.3-m7.1-m7-test-20261015-46e7bf7-macos-arm64.dmg',out);await app.start();report.workflow=await exerciseInstalledWorkflow(app);await app.quit();report.bootAndOrderedQuit=true;
}catch(e){error=e;report.failure=e.stack;
 try{const facts=JSON.parse(readFileSync(join(out,'workflow-facts.json')));report.lastStatus=await invoke(app,'agentGetStatus',[facts.sessionId]);report.lastSession=await invoke(app,'sessionGet',[facts.sessionId]);report.lastUi=await inspect(app);report.composer=await app.renderer.evaluate(`(() => {const i=document.querySelector('.composer-input');return {text:i?.textContent,html:i?.innerHTML,editable:i?.getAttribute('contenteditable'),send:document.querySelector('.composer-shell .send-btn')?.outerHTML,stop:document.querySelector('.composer-shell .stop-btn')?.outerHTML};})()`);await app.screenshot('failure');}catch(e){report.captureFailure=String(e);}
}finally{if(app){try{await app.cleanup();report.cleaned=true;}catch(e){error??=e;report.cleanupFailure=String(e);}report.processReports=app.reports;report.launches=app.launches;writeFileSync(join(out,'application-output.txt'),app.output);if(app.clean)app.removeOwnedRoot();}write('navigation-trace.json',navigation);write('last-observations.json',snapshots);write('diagnostic-report.json',report);}
if(error)throw error;console.log('Same workflow passed with observation-only diagnostics.');
