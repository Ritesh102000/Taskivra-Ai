import type {RoutineTiming} from '../contracts/routines';
export class RoutineScheduleError extends Error {}
const formatters=new Map<string,Intl.DateTimeFormat>();
export function localParts(at:number,timezone:string) {
 let f=formatters.get(timezone);if(!f){f=new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',weekday:'short',hourCycle:'h23'});formatters.set(timezone,f);}
 const p=Object.fromEntries(f.formatToParts(new Date(at)).map(v=>[v.type,v.value]));
 return{date:`${p.year}-${p.month}-${p.day}`,hour:Number(p.hour),minute:Number(p.minute),weekday:['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(p.weekday)};
}
export function nextOccurrence(after:number,timing:RoutineTiming):number {
 if(!timing||!Array.isArray(timing.weekdays)||!timing.weekdays.length||timing.weekdays.some(d=>!Number.isInteger(d)||d<0||d>6)||!Number.isInteger(timing.hour)||timing.hour<0||timing.hour>23||!Number.isInteger(timing.minute)||timing.minute<0||timing.minute>59)throw new RoutineScheduleError('Invalid saved schedule.');
 try{localParts(after,timing.timezone);}catch(error){if(error instanceof RangeError)throw new RoutineScheduleError('Invalid saved timezone.');throw error;}
 // Search actual instants: spring-forward missing times are skipped; the durable
 // local-date occurrence key prevents a fall-back hour dispatching twice.
 for(let at=Math.floor(after/60000)*60000+60000,end=at+16*86400000;at<end;at+=60000){const p=localParts(at,timing.timezone);if(p.hour===timing.hour&&p.minute===timing.minute&&timing.weekdays.includes(p.weekday))return at;}
 throw new RoutineScheduleError('No valid occurrence in the next sixteen days.');
}
