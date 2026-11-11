// Optional live integration test. Uses only synthetic pages/files and its own
// task space. Run with `npm run test:live` on an onboarded Ego installation.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { apply, resolveExecutable } from '../index.js'

const root = mkdtempSync(join(tmpdir(), 'ego-plugin-live-'))
const rootJs = root.replaceAll('\\', '/')
writeFileSync(join(root, 'upload.txt'), 'Synthetic upload — 浏览器测试', 'utf8')
const server = createServer((req, res) => {
  if (req.url === '/download') {
    res.writeHead(200, { 'content-type': 'text/plain', 'content-disposition': 'attachment; filename="result.txt"' })
    return res.end('synthetic-download')
  }
  if (req.url === '/data') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"synthetic":true}') }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(`<!doctype html><title>Ego plugin integration</title><h1>浏览器自动化测试</h1>
<label>Name <input id="name"></label><select id="choice"><option>A</option><option>B</option></select>
<input type="file" id="upload"><a href="/download" id="download">Download</a>
<button id="dialog" onclick="alert('synthetic-dialog')">Dialog</button>
<a id="popup" href="/popup" target="_blank">Popup</a>`)
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const url = `http://127.0.0.1:${server.address().port}`
let tool
apply({ tools: { register(def) { tool = def } } }, { shellProxy: false, timeoutMs: 60_000 })
const exec = { agent: { session: { id: `live-test-${process.pid}` } } }
async function run(script, extra = {}) {
  const result = await tool.execute({ description: 'Run synthetic Ego integration check', script, timeoutMs: 60_000, ...extra }, exec)
  assert.ok(result.ok, result.stderr + result.stdout)
  return result.stderr + result.stdout
}
const spaceName = `dsh-plugin-live-${process.pid}-${Date.now()}`
let spaceId
try {
  const metadata = await run('console.log("META="+JSON.stringify({profiles:await profiles(),spaces:await listTaskSpaces()}))')
  const meta = JSON.parse(metadata.split('\n').find(l => l.startsWith('META=')).slice(5))
  assert.ok(meta.profiles.length > 0)
  const profileId = meta.profiles.find(p => !p.isDefault)?.id ?? meta.profiles[0].id
  const first = await run(`
const task = await taskSpace(${JSON.stringify(spaceName)}, { profileId: ${JSON.stringify(profileId)} });
const page = task.page('p1');
await page.goto(${JSON.stringify(url)});
console.log('SPACE='+task.spaceId);
console.log(await page.snapshot());
await page.fill('#name', '无人监管 automation');
await page.selectOption('#choice', { label: 'B' });
await page.setInputFiles('#upload', ${JSON.stringify(`${rootJs}/upload.txt`)});
const state = await page.evaluate(() => ({ title:document.title, name:document.querySelector('#name').value, choice:document.querySelector('#choice').value, file:document.querySelector('#upload').files[0].name }));
console.log('STATE='+JSON.stringify(state));
const response = await page.fetch('/data');
console.log('FETCH='+response.body);
await page.screenshot({ path: ${JSON.stringify(`${rootJs}/screenshot.png`)} });
const downloadPromise = page.waitForEvent('download', { timeout:10000 });
await page.click('#download');
const download = await downloadPromise;
await download.saveAs(${JSON.stringify(`${rootJs}/download.txt`)});
const receipt = await page.click('#dialog');
await page.acceptDialog();
const popupPromise = page.waitForEvent('popup');
await page.click('#popup');
const popup = await popupPromise;
await popup.waitForLoadState();
console.log('POPUP='+await popup.title());
await popup.close();
console.log('CDP='+JSON.stringify(await page.cdp('Runtime.evaluate',{expression:'1+1',returnByValue:true})));
console.log('TABS='+JSON.stringify((await task.tabs()).map(t=>({label:t.label,url:t.url}))));
`)
  spaceId = Number(first.split('\n').find(l => l.startsWith('SPACE=')).slice(6))
  const state = JSON.parse(first.split('\n').find(l => l.startsWith('STATE=')).slice(6))
  assert.equal(state.name, '无人监管 automation')
  assert.equal(state.choice, 'B')
  assert.equal(state.file, 'upload.txt')
  assert.match(first, /synthetic.*true/)
  assert.ok(existsSync(join(root, 'screenshot.png')))
  assert.equal(readFileSync(join(root, 'download.txt'), 'utf8'), 'synthetic-download')
  const resumed = await run(`const task = await taskSpace(${spaceId}); const page = task.page('p1'); console.log('RESUMED='+await page.evaluate(()=>document.querySelector('#name').value));`)
  assert.match(resumed, /RESUMED=无人监管 automation/)
  await run(`const task = await taskSpace(${spaceId}); console.log(JSON.stringify(await task.finish({ keep: [] })));`)
  spaceId = undefined

  // Windows official file-import launcher: local modules, Unicode and Node fs
  // are allowed, without declarations injected into the imported source.
  const modulePath = join(root, 'round-01.mjs')
  writeFileSync(modulePath, `const fs=await import('node:fs/promises'); console.log('FILE_IMPORT='+await fs.readFile(${JSON.stringify(`${rootJs}/upload.txt`)},'utf8'));`, 'utf8')
  const imported = await run(`await import(${JSON.stringify(pathToFileURL(modulePath).href)})`)
  assert.match(imported, /FILE_IMPORT=Synthetic upload — 浏览器测试/)

  const explicit = resolveExecutable().command
  let explicitTool
  apply({ tools: { register(def) { explicitTool = def } } }, { shellProxy:false, executable:explicit })
  assert.ok((await explicitTool.execute({ script:'console.log("EXPLICIT_OK")',description:'Check explicit executable' }, exec)).ok)
  await assert.rejects(tool.execute({ script:'x',description:'x',spaceId:1,profileId },exec), /new space/)
  console.log(`PASS live Ego: ${meta.profiles.length} visible profiles; selected ${profileId}; official declarations, navigation, snapshot, fill/select, upload/download, screenshot, fetch, dialog, popup, CDP, resume, finish and file import`)
} finally {
  if (spaceId) {
    // Only close our synthetic Agent-owned space if it is still ours.
    try { await run(`const entries=await listTaskSpaces(); if(entries.some(s=>s.id===${spaceId}&&s.ownership==='agent')) { const t=await taskSpace(${spaceId}); await t.finish({keep:[]}); }`) } catch {}
  }
  await new Promise(resolve => server.close(resolve))
  server.closeAllConnections()
  rmSync(root, { recursive:true,force:true })
}
