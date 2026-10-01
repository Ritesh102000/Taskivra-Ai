import assert from 'node:assert/strict';
import test from 'node:test';
import {bounded} from '../../packages/agent-loop/bounded';
import {googleBrowserRejected,recoverableReadError} from '../../packages/agent-loop/troubleshooting';
test('trace ceiling applies after JSON escaping and preserves whole Unicode characters',()=>{
  for(const value of ['"\\\n'.repeat(30000),'😀é日本語'.repeat(20000)])for(const cap of [128,24000,58000]){
    const result=bounded({value},cap);assert.ok(Buffer.byteLength(result)<=cap);assert.equal(JSON.parse(result).truncated,true);assert.doesNotMatch(result,/�/);
  }
});
test('Google rejection classification uses the exact HTTPS host and route without retaining query secrets',()=>{
  assert.equal(googleBrowserRejected('https://accounts.google.com/v3/signin/rejected?secret=never-record'),true);
  for(const url of ['https://accounts.google.com.evil.test/v3/signin/rejected','https://example.com/?text=This%20browser%20is%20not%20secure','http://accounts.google.com/v3/signin/rejected','https://accounts.google.com/v3/signin/identifier'])assert.equal(googleBrowserRejected(url),false);
});
test('only transient read errors can be retried; uncertain actions and access denials cannot',()=>{
  assert.equal(recoverableReadError({code:'observation_unavailable'}),'observation_unavailable');
  for(const code of ['browser_action_outcome_unknown','permission_denied','browser_action_failed','human_login_required','cancelled'])assert.equal(recoverableReadError({code}),null);
});
