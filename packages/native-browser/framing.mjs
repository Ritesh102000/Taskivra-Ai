export const LIMIT=900*1024;
export function encode(value){const body=Buffer.from(JSON.stringify(value));if(!body.length||body.length>LIMIT)throw new Error('frame_too_large');const header=Buffer.alloc(4);header.writeUInt32LE(body.length);return Buffer.concat([header,body]);}
export class Decoder {
  buffer=Buffer.alloc(0);
  push(chunk){const values=[];let offset=0;while(offset<chunk.length){const want=this.buffer.length<4?4-this.buffer.length:4+this.buffer.readUInt32LE(0)-this.buffer.length;const count=Math.min(want,chunk.length-offset);this.buffer=Buffer.concat([this.buffer,chunk.subarray(offset,offset+count)]);offset+=count;if(this.buffer.length>=4){const n=this.buffer.readUInt32LE(0);if(!n||n>LIMIT)throw new Error('invalid_frame_length');if(this.buffer.length===n+4){if(values.length>=32)throw new Error('queue_full');values.push(JSON.parse(this.buffer.subarray(4).toString('utf8')));this.buffer=Buffer.alloc(0);}}}return values;}
  end(){if(this.buffer.length)throw new Error('truncated_frame');}
}
