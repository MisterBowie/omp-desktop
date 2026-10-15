import assert from 'node:assert/strict';
import {setImmediate as nextTask} from 'node:timers/promises';
import {test} from 'node:test';
import {reloadAndSelect} from '../../../scripts/e2e/installed-workflow.mjs';

function rendererFixture(mode) {
  let loaded=false;const listeners=new Set();const actions=[];
  return {actions,listeners,renderer:{
    on(event,handler) {assert.equal(event,'Page.loadEventFired');listeners.add(handler);return()=>listeners.delete(handler);},
    async send(method) {
      assert.equal(method,'Page.reload');
      if(mode==='failure')throw new Error('reload refused');
      const load=()=>{loaded=true;for(const handler of [...listeners])handler({});};
      if(mode==='synchronous')load();else setImmediate(load);
      return {};
    },
    async evaluate(expression) {
      if(expression.includes('.app-shell'))return true; // The old document is ready too.
      if(expression.includes('const row =')){actions.push({loaded});return true;}
      if(expression.includes('document.body.innerText'))return {activeSessionId:'session-1'};
      throw new Error('Unexpected DOM observation');
    },
  }};
}
test('reload waits for the new document before acting on a still-ready old DOM',async()=>{
  const f=rendererFixture('asynchronous');await reloadAndSelect({renderer:f.renderer},'session-1');await nextTask();
  assert.equal(f.actions.length,1);assert.equal(f.actions[0].loaded,true,'sidebar click ran before the new document loaded');assert.equal(f.listeners.size,0);
});
test('a load event arriving before the reload reply is retained',async()=>{
  const f=rendererFixture('synchronous');await reloadAndSelect({renderer:f.renderer},'session-1');assert.deepEqual(f.actions,[{loaded:true}]);assert.equal(f.listeners.size,0);
});
test('reload transport failure propagates and releases navigation listeners',async()=>{
  const f=rendererFixture('failure');await assert.rejects(reloadAndSelect({renderer:f.renderer},'session-1'),/reload refused/);assert.equal(f.actions.length,0);assert.equal(f.listeners.size,0);
});
