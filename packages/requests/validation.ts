import { Worker } from 'node:worker_threads';
import type { FileConstraints, ValidationResult } from '../contracts/requests';
import { REQUEST_LIMITS } from '../contracts/requests';

/** This fixed function is serialized into a worker. Candidate text is never evaluated as code. */
function checkContent(input:{text:string;constraints:FileConstraints}):ValidationResult {
  const {text,constraints:c}=input;
  const no=(explanation:string)=>({accepted:false,explanation});
  for(const literal of c.textIncludes||[])if(!text.includes(literal))return no(`Missing required literal text: ${literal}`);
  if(c.csv){
    const rows:string[][]=[];let row:string[]=[],cell='',quoted=false,closed=false;
    const pushCell=()=>{if(cell.length>65536||row.length>=128)throw Error('CSV cell or column limit exceeded.');row.push(cell);cell='';closed=false;};
    const pushRow=()=>{pushCell();rows.push(row);row=[];if(rows.length>10001)throw Error('CSV supports at most 10,000 data rows.');};
    const source=text.replace(/^\uFEFF/,'');
    try{
      for(let i=0;i<source.length;i++){
        const ch=source[i];
        if(quoted){if(ch==='"'){if(source[i+1]==='"'){cell+='"';i++;}else{quoted=false;closed=true;}}else cell+=ch;}
        else if(ch==='"'){if(cell||closed)throw Error('CSV has an unexpected quote.');quoted=true;}
        else if(ch===',')pushCell();
        else if(ch==='\n'||ch==='\r'){if(ch==='\r'&&source[i+1]==='\n')i++;pushRow();}
        else{if(closed)throw Error('CSV has data after a closing quote.');cell+=ch;}
        if(cell.length>65536)throw Error('CSV cell limit exceeded.');
      }
      if(quoted)throw Error('CSV has an unterminated quoted field.');if(cell||row.length||closed)pushRow();
      if(!rows.length)throw Error('CSV header is missing.');
      const headers=rows.shift()!;if(headers.some(h=>!h)||new Set(headers).size!==headers.length)throw Error('CSV headers must be nonempty and distinct.');
      if(rows.some(r=>r.length!==headers.length))throw Error('CSV rows do not match the header column count.');
      for(const column of c.csv.requiredColumns)if(!headers.includes(column))return no(`Missing required CSV column: ${column}`);
      if(rows.length<(c.csv.minRows||0)||rows.length>(c.csv.maxRows??10000))return no('CSV data row count is outside the requested range.');
      for(const rule of c.csv.equals||[]){const index=headers.indexOf(rule.column);if(index<0)return no(`Missing required CSV column: ${rule.column}`);if(!rows.length||rows.some(row=>row[index]!==rule.value))return no(`Every CSV row must have ${rule.column} equal to ${rule.value}.`);}
    }catch(error){return no(error instanceof Error?error.message:'CSV validation failed.');}
  }
  if(c.json){
    try{
      const value:unknown=JSON.parse(text.replace(/^\uFEFF/,''));
      const stack=[{value,depth:0}];let count=0;
      while(stack.length){const entry=stack.pop()!;if(++count>10000||entry.depth>32)throw Error('JSON exceeds 10,000 entries or depth 32.');if(entry.value&&typeof entry.value==='object')for(const child of Object.values(entry.value))stack.push({value:child,depth:entry.depth+1});}
      if(!value||typeof value!=='object'||Array.isArray(value))return no('JSON must have a top-level object.');
      for(const key of c.json.requiredKeys)if(!Object.hasOwn(value,key))return no(`Missing required JSON key: ${key}`);
      for(const rule of c.json.equals||[]){let current:unknown=value;for(const key of rule.path){if(!current||typeof current!=='object'||!Object.hasOwn(current,key))return no(`Missing JSON path: ${rule.path.join('.')}`);current=(current as Record<string,unknown>)[key];}if(current!==rule.value)return no(`JSON value does not match at ${rule.path.join('.')}.`);}
    }catch(error){return no(error instanceof SyntaxError?'JSON is malformed.':error instanceof Error?error.message:'JSON validation failed.');}
  }
  return{accepted:true,explanation:'Requested deterministic format, size, and content checks passed. No semantic interpretation was performed.'};
}

export async function validateContent(text:string,constraints:FileConstraints):Promise<ValidationResult>{
  if(Buffer.byteLength(text)>REQUEST_LIMITS.validationBytes)return{accepted:false,explanation:'Content validation supports complete UTF-8 files up to 1 MiB.'};
  // esbuild/tsx may preserve function names using this pure helper inside the fixed parser.
  const source=`const __name=(fn)=>fn;const {parentPort,workerData}=require('node:worker_threads');parentPort.postMessage((${checkContent.toString()})(workerData));`;
  const worker=new Worker(source,{eval:true,execArgv:[],workerData:{text,constraints},resourceLimits:{maxOldGenerationSizeMb:32,maxYoungGenerationSizeMb:8,stackSizeMb:2}});
  return new Promise(resolve=>{
    let done=false;const finish=(result:ValidationResult)=>{if(done)return;done=true;clearTimeout(timer);void worker.terminate();resolve(result);};
    const timer=setTimeout(()=>finish({accepted:false,explanation:'Content validation exceeded its two-second limit.'}),REQUEST_LIMITS.validationMs);
    worker.once('message',(result:ValidationResult)=>finish(result));
    worker.once('error',()=>finish({accepted:false,explanation:'Content validation could not finish within its resource limits.'}));
    worker.once('exit',()=>{if(!done)finish({accepted:false,explanation:'Content validation ended without a result.'});});
  });
}
