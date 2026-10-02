import {parseCommand} from '../../../packages/contracts/validation';
import {parseLiveCommand} from '../../../packages/contracts/live-validation';
import {parseCodeCommand} from '../../../packages/contracts/code-validation';
import {parseBrowserCommand} from '../../../packages/contracts/browser-validation';
import {COMMAND_CHANNEL,LIVE_CHANNEL,CODE_CHANNEL,BROWSER_CHANNEL} from '../../../packages/contracts';
/** Called only after trusted sender/lifecycle checks. Invalid payloads get no priority. */
export function isValidatedStopControl(channel:string,raw:unknown):boolean{
 try{
  if(channel===COMMAND_CHANNEL){const c=parseCommand(raw);return c.type==='tasks.pause'||c.type==='tasks.cancel';}
  if(channel===LIVE_CHANNEL){const c=parseLiveCommand(raw);return c.type==='live.pause'||c.type==='live.stop';}
  if(channel===CODE_CHANNEL)return parseCodeCommand(raw).type==='code.stop';
  if(channel===BROWSER_CHANNEL)return parseBrowserCommand(raw).type==='browser.close';
 }catch{}
 return false;
}
/** Separate finite reserve keeps owner interruption available during read bursts. */
export class IpcAdmission {
 private windowAt=0;private ordinary=0;private controls=0;
 admit(channel:string,raw:unknown,now:number):boolean{
  if(now-this.windowAt>=5000||now<this.windowAt){this.windowAt=now;this.ordinary=0;this.controls=0;}
  return isValidatedStopControl(channel,raw)?++this.controls<=32:++this.ordinary<=256;
 }
}
