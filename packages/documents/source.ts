/** Fixed trusted helper; document content never supplies Python, paths or commands. Runs only inside the code container. */
export const DOCUMENT_EXTRACTOR = String.raw`
import json, hashlib, math, datetime, zipfile, pathlib, sys

MAX_BYTES = 196608
MAX_TEXT = 32000

def reject(code):
    raise ValueError(code)

def clip(value, limit=4096):
    if isinstance(value, str) and len(value) > limit:
        return value[:limit], True
    return value, False

def typed(value):
    if value is None: return {'type': 'blank', 'value': None}
    if isinstance(value, bool): return {'type': 'boolean', 'value': value}
    if isinstance(value, (datetime.datetime, datetime.date, datetime.time)):
        return {'type': type(value).__name__, 'value': value.isoformat()}
    if isinstance(value, datetime.timedelta): return {'type': 'duration', 'seconds': value.total_seconds()}
    if isinstance(value, (int, float)):
        if isinstance(value, float) and not math.isfinite(value): return {'type': 'nonfinite_number', 'value': str(value)}
        if isinstance(value, int) and abs(value) > 9007199254740991: return {'type': 'number', 'value': str(value), 'encoding': 'decimal_string'}
        return {'type': 'number', 'value': value}
    value = str(value)
    visible, truncated = clip(value)
    return {'type': 'string', 'value': visible, 'truncated': truncated, **({'originalCharacters': len(value)} if truncated else {})}

def pdf_extract(path, options):
    from pypdf import PdfReader
    reader = PdfReader(path, strict=True)
    if reader.is_encrypted: reject('encrypted_pdf_unsupported')
    total = len(reader.pages)
    if total > 2000: reject('pdf_page_limit')
    start, count = options['pageStart'], options['pageCount']
    if start > max(total, 1): reject('page_range_out_of_bounds')
    end = min(total, start + count - 1)
    pages, remaining, truncated = [], MAX_TEXT, False
    for number in range(start, end + 1):
        value = reader.pages[number - 1].extract_text() or ''
        text = value[:remaining]
        cut = len(text) < len(value)
        pages.append({'page': number, 'text': text, 'originalCharacters': len(value), 'truncated': cut})
        remaining -= len(text)
        truncated = truncated or cut
        if remaining <= 0: break
    last = pages[-1]['page'] if pages else 0
    warnings = []
    if not any(page['text'].strip() for page in pages): warnings.append('No extractable text in this range; image-only pages may require OCR, which was not performed.')
    if truncated: warnings.append('The text budget was reached. This extraction is incomplete.')
    return {'format': 'pdf', 'totalPages': total, 'pages': pages, 'coverage': {'firstPage': start, 'lastPage': last, 'nextPage': last + 1 if last < total else None, 'completeDocument': start == 1 and last == total and not truncated, 'textTruncated': truncated}, 'warnings': warnings}

def xlsx_extract(path, options):
    import openpyxl
    from openpyxl.xml import DEFUSEDXML
    if not DEFUSEDXML: reject('hardened_xml_parser_required')
    with zipfile.ZipFile(path) as archive:
        entries = archive.infolist()
        if len(entries) > 2048: reject('xlsx_entry_limit')
        expanded = 0
        for entry in entries:
            parts = pathlib.PurePosixPath(entry.filename).parts
            if entry.filename.startswith('/') or chr(92) in entry.filename or '..' in parts or entry.flag_bits & 1: reject('unsafe_xlsx_archive')
            expanded += entry.file_size
            if expanded > 268435456 or entry.file_size > max(entry.compress_size, 1) * 100: reject('xlsx_expansion_limit')
            name = entry.filename.lower()
            if any(mark in name for mark in ['vbaproject', 'macrosheets/', 'dialogsheet', 'activex/', 'embeddings/']): reject('active_xlsx_content_unsupported')
    formulas = openpyxl.load_workbook(path, read_only=True, data_only=False, keep_links=False)
    cached = openpyxl.load_workbook(path, read_only=True, data_only=True, keep_links=False)
    try:
        if len(formulas.sheetnames) > 100: reject('xlsx_sheet_limit')
        selected = options.get('sheet') or formulas.sheetnames[0]
        if selected not in formulas.sheetnames: reject('sheet_not_found')
        sheet, values = formulas[selected], cached[selected]
        row_start, col_start = options['startRow'], options['startColumn']
        row_end = min(row_start + options['rowCount'] - 1, sheet.max_row or 0)
        col_end = min(col_start + options['columnCount'] - 1, sheet.max_column or 0)
        if row_start > max(sheet.max_row or 0, 1) or col_start > max(sheet.max_column or 0, 1): reject('cell_range_out_of_bounds')
        rows, truncated = [], False
        formula_rows = sheet.iter_rows(min_row=row_start, max_row=row_end, min_col=col_start, max_col=col_end)
        cached_rows = values.iter_rows(min_row=row_start, max_row=row_end, min_col=col_start, max_col=col_end)
        for index, (source_row, cached_row) in enumerate(zip(formula_rows, cached_rows), row_start):
            cells = []
            for column, (cell, saved) in enumerate(zip(source_row, cached_row), col_start):
                value = typed(cell.value)
                if cell.data_type == 'f': value = {'type': 'formula', 'formula': str(cell.value), 'cached': typed(saved.value), 'evaluated': False}
                elif cell.data_type == 'e': value = {'type': 'error', 'value': str(cell.value)}
                address = openpyxl.utils.get_column_letter(column) + str(index)
                cells.append({'address': address, 'numberFormat': str(cell.number_format), **value})
                truncated = truncated or bool(value.get('truncated'))
            candidate = {'row': index, 'cells': cells}
            # Leave headroom for metadata. Complete earlier rows remain an explicit partial result.
            if len(json.dumps(rows + [candidate], ensure_ascii=False).encode('utf8')) > MAX_BYTES - 8192:
                truncated = True
                break
            rows.append(candidate)
        last = rows[-1]['row'] if rows else row_start - 1
        return {'format': 'xlsx', 'sheet': selected, 'sheets': formulas.sheetnames, 'dimensions': {'rows': sheet.max_row, 'columns': sheet.max_column}, 'rows': rows, 'coverage': {'firstRow': row_start, 'lastRow': last, 'firstColumn': col_start, 'lastColumn': col_end, 'nextRow': last + 1 if last < (sheet.max_row or 0) else None, 'nextColumn': col_end + 1 if col_end < (sheet.max_column or 0) else None, 'completeSheet': row_start == 1 and col_start == 1 and last == sheet.max_row and col_end == sheet.max_column and not truncated, 'valuesTruncated': truncated}, 'warnings': ['Formulas were not calculated. Cached values may be missing or outdated. External workbook links were not loaded.']}
    finally:
        formulas.close()
        cached.close()

def extract(configuration):
    path = configuration['inputPath']
    with open(path, 'rb') as source:
        digest = hashlib.file_digest(source, 'sha256').hexdigest()
    if digest != configuration['sourceSha256']: reject('source_hash_changed')
    data = pdf_extract(path, configuration) if configuration['format'] == 'pdf' else xlsx_extract(path, configuration)
    data['sourceSha256'] = digest
    encoded = json.dumps(data, ensure_ascii=False, allow_nan=False)
    if len(encoded.encode('utf8')) > MAX_BYTES: reject('extraction_output_limit')
    pathlib.Path('outputs').mkdir(exist_ok=True)
    with open(configuration['outputPath'], 'x', encoding='utf8') as output:
        output.write(encoded)
    print(json.dumps({'extracted': True, 'format': configuration['format']}))
`;
