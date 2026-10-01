export const LIMIT:number;
export function encode(value:unknown):Buffer;
export class Decoder {push(chunk:Buffer):unknown[];end():void;}
