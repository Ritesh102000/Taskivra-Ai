import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { BrowserTransport } from '../../packages/browser-runtime/transport';
function fixture(){
  const child=Object.assign(new EventEmitter(),{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),kill:()=>true});
  let failures=0;const transport=new BrowserTransport(child as unknown as ChildProcessWithoutNullStreams,()=>{failures++;});
  const send=(value:object)=>{const body=Buffer.from(JSON.stringify(value)),prefix=Buffer.alloc(4);prefix.writeUInt32BE(body.length);child.stdout.write(prefix.subarray(0,2));child.stdout.write(Buffer.concat([prefix.subarray(2),body]));};
  const ready=()=>send({type:'ready',protocol:3,phase:'restore',controller:'agent',generation:7});
  return{child,transport,send,ready,failures:()=>failures};
}

test('framed transport handles fragmented responses without rolling its generation backwards',async()=>{
  const f=fixture();try{
    f.ready();await f.transport.ready;const requests:any[]=[];f.child.stdin.on('data',bytes=>requests.push(JSON.parse(bytes.subarray(4).toString())));
    const first=f.transport.request('page.observe',{}, {actor:'owner',generation:7}),second=f.transport.request('tabs.list',{}, {actor:'owner',generation:7});
    f.send({id:requests[1].id,ok:true,controller:'human',generation:8,result:[]});
    f.send({id:requests[0].id,ok:true,controller:'agent',generation:7,result:{}});
    assert.equal((await first).generation,7);assert.equal((await second).generation,8);assert.equal(f.transport.generation,8);assert.equal(f.transport.controller,'human');
  }finally{f.transport.dispose();}
});

test('oversized response quarantines transport and rejects every pending action once',async()=>{
  const f=fixture();f.ready();await f.transport.ready;
  const pending=f.transport.request('page.observe',{}, {actor:'agent',generation:7});const rejection=assert.rejects(pending,/transport_invalid/);
  const header=Buffer.alloc(4);header.writeUInt32BE(3*1024*1024+1);f.child.stdout.write(header);await rejection;
  assert.equal(f.failures(),1);await assert.rejects(f.transport.request('tabs.list',{}, {actor:'agent',generation:7}),/unavailable/);f.transport.dispose();assert.equal(f.failures(),1);
});

test('duplicate ready frames and invalid protocol handshakes fail closed',async()=>{
  const f=fixture();f.ready();await f.transport.ready;f.ready();assert.equal(f.failures(),1);f.transport.dispose();
  const g=fixture(),rejected=assert.rejects(g.transport.ready,/transport_invalid/);g.send({type:'ready',protocol:2,phase:'restore',controller:'agent',generation:7});await rejected;g.transport.dispose();
});

test('worker error text cannot expose arbitrary page or credential content as an error code',async()=>{
  const f=fixture();try{
    f.ready();await f.transport.ready;let id='';f.child.stdin.on('data',bytes=>{id=JSON.parse(bytes.subarray(4).toString()).id;});
    const pending=f.transport.request('page.key',{}, {actor:'human',generation:7});const rejected=assert.rejects(pending,{message:'browser_action_failed',code:'browser_action_failed'});
    f.send({id,ok:false,controller:'human',generation:7,error:'secret credential contents 123'});await rejected;
  }finally{f.transport.dispose();}
});
