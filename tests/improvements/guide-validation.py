import importlib.util,json,tempfile,pathlib,shutil
spec=importlib.util.spec_from_file_location('guide','scripts/build-guide.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
assert m.load_guide()['version']==json.load(open('package.json'))['version']
with tempfile.TemporaryDirectory() as temp:
 root=pathlib.Path(temp);(root/'docs/guide').mkdir(parents=True)
 for name in ['guide-content.json','use-cases.json']:shutil.copyfile('docs/guide/'+name,root/'docs/guide'/name)
 shutil.copyfile('package.json',root/'package.json');m.ROOT=root
 source=root/'docs/guide/guide-content.json';data=json.loads(source.read_text());data['sections'][0]['blocks'].append({'type':'p','text':'<a href="#absent-test-anchor">Missing</a>'});source.write_text(json.dumps(data))
 try:m.load_guide();raise AssertionError('missing fragment accepted')
 except ValueError as e:assert 'Unknown link destination' in str(e)
print('Guide edition and missing-anchor regression passed')
