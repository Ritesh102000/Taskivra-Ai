/** Cap the final UTF-8 JSON, including escaping introduced by the wrapper. */
export function bounded(value:unknown,bytes=24000):string {
  if(bytes<64)throw new RangeError('JSON limit is too small.');
  const text=JSON.stringify(value)??'null';
  if(Buffer.byteLength(text)<=bytes)return text;
  const points=Array.from(text);let low=0,high=Math.min(points.length,bytes);
  const wrap=(length:number)=>JSON.stringify({truncated:true,excerpt:points.slice(0,length).join('')});
  while(low<high){const mid=Math.ceil((low+high)/2);if(Buffer.byteLength(wrap(mid))<=bytes)low=mid;else high=mid-1;}
  return wrap(low);
}
