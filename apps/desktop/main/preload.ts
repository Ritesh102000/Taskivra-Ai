import {FLEET_CHANNEL} from '../../../packages/contracts/fleet';
import {SECURITY_REVIEW_CHANNEL} from '../../../packages/contracts/security-review';
import {MODEL_PROVIDERS_CHANNEL} from '../../../packages/contracts/model-providers';
import {TASK_RECOVERY_CHANNEL} from '../../../packages/contracts/task-recovery';
import {REPORT_EXPORT_CHANNEL} from '../../../packages/contracts/results';
import {GMAIL_REVIEW_CHANNEL} from '../../../packages/contracts/gmail-review';
import {GOOGLE_WORKSPACE_CHANNEL,GOOGLE_WORKSPACE_CHANGED_CHANNEL} from '../../../packages/contracts/google-workspace';
import {BROWSER_ACTIONS_CHANNEL} from '../../../packages/contracts/browser-actions';
import {ROUTINES_CHANNEL} from '../../../packages/contracts/routines';
import {PROJECTS_CHANNEL} from '../../../packages/contracts/projects';
import { RECOVERY_CHANNEL } from '../../../packages/contracts/recovery-ui';
import { RESULTS_CHANNEL } from '../../../packages/contracts/results';
import { READINESS_CHANNEL } from '../../../packages/contracts/readiness';
import { MODEL_CONNECTION_CHANNEL } from '../../../packages/contracts/model-connection';
import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { CHANGED_CHANNEL, COMMAND_CHANNEL, FILES_CHANNEL, DROP_CHANNEL, PREVIEW_CHANNEL, BROWSER_CHANNEL, BROWSER_CHANGED_CHANNEL, CODE_CHANNEL, CODE_CHANGED_CHANNEL, REQUEST_CHANNEL, REQUEST_PICK_CHANNEL, REQUEST_CHANGED_CHANNEL, LIVE_CHANNEL, LIVE_CHANGED_CHANNEL, GMAIL_CHANNEL, GMAIL_CHANGED_CHANNEL, GMAIL_IMPORT_CHANNEL, COLLABORATION_CHANNEL, BROWSER_SETUP_CHANNEL } from '../../../packages/contracts/index';
import type { AppBridge, CommandResult } from '../../../packages/contracts/index';
import { nativeDropPaths } from './drop';
import { WORKFLOWS_CHANNEL } from '../../../packages/contracts/workflows';

async function fileInvoke<T>(channel: string, payload: unknown): Promise<T> {
  const result = await ipcRenderer.invoke(channel, payload);
  if (!result.ok) throw new Error(result.error.message);
  return result.value as T;
}

const bridge: AppBridge = {
  fleet(command){return fileInvoke(FLEET_CHANNEL,command);},
  securityReview(command){return fileInvoke(SECURITY_REVIEW_CHANNEL,command);},
  modelProviders(command){return fileInvoke(MODEL_PROVIDERS_CHANNEL,command);},
  taskRecovery(command){return fileInvoke(TASK_RECOVERY_CHANNEL,command);},
  reportExport(command){return fileInvoke(REPORT_EXPORT_CHANNEL,command);},
  gmailReview(command){return fileInvoke(GMAIL_REVIEW_CHANNEL,command);},
  googleWorkspace(command){return fileInvoke(GOOGLE_WORKSPACE_CHANNEL,command);},
  googleWorkspaceImportClient(){return fileInvoke(GOOGLE_WORKSPACE_CHANNEL+':import-client',undefined);},
  onGoogleWorkspaceChanged(callback){if(typeof callback!=='function')throw new TypeError('A callback is required.');const listener=()=>callback();ipcRenderer.on(GOOGLE_WORKSPACE_CHANGED_CHANNEL,listener);return()=>ipcRenderer.removeListener(GOOGLE_WORKSPACE_CHANGED_CHANNEL,listener);},
  browserActions(command){return fileInvoke(BROWSER_ACTIONS_CHANNEL,command);},
  routines(command){return fileInvoke(ROUTINES_CHANNEL,command);},
  projects(command){return fileInvoke(PROJECTS_CHANNEL,command);},
  recovery(command) { return fileInvoke(RECOVERY_CHANNEL, command); },
  results(command) { return fileInvoke(RESULTS_CHANNEL, command); },
  readiness(command) { return fileInvoke(READINESS_CHANNEL, command); },
  modelConnection(command) { return fileInvoke(MODEL_CONNECTION_CHANNEL, command); },
  workflows(command) { return fileInvoke(WORKFLOWS_CHANNEL, command); },
  collaboration(command) { return fileInvoke(COLLABORATION_CHANNEL,command); },
  browserSetup(command) { return fileInvoke(BROWSER_SETUP_CHANNEL,command); },
  async command(command) {
    const result: CommandResult = await ipcRenderer.invoke(COMMAND_CHANNEL, command);
    if (!result.ok) throw new Error(result.error.message);
    return result.snapshot;
  },
  onChanged(callback) {
    if (typeof callback !== 'function') throw new TypeError('A callback is required.');
    const listener = () => callback();
    ipcRenderer.on(CHANGED_CHANNEL, listener);
    return () => ipcRenderer.removeListener(CHANGED_CHANNEL, listener);
  },
  browser(command) { return fileInvoke(BROWSER_CHANNEL,command); },
  code(command) { return fileInvoke(CODE_CHANNEL,command); },
  live(command) { return fileInvoke(LIVE_CHANNEL, command); },
  gmail(command) { return fileInvoke(GMAIL_CHANNEL, command); },
  gmailImportClient() { return fileInvoke(GMAIL_IMPORT_CHANNEL, undefined); },
  onGmailChanged(callback) {
    if (typeof callback !== 'function') throw new TypeError('A callback is required.');
    const listener = () => callback(); ipcRenderer.on(GMAIL_CHANGED_CHANNEL, listener);
    return () => ipcRenderer.removeListener(GMAIL_CHANGED_CHANNEL, listener);
  },
  requests(command) { return fileInvoke(REQUEST_CHANNEL, command); },
  requestPick(command) { return fileInvoke(REQUEST_PICK_CHANNEL, command); },
  onLiveChanged(callback) {
    if (typeof callback !== 'function') throw new TypeError('A callback is required.');
    const listener = () => callback(); ipcRenderer.on(LIVE_CHANGED_CHANNEL, listener);
    return () => ipcRenderer.removeListener(LIVE_CHANGED_CHANNEL, listener);
  },
  onRequestsChanged(callback) {
    if (typeof callback !== 'function') throw new TypeError('A callback is required.');
    const listener = () => callback(); ipcRenderer.on(REQUEST_CHANGED_CHANNEL, listener);
    return () => ipcRenderer.removeListener(REQUEST_CHANGED_CHANNEL, listener);
  },
  onCodeChanged(callback) {
    if (typeof callback !== 'function') throw new TypeError('A callback is required.');
    const listener = () => callback();
    ipcRenderer.on(CODE_CHANGED_CHANNEL, listener);
    return () => ipcRenderer.removeListener(CODE_CHANGED_CHANNEL, listener);
  },
  onBrowserChanged(callback) {
    if(typeof callback!=='function')throw new TypeError('A callback is required.');
    const listener=()=>callback();ipcRenderer.on(BROWSER_CHANGED_CHANNEL,listener);
    return ()=>ipcRenderer.removeListener(BROWSER_CHANGED_CHANNEL,listener);
  },
  files(command) { return fileInvoke(FILES_CHANNEL, command); },
  preview(versionId) { return fileInvoke(PREVIEW_CHANNEL, versionId); },
  importDroppedFiles(target, files) {
    const paths = nativeDropPaths(files, file => webUtils.getPathForFile(file));
    return fileInvoke(DROP_CHANNEL, { target, paths });
  },
};
contextBridge.exposeInMainWorld('agentWorkspaces', Object.freeze(bridge));
