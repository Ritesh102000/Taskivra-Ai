import {useEffect,useState} from 'react';
import type {AppBridge,Snapshot,Task} from '../../../packages/contracts';
import type {ReadinessAction} from '../../../packages/contracts/readiness';
import {ReadinessPanel} from './Readiness';
export function TaskReadiness({bridge,snapshot,task,onAction}:{bridge:AppBridge;snapshot:Snapshot;task:Task;onAction(action:ReadinessAction):void}) {
 const [revision,setRevision]=useState(0);
 useEffect(()=>{let timer:ReturnType<typeof setTimeout>|undefined;const changed=()=>{clearTimeout(timer);timer=setTimeout(()=>setRevision(n=>n+1),250);};const stops=[bridge.onChanged(changed),bridge.onGmailChanged(changed),bridge.onGoogleWorkspaceChanged(changed),bridge.onCodeChanged(changed),bridge.onBrowserChanged(changed)];return()=>{clearTimeout(timer);for(const stop of stops)stop();};},[bridge]);
 const inputs=new Set(snapshot.taskArtifacts.filter(a=>a.taskId===task.id&&a.role==='input').map(a=>a.versionId));
 return <ReadinessPanel targetKey={task.id+':'+task.revision+':'+revision+':'+snapshot.artifacts.filter(v=>inputs.has(v.id)).map(v=>v.id+':'+v.status+':'+v.format).sort().join(',')} check={()=>bridge.readiness({type:'readiness.check',target:{kind:'task',taskId:task.id}})} onAction={onAction} inputVersions={snapshot.artifacts.filter(v=>inputs.has(v.id)&&v.status==='ready').map(v=>({id:v.id,displayName:v.displayName}))} onAssign={async(slotKey,versionId)=>{await bridge.workflows({type:'workflows.assignInputs',taskId:task.id,assignments:[{slotKey,versionId}]});setRevision(n=>n+1);}}/>;
}
