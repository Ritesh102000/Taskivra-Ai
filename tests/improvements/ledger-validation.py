"""Validate complete canonical coverage and concrete local implementation records."""
import json
from collections import Counter
from pathlib import Path
root=Path(__file__).resolve().parents[2]
ledger=json.loads((root/'docs/improvements/ledger.json').read_text())
items=ledger['items']
assert len(items)==102
assert [item['id'] for item in items]==[f'C{i:02}' for i in range(1,103)]
assert Counter(i['kind'] for i in items)=={'defect':53,'risk':10,'proposal':39}
for item in items:
    assert item['decision'] and not item['decision'].startswith(('Pending','See integration')),(item['id'],'decision')
    assert item['status'] in ('implemented','implemented_verified','already_resolved','inapplicable_with_evidence'),(item['id'],'status')
    assert item['changed_files'] and item['verification'],item['id']
    assert item['remaining_blocker'] is None or isinstance(item['remaining_blocker'],str)
    for file in item['changed_files']:
        assert (root/file).exists(),(item['id'],file)
print('102 canonical IDs:53 defects,10 risks,39 proposals; decisions/files/verification records present.')
