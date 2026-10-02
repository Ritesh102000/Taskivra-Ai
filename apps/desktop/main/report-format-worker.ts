import {parentPort} from 'node:worker_threads';
import {createDocxReport,createXlsxReport,type ExportSource} from '../../../packages/report-export';
parentPort!.once('message',({source,format}:{source:ExportSource;format:'docx'|'xlsx'})=>{
 try {const bytes=format==='docx'?createDocxReport(source):createXlsxReport(source);parentPort!.postMessage({ok:true,bytes});}
 catch {parentPort!.postMessage({ok:false,message:'This report could not be formatted safely. Export the exact original file or reduce the report size.'});}
});
