import { Fragment, useMemo, useState } from 'react';
import type { ArtifactPreview } from '../../../packages/contracts/index';
import { inlineTokens, parseCsvPreview, parseMarkdownPreview } from '../../../packages/results/preview';

function Inline({ text }: { text: string }) {
  return <>{inlineTokens(text).map((token, i) => token.kind === 'strong' ? <strong key={i}>{token.text}</strong> : token.kind === 'code' ? <code key={i}>{token.text}</code> : token.kind === 'reference' ? <span key={i} className="result-source-reference">{token.text} <small>({token.url})</small></span> : <Fragment key={i}>{token.text}</Fragment>)}</>;
}
function Table({ rows }: { rows: string[][] }) {
  if (!rows.length) return <p className="result-note">This table is empty.</p>;
  return <div className="result-table-scroll" tabIndex={0} role="region" aria-label="Result table"><table><thead><tr>{rows[0].map((cell, i) => <th key={i} scope="col">{cell}</th>)}</tr></thead><tbody>{rows.slice(1).map((row, i) => <tr key={i}>{row.map((cell, j) => <td key={j}>{cell}</td>)}</tr>)}</tbody></table></div>;
}
/** Every string becomes a React text child. No HTML insertion, link navigation,
 * image loading, embedded documents, scripts, formula evaluation or network. */
export function SafeResultPreview({ preview }: { preview: ArtifactPreview }) {
  const [raw, setRaw] = useState(false);
  const markdown = useMemo(() => ['markdown', 'md'].includes(preview.version.format) && preview.text !== null ? parseMarkdownPreview(preview.text) : null, [preview]);
  const csv = useMemo(() => preview.version.format === 'csv' && preview.text !== null ? parseCsvPreview(preview.text, preview.truncated) : null, [preview]);
  if (preview.text === null) return <div className="result-metadata-only"><strong>Preview unavailable for this file format.</strong><p>{preview.note}</p><p>Export the exact file to inspect it in a suitable application.</p></div>;
  return <section className="safe-result-preview" aria-label="Result contents">
    <div className="result-preview-toolbar"><span>{raw ? 'Original text' : csv ? 'Table preview · first row shown as headers' : markdown ? 'Report preview' : 'Text preview'}</span>{(csv || markdown) && <button className="inline-link" onClick={() => setRaw(!raw)}>{raw ? 'Show formatted preview' : 'Show original text'}</button>}</div>
    {(preview.truncated || markdown?.truncated || csv?.truncated || csv?.omittedColumns) && <p className="result-coverage" role="status">This is a partial preview. Tables show at most 200 data rows and 20 columns; long cells may be clipped. Export the file for complete coverage.</p>}
    {csv?.error && !raw && <p className="result-coverage">{csv.error}</p>}
    {raw || (!csv && !markdown) || csv?.error ? <pre className="result-plain">{preview.text}</pre> : csv ? <Table rows={csv.rows} /> : <div className="result-markdown">{markdown!.blocks.map((block, i) => {
      if (block.kind === 'table') return <Table key={i} rows={block.rows} />;
      if (block.kind === 'code') return <pre key={i}><code>{block.text}</code></pre>;
      if (block.kind === 'heading') return <div key={i} role="heading" aria-level={Math.min(6, block.level + 1)} className={'result-heading level-' + block.level}><Inline text={block.text} /></div>;
      if (block.kind === 'quote') return <blockquote key={i}><Inline text={block.text} /></blockquote>;
      if (block.kind === 'item') return <p key={i} className="result-list-item"><span aria-hidden="true">{block.marker || '•'} </span><Inline text={block.text} /></p>;
      return <p key={i}><Inline text={block.text} /></p>;
    })}</div>}
    <p className="result-note">Previewed as inert content. References are shown as text; external pages and images are not loaded.</p>
  </section>;
}
