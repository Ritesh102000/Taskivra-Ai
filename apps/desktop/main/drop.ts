/** Native File identity is verified by Electron, never by File.name or a path property. */
export function nativeDropPaths(files: unknown, resolveNativeFile: (file: File) => string): string[] {
  if (!Array.isArray(files) || files.length < 1 || files.length > 32) throw new Error('Drop between 1 and 32 local files.');
  return files.map(file => {
    const path = resolveNativeFile(file);
    if (!path || !path.startsWith('/') || path.includes('\0') || path.length > 4096) throw new Error('Only files dragged from your Mac can be imported.');
    return path;
  });
}
