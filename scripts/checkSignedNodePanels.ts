/** Read-only deployment check: bun --no-env-file scripts/checkSignedNodePanels.ts */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
const full = process.env.FULL_PANEL_URL ?? 'https://full-node.rogue-one.eu';
const light = process.env.LIGHT_PANEL_URL ?? 'https://light-node.rogue-one.eu';
const out = process.env.PANEL_CHECK_OUT ?? '/tmp/arkiv-signed-panels';
await mkdir(out, {recursive:true});
async function api(origin:string,path:string,body?:unknown):Promise<any> {
 for(let i=0;i<8;i++) {
  const res=await fetch(origin+path,{...(body ? {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)} : {})});
  const data=await res.json();
  if([429,503].includes(res.status)){await Bun.sleep(300);continue;}
  assert.equal(res.status,200,JSON.stringify(data));return data;
 }
 throw Error('Node repeatedly busy');
}
const fs=await api(full,'/node-sim/v1/status'),ls=await api(light,'/node-sim/v1/status');
assert.equal(fs.role,'full');assert.equal(ls.role,'light');
assert.equal(ls.authentication,'signed-proposer-v1');
for(const field of ['sourceId','runId','genesisHash','chainId','authentication']) {
 assert.equal(typeof ls[field],'string',field);assert.equal(fs[field],ls[field],field);
}
const query={height:ls.head.height,namespace:'1',attribute:'$contentType',valueType:'str',value:'application/octet-stream',limit:3,cursor:null};
const proof=await api(light,'/node-sim/v1/query/inspect',query);
assert.equal(proof.verification,'proof verified against authenticated single-proposer header');
assert.equal(proof.rows.length,3);assert.ok(proof.continuation);
const block=await api(full,'/node-sim/v1/feed/blocks/'+query.height);
assert.equal(proof.snapshot.stateRoot,block.header.stateRoot);
const second=await api(light,'/node-sim/v1/query/inspect',{...query,cursor:proof.continuation});
assert.equal(second.snapshot.stateRoot,proof.snapshot.stateRoot);
assert.equal(new Set([...proof.rows,...second.rows].map(r=>r.recordId)).size,6);
const absent=await api(light,'/node-sim/v1/query/inspect',{...query,value:'application/x-arkiv-absent-demo'});
assert.equal(absent.rows.length,0);
for(const origin of [full,light]) {
 for(const path of ['/api/health','/local-sim/v1/status','/node-sim/v1/control','/signed/v1/control','/signed/v1/replication/blocks/1']) assert.equal((await fetch(origin+path)).status,404,path);
 const rpc=await api(origin,'/',{jsonrpc:'2.0',id:1,method:'eth_chainId',params:[]});assert.equal(BigInt(rpc.result).toString(),ls.chainId);
 await new Promise<void>((resolve,reject)=>{const ws=new WebSocket(origin.replace('https:','wss:')+'/');const t=setTimeout(()=>{ws.close();reject(Error('WS timeout'));},10000);ws.onopen=()=>ws.send(JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_chainId',params:[]}));ws.onerror=()=>{clearTimeout(t);reject(Error('WS error'));};ws.onmessage=e=>{clearTimeout(t);ws.close();try{assert.equal(BigInt(JSON.parse(e.data).result).toString(),ls.chainId);resolve();}catch(e){reject(e);}};});
}
const browser=await chromium.launch({headless:true});
const errors:string[]=[];
try {
 const page=await browser.newPage({viewport:{width:1440,height:1000}});
 page.on('pageerror',e=>errors.push(e.message));
 await page.goto(full);await page.locator('.nd-block-result').waitFor({timeout:30000});
 assert.ok((await page.locator('body').innerText()).includes('SIGNED PROPOSER'));
 await page.screenshot({path:out+'/full.png',fullPage:true});
 await page.goto(light + '/proof-inspector?proof=equality');await page.locator('.nd-verified').waitFor({timeout:30000});
 assert.equal(await page.locator('.nd-records > details').count(),3);
 await page.getByRole('button',{name:'Next page',exact:true}).click();
 await page.getByText('PAGE 2',{exact:true}).waitFor();
 await page.getByRole('button',{name:/02 \/ Absence/}).click();
 await page.locator('.nd-absence').waitFor();
 await page.screenshot({path:out+'/light-absence.png',fullPage:true});
 await page.getByRole('button',{name:/01 \/ Live entities/}).click();
 await page.locator('.nd-verified').waitFor();
 await page.screenshot({path:out+'/light.png',fullPage:true});
 for(const origin of [full,light]) {
  await page.setViewportSize({width:390,height:844});await page.goto(origin === light ? light + '/proof-inspector?proof=equality' : origin);
  await page.locator(origin===full?'.nd-block-result':'.nd-verified').waitFor();
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1));
 }
 assert.deepEqual(errors,[]);
 const report={chainId:ls.chainId,identity:{sourceId:ls.sourceId,runId:ls.runId,genesisHash:ls.genesisHash,chainId:ls.chainId},height:query.height,matchingEntities:proof.postingCount,proofBytes:(proof.canonicalProof.length-2)/2,checks:['full block inspector','membership','pagination','absence','witness visualizer','mobile layouts','HTTP RPC','WebSockets','restricted routes'],errors};
 await Bun.write(out+'/report.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
} finally {await browser.close();}
