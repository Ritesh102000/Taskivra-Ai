import {createHash} from 'node:crypto';
import type {RoutineResultChange} from '../contracts/routines';

type Normalized = {format:'csv'|'markdown'; units:string[]; hash:string};
const fingerprint = (value:unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** Strict bounded CSV parser; cells are data, including formulas, and are never evaluated. */
export function csvRows(text:string):string[][] {
 const rows:string[][]=[];let row:string[]=[],cell='',quoted=false,closed=false;
 const cellEnd=()=>{if(cell.length>65536||row.length>=128)throw Error('CSV comparison limit reached.');row.push(cell);cell='';closed=false;};
 const rowEnd=()=>{cellEnd();rows.push(row);row=[];if(rows.length>10001)throw Error('CSV comparison limit reached.');};
 for(let i=0;i<text.length;i++){
  const char=text[i];
  if(quoted){if(char==='"'){if(text[i+1]==='"'){cell+='"';i++;}else{quoted=false;closed=true;}}else cell+=char;}
  else if(char==='"'){if(cell||closed)throw Error('Invalid CSV quoting.');quoted=true;}
  else if(char===',')cellEnd();
  else if(char==='\n'||char==='\r'){if(char==='\r'&&text[i+1]==='\n')i++;rowEnd();}
  else{if(closed)throw Error('Invalid CSV quoting.');cell+=char;}
  if(cell.length>65536)throw Error('CSV comparison limit reached.');
 }
 if(quoted)throw Error('Invalid CSV quoting.');if(cell||row.length||closed)rowEnd();
 if(!rows.length||rows[0].some(v=>!v)||new Set(rows[0]).size!==rows[0].length||rows.some(r=>r.length!==rows[0].length))throw Error('CSV requires distinct column names and consistent rows.');
 return rows;
}
export function normalizeResult(text:string,format:string):Normalized {
 if(Buffer.byteLength(text)>1048576||text.includes('\0'))throw Error('Comparison requires a complete text result up to 1 MiB.');
 text=text.replace(/^\uFEFF/,'').replace(/\r\n?/g,'\n');
 if(format==='csv'){
  const [headers,...rows]=csvRows(text),indexes=headers.map((_,i)=>i).sort((a,b)=>headers[a].localeCompare(headers[b],'en'));
  const columns=indexes.map(i=>headers[i]),units=rows.map(row=>JSON.stringify(indexes.map(i=>row[i]))).sort();
  // Include a column declaration so adding or renaming an empty column still counts.
  units.unshift('Columns: '+JSON.stringify(columns));
  return{format:'csv',units,hash:fingerprint({format:'csv',units})};
 }
 if(!['markdown','md','text','txt'].includes(format))throw Error('Only complete Markdown, text and CSV results support comparison.');
 const units:string[]=[];let paragraph:string[]=[],code:string[]|null=null,fence:string|null=null;
 const flush=()=>{if(paragraph.length){units.push(paragraph.join(' ').replace(/[\t ]+/g,' ').trim());paragraph=[];}};
 for(const line of text.split('\n')){
  const mark=line.match(/^\s*(`{3,}|~{3,})/);
  if(code){code.push(line.replace(/[\t ]+$/,''));if(mark&&mark[1][0]===fence![0]&&mark[1].length>=fence!.length){units.push(code.join('\n'));code=null;fence=null;}continue;}
  if(mark){flush();fence=mark[1];code=[line.replace(/[\t ]+$/,'')];continue;}
  if(!line.trim()){flush();continue;}
  if(/^\s*#{1,6}\s/.test(line)){flush();units.push(line.replace(/^\s*#{1,6}\s+/,'').replace(/[\t ]+/g,' ').trim());continue;}
  if(/^\s*(?:[-*+] |\d+[.)] |\|)/.test(line)){flush();units.push(line.replace(/[\t ]+/g,' ').trim());continue;}
  paragraph.push(line.trim());
 }
 if(code)units.push(code.join('\n'));flush();
 return{format:'markdown',units,hash:fingerprint({format:'markdown',units})};
}
function subtract(left:string[],right:string[]):string[]{
 const counts=new Map<string,number>();for(const v of right)counts.set(v,(counts.get(v)||0)+1);
 return left.filter(v=>{const n=counts.get(v)||0;if(n){counts.set(v,n-1);return false;}return true;});
}
export function compareResults(baseline:{text:string;format:string},result:{text:string;format:string}):RoutineResultChange {
 const before=normalizeResult(baseline.text,baseline.format),after=normalizeResult(result.text,result.format);
 if(before.format!==after.format)throw Error('The output format changed; compare these versions manually.');
 const added=subtract(after.units,before.units),removed=subtract(before.units,after.units);
 // Preserve meaningful Markdown ordering: a reorder of the same sections is explicitly visible.
 if(before.hash!==after.hash&&!added.length&&!removed.length&&after.format==='markdown'){added.push('Section order changed.');removed.push('Previous section order.');}
 return{added:added.length,removed:removed.length,addedExamples:added.slice(0,8).map(v=>v.slice(0,240)),removedExamples:removed.slice(0,8).map(v=>v.slice(0,240)),unit:after.format==='csv'?'rows':'sections',format:after.format,baselineHash:before.hash,resultHash:after.hash};
}
