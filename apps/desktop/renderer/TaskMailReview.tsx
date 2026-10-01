import type {AppBridge,LiveTaskState} from '../../../packages/contracts';
import {GmailReviewPanel} from './GmailReview';
export function TaskMailReview({bridge,run}:{bridge:AppBridge;run:LiveTaskState}){
 if(!run.policy.mailAccount)return null;
 return <GmailReviewPanel taskId={run.taskId} account={run.policy.mailAccount} enabled={run.policy.mailDetail==='threads_and_attachments'} onSearch={async(query,cursor)=>{const r=await bridge.gmailReview({type:'gmailReview.search',taskId:run.taskId,query,cursor});if(!r.search)throw new Error('No search result returned.');return r.search;}} onThread={async threadId=>{const r=await bridge.gmailReview({type:'gmailReview.thread',taskId:run.taskId,threadId});if(!r.thread)throw new Error('No thread returned.');return r.thread;}} onImportAttachment={async(messageId,attachmentId)=>{const r=await bridge.gmailReview({type:'gmailReview.attachment',taskId:run.taskId,messageId,attachmentId});if(!r.imported)throw new Error('No attachment imported.');return r.imported;}}/>;
}
