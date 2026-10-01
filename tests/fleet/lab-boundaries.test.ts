import test from 'node:test';
import assert from 'node:assert/strict';
import {LAB_ORIGIN,LocalLabController,labURL,parseLabCommand} from '../../packages/local-lab';
import {FLEET_LAB_URL} from '../../packages/contracts/fleet';
import {cleanBrowserObservation} from '../../packages/agent-loop/browser-results';
import type {LivePolicy} from '../../packages/contracts/live';

const argv=(...parts:string[])=>JSON.stringify(parts);
const policy:LivePolicy={mode:'workspace',allowedOrigins:[LAB_ORIGIN]};
const observation={tab:'local_tab',url:FLEET_LAB_URL+'catalog',title:'Training catalog',revision:3,targets:[{ref:'open_item',kind:'button',label:'Open item'}],text:'Synthetic training page.'};

test('local terminal parses bounded curl requests and leaves inline text as data',()=>{
 assert.deepEqual(parseLabCommand(argv('curl','-s','-i','-H','Accept: application/json',FLEET_LAB_URL+'catalog')),{url:FLEET_LAB_URL+'catalog',method:'GET',headers:{accept:'application/json'}});
 const body=JSON.stringify({note:'$(touch /never-run); echo text; `id`'}),request=parseLabCommand(argv('curl','--request','PUT','--data-raw',body,'/api/preferences'));
 assert.equal(request.method,'PUT');assert.equal(request.url,FLEET_LAB_URL+'api/preferences');assert.equal(request.body,body);assert.deepEqual(request.headers,{'content-type':'application/json'});
 assert.equal(parseLabCommand(argv('curl','-d','{"displayName":"Synthetic visitor"}','/api/register')).method,'POST');
});

test('local URL guards reject other websites, local ports, credentials, file and active schemes',()=>{
 for(const url of ['https://outside.example/path','http://localhost:4318/','http://127.0.0.1:4319/','http://127.0.0.2:4318/','https://127.0.0.1:4318/','file:///etc/passwd','javascript:alert(1)','data:text/html,fixture','http://name:password@127.0.0.1:4318/','//outside.example/path',FLEET_LAB_URL+'bad\npath',FLEET_LAB_URL+'bad\\path']){
  assert.throws(()=>labURL(url),url);assert.throws(()=>parseLabCommand(argv('curl',url)),url);
 }
 assert.equal(labURL(FLEET_LAB_URL+'#product'),FLEET_LAB_URL+'#product');
 for(const asset of ['/app.js','/server.mjs','/index.html','/__lab/health','/.env'])assert.throws(()=>parseLabCommand(argv('curl',FLEET_LAB_URL.slice(0,-1)+asset)));
 assert.equal(labURL('/catalog?item=synthetic'),FLEET_LAB_URL+'catalog?item=synthetic');
 assert.equal(labURL('http://127.1:4318/catalog'),FLEET_LAB_URL+'catalog'); // Same canonical loopback origin.
});

test('local terminal denies redirect, output, file-input, host-header and shell execution options',()=>{
 const rejected=[
  ['curl','--location',FLEET_LAB_URL],['curl','-L',FLEET_LAB_URL],['curl','-o','/tmp/output',FLEET_LAB_URL],['curl','--output','/tmp/output',FLEET_LAB_URL],
  ['curl','--config','/tmp/curlrc',FLEET_LAB_URL],['curl','--upload-file','/tmp/input',FLEET_LAB_URL],['curl','--proxy','http://outside.example',FLEET_LAB_URL],['curl','--resolve','outside.example:80:127.0.0.1',FLEET_LAB_URL],
  ['curl','-d','@/etc/passwd',FLEET_LAB_URL],['curl','--data-binary','@/etc/passwd',FLEET_LAB_URL],['curl','-H','Host: outside.example',FLEET_LAB_URL],['curl','-H','Cookie: unrelated-session',FLEET_LAB_URL],['curl','-H','Authorization: unrelated-token',FLEET_LAB_URL],['curl','-H','Accept: text/plain\r\nHost: outside.example',FLEET_LAB_URL],
  ['curl','-X','CONNECT',FLEET_LAB_URL],['curl',FLEET_LAB_URL,FLEET_LAB_URL+'another'],['sh','-c','curl '+FLEET_LAB_URL],['bash','-c','id'],['curl',FLEET_LAB_URL,';','id'],['curl','--next',FLEET_LAB_URL],
 ];
 for(const parts of rejected)assert.throws(()=>parseLabCommand(argv(...parts)),parts.join(' '));
 assert.throws(()=>parseLabCommand('not json'));assert.throws(()=>parseLabCommand(argv('curl','-H')));assert.throws(()=>parseLabCommand(argv('curl','-d')));assert.throws(()=>parseLabCommand(argv('curl','-d','x'.repeat(8193),FLEET_LAB_URL)));assert.throws(()=>parseLabCommand(argv('curl',...Array(20).fill('-s'),FLEET_LAB_URL)));
});

test('local command broker uses agent cookies and returns redirects without following them',async()=>{
 const original=globalThis.fetch,calls:{url:string;options:RequestInit|undefined}[]=[],agents:string[]=[];
 const controller=new LocalLabController({serverPath:'/unused-test-fixture',cookies:async agentId=>{agents.push(agentId);return'synthetic_session=test-only';}});
 controller.status=()=>({ready:true,siteUrl:FLEET_LAB_URL,message:'Synthetic transport fixture only.'});
 globalThis.fetch=(async(input:RequestInfo|URL,options?:RequestInit)=>{calls.push({url:String(input),options});return new Response('Synthetic redirect response.',{status:302,headers:{location:'https://outside.example/','content-type':'text/plain'}});}) as typeof fetch;
 try{
  const result=await controller.command('synthetic_agent',argv('curl',FLEET_LAB_URL+'redirect-check')) as Record<string,unknown>;
  assert.equal(calls.length,1);assert.equal(calls[0].url,FLEET_LAB_URL+'redirect-check');assert.equal(calls[0].options?.redirect,'manual');assert.equal(new Headers(calls[0].options?.headers).get('cookie'),'synthetic_session=test-only');assert.deepEqual(agents,['synthetic_agent']);
  assert.equal(result.status,302);assert.equal(result.redirectFollowed,false);assert.equal(result.body,'Synthetic redirect response.');assert.equal(result.sourceEvidence,true);
  await assert.rejects(controller.command('synthetic_agent',argv('curl','https://outside.example/')));assert.equal(calls.length,1);
 }finally{globalThis.fetch=original;await controller.close();}
});

test('local terminal bounds response bytes and rejects a stopped task result',async()=>{
 const original=globalThis.fetch,controller=new LocalLabController({serverPath:'/unused-test-fixture'});controller.status=()=>({ready:true,siteUrl:FLEET_LAB_URL,message:'Synthetic transport fixture only.'});
 globalThis.fetch=(async()=>new Response('x'.repeat(25000),{status:200})) as typeof fetch;
 try{
  const result=await controller.command('synthetic_agent',argv('curl','/catalog')) as Record<string,unknown>;assert.equal(result.bytes,24000);assert.equal(Buffer.byteLength(String(result.body)),24000);assert.equal(result.truncated,true);
  const abort=new AbortController();abort.abort();await assert.rejects(controller.command('synthetic_agent',argv('curl','/catalog'),abort.signal),/task stopped/);
 }finally{globalThis.fetch=original;await controller.close();}
});

test('ordinary HTTP observations remain redacted unless the exact local exception is supplied',()=>{
 const denied=[cleanBrowserObservation(observation,policy),cleanBrowserObservation(observation,policy,'http://localhost:4318'),cleanBrowserObservation(observation,policy,FLEET_LAB_URL),cleanBrowserObservation(observation,{mode:'workspace',allowedOrigins:[]},LAB_ORIGIN)];
 for(const result of denied){assert.equal(result.loginOrRedirect,true);assert.equal(result.text,undefined);assert.equal(result.targets,undefined);}
 const allowed=cleanBrowserObservation(observation,policy,LAB_ORIGIN);assert.equal(allowed.url,observation.url);assert.equal(allowed.text,observation.text);assert.equal(allowed.tabId,'local_tab');assert.equal(allowed.revision,3);assert.deepEqual(allowed.targets,observation.targets);assert.equal(allowed.fullPageVerified,false);
 for(const url of ['http://localhost:4318/catalog','http://127.0.0.1:4319/catalog','file:///etc/passwd','http://user:password@127.0.0.1:4318/catalog'])assert.equal(cleanBrowserObservation({...observation,url},policy,LAB_ORIGIN).loginOrRedirect,true);
});

test('the local HTTP exception preserves login and human-control sensitivity and observation size limits',()=>{
 for(const extra of [{url:FLEET_LAB_URL+'login?token=REDACTION_CANARY'},{url:FLEET_LAB_URL+'auth'},{humanLoginRequired:true},{nativeHumanControl:true}]){
  const result=cleanBrowserObservation({...observation,...extra,title:'REDACTION_CANARY',text:'REDACTION_CANARY',targets:[{ref:'target',kind:'input',label:'REDACTION_CANARY'}]},policy,LAB_ORIGIN);
  assert.equal(result.loginOrRedirect,true);assert.equal(JSON.stringify(result).includes('REDACTION_CANARY'),false);
 }
 const result=cleanBrowserObservation({...observation,text:'😀'.repeat(14000)},policy,LAB_ORIGIN);assert.ok(Buffer.byteLength(JSON.stringify(result))<=20*1024);assert.equal(result.textTruncated,true);assert.equal(result.fullPageVerified,false);assert.equal(Buffer.from(String(result.text)).toString(),result.text);
});
