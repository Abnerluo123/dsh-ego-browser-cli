import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runEgo } from '../index.js'

const root = mkdtempSync(join(tmpdir(), 'ego-runner-test-'))
// Node stands in for Ego: runEgo always adds nodejs as the fixed subcommand,
// which Node loads as this synthetic script in our isolated cwd.
writeFileSync(join(root, 'nodejs'), `
const fs=require('node:fs');
const {spawn}=require('node:child_process');
let input=''; process.stdin.setEncoding('utf8');
process.stdin.on('data',c=>input+=c);
process.stdin.on('end',async()=>{
  if(input==='TREE') {
    fs.writeFileSync('parent.pid',String(process.pid));
    spawn(process.execPath,['-e', 'require("node:fs").writeFileSync("child.pid",String(process.pid));setInterval(()=>{},1000)'],{stdio:'ignore'});
    setInterval(()=>{},1000);
  } else if(input==='ORPHAN') {
    const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore',process.stdout,process.stderr]});
    fs.writeFileSync('orphan.pid',String(child.pid));
    process.exit(0);
  } else if(input==='FLOOD') { process.stdout.write('x'.repeat(130000)); }
  else if(input==='UNICODE') { for(const byte of Buffer.from('中文λ🌍')) { process.stderr.write(Buffer.of(byte)); await new Promise(r=>setTimeout(r,2)); } }
  else { console.log(input); }
});
`, 'utf8')
const options = { cwd:root, timeoutMs:5000 }
const alive = pid => { try { process.kill(pid,0);return true } catch { return false } }
async function until(predicate) {
  const deadline=Date.now()+5000
  while(!predicate()) { assert.ok(Date.now()<deadline,'process tree did not terminate');await new Promise(r=>setTimeout(r,20)) }
}
try {
  const text=await runEgo(process.execPath,'literal code with eval( and Unicode 中文',options)
  assert.equal(text.exitCode,0)
  assert.match(text.stdout,/literal code with eval\( and Unicode 中文/)
  const unicode=await runEgo(process.execPath,'UNICODE',options)
  assert.equal(unicode.stderr,'中文λ🌍')
  const flood=await runEgo(process.execPath,'FLOOD',options)
  assert.equal(flood.truncated,true)
  assert.equal(flood.stdout.length,120000)
  const timed=await runEgo(process.execPath,'TREE',{...options,timeoutMs:1000})
  assert.equal(timed.timedOut,true)
  assert.notEqual(timed.exitCode,0)
  assert.ok(existsSync(join(root,'child.pid')))
  await until(()=>!alive(Number(readFileSync(join(root,'parent.pid'),'utf8')))&&!alive(Number(readFileSync(join(root,'child.pid'),'utf8'))))
  const controller=new AbortController()
  const aborted=runEgo(process.execPath,'TREE',{...options,signal:controller.signal})
  setTimeout(()=>controller.abort(),1000)
  assert.notEqual((await aborted).exitCode,0)
  await until(()=>!alive(Number(readFileSync(join(root,'parent.pid'),'utf8')))&&!alive(Number(readFileSync(join(root,'child.pid'),'utf8'))))
  const began=Date.now()
  const orphaned=await runEgo(process.execPath,'ORPHAN',{...options,timeoutMs:200})
  if(orphaned.timedOut) assert.notEqual(orphaned.exitCode,0)
  else assert.equal(orphaned.exitCode,0) // Windows may close inherited pipes at parent exit.
  assert.ok(Date.now()-began<4500,'inherited pipes must not hang completion')
  const orphan=Number(readFileSync(join(root,'orphan.pid'),'utf8'))
  // Windows cannot enumerate descendants through a parent PID after it exits;
  // explicitly clean up the synthetic orphan if the OS tree kill cannot find it.
  if(alive(orphan)) process.kill(orphan,'SIGKILL')
  console.log('PASS fixed runner stdin/Unicode/truncation, timeout/abort tree cleanup and bounded orphan-pipe completion')
} finally {
  if(existsSync(join(root,'orphan.pid'))) {
    const pid=Number(readFileSync(join(root,'orphan.pid'),'utf8'))
    if(alive(pid)) process.kill(pid,'SIGKILL')
  }
  rmSync(root,{recursive:true,force:true})
}
