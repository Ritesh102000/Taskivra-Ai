"""Run the actual fixed helper with synthetic workbook-reader seam, no files parsed."""
import json,sys,types,tempfile,zipfile, pathlib, shutil
root=pathlib.Path(tempfile.mkdtemp(prefix='r22-extraction-'))
try:
 source=pathlib.Path('packages/documents/source.ts').read_text().split('String.raw`',1)[1].rsplit('`;',1)[0]
 scope={};exec(source,scope)
 class Cell:
  def __init__(self,value,kind):self.value=value;self.data_type=kind;self.number_format='General'
 class Sheet:
  max_row=1;max_column=1
  def __init__(self,cached):self.cached=cached
  def iter_rows(self,**kwargs):yield [Cell('C'*5000,'s') if self.cached else Cell('="cached source"','f')]
 class Book:
  sheetnames=['Data']
  def __init__(self,cached):self.cached=cached
  def __getitem__(self,key):return Sheet(self.cached)
  def close(self):pass
 fake=types.ModuleType('openpyxl');fake.load_workbook=lambda path,**kw:Book(kw['data_only']);fake.utils=types.SimpleNamespace(get_column_letter=lambda n:'A')
 xml=types.ModuleType('openpyxl.xml');xml.DEFUSEDXML=True
 sys.modules['openpyxl']=fake;sys.modules['openpyxl.xml']=xml
 with zipfile.ZipFile(root/'synthetic.xlsx','w') as z:z.writestr('synthetic.txt','Synthetic archive only; sheet values provided by fake reader')
 result=scope['xlsx_extract'](root/'synthetic.xlsx',{'startRow':1,'rowCount':1,'startColumn':1,'columnCount':1})
 value=result['rows'][0]['cells'][0]['cached']
 out={'fixtureOnly':True,'boundary':'Actual DOCUMENT_EXTRACTOR xlsx_extract/typed logic; fake openpyxl workbook reader and hardened-parser flag. No XLSX parsing, Docker/runtime or XML security claim.','cachedOriginalCharacters':value['originalCharacters'],'cachedReturnedCharacters':len(value['value']),'cachedTruncated':value['truncated'],'coverage':result['coverage'],'warnings':result['warnings']}
 assert value['truncated'] and len(value['value'])==4096
 assert result['coverage']['valuesTruncated'] is True and result['coverage']['completeSheet'] is False
finally:shutil.rmtree(root)
out['cleanupVerified']=not root.exists()
print(json.dumps(out,indent=2))
