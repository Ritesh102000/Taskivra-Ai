export const GMAIL_SCOPE='https://www.googleapis.com/auth/gmail.readonly';
export interface GmailState {configured:boolean;connectedAccount:string|null;connecting:boolean;error:string|null}
export interface GmailUnreadMessage {id:string;threadId:string;from:string;to:string;subject:string;date:string;snippet:string}
export interface GmailUnreadResult {source:'gmail_readonly_api';account:string;accountVerified:true;listingVerified:true;query:'is:unread';messages:GmailUnreadMessage[];hasMore:boolean;resultSizeEstimate:number|null;preservedUnread:true;summariesTruncated?:boolean;retrievedAt:number}
export type GmailCommand={type:'gmail.state'}|{type:'gmail.connect';account:string}|{type:'gmail.disconnect'};
export const GMAIL_CHANNEL='agent-workspaces:gmail';
export const GMAIL_CHANGED_CHANNEL='agent-workspaces:gmail-changed';
