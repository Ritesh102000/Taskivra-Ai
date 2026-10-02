import {Worker} from 'node:worker_threads';
import type {ExportSource} from '../../../packages/report-export';
/** One admitted export at a time in ReportExportController; worker receives only the checksum-proven source. */
export function formatOfficeInWorker(path:string,source:ExportSource,format:'docx'|'xlsx'):Promise<Buffer> {
 return new Promise((resolve,reject)=>{const worker=new Worker(path);let done=false;const finish=(error:Error|null,bytes?:Buffer)=>{if(done)return;done=true;clearTimeout(timer);void worker.terminate();if(error)reject(error);else resolve(bytes!);};const timer=setTimeout(()=>finish(new Error('Report formatting timed out. Export the original file or try a smaller report.')),30000);
 worker.on('message',result=>{if(result?.ok===true&&result.bytes instanceof Uint8Array)finish(null,Buffer.from(result.bytes));else finish(new Error('This report could not be formatted safely. Export the exact original file or reduce the report size.'));});worker.on('error',()=>finish(new Error('The report formatter is unavailable. Rebuild the application or export the original file.')));worker.on('exit',()=>{if(!done)finish(new Error('The report formatter stopped before returning an export. The original file is preserved.'));});worker.postMessage({source,format});});
}
