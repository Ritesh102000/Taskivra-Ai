import { safeStorage } from 'electron';
import { randomBytes } from 'node:crypto';
import { constants, closeSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { privateDirectory } from '../../../packages/persistence/index';

/** The wrapping key remains in macOS Keychain; profiles receive a separate random key. */
export function loadBrowserProfileKey(dataRoot:string):Buffer {
  if(!safeStorage.isEncryptionAvailable())throw new Error('browser_keychain_unavailable');
  const directory=join(dataRoot,'control');privateDirectory(directory);
  const path=join(directory,'browser-key.enc');
  try{
    const stat=lstatSync(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>8192||(stat.mode&0o077)!==0)throw new Error('browser_key_invalid');
    const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
    try{const verified=fstatSync(fd);if(verified.ino!==stat.ino||verified.dev!==stat.dev)throw new Error('browser_key_changed');const text=safeStorage.decryptString(readFileSync(fd));if(!/^[a-f0-9]{64}$/.test(text))throw new Error('browser_key_invalid');return Buffer.from(text,'hex');}finally{closeSync(fd);}
  }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  const key=randomBytes(32),wrapped=safeStorage.encryptString(key.toString('hex'));
  const fd=openSync(path,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
  try{writeFileSync(fd,wrapped);fsyncSync(fd);}finally{closeSync(fd);}
  const parent=openSync(directory,constants.O_RDONLY);try{fsyncSync(parent);}finally{closeSync(parent);}
  return key;
}
