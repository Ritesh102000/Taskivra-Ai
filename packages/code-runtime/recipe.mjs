/** Pure parser. Recipes are explicit owner-reviewed build inputs, never model-executed commands. */
export function validateRecipe(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !['version', 'python', 'node', 'pipApkVersion'].includes(k)) || value.version !== 1) throw new Error('Invalid dependency recipe.');
  const python = value.python || [], node = value.node;
  if (!Array.isArray(python) || python.length > 64 || (node !== undefined && (!Array.isArray(node) || !node.length || node.length > 64)) || (!python.length && !node?.length)) throw new Error('A recipe requires 1–64 exact dependencies per runtime.');
  const seen = new Set();
  for (const [runtime, list] of [['python', python], ['node', node || []]]) for (const item of list) {
    if (!item || typeof item !== 'object' || Object.keys(item).sort().join(',') !== (runtime === 'python' ? 'name,sha256,version' : 'name,version') || typeof item.name !== 'string' || !(runtime === 'python' ? /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/ : /^(?:@[a-z0-9][a-z0-9_.-]*\/)?[a-z0-9][a-z0-9_.-]{0,100}$/).test(item.name) || typeof item.version !== 'string' || !/^\d[a-zA-Z0-9.+_-]{0,100}$/.test(item.version) || (runtime === 'python' && !/^[a-f0-9]{64}$/.test(item.sha256))) throw new Error('Dependency names, versions and hashes must be exact, bounded values.');
    const key = runtime + ':' + (runtime === 'python' ? item.name.toLowerCase().replace(/[-_.]+/g, '-') : item.name); if (seen.has(key)) throw new Error('Duplicate dependency.'); seen.add(key);
  }
  if (python.length && (typeof value.pipApkVersion !== 'string' || !/^\d[0-9.]*-r\d+$/.test(value.pipApkVersion))) throw new Error('Python builds require an exact py3-pip Alpine package version.');
  if (!python.length && value.pipApkVersion !== undefined) throw new Error('Unexpected pip bootstrap.');
  return { python, node, pipApkVersion: value.pipApkVersion };
}
