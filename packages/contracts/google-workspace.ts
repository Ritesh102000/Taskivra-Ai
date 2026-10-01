export const GOOGLE_WORKSPACE_SCOPE='https://www.googleapis.com/auth/drive.readonly';
export interface GoogleWorkspaceState {configured:boolean;connectedAccount:string|null;connecting:boolean;error:string|null;scope:typeof GOOGLE_WORKSPACE_SCOPE;access:'selected_imports';setupMode:'owner_desktop_client';liveAccessTested:boolean}
export type GoogleSelection={kind:'drive_file';resourceId:string}|{kind:'sheet_range';resourceId:string;range:string};
export interface GoogleImportReceipt {source:'google_drive'|'google_sheets';account:string;accountVerified:true;resourceId:string;resourceName:string;resourceVersion:string;modifiedTime:string;range?:string;rowCount?:number;columnCount?:number;retrievedAt:number;sha256:string;bytes:number;readOnly:true;scope:'explicit_selection';providerScope:typeof GOOGLE_WORKSPACE_SCOPE;warnings:string[]}
export interface GoogleImportResult {versionIds:string[];receipt:GoogleImportReceipt}
export type GoogleWorkspaceCommand={type:'googleWorkspace.state'}|{type:'googleWorkspace.disconnect'}|{type:'googleWorkspace.verify'}|{type:'googleWorkspace.connect';projectId:string;account:string}|{type:'googleWorkspace.import';projectId:string;agentId:string;taskId?:string;selection:GoogleSelection};
export const GOOGLE_WORKSPACE_CHANNEL='agent-workspaces:google-workspace';
export const GOOGLE_WORKSPACE_CHANGED_CHANNEL='agent-workspaces:google-workspace-changed';
