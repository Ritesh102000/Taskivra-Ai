import {formatOfficeInWorker} from './report-format';
import {IpcAdmission} from './ipc-admission';
import {safeRecoveryFailure} from '../../../packages/recovery';
import {DocumentError} from '../../../packages/documents';
import {record,identity} from '../../../packages/contracts/live-validation';
import {LocalLabController} from '../../../packages/local-lab';
import {ElectronLabRuntime} from './lab-browser-runtime';
import {FLEET_CHANNEL} from '../../../packages/contracts/fleet';
import {FleetError} from '../../../packages/fleet';
import {SECURITY_REVIEW_CHANNEL} from '../../../packages/contracts/security-review';
import {SecurityReviewError} from '../../../packages/security-review';
import {MODEL_PROVIDERS_CHANNEL} from '../../../packages/contracts/model-providers';
import {TASK_RECOVERY_CHANNEL} from '../../../packages/contracts/task-recovery';
import {REPORT_EXPORT_CHANNEL} from '../../../packages/contracts/results';
import {ProviderController} from './provider-controller';
import {ReportExportController,renderIsolatedReportPdf} from './report-export-controller';
import {GMAIL_REVIEW_CHANNEL} from '../../../packages/contracts/gmail-review';
import {GmailReviewController} from './gmail-review-controller';
import {GoogleWorkspaceService,GoogleWorkspaceError} from '../../../packages/google-workspace';
import {GOOGLE_WORKSPACE_CHANNEL,GOOGLE_WORKSPACE_CHANGED_CHANNEL} from '../../../packages/contracts/google-workspace';
import {GoogleWorkspaceController} from './google-workspace-controller';
import {BROWSER_ACTIONS_CHANNEL} from '../../../packages/contracts/browser-actions';
import {BrowserActionError} from '../../../packages/browser-actions';
import {ROUTINES_CHANNEL} from '../../../packages/contracts/routines';
import {PROJECTS_CHANNEL} from '../../../packages/contracts/projects';
import {RoutineError} from '../../../packages/routines';
import {ProjectError} from '../../../packages/projects';
import {RESULTS_CHANNEL} from '../../../packages/contracts/results';
import {READINESS_CHANNEL} from '../../../packages/contracts/readiness';
import {MODEL_CONNECTION_CHANNEL} from '../../../packages/contracts/model-connection';
import {RECOVERY_CHANNEL} from '../../../packages/contracts/recovery-ui';
import {ResultError} from '../../../packages/results';
import {ReadinessError} from '../../../packages/readiness';
import {RecoveryController} from './recovery-controller';
import {ModelConnectionController,ModelConnectionError} from './model-connection-controller';
import { app, BrowserWindow, dialog, ipcMain, Menu, protocol, session, shell, powerMonitor } from 'electron';
import { readFileSync, readdirSync, mkdirSync, lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, extname } from 'node:path';
import { Coordinator, CoordinatorError } from '../../../packages/coordinator/index';
import { parseCommand, CommandValidationError } from '../../../packages/contracts/validation';
import { HISTORY_CHANNEL, GRANTS_CHANNEL, CHANGED_CHANNEL, COMMAND_CHANNEL, FILES_CHANNEL, DROP_CHANNEL, PREVIEW_CHANNEL, BROWSER_CHANNEL, BROWSER_CHANGED_CHANNEL, CODE_CHANNEL, CODE_CHANGED_CHANNEL, REQUEST_CHANNEL, REQUEST_PICK_CHANNEL, REQUEST_CHANGED_CHANNEL, LIVE_CHANNEL, LIVE_CHANGED_CHANNEL, GMAIL_CHANNEL, GMAIL_CHANGED_CHANNEL, GMAIL_IMPORT_CHANNEL, COLLABORATION_CHANNEL, BROWSER_SETUP_CHANNEL } from '../../../packages/contracts/index';
import type { CommandResult } from '../../../packages/contracts/index';
import { APP_URL, CONTENT_SECURITY_POLICY, isTrustedSender } from './security';
import { FileController } from './file-controller';
import {RepositorySnapshotError} from '../../../packages/repository-snapshot';
import { DockerBrowserRuntimeFactory } from '../../../packages/browser-runtime/index';
import { NativeChromeRuntime } from '../../../packages/native-browser';
import { BrowserRuntimeRouter,BrowserSetupController } from './browser-setup-controller';
import { CollaborationError } from '../../../packages/collaboration';
import { WorkflowError } from '../../../packages/workflows';
import { WORKFLOWS_CHANNEL } from '../../../packages/contracts/workflows';
import { BrowserError } from '../../../packages/browser/index';
import { unavailableRuntime, type BrowserRuntime } from '../../../packages/browser/runtime';
import { loadBrowserProfileKey } from './browser-key';
import { ArtifactError } from '../../../packages/artifacts/index';
import { DockerCodeRuntimeFactory } from '../../../packages/code-runtime/index';
import { CodeError } from '../../../packages/code/index';
import { RequestController } from './request-controller';
import { GmailController, GmailControllerError } from './gmail-controller';
import { GmailService, GmailError } from '../../../packages/gmail/index';
import { MacGmailSecretStore } from '../../../packages/gmail/keychain';
import { RequestError } from '../../../packages/requests/index';
import { LiveError } from '../../../packages/contracts/live-validation';
import { OpenAIResponsesAdapter, MacKeychainCredentials, ModelAdapterError, CredentialError, ProviderRegistry, ProviderConfigurationError, providerCredentialAccount } from '../../../packages/model-adapters/index';

app.setName('Agent Workspaces');
// A local developer/test override; the renderer never supplies a filesystem path.
const dataRoot = resolve(process.env.AW_DATA_ROOT || join(homedir(), 'Library', 'Application Support', 'Agent Workspaces'));
mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
mkdirSync(join(dataRoot, 'desktop'), { recursive: true, mode: 0o700 });
app.setPath('userData', join(dataRoot, 'desktop'));
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: false } }]);

let window: BrowserWindow | null = null;
let coordinator: Coordinator | null = null;
let timer: ReturnType<typeof setInterval> | undefined;
let lastEventId = -1;
const ipcAdmission=new IpcAdmission();
let closing = false;
let closeGoogle:(()=>Promise<void>)|undefined;
let maintenanceGate = false;
let sleepRequested = false;
let sleepWork:Promise<unknown>=Promise.resolve();
let maintenanceWork: Promise<unknown> = Promise.resolve();
const registeredIpc=new Set<string>();
const IPC_LIFECYCLE_EXCEPTIONS=new Set([RECOVERY_CHANNEL]);
const pendingIpc = new Set<Promise<unknown>>();
function registerIpc(channel:string, handler:Parameters<typeof ipcMain.handle>[1], track=true):void {
  if(registeredIpc.has(channel))throw new Error('Duplicate IPC registration.');
  if(track===IPC_LIFECYCLE_EXCEPTIONS.has(channel))throw new Error('IPC lifecycle policy mismatch.');
  registeredIpc.add(channel);
  ipcMain.handle(channel, (event,...args)=> {
    const result=Promise.resolve().then(()=>handler(event,...args));
    if(track){pendingIpc.add(result);void result.finally(()=>pendingIpc.delete(result)).catch(()=>{});}
    return result;
  });
}
async function appMaintenance<T>(work:()=>Promise<T>):Promise<T> {
  if(maintenanceGate)throw new Error('A workspace checkpoint is already in progress.');
  maintenanceGate=true;
  const pending=(async()=>{
    try{await Promise.allSettled([...pendingIpc]);return await work();}
    finally{
      try{while(sleepRequested&&!closing&&coordinator){sleepRequested=false;await sleepWork;await coordinator.withQuiesced(async()=>undefined);}}
      finally{maintenanceGate=false;notifyChanges();}
    }
  })();
  maintenanceWork=pending;
  return await pending;
}


function notifyChanges(): void {
  if (!coordinator || !window || window.isDestroyed()) return;
  try {
  const latest = coordinator.eventWatermark();
  if (latest !== lastEventId) {
    window.webContents.send(CHANGED_CHANNEL);
    lastEventId = latest;
  }
  } catch { /* Observers cannot replace a committed command result; retry on the next tick. */ }
}

function bundledAssets(): Map<string, { bytes: Uint8Array; type: string }> {
  const root = join(__dirname, '../renderer');
  const assets = new Map<string, { bytes: Uint8Array; type: string }>();
  const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
  function collect(directory: string, prefix: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (lstatSync(absolute).isSymbolicLink()) throw new Error('Bundled assets cannot contain symlinks.');
      if (entry.isDirectory()) collect(absolute, `${prefix}${entry.name}/`);
      else if (entry.isFile() && mime[extname(entry.name)]) assets.set(`${prefix}${entry.name}`, { bytes: new Uint8Array(readFileSync(absolute)), type: mime[extname(entry.name)] });
    }
  }
  collect(root, '/');
  return assets;
}

async function launch(): Promise<void> {
  const assets = bundledAssets();
  protocol.handle('app', request => {
    const url = new URL(request.url);
    const asset = url.host === 'desktop' && !url.search && !url.hash ? assets.get(url.pathname) : undefined;
    if (request.method !== 'GET' || !asset) return new Response('Not found', { status: 404 });
    return new Response(asset.bytes as BodyInit, { headers: {
      'Content-Type': asset.type, 'Content-Security-Policy': CONTENT_SECURITY_POLICY,
      'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store',
    } });
  });
  const ownerSession = session.defaultSession;
  ownerSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  ownerSession.setPermissionCheckHandler(() => false);
  ownerSession.on('will-download', event => event.preventDefault());
  ownerSession.webRequest.onBeforeRequest((details, callback) => {
    // This shell renders installed assets and ephemeral image frames; websites execute in isolated workers.
    callback({ cancel: !details.url.startsWith('app://desktop/') });
  });
  let browserRuntime:BrowserRuntime;
  try{
    browserRuntime=new DockerBrowserRuntimeFactory({dataRoot,profileKey:()=>loadBrowserProfileKey(dataRoot),seccompPath:join(__dirname,'browser-seccomp.json'),
      testFixture:process.env.AW_BROWSER_TEST_FIXTURE==='1'&&!!process.env.AW_DATA_ROOT&&dataRoot.includes('/.test-data/'),
      reserveStorage:async bytes=>{if(!coordinator)throw new Error('coordinator_closed');return coordinator.artifacts.reserveExternal('browser-profile',bytes);}});
  }catch{browserRuntime={...unavailableRuntime,async status(){return{ready:false,message:'Local login storage could not be unlocked. Unlock the macOS login keychain and restart the app.'};}};}
  const nativeBrowser=new NativeChromeRuntime({dataRoot,extensionPath:join(app.getAppPath(),'extensions/agent-browser'),hostPath:join(app.getAppPath(),'packages/native-browser/native-host.mjs'),onChanged:()=>{if(window&&!window.isDestroyed())window.webContents.send(BROWSER_CHANGED_CHANNEL);}});
  const browserRouter=new BrowserRuntimeRouter({dataRoot,desktop:nativeBrowser,docker:browserRuntime,defaultBackend:process.env.AW_BROWSER_TEST_FIXTURE==='1'&&!!process.env.AW_DATA_ROOT&&dataRoot.includes('/.test-data/')?'docker':'desktop_chrome'});
  const localLab=new LocalLabController({serverPath:join(app.getAppPath(),'labs/harbor-desk/server.mjs'),cookies:agentId=>labBrowser.cookies(agentId)});
  const labBrowser=new ElectronLabRuntime(localLab);
  browserRuntime={status:agentId=>agentId&&coordinator?.fleets.isLabAgent(agentId)?labBrowser.status():browserRouter.status(agentId),launch:options=>coordinator?.fleets.isLabAgent(options.agentId)?labBrowser.launch(options):browserRouter.launch(options),reconcile:async()=>{await browserRouter.reconcile();await labBrowser.reconcile();},close:async()=>{await labBrowser.close();await browserRouter.close();}};
  const codeRuntime = new DockerCodeRuntimeFactory({ dataRoot });
  const credentials = new MacKeychainCredentials({ helperPath: join(app.getAppPath(), 'packages/model-adapters/bin/keychain-helper') });
  const modelAdapter = new OpenAIResponsesAdapter({ credentials });
  const modelProviders = new ProviderRegistry({ filePath: join(dataRoot, 'control', 'model-providers.json'), legacyAdapter: modelAdapter,
    credentials: profile => new MacKeychainCredentials({ helperPath: join(app.getAppPath(), 'packages/model-adapters/bin/keychain-helper'), account: providerCredentialAccount(profile) }) });
  const gmail = new GmailService({ store: new MacGmailSecretStore({ helperPath: join(app.getAppPath(), 'packages/gmail/bin/keychain-helper') }),
    openExternal: async url => {
      const target = new URL(url);
      if (target.origin !== 'https://accounts.google.com' || target.pathname !== '/o/oauth2/v2/auth' || target.username || target.password) throw new GmailError('oauth_failed');
      await shell.openExternal(url);
    }, onChanged: () => {
      if (window && !window.isDestroyed()) window.webContents.send(GMAIL_CHANGED_CHANNEL);
      void coordinator?.live.gmailChanged().catch(() => { /* Saved requests remain pending if reconciliation is interrupted. */ });
    } });
  const googleWorkspace=new GoogleWorkspaceService({store:new MacGmailSecretStore({helperPath:join(app.getAppPath(),'packages/google-workspace/bin/keychain-helper')}),openExternal:async url=>{const target=new URL(url);if(target.origin!=='https://accounts.google.com'||target.pathname!=='/o/oauth2/v2/auth'||target.username||target.password)throw new GoogleWorkspaceError('oauth_failed');await shell.openExternal(url);},onChanged:()=>{if(window&&!window.isDestroyed())window.webContents.send(GOOGLE_WORKSPACE_CHANGED_CHANNEL);notifyChanges();}});
  closeGoogle=()=>googleWorkspace.close();
  coordinator = new Coordinator({ dataRoot, localLab, browserRuntime, codeRuntime, modelAdapter, modelResolver: selection=>modelProviders.resolve(selection), modelCatalog: ()=>modelProviders.options(), gmail, onCollaborationChanged:()=>{notifyChanges();coordinator?.live.tick();}, onRequestsChanged: () => {
    if (window && !window.isDestroyed()) window.webContents.send(REQUEST_CHANGED_CHANNEL);
    notifyChanges();
  }, onLiveChanged: () => {
    if (window && !window.isDestroyed()) window.webContents.send(LIVE_CHANGED_CHANNEL);
    notifyChanges();
  }, onCodeChanged: () => {
    if (window && !window.isDestroyed()) window.webContents.send(CODE_CHANGED_CHANNEL);
    notifyChanges();
  }, onBrowserChanged:()=>{
    if(window&&!window.isDestroyed())window.webContents.send(BROWSER_CHANGED_CHANNEL);notifyChanges();
  } });
  await coordinator.artifacts.ready;
  await coordinator.browser.ready;
  await coordinator.code.ready;
  await coordinator.requests.ready;
  await coordinator.live.ready;
  const gmailReview=new GmailReviewController(coordinator);
  const googleController=new GoogleWorkspaceController(googleWorkspace,coordinator);
  const browserSetup=new BrowserSetupController(coordinator,browserRouter,nativeBrowser);
  window = new BrowserWindow({
    width: 1380, height: 900, minWidth: 760, minHeight: 560,
    title: 'Agent Workspaces', backgroundColor: '#f7f9f9', show: false,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'), contextIsolation: true,
      sandbox: true, nodeIntegration: false, nodeIntegrationInWorker: false,
      webSecurity: true, allowRunningInsecureContent: false,
      webviewTag: false, navigateOnDragDrop: false,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.on('ready-to-show', () => window?.show());
  window.on('closed', () => { window = null; });
  registerIpc(COMMAND_CHANNEL, (event, raw: unknown): CommandResult => {
    const frame = event.senderFrame;
    if (closing || maintenanceGate || coordinator?.maintenanceActive || !window || !coordinator || !frame || !isTrustedSender({
      senderId: event.sender.id, trustedWebContentsId: window.webContents.id,
      isMainFrame: frame === window.webContents.mainFrame, url: frame.url,
    })) return { ok: false, error: { code: 'permission_denied', message: 'This window cannot issue application commands.' } };
    const now = Date.now();

    if(!ipcAdmission.admit(COMMAND_CHANNEL,raw,now)) return { ok: false, error: { code: 'rate_limited', message: 'Too many requests. Try again in a few seconds.' } };
    try {
      const command = parseCommand(raw);
      const snapshot = coordinator.handle(command);
      if (command.type !== 'snapshot') notifyChanges();
      return { ok: true, snapshot };
    } catch (error) {
      if (error instanceof CommandValidationError) return { ok: false, error: { code: error.code, message: error.message } };
      // Domain errors are reviewed coordinator messages; filesystem/SQL internals stay off IPC.
      if (error instanceof Error && 'code' in error && typeof error.code === 'string' && ['invalid_state', 'not_found', 'stale_revision', 'stale_generation', 'lease_expired', 'capacity_limit', 'permission_denied', 'conflict', 'invalid_command'].includes(error.code)) return { ok: false, error: { code: error.code, message: error.message } };
      return { ok: false, error: { code: 'operation_failed', message: 'The operation could not finish. Your last saved progress is preserved.' } };
    }
  });
  registerIpc(BROWSER_CHANNEL,async(event,raw:unknown)=>{
    const frame=event.senderFrame,current=coordinator;
    if(closing||maintenanceGate||coordinator?.maintenanceActive||!window||!current||!frame||!isTrustedSender({senderId:event.sender.id,trustedWebContentsId:window.webContents.id,isMainFrame:frame===window.webContents.mainFrame,url:frame.url}))return{ok:false,error:{code:'permission_denied',message:'This window cannot control browsers.'}};
    const now=Date.now();
    if(!ipcAdmission.admit(BROWSER_CHANNEL,raw,now))return{ok:false,error:{code:'rate_limited',message:'Too many browser requests. Wait a moment and refresh.'}};
    try{return{ok:true,value:await current.browser.handle(raw)};}
    catch(error){if(error instanceof BrowserError||error instanceof CommandValidationError||error instanceof ArtifactError)return{ok:false,error:{code:error.code,message:error.message}};
      return{ok:false,error:{code:'browser_action_failed',message:'The browser action could not finish. Refresh the view before trying another action.'}};
    }finally{notifyChanges();}
  });
  registerIpc(HISTORY_CHANNEL,async(event,raw:unknown)=>{
    const frame=event.senderFrame,current=coordinator;
    if(closing||maintenanceGate||current?.maintenanceActive||!window||!current||!frame||!isTrustedSender({senderId:event.sender.id,trustedWebContentsId:window.webContents.id,isMainFrame:frame===window.webContents.mainFrame,url:frame.url}))return{ok:false,error:{code:'permission_denied',message:'This window cannot inspect task history.'}};
    if(!ipcAdmission.admit(HISTORY_CHANNEL,raw,Date.now()))return{ok:false,error:{code:'rate_limited',message:'Wait a moment and refresh.'}};
    try{return{ok:true,value:current.taskHistory(raw)};}catch(error){if(error instanceof CoordinatorError||error instanceof LiveError)return{ok:false,error:{code:error.code,message:error.message}};return{ok:false,error:{code:'history_failed',message:'Task history could not be read. Refresh before retrying.'}};}finally{if(raw&&typeof raw==='object'&&'type' in raw&&raw.type==='tasks.archive')notifyChanges();}
  });
  registerIpc(GRANTS_CHANNEL,async(event,raw:unknown)=>{
    const frame=event.senderFrame,current=coordinator;
    if(closing||maintenanceGate||current?.maintenanceActive||!window||!current||!frame||!isTrustedSender({senderId:event.sender.id,trustedWebContentsId:window.webContents.id,isMainFrame:frame===window.webContents.mainFrame,url:frame.url}))return{ok:false,error:{code:'permission_denied',message:'This window cannot review exact capability grants.'}};
    if(!ipcAdmission.admit(GRANTS_CHANNEL,raw,Date.now()))return{ok:false,error:{code:'rate_limited',message:'Wait a moment and refresh.'}};
    try{const c=record(raw,['type','taskId','requestId']);if(c.type==='grants.list'){record(raw,['type','taskId']);return{ok:true,value:c.taskId===null?current.requests.grants():current.requests.grants(identity(c.taskId))};}if(c.type==='grants.revoke'){record(raw,['type','requestId']);return{ok:true,value:current.requests.revokeGrant(identity(c.requestId))};}throw new CommandValidationError('Choose a supported grant action.');}
    catch(error){if(error instanceof RequestError||error instanceof LiveError||error instanceof CommandValidationError)return{ok:false,error:{code:error.code,message:error.message}};return{ok:false,error:{code:'operation_failed',message:'The grant action could not finish. Refresh before retrying.'}};}
    finally{notifyChanges();}
  });
  const modelConnection = new ModelConnectionController(credentials,async()=>Boolean(coordinator?.live.hasInFlightWork||coordinator?.snapshot().tasks.some(t=>t.executionMode==='live'&&['queued','running','pausing'].includes(t.state))));
  const providerController = new ProviderController(modelProviders,()=>Boolean(coordinator?.live.hasInFlightWork||coordinator?.snapshot().tasks.some(t=>t.executionMode==='live'&&['queued','running','pausing'].includes(t.state))));
  for(const channel of [FLEET_CHANNEL,SECURITY_REVIEW_CHANNEL,TASK_RECOVERY_CHANNEL,COLLABORATION_CHANNEL,BROWSER_SETUP_CHANNEL,WORKFLOWS_CHANNEL,GMAIL_REVIEW_CHANNEL,GOOGLE_WORKSPACE_CHANNEL,BROWSER_ACTIONS_CHANNEL,ROUTINES_CHANNEL,PROJECTS_CHANNEL,RESULTS_CHANNEL,READINESS_CHANNEL])registerIpc(channel,async(event,raw:unknown)=>{
    const frame=event.senderFrame,current=coordinator;
    if(closing||maintenanceGate||coordinator?.maintenanceActive||!window||!current||!frame||!isTrustedSender({senderId:event.sender.id,trustedWebContentsId:window.webContents.id,isMainFrame:frame===window.webContents.mainFrame,url:frame.url}))return{ok:false,error:{code:'permission_denied',message:'This window cannot change workspace coordination.'}};
    const now=Date.now();if(!ipcAdmission.admit(channel,raw,now))return{ok:false,error:{code:'rate_limited',message:'Wait a moment and refresh.'}};
    try{if(channel===SECURITY_REVIEW_CHANNEL&&raw&&typeof raw==='object'&&'type' in raw&&raw.type==='securityReview.create')throw new SecurityReviewError('feature_retired','Use Fleets to start an automatic team. Existing review tasks and results are preserved.');return{ok:true,value:await(channel===FLEET_CHANNEL?current.fleets.handle(raw):channel===SECURITY_REVIEW_CHANNEL?current.securityReviews.handle(raw):channel===TASK_RECOVERY_CHANNEL?current.taskRecovery.handle(raw):channel===GMAIL_REVIEW_CHANNEL?gmailReview.handle(raw):channel===GOOGLE_WORKSPACE_CHANNEL?googleController.handle(raw):channel===BROWSER_ACTIONS_CHANNEL?current.browserActions.handle(raw):channel===ROUTINES_CHANNEL?current.routines.handle(raw):channel===PROJECTS_CHANNEL?current.handleProjects(raw,async()=>googleWorkspace.verifiedConnectedAccount()):channel===RESULTS_CHANNEL?current.results.handle(raw):channel===READINESS_CHANNEL?current.readiness.handle(raw):channel===WORKFLOWS_CHANNEL?current.workflows.handle(raw):channel===COLLABORATION_CHANNEL?current.collaboration.handle(raw):browserSetup.handle(raw))};}
    catch(error){if(error instanceof FleetError||error instanceof SecurityReviewError||error instanceof GmailError||error instanceof GoogleWorkspaceError||error instanceof BrowserActionError||error instanceof RoutineError||error instanceof ProjectError||error instanceof ModelConnectionError||error instanceof ReadinessError||error instanceof DocumentError||error instanceof CredentialError||error instanceof ResultError||error instanceof WorkflowError||error instanceof CoordinatorError||error instanceof CollaborationError||error instanceof BrowserError||error instanceof CommandValidationError)return{ok:false,error:{code:error.code,message:error.message}};return{ok:false,error:{code:'operation_failed',message:'This change could not finish. Saved tasks and files are preserved.'}};}
    finally{notifyChanges();}
  });
  registerIpc(MODEL_CONNECTION_CHANNEL,async(event,raw:unknown)=>{
    const frame=event.senderFrame;
    if(closing||maintenanceGate||coordinator?.maintenanceActive||!window||!coordinator||!frame||!isTrustedSender({senderId:event.sender.id,trustedWebContentsId:window.webContents.id,isMainFrame:frame===window.webContents.mainFrame,url:frame.url}))return{ok:false,error:{code:'busy',message:'Wait for the current workspace change before updating your model connection.'}};
    try{return{ok:true,value:await appMaintenance(async()=>{const current=coordinator!;await current.routines.suspend();try{if(current.live.hasInFlightWork)throw new ModelConnectionError('busy','Pause active tasks and wait for their current step to stop before changing the model key.');await current.live.suspend();return await modelConnection.handle(raw);}finally{current.live.resumeScheduling();current.routines.resume();}})};}
    catch(error){if(error instanceof ModelConnectionError)return{ok:false,error:{code:error.code,message:error.message}};return{ok:false,error:{code:'connection_failed',message:'The connection could not be updated.'}};}
  },false);
  registerIpc(MODEL_PROVIDERS_CHANNEL,async(event,raw:unknown)=>{
    const frame=event.senderFrame;
    if(closing||maintenanceGate||coordinator?.maintenanceActive||!window||!coordinator||!frame||!isTrustedSender({senderId:event.sender.id,trustedWebContentsId:window.webContents.id,isMainFrame:frame===window.webContents.mainFrame,url:frame.url}))return{ok:false,error:{code:'busy',message:'Wait for the current workspace change before updating model connections.'}};
    const now=Date.now();if(!ipcAdmission.admit(MODEL_PROVIDERS_CHANNEL,raw,now))return{ok:false,error:{code:'rate_limited',message:'Wait a moment and refresh.'}};
    try {
      // State only reads immutable metadata and Keychain presence; it never writes or contacts a model.
      if(raw&&typeof raw==='object'&&!Array.isArray(raw)&&(raw as {type?:unknown}).type==='providers.state')return{ok:true,value:await providerController.handle(raw)};
      const value=await appMaintenance(async()=>{const current=coordinator!;await current.routines.suspend();try{
        if(current.live.hasInFlightWork)throw new ProviderConfigurationError('provider_busy','Pause active tasks and wait for their current step to stop before changing model connections.');
        await current.live.suspend();return await providerController.handle(raw);
      }finally{current.live.resumeScheduling();current.routines.resume();}});
      if(window&&!window.isDestroyed())window.webContents.send(LIVE_CHANGED_CHANNEL);
      return{ok:true,value};
    }catch(error){if(error instanceof ProviderConfigurationError)return{ok:false,error:{code:error.code,message:error.message}};return{ok:false,error:{code:'connection_failed',message:'The model connection could not be updated. Saved revisions are preserved.'}};}
  },false);
  registerIpc(CODE_CHANNEL, async (event, raw: unknown) => {
    const frame = event.senderFrame, current = coordinator;
    if (closing || maintenanceGate || coordinator?.maintenanceActive || !window || !current || !frame || !isTrustedSender({ senderId: event.sender.id, trustedWebContentsId: window.webContents.id, isMainFrame: frame === window.webContents.mainFrame, url: frame.url })) return { ok: false, error: { code: 'permission_denied', message: 'This window cannot execute code.' } };
    const now = Date.now();

    if(!ipcAdmission.admit(CODE_CHANNEL,raw,now)) return { ok: false, error: { code: 'rate_limited', message: 'Too many execution requests. Wait a moment and refresh code status.' } };
    try { return { ok: true, value: await current.code.handle(raw) }; }
    catch (error) {
      if (error instanceof CodeError || error instanceof CommandValidationError || error instanceof ArtifactError) return { ok: false, error: { code: error.code, message: error.message } };
      return { ok: false, error: { code: 'code_action_failed', message: 'The code operation did not finish. Read its current status before trying again. Existing committed files are preserved.' } };
    } finally { notifyChanges(); }
  });
  const gmailConnection = new GmailController(gmail, async taskId => {
    const current = coordinator;
    if (!current || closing) return null;
    const task = current.snapshot().tasks.find(item => item.id === taskId);
    if (!task || task.executionMode !== 'live') return null;
    const saved = (await current.live.handle({ type: 'live.state' })).tasks.find(item => item.taskId === taskId);
    return saved?.policy.mode === 'read_only_browser' && saved.policy.allowedOrigins.includes('https://mail.google.com') ? saved.policy.mailAccount || null : null;
  }, async () => {
    if (!window || closing) return null;
    const chosen = await dialog.showOpenDialog(window, {
      title: 'Import Google Desktop OAuth client', buttonLabel: 'Import secure configuration',
      message: 'Choose the Desktop app client JSON from your Google Cloud project. Replacing it clears the saved Gmail connection. Configuration stays in the macOS Keychain and is never added to agent files.',
      properties: ['openFile', 'noResolveAliases'], filters: [{ name: 'Google Desktop OAuth client JSON', extensions: ['json'] }],
    });
    return chosen.canceled ? null : chosen.filePaths[0] || null;
  });
  for (const channel of [GMAIL_CHANNEL, GMAIL_IMPORT_CHANNEL]) registerIpc(channel, async (event, raw: unknown) => {
    const frame = event.senderFrame;
    if (closing || maintenanceGate || coordinator?.maintenanceActive || !window || !coordinator || !frame || !isTrustedSender({ senderId: event.sender.id, trustedWebContentsId: window.webContents.id, isMainFrame: frame === window.webContents.mainFrame, url: frame.url })) return { ok: false, error: { code: 'permission_denied', message: 'This window cannot configure Gmail.' } };
    const now = Date.now();
    if(!ipcAdmission.admit(channel,raw,now)) return { ok: false, error: { code: 'rate_limited', message: 'Too many connection requests. Wait a moment and refresh.' } };
    try { return { ok: true, value: await (channel === GMAIL_IMPORT_CHANNEL ? gmailConnection.importClient(raw) : gmailConnection.handle(raw)) }; }
    catch (error) {
      if (error instanceof GmailError || error instanceof GmailControllerError) return { ok: false, error: { code: error.code, message: error.message } };
      return { ok: false, error: { code: 'gmail_unavailable', message: 'The Gmail connection could not be updated. Refresh its status before trying again.' } };
    }finally{void coordinator?.handleProjects({type:'projects.state'}).catch(()=>{});notifyChanges();}
  });
  const googlePicker=new GmailController(googleWorkspace,async()=>null,async()=>{
    if(!window||closing)return null;
    const selected=await dialog.showOpenDialog(window,{title:'Import Google Desktop OAuth client for Drive and Sheets',buttonLabel:'Import configuration',message:'Enable Google Drive and Google Sheets APIs for this client. Credentials are stored separately from Gmail.',properties:['openFile','noResolveAliases'],filters:[{name:'Desktop OAuth client JSON',extensions:['json']}]});return selected.canceled?null:selected.filePaths[0]||null;
  });
  registerIpc(GOOGLE_WORKSPACE_CHANNEL+':import-client',async(event,raw:unknown)=>{
    const frame=event.senderFrame;if(closing||maintenanceGate||!window||!frame||!isTrustedSender({senderId:event.sender.id,trustedWebContentsId:window.webContents.id,isMainFrame:frame===window.webContents.mainFrame,url:frame.url}))return{ok:false,error:{code:'permission_denied',message:'This window cannot import a connection.'}};
    try{const result=await googlePicker.importClient(raw);return{ok:true,value:{...result,state:await googleWorkspace.status()}};}catch(error){return{ok:false,error:{code:'connection_failed',message:error instanceof GoogleWorkspaceError||error instanceof GmailControllerError?error.message:'The Google connection could not be imported.'}};}
  });
  const requestFiles = new RequestController(coordinator, async (request, label) => {
    if (!window || closing) return null;
    const owner = coordinator?.snapshot().agents.find(agent => agent.id === request.agentId)?.name || 'Selected agent';
    const result = await dialog.showOpenDialog(window, {
      title: `Supply ${label}`, buttonLabel: 'Import for validation',
      message: `Private to ${owner}. This copy will be checked for “${request.title}” before it becomes a task input.`,
      properties: ['openFile', 'noResolveAliases'],
      filters: [{ name: 'Supported files', extensions: ['txt', 'md', 'csv', 'json', 'pdf', 'xlsx', 'png', 'jpg', 'jpeg'] }, { name: 'All files', extensions: ['*'] }],
    });
    return result.canceled ? null : result.filePaths[0] || null;
  });
  for (const [channel, handler] of [[LIVE_CHANNEL, (raw: unknown) => coordinator!.live.handle(raw)], [REQUEST_CHANNEL, (raw: unknown) => coordinator!.requests.handle(raw)], [REQUEST_PICK_CHANNEL, (raw: unknown) => requestFiles.pick(raw)]] as const) {
    registerIpc(channel, async (event, raw: unknown) => {
      const frame = event.senderFrame;
      if (closing || maintenanceGate || coordinator?.maintenanceActive || !window || !coordinator || !frame || !isTrustedSender({ senderId: event.sender.id, trustedWebContentsId: window.webContents.id, isMainFrame: frame === window.webContents.mainFrame, url: frame.url })) return { ok: false, error: { code: 'permission_denied', message: 'This window cannot operate live tasks or requests.' } };
      const now = Date.now();

      if(!ipcAdmission.admit(channel,raw,now)) return { ok: false, error: { code: 'rate_limited', message: 'Too many requests. Wait a moment and refresh.' } };
      try { return { ok: true, value: await handler(raw) }; }
      catch (error) {
        if (error instanceof FleetError || error instanceof LiveError || error instanceof RequestError || error instanceof CommandValidationError || error instanceof ArtifactError || error instanceof CoordinatorError || error instanceof ModelAdapterError || error instanceof CredentialError || error instanceof WorkflowError || error instanceof ResultError) return { ok: false, error: { code: error.code, message: error.message } };
        return { ok: false, error: { code: 'operation_failed', message: 'This task operation did not finish. Refresh its current state before trying again; no retry was sent.' } };
      } finally {
        // A status read must not notify its own subscribers and create a polling loop.
        const type = raw && typeof raw === 'object' ? (raw as { type?: unknown }).type : null;
        if (!((channel === LIVE_CHANNEL && type === 'live.state') || (channel === REQUEST_CHANNEL && type === 'requests.list'))) notifyChanges();
      }
    });
  }
  const files = new FileController(coordinator, {
    async pickFolder(){if(!window)return null;const selected=await dialog.showOpenDialog(window,{title:'Review a bounded repository snapshot',buttonLabel:'Preview folder',message:'Read a small local source pilot, then review captured paths and exclusions before saving. Nothing is sent to a model.',properties:['openDirectory','noResolveAliases']});return selected.canceled?null:selected.filePaths[0]||null;},
    async pick(target, singleFile) {
      if (!window) return [];
      const recipient = target.scope === 'shared' ? 'Personal workspace · shared files' : coordinator?.snapshot().agents.find(agent => agent.id === target.agentId)?.name || 'Selected agent';
      const result = await dialog.showOpenDialog(window, {
        title: singleFile ? 'Add an immutable file version' : 'Import files',
        buttonLabel: 'Import copies',
        message: `Destination: ${recipient}. ${target.scope === 'private' ? 'Private to this agent.' : 'These files will be shared with agents in Personal workspace.'} Originals remain unchanged.`,
        properties: singleFile ? ['openFile', 'noResolveAliases'] : ['openFile', 'multiSelections', 'noResolveAliases'],
        filters: [{ name: 'Supported documents', extensions: ['txt', 'md', 'csv', 'json', 'pdf', 'xlsx', 'png', 'jpg', 'jpeg'] }, { name: 'All files (metadata only for other formats)', extensions: ['*'] }],
      });
      return result.canceled ? [] : result.filePaths;
    },
    async save(displayName) {
      if (!window) return null;
      const safeName = displayName.replace(/[\\/:\u0000-\u001f]/g, '_').slice(0, 180) || 'export';
      const result = await dialog.showSaveDialog(window, {
        title: 'Export a verified file copy', buttonLabel: 'Export copy',
        defaultPath: join(app.getPath('downloads'), safeName),
        message: 'Choose a new filename. Existing files are preserved.',
      });
      return result.canceled ? null : result.filePath || null;
    },
  });
  for (const [channel, handler] of [[FILES_CHANNEL, (raw: unknown) => files.run(raw)], [DROP_CHANNEL, (raw: unknown) => files.drop(raw)], [PREVIEW_CHANNEL, (raw: unknown) => files.preview(raw)]] as const) {
    registerIpc(channel, async (event, raw: unknown) => {
      const frame = event.senderFrame;
      if (closing || maintenanceGate || coordinator?.maintenanceActive || !window || !frame || !isTrustedSender({ senderId: event.sender.id, trustedWebContentsId: window.webContents.id, isMainFrame: frame === window.webContents.mainFrame, url: frame.url })) return { ok: false, error: { code: 'permission_denied', message: 'This window cannot access workspace files.' } };
      const now = Date.now();

      if(!ipcAdmission.admit(channel,raw,now)) return { ok: false, error: { code: 'rate_limited', message: 'Too many requests. Try again in a few seconds.' } };
      try { return { ok: true, value: await handler(raw) }; }
      catch (error) {
        if (error instanceof CommandValidationError || error instanceof ArtifactError || error instanceof RepositorySnapshotError) return { ok: false, error: { code: error.code, message: error.message } };
        return { ok: false, error: { code: 'operation_failed', message: 'The file operation did not finish. Existing committed files are preserved.' } };
      } finally { notifyChanges(); }
    });
  }
  const reportExport = new ReportExportController({results:coordinator.results,artifacts:coordinator.artifacts,renderPdf:renderIsolatedReportPdf,formatOffice:(source,format)=>formatOfficeInWorker(join(app.getAppPath(),'dist/main/report-format-worker.cjs'),source,format),saveDialog:async(suggestedName,format)=>{
    if(!window||closing)return null;
    const result=await dialog.showSaveDialog(window,{title:'Export a formatted report',defaultPath:suggestedName,buttonLabel:'Export report',properties:['createDirectory','showOverwriteConfirmation','dontAddToRecent'],filters:[{name:format==='pdf'?'PDF document':format==='docx'?'Word document':'Excel workbook',extensions:[format]}]});
    return result.canceled?null:result.filePath||null;
  }});
  registerIpc(REPORT_EXPORT_CHANNEL,async(event,raw:unknown)=>{
    const frame=event.senderFrame;
    if(closing||maintenanceGate||coordinator?.maintenanceActive||!window||!coordinator||!frame||!isTrustedSender({senderId:event.sender.id,trustedWebContentsId:window.webContents.id,isMainFrame:frame===window.webContents.mainFrame,url:frame.url}))return{ok:false,error:{code:'permission_denied',message:'This window cannot export reports.'}};
    const now=Date.now();if(!ipcAdmission.admit(REPORT_EXPORT_CHANNEL,raw,now))return{ok:false,error:{code:'rate_limited',message:'Wait a moment before starting another export.'}};
    try{return{ok:true,value:await reportExport.handle(raw)};}
    catch(error){if(error instanceof ResultError||error instanceof ArtifactError||error instanceof LiveError)return{ok:false,error:{code:error.code,message:error.message}};return{ok:false,error:{code:'report_export_failed',message:'The report could not be exported. Choose a supported saved result and a writable destination; the source file is preserved.'}};}
  });
  const recovery = new RecoveryController(coordinator.recovery, async purpose=>{
    if(!window||closing)return null;
    const result=await dialog.showOpenDialog(window,{title:purpose==='source'?'Choose an Agent Workspaces backup':purpose==='backup'?'Choose where to save a backup':'Choose where to restore a separate copy',buttonLabel:'Choose folder',properties:['openDirectory','createDirectory','noResolveAliases']});
    return result.canceled?null:result.filePaths[0]||null;
  });
  registerIpc(RECOVERY_CHANNEL, async(event,raw:unknown)=>{
    const frame=event.senderFrame;
    if(closing||maintenanceGate||!window||!coordinator||!frame||!isTrustedSender({senderId:event.sender.id,trustedWebContentsId:window.webContents.id,isMainFrame:frame===window.webContents.mainFrame,url:frame.url}))return{ok:false,error:{code:'busy',message:'Recovery is unavailable while another checkpoint is running.'}};
    try{return{ok:true,value:await appMaintenance(()=>recovery.handle(raw))};}
    catch(error){return{ok:false,error:safeRecoveryFailure(error)};}
  },false);
  powerMonitor.on('suspend',()=>{
    if(closing||!coordinator)return;
    sleepRequested=true;
    // Abort model work immediately, even while a native folder picker is open.
    // appMaintenance retains the pending sleep checkpoint until that operation exits.
    const current=coordinator,taskIds=current.snapshot().tasks.map(task=>task.id);
    const stops=Promise.allSettled([current.fleets.suspend(),current.live.suspend(),current.routines.suspend(),current.code.stopAndDrain(),...taskIds.map(id=>current.browser.stopForTask(id))]);
    sleepWork=Promise.allSettled([sleepWork,stops]);
    if(!maintenanceGate)void appMaintenance(async()=>undefined).catch(()=>console.error('Sleep checkpoint was interrupted; saved work will need review before resuming.'));
  });
  powerMonitor.on('resume',()=>{coordinator?.fleets.resume();notifyChanges();});
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Agent Workspaces', submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] },
    { role: 'editMenu' },
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }] },
    { role: 'windowMenu' },
  ]));
  await window.loadURL(APP_URL);
  timer = setInterval(() => {
    try { if(!maintenanceGate){coordinator?.tick();coordinator?.routines.tick();} notifyChanges(); }
    catch { console.error('A coordinator tick failed; persisted task state is retained.'); }
  }, 1500);
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (window?.isMinimized()) window.restore(); window?.show(); window?.focus(); });
  app.whenReady().then(launch).catch(error => {
    console.error('Agent Workspaces failed to start:', error instanceof Error ? error.message : 'Unknown error');
    dialog.showErrorBox('Agent Workspaces could not start', 'The local database or bundled application could not be opened. Check your data folder and run npm run build again.');
    app.quit();
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', event => {
    if (!coordinator) return;
    event.preventDefault();
    if(closing)return;
    closing = true;
    if (timer) clearInterval(timer);
    const current = coordinator;
    // Keep the internal storage reservation available until profile checkpoints finish.
    // IPC is fenced by closing; the window is already closing or hidden.
    void Promise.allSettled([maintenanceWork,sleepWork,...pendingIpc]).then(async()=>{await closeGoogle?.();await current.shutdown();}).catch(()=>{console.error('Runtime shutdown was interrupted; the last saved checkpoints are retained.');current.close();}).finally(()=>{coordinator=null;app.quit();});
  });
  process.on('SIGTERM', () => app.quit());
  process.on('SIGINT', () => app.quit());
}
