import test from 'node:test';
import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';
// @ts-ignore Browser worker is intentionally plain JavaScript.
import {readGmailListing} from '../../workers/browser/gmail.mjs';
function read(label:string,url='https://mail.google.com/mail/u/0/#search/is%3Aunread'){
 const document={querySelectorAll:()=>[{getAttribute:()=>label}],querySelector:()=>({innerText:'No conversations found'})};
 // No row extraction is reached for these account/empty-state fixture checks.
 document.querySelectorAll=(selector?:string):any=>selector==='tr.zA'?[]:[{getAttribute:()=>label}];
 return runInNewContext(`(${readGmailListing.toString()})('alice@gmail.com')`,{URL,location:{href:url},document});
}
test('mailbox identity cannot be satisfied by an account whose email merely contains the target',()=>{
 assert.equal(read('Google Account: Mallory (malice@gmail.com)').accountVerified,false);
 assert.equal(read('Google Account: Alice (alice@gmail.com)').accountVerified,true);
 assert.equal(read('Google Account: Alice (alice@gmail.com)','https://attacker.example/#search/is%3Aunread').listingVerified,false);
});
