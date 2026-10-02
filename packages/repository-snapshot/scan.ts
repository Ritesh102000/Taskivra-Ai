/** Python stdlib dir_fd traversal pins every directory; never resolves child host paths. */
export const scanScript=String.raw`
import os,sys,json,hashlib,re,stat
root=sys.argv[1]
flags=os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK
secretpath=re.compile(r'(^|/)(\.env(?:\..*)?|\.git|node_modules|\.ssh|\.aws|\.npmrc|\.netrc|credentials(?:\..*)?|secrets?(?:\..*)?|.*\.(pem|key|p12|pfx))($|/)',re.I)
secrettext=re.compile(r'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY|(?:api[_-]?key|access[_-]?token|password|secret)\s*[:=]\s*["\x27]?[A-Za-z0-9_+/-]{12,}|(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]{16,}',re.I)
entries=[];exclusions=[];count=0;total=0
def exclude(path,reason):
 if len(exclusions)<64: exclusions.append(dict(path=path,reason=reason))
def walk(fd,prefix,depth):
 global count,total
 if depth>8: exclude(prefix,'depth limit');return
 names=[]
 with os.scandir(fd) as listing:
  for entry in listing:
   if count+len(names)>=256:exclude(prefix or '.','scan limit: additional entries unvisited');break
   names.append(entry.name)
 for name in sorted(names):
  if count>=256:exclude(prefix or '.','scan limit: additional entries unvisited');return
  try:name.encode('utf-8')
  except UnicodeError:exclude('[non-UTF8 name]','unsupported filename');continue
  count+=1
  path=prefix+'/'+name if prefix else name
  if secretpath.search(path):exclude(path,'secret or dependency directory/name');continue
  try:
   before=os.stat(name,dir_fd=fd,follow_symlinks=False)
   if stat.S_ISLNK(before.st_mode):exclude(path,'symbolic link');continue
   if stat.S_ISDIR(before.st_mode):
    child=os.open(name,flags|os.O_DIRECTORY,dir_fd=fd)
    try:
     actual=os.fstat(child)
     if (actual.st_dev,actual.st_ino)!=(before.st_dev,before.st_ino):raise ValueError()
     walk(child,path,depth+1)
    finally:os.close(child)
    continue
   if not stat.S_ISREG(before.st_mode):exclude(path,'nonregular file');continue
   if before.st_nlink!=1:exclude(path,'hard-linked file');continue
   if len(entries)>=16:exclude(path,'file count limit');continue
   if before.st_size>8192 or total+before.st_size>32768:exclude(path,'file or total byte limit');continue
   leaf=os.open(name,flags,dir_fd=fd)
   try:
    actual=os.fstat(leaf)
    if not stat.S_ISREG(actual.st_mode) or actual.st_nlink!=1 or (actual.st_dev,actual.st_ino,actual.st_size)!=(before.st_dev,before.st_ino,before.st_size):raise ValueError()
    data=os.read(leaf,actual.st_size+1);after=os.fstat(leaf)
    if len(data)!=actual.st_size or (actual.st_size,actual.st_mtime_ns)!=(after.st_size,after.st_mtime_ns):raise ValueError()
   finally:os.close(leaf)
  except Exception:exclude(path,'changed or unsafe file');continue
  try:
   text=data.decode('utf-8')
   if '\0' in text:raise ValueError()
  except Exception:exclude(path,'binary or invalid UTF-8');continue
  if secrettext.search(text):exclude(path,'possible secret content');continue
  if len(json.dumps(entries+[dict(path=path,text=text)],ensure_ascii=False).encode('utf-8'))>48000:exclude(path,'JSON transport byte limit');continue
  entries.append(dict(path=path,text=text,bytes=len(data),sha256=hashlib.sha256(data).hexdigest()));total+=len(data)
def gitmetadata(rootfd):
 gitfd=os.open('.git',flags|os.O_DIRECTORY,dir_fd=rootfd)
 def read(parts,limit):
  parent=os.dup(gitfd)
  try:
   for part in parts[:-1]:
    child=os.open(part,flags|os.O_DIRECTORY,dir_fd=parent);os.close(parent);parent=child
   leaf=os.open(parts[-1],flags,dir_fd=parent)
   try:
    info=os.fstat(leaf)
    if not stat.S_ISREG(info.st_mode) or info.st_nlink!=1 or info.st_size>limit:raise ValueError()
    data=os.read(leaf,limit+1)
    after=os.fstat(leaf)
    if len(data)!=info.st_size or (info.st_size,info.st_mtime_ns)!=(after.st_size,after.st_mtime_ns):raise ValueError()
    return data
   finally:os.close(leaf)
  finally:os.close(parent)
 try:
  head=read(['HEAD'],256).decode('ascii').strip()
  if head.startswith('ref: '):
   ref=head[5:]
   if not re.fullmatch(r'refs/[A-Za-z0-9_./-]+',ref) or any(p in ('','.','..') for p in ref.split('/')):raise ValueError()
   try:head=read(ref.split('/'),256).decode('ascii').strip()
   except FileNotFoundError:
    refs=read(['packed-refs'],65536).decode('ascii').splitlines();head=next(line.split(' ')[0] for line in refs if line.endswith(' '+ref))
  if not re.fullmatch(r'[a-f0-9]{40}|[a-f0-9]{64}',head):raise ValueError()
  algorithm='sha1' if len(head)==40 else 'sha256';width=len(head)//2
  def obj(oid,kind):
   import zlib
   if not re.fullmatch(r'[a-f0-9]{'+str(width*2)+'}',oid):raise ValueError()
   packed=read(['objects',oid[:2],oid[2:]],65536);decoder=zlib.decompressobj();raw=decoder.decompress(packed,65537)
   if len(raw)>65536 or not decoder.eof or decoder.unused_data or decoder.unconsumed_tail or hashlib.new(algorithm,raw).hexdigest()!=oid:raise ValueError()
   header,data=raw.split(bytes([0]),1)
   if header!=kind.encode()+b' '+str(len(data)).encode():raise ValueError()
   return data
  commit=obj(head,'commit');first=commit.splitlines()[0].decode('ascii')
  if not first.startswith('tree '):raise ValueError()
  tree=first[5:];blobs={};visited=0
  def treewalk(oid,prefix,depth):
   nonlocal visited
   if depth>8:raise ValueError()
   data=obj(oid,'tree');offset=0
   while offset<len(data):
    visited+=1
    if visited>256:raise ValueError()
    space=data.index(b' ',offset);zero=data.index(bytes([0]),space);mode=data[offset:space];name=data[space+1:zero].decode('utf-8')
    if not name or zero+1+width>len(data):raise ValueError()
    child=data[zero+1:zero+1+width].hex();offset=zero+1+width
    if name in ('.','..') or '/' in name:raise ValueError()
    path=prefix+'/'+name if prefix else name
    if mode==b'40000':treewalk(child,path,depth+1)
    elif mode in (b'100644',b'100755'):blobs[path]=child
  treewalk(tree,'',0)
  index=read(['index'],65536);tracked=[]
  if len(index)<12+width or hashlib.new(algorithm,index[:-width]).digest()!=index[-width:]:raise ValueError()
  if index[:4]!=b'DIRC' or int.from_bytes(index[4:8],'big') not in (2,3):raise ValueError()
  count=int.from_bytes(index[8:12],'big');offset=12
  if count>256:raise ValueError()
  for _ in range(count):
   start=offset;fixed=42+width
   if offset+fixed>len(index)-width:raise ValueError()
   flag=int.from_bytes(index[offset+40+width:offset+42+width],'big');offset+=fixed
   if flag & 16384:offset+=2
   end=index.index(bytes([0]),offset,len(index)-width);name=index[offset:end].decode('utf-8')
   if any(part in ('','.','..') for part in name.split('/')):raise ValueError()
   tracked.append(name);offset=start+((end-start+1+7)//8)*8
   if offset>len(index)-width:raise ValueError()
  return dict(commit=head,tracked=tracked,headBlobs=blobs,objectFormat=algorithm)
 finally:os.close(gitfd)
metadata=None
fd=os.open(root,flags|os.O_DIRECTORY)
try:
 actual=os.fstat(fd)
 if (actual.st_dev,actual.st_ino)!=(int(sys.argv[2]),int(sys.argv[3])):raise ValueError('selected folder changed')
 try:metadata=gitmetadata(fd)
 except Exception:pass
 walk(fd,'',0)
finally:os.close(fd)
print(json.dumps(dict(entries=entries,exclusions=exclusions,metadata=metadata),ensure_ascii=False))
`;
