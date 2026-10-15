/** Rehearse the historical 18.2.7 -> pinned 18.3.0 source upgrade in an owned clone. */
import assert from 'node:assert/strict';
import {execFileSync, spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {loadManifest, validateSource} from '/Users/vv/Documents/对话/omp-desktop-local-m7/app/scripts/omp-patch.mjs';
import {validateForkCheckout} from '/Users/vv/Documents/对话/omp-desktop-local-m7/app/scripts/omp-sidecar.mjs';
const repository='/Users/vv/Documents/对话/omp-desktop-local-m7';
const reference='/Users/vv/Documents/对话/omp-desktop-local-m6/upstream/oh-my-pi';
const history='/Users/vv/Documents/对话/omp-desktop/upstream/oh-my-pi';
const fork='/Users/vv/Documents/对话/omp-runtime-fork';
const review='/Users/vv/Documents/对话/omp-local-m7-review-20261015';
const root=mkdtempSync(join(review,'upstream-rehearsal-'));const source=join(root,'source');
const sha=b=>createHash('sha256').update(b).digest('hex');
const git=(args,cwd=source)=>execFileSync('git',args,{cwd,encoding:'utf8',maxBuffer:16*1024*1024}).trim();
const {manifest,patchPath}=loadManifest(join(repository,'app/patches/oh-my-pi/manifest.json'));
const historical=JSON.parse(git(['show','474408d:app/patches/oh-my-pi/manifest.json'],repository));
const oldPatch=execFileSync('git',['show',`474408d:app/patches/oh-my-pi/${historical.patch.file}`],{cwd:repository,maxBuffer:2*1024*1024});
const oldRecord=manifest.history.find(row=>row.base.version==='18.2.7');
assert.equal(historical.base.sha,oldRecord.base.sha);assert.equal(sha(oldPatch),oldRecord.patch.sha256);assert.equal(oldPatch.length,oldRecord.patch.bytes);
const historicalPatch=join(root,'historical.patch');writeFileSync(historicalPatch,oldPatch);
const result={scope:'Actual owned source upgrade/patch reconstruction/rollback and current-version runtime tests. Historical 18.2.7 is not built or executed; no production pins are changed.',root,old:{base:historical.base,patch:historical.patch},current:{base:manifest.base,fork:manifest.fork,patch:manifest.patch},steps:[]};
try{
 execFileSync('git',['clone','--shared','--no-checkout',history,source],{stdio:'pipe'});
 git(['fetch',fork,manifest.fork.commit]);
 git(['remote','set-url','origin',manifest.fork.repository]);
 git(['checkout','--detach',historical.base.sha]);
 const oldTree=git(['rev-parse','HEAD^{tree}']);assert.equal(git(['status','--porcelain']),'');
 git(['apply','--check',historicalPatch]);git(['apply','--index',historicalPatch]);result.old.patchedTree=git(['write-tree']);
 git(['apply','--reverse','--index',historicalPatch]);assert.equal(git(['write-tree']),oldTree);assert.equal(git(['status','--porcelain']),'');
 result.steps.push('historical patch applies; reverse restores exact 18.2.7 baseline tree');
 assert.throws(()=>validateSource(source,manifest),/manifest patches/);result.steps.push('current source validator refuses old baseline');
 git(['checkout','--detach',manifest.base.sha]);validateSource(source,manifest);
 const stale=spawnSync('git',['apply','--check',historicalPatch],{cwd:source,encoding:'utf8'});
 result.stalePatchOnNewBase={exitCode:stale.status,stderr:stale.stderr};
 git(['apply','--check',patchPath]);git(['apply','--index',patchPath]);
 assert.equal(git(['write-tree']),manifest.fork.tree);result.reconstructedTree=git(['write-tree']);
 result.steps.push('18.3.0 base plus controlled patch reconstructs exact published fork tree');
 git(['apply','--reverse','--index',patchPath]);assert.equal(git(['write-tree']),git(['rev-parse',`${manifest.base.sha}^{tree}`]));
 git(['checkout','--detach',manifest.fork.commit]);validateForkCheckout(source,manifest,patchPath);
 // Dependencies and native sources are exactly the existing current reference/fork.
 assert.equal(git(['diff',manifest.base.sha,manifest.fork.commit,'--','crates','Cargo.toml','Cargo.lock','packages/natives/src','packages/natives/Cargo.toml']),'');
 for(const rel of ['node_modules','packages/natives/native','packages/coding-agent/src/export/html/tool-views.generated.js']){
  const input=join(reference,rel);assert(existsSync(input),`prepared reference payload missing: ${rel}`);mkdirSync(join(source,rel,'..'),{recursive:true});
  if(rel==='packages/natives/native'){cpSync(input,join(source,rel),{recursive:true,verbatimSymlinks:true});}
  else execFileSync('/bin/cp',['-cR',input,join(source,rel)]);
 }
 for(const part of ['home','tmp'])mkdirSync(join(root,part));
 const output=spawnSync('/Users/vv/.bun/bin/bun',['test','packages/agent/test/agent-loop.test.ts','packages/coding-agent/test/rpc-host-tools.test.ts','packages/coding-agent/test/agent-session-turn-system-prompt.test.ts'],{cwd:source,encoding:'utf8',timeout:180000,maxBuffer:8*1024*1024,env:{PATH:'/Users/vv/.bun/bin:/usr/bin:/bin',HOME:join(root,'home'),TMPDIR:join(root,'tmp')}});
 writeFileSync(join(review,'upstream-rehearsal-current-tests.txt'),`${output.stdout}\n${output.stderr}`);assert.equal(output.status,0);
 result.currentTests={exitCode:output.status,summary:output.stderr.split('\n').filter(l=>/ pass| fail|skip|Ran /.test(l)).slice(-6)};
 git(['checkout','--detach',historical.base.sha]);assert.equal(git(['rev-parse','HEAD^{tree}']),oldTree);assert.equal(git(['status','--porcelain']),'');
 result.rollback={head:git(['rev-parse','HEAD']),tree:git(['rev-parse','HEAD^{tree}']),clean:true};
 assert.throws(()=>validateForkCheckout(source,manifest,patchPath),/HEAD|commit/);
 result.steps.push('rollback restores exact historical source tree and current release gate refuses it');
 git(['checkout','--detach',manifest.fork.commit]);validateForkCheckout(source,manifest,patchPath);result.steps.push('return to current controlled source passes gate');
 result.verified=true;
} catch(error){result.failure=error.stack;throw error;}finally{
 writeFileSync(join(review,'upstream-rehearsal.json'),`${JSON.stringify(result,null,2)}\n`);
 if(result.verified)rmSync(root,{recursive:true,force:true});
}
console.log(JSON.stringify({verified:result.verified,steps:result.steps,tests:result.currentTests}));
