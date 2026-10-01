import type {GmailUnreadMessage} from './gmail';
export interface GmailSearchPage {source:'gmail_readonly_api';account:string;accountVerified:true;query:string;messages:GmailUnreadMessage[];nextCursor:string|null;hasMore:boolean;page:number;pageLimit:5;pageSize:20;resultSizeEstimate:number|null;coverage:'bounded_search';summariesTruncated:boolean;preservedUnread:true;retrievedAt:number}
export interface GmailAttachmentRef {messageId:string;attachmentId:string;filename:string;mime:string;bytes:number;importable:boolean}
export interface GmailThreadMessage extends GmailUnreadMessage {body:string;bodyFormat:'plain_text';bodyTruncated:boolean;htmlOmitted:boolean;bodyUnavailable:boolean;attachments:GmailAttachmentRef[]}
export interface GmailThreadResult {source:'gmail_readonly_api';account:string;accountVerified:true;threadId:string;messages:GmailThreadMessage[];coverage:'selected_thread';bodyTruncated:boolean;headersTruncated:boolean;preservedUnread:true;retrievedAt:number;notes:string[]}
export interface GmailAttachmentReceipt {source:'gmail_attachment';account:string;accountVerified:true;messageId:string;attachmentId:string;filename:string;mime:string;sha256:string;bytes:number;retrievedAt:number;preservedUnread:true}
export type GmailReviewCommand={type:'gmailReview.search';taskId:string;query:string;cursor?:string}|{type:'gmailReview.thread';taskId:string;threadId:string}|{type:'gmailReview.attachment';taskId:string;messageId:string;attachmentId:string};
export const GMAIL_REVIEW_CHANNEL='agent-workspaces:gmail-review';
