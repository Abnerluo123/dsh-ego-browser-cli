import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs'
import { delimiter, join, isAbsolute } from 'node:path'
import { tmpdir } from 'node:os'
import { resolveExecutable } from '../index.js'
import { startProxy } from '../proxy.js'

const root=mkdtempSync(join(tmpdir(),'ego-resolution-'))
try {
  const options={home:root,path:''}
  assert.equal(resolveExecutable(undefined,options).command,null)
  assert.equal(resolveExecutable('ego-browser',options).command,null)
  await assert.rejects(startProxy({executable:'ego-browser'}),/invalid configured/)
  const shim=join(root,'dsh-ego-browser-shim-test')
  mkdirSync(shim)
  const executable=process.platform==='win32'?'ego-browser.exe':'ego-browser'
  const fakeShim=join(shim,executable)
  writeFileSync(fakeShim,'not a real executable');chmodSync(fakeShim,0o700)
  assert.equal(resolveExecutable(undefined,{home:root,path:shim}).command,null)
  assert.equal(resolveExecutable(fakeShim,options).command,null)
  const bin=join(root,'bin');mkdirSync(bin)
  const actual=join(bin,executable)
  writeFileSync(actual,'synthetic resolution marker');chmodSync(actual,0o700)
  const found=resolveExecutable(undefined,{home:root,path:`${shim}${delimiter}${bin}`})
  assert.equal(found.command,actual)
  assert.ok(isAbsolute(found.command))
  assert.equal(resolveExecutable('ego-browser',{home:root,path:bin}).command,actual)
  assert.equal(resolveExecutable('bad\0name',options).command,null)
  console.log('PASS missing executables never install recursive proxies; existing shims skipped and all resolutions are absolute')
} finally { rmSync(root,{recursive:true,force:true}) }
