import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
const repo='/Users/vv/Documents/对话/omp-desktop-review-m5-r4b';
register(pathToFileURL(repo+'/app/apps/desktop/test/helpers/ts-import-hooks.mjs'));
const { OmpSessionRunner }=await import(pathToFileURL(repo+'/app/packages/omp-runtime/src/session/runner.ts'));
const { encodeStartRefusal,OMP_START_REFUSAL_KIND,OMP_START_REFUSAL_VERSION }=await import(pathToFileURL(repo+'/app/packages/omp-runtime/src/session/start-refusal.ts'));
const { OMP_TURN_COMMAND,turnCommandToken,encodeTurnAck }=await import(pathToFileURL(repo+'/app/packages/omp-runtime/src/session/turn-fence.ts'));
const report={desktopCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim(),layer:'production runner/codec with scripted formal RPC frames; no runtime process/provider',results:[]};
function fixture({delayedDiscovery=false,serialized=false,abortEmitsEnd=true,finishRealPrompt=false}={}){
 const handlers=new Set(),failures=new Set(),ends=[],events=[],tokens=[],requests=[];
 let releaseDiscovery;
 const commands={success:true,data:{commands:[{name:OMP_TURN_COMMAND,source:'extension',description:'desktop turn boundary'}]}};
 const discovery=delayedDiscovery?new Promise(resolve=>{releaseDiscovery=()=>resolve(commands);}):Promise.resolve(commands);
 const send=frame=>{for(const handler of handlers)handler(frame);};
 const respond=async command=>{
  if(command.type==='get_available_commands')return discovery;
  if(command.type==='abort'){if(abortEmitsEnd)send({type:'agent_end',messages:[]});return{success:true};}
  if(command.type==='get_state')return{success:true,data:{isStreaming:false}};
  if(command.type==='prompt'){
   const token=turnCommandToken(command.message);
   if(token){tokens.push(token);send({type:'extension_ui_request',id:'review-ack-'+tokens.length,method:'notify',notifyType:'info',message:encodeTurnAck(token)});}
   else if(finishRealPrompt){setTimeout(()=>{send({type:'agent_start'});send({type:'agent_end',messages:[]});},0);}
  }
  return{success:true};
 };
 let tail=Promise.resolve();
 const runtime={pid:1234,usable:true,write:()=>true,onFrame:handler=>{handlers.add(handler);return()=>handlers.delete(handler);},onFailure:handler=>{failures.add(handler);return()=>failures.delete(handler);},request:command=>{
  requests.push(command);
  if(!serialized)return respond(command);
  const pending=tail.then(()=>respond(command));
  tail=pending.then(()=>undefined,()=>undefined);
  return pending;
 }};
 const runner=new OmpSessionRunner({sessionId:'desktop-parent',runtime,nativeSessionIdentity:()=> 'native-parent',turnFenceTimeoutMs:500,emit:e=>events.push(e),onTurnEnd:e=>ends.push(e)});
 const refusal=(token,id,{native='native-parent'}={})=>({type:'extension_ui_request',id,method:'notify',notifyType:'error',message:encodeStartRefusal({v:OMP_START_REFUSAL_VERSION,kind:OMP_START_REFUSAL_KIND,sessionId:native,turnToken:token,code:'state-invalid',reason:'review start refusal',refusalId:id,at:100})});
 return{runner,send,refusal,ends,events,tokens,requests,releaseDiscovery};
}
{
 const f=fixture();
 const row={case:'old-and-unseen-refusal-during-next-awaiting-start'};
 try{
  row.first=await f.runner.prompt('first user turn');
  const old=f.refusal(f.tokens[0],'first-refusal');
  f.send(old);
  row.firstState=f.runner.runState();row.firstEnds=[...f.ends];
  assert.equal(row.firstState,'idle','positive control: genuine first refusal closes first generation');
  assert.equal(row.firstEnds.length,1);
  row.second=await f.runner.prompt('second user turn');
  assert.equal(f.runner.runState(),'running','positive control: next turn is awaiting agent_start');
  f.send(old);row.afterExactReplay=f.runner.runState();
  f.send(f.refusal(f.tokens[0],'unseen-delayed-old-refusal'));row.afterUnseenOld=f.runner.runState();
  f.send(f.refusal(f.tokens[1],'foreign-refusal',{native:'foreign-child'}));row.afterForeign=f.runner.runState();
  row.endsBeforeGenuineNew=[...f.ends];
  f.send(f.refusal(f.tokens[1],'genuine-new-refusal'));row.afterGenuineNew=f.runner.runState();row.ends=[...f.ends];
  row.passed=row.afterExactReplay==='running'&&row.afterUnseenOld==='running'&&row.afterForeign==='running'&&row.endsBeforeGenuineNew.length===1&&row.afterGenuineNew==='idle'&&row.ends.length===2;
  row.diagnostics=f.runner.diagnostics();
 }catch(error){row.controlError=String(error.message);row.passed=false;}
 finally{f.runner.dispose('generation review complete');}
 report.results.push(row);
}
{
 const f=fixture({delayedDiscovery:true,serialized:true,abortEmitsEnd:false,finishRealPrompt:true});
 const row={case:'stop-during-delayed-command-discovery',transportOrdering:'ordinary RPC commands serialized as fixed OMP RpcInputDispatcher; abort before agent_start emits no agent_end'};
 const pending=f.runner.prompt('user turn stopped before real dispatch').then(value=>({value}),error=>({error:String(error.message)}));
 try{
  await Promise.resolve();
  assert(f.requests.some(r=>r.type==='get_available_commands'),'positive control: fence discovery is in flight');
  const stopping=f.runner.stop();
  row.stateAtStopRequest=f.runner.runState();
  row.realPromptsAtStopRequest=f.requests.filter(r=>r.type==='prompt'&&!turnCommandToken(r.message)).length;
  f.releaseDiscovery();
  [row.promptOutcome,row.stop]=await Promise.all([pending,stopping]);
  row.realPromptsAfterStopRequest=f.requests.filter(r=>r.type==='prompt'&&!turnCommandToken(r.message)).length;
  row.commandsAfterStopRequest=f.requests.filter(r=>r.type==='prompt').map(r=>({control:!!turnCommandToken(r.message),message:turnCommandToken(r.message)?'[turn binding token]':r.message}));
  row.stateAtEnd=f.runner.runState();row.ends=[...f.ends];
  row.passed=row.stop.converged&&row.stateAtStopRequest==='stopping'&&row.realPromptsAtStopRequest===0&&row.realPromptsAfterStopRequest===0&&!!row.promptOutcome.error;
 }catch(error){row.controlError=String(error.message);row.passed=false;f.releaseDiscovery?.();await pending;}
 finally{f.runner.dispose('stop review complete');}
 report.results.push(row);
}
report.passed=report.results.every(row=>row.passed);
writeFileSync('/Users/vv/Documents/对话/omp-t20-b1-review-20261002/start-refusal-generation-'+report.desktopCommit.slice(0,8)+'.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
process.exitCode=report.passed?0:1;
