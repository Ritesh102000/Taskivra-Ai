// Independent parser proof using disposable files; never starts production Electron.
import {createHash} from 'node:crypto';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createXlsxReport,createDocxReport,type ExportSource} from '../../packages/report-export';
const directory=mkdtempSync(join(tmpdir(),'aw-office-fidelity-'));
function source(text:string,format:string):ExportSource{return {text,taskId:'fidelity-task',review:'unreviewed',version:{id:'fidelity-version',artifactId:'fidelity-artifact',version:1,displayName:'Synthetic fidelity',ownerAgentId:'fixture-agent',producerTaskId:'fidelity-task',visibility:'private',bytes:Buffer.byteLength(text),sha256:createHash('sha256').update(text).digest('hex'),mime:'text/plain',format,createdAt:0,status:'ready',sourceVersionId:null}};}
try{
 const xlsx=join(directory,'literal.xlsx'),docx=join(directory,'ordered.docx');
 writeFileSync(xlsx,createXlsxReport(source('name,value\nCR,"alpha\rbeta"\nLF,"alpha\nbeta"\nFormula,=2+2\nUnicode,こんにちは\n','csv')));
 writeFileSync(docx,createDocxReport(source('# Ordered\n\n7. Seventh\n9. Ninth\n','markdown')));
 const script=String.raw`import sys,zipfile,xml.etree.ElementTree as E
import openpyxl
book=openpyxl.load_workbook(sys.argv[1],data_only=False)
sheet=book.worksheets[0]
assert sheet['B2'].value=='alpha\rbeta'
assert sheet['B3'].value=='alpha\nbeta'
assert sheet['B4'].value=='=2+2' and sheet['B4'].data_type=='s'
assert sheet['B5'].value=='こんにちは'
root=E.fromstring(zipfile.ZipFile(sys.argv[2]).read('word/document.xml'))
ns={'w':'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
text='\n'.join(''.join(p.itertext()) for p in root.findall('.//w:p',ns))
assert '7.' in text and '9.' in text
print('openpyxl literal CR/LF/formula/Unicode and independent DOCX ordered markers: passed')`;
 process.stdout.write(execFileSync(process.env.AW_VERIFY_PYTHON||'python3',['-c',script,xlsx,docx],{encoding:'utf8'}));
}finally{rmSync(directory,{recursive:true,force:true});}
