// Bounded structural validation, not a malware scanner or a full media decoder.
const fs=require('node:fs');
const crcTable=Uint32Array.from({length:256},(_,value)=>{let crc=value;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);return crc>>>0;});
function png(b) {
 if(b.length<45||!b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return false;
 let offset=8,first=true,data=false,end=false;
 while(offset+12<=b.length){
  const n=b.readUInt32BE(offset),type=b.toString('ascii',offset+4,offset+8);
  if(n>b.length-offset-12)return false;
  let crc=0xffffffff;for(const v of b.subarray(offset+4,offset+8+n))crc=(crc>>>8)^crcTable[(crc^v)&255];
  if(((crc^0xffffffff)>>>0)!==b.readUInt32BE(offset+8+n))return false;
  if(first&&(type!=='IHDR'||n!==13||!b.readUInt32BE(offset+8)||!b.readUInt32BE(offset+12)))return false;
  if(type==='IDAT'&&n)data=true;
  offset+=12+n;first=false;
  if(type==='IEND'){end=n===0&&offset===b.length;break;}
 }
 return data&&end;
}
function jpeg(b){
 if(b.length<20||b.readUInt16BE(0)!==0xffd8||b.readUInt16BE(b.length-2)!==0xffd9)return false;
 let offset=2,frame=false,scan=false;
 for(let count=0;offset<b.length-2&&count<4096;count++){
  if(b[offset++]!==255)return false;while(b[offset]===255)offset++;
  const type=b[offset++];if(type===0||type===216||type===217)return false;
  if(offset+2>b.length)return false;const size=b.readUInt16BE(offset);
  if(size<2||offset+size>b.length)return false;
  if([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(type)){if(size<8||!b.readUInt16BE(offset+3)||!b.readUInt16BE(offset+5))return false;frame=true;}
  if(type===218){scan=size>=6&&offset+size<b.length-2;break;}
  offset+=size;
 }
 return frame&&scan;
}
function gif(b){
 if(b.length<20||!['GIF87a','GIF89a'].includes(b.toString('ascii',0,6))||!b.readUInt16LE(6)||!b.readUInt16LE(8))return false;
 let o=13+(b[10]&128?3*(2**((b[10]&7)+1)):0),image=false;
 function blocks(){let bytes=0;while(o<b.length){const n=b[o++];if(!n)return bytes;if(o+n>b.length)return -1;bytes+=n;o+=n;}return -1;}
 for(let count=0;o<b.length&&count<4096;count++){
  const type=b[o++];if(type===59)return image&&o===b.length;
  if(type===33){if(o>=b.length)return false;o++;if(blocks()<0)return false;}
  else if(type===44){if(o+9>b.length||!b.readUInt16LE(o+4)||!b.readUInt16LE(o+6))return false;const flags=b[o+8];o+=9+(flags&128?3*2**((flags&7)+1):0);if(b[o]<2||b[o]>8)return false;o++;if(blocks()<=0)return false;image=true;}
  else return false;
 }
 return false;
}
function riff(b,kind){
 if(b.length<20||b.toString('ascii',0,4)!=='RIFF'||b.readUInt32LE(4)+8!==b.length||b.toString('ascii',8,12)!==kind)return false;
 let o=12,media=false;
 while(o+8<=b.length){const name=b.toString('ascii',o,o+4),n=b.readUInt32LE(o+4);if(n>b.length-o-8)return false;
  const data=b.subarray(o+8,o+8+n);
  if(kind==='WEBP'&&name==='VP8 '&&n>=10&&data.subarray(3,6).equals(Buffer.from([157,1,42]))&&(data.readUInt16LE(6)&16383)&&(data.readUInt16LE(8)&16383))media=true;
  if(kind==='WEBP'&&name==='VP8L'&&n>=5&&data[0]===47)media=true;
  if(kind==='WEBP'&&name==='ANMF'&&n>24&&(data.includes(Buffer.from('VP8 '))||data.includes(Buffer.from('VP8L'))))media=true;
  o+=8+n+(n%2);
 }
 return media&&o===b.length;
}
function pdf(b){
 // Require a versioned header, object structure, a bounded numeric xref offset and
 // final EOF. PDFs can still contain active content: serve only as attachments.
 if(!/^%PDF-1\.[0-9]|^%PDF-2\.0/.test(b.toString('ascii',0,9)))return false;
 const tail=b.toString('latin1',Math.max(0,b.length-2048));
 const match=/startxref\s+(\d+)\s+%%EOF\s*$/.exec(tail);if(!match)return false;
 const x=Number(match[1]);if(!Number.isSafeInteger(x)||x>=b.length)return false;
 const ref=b.toString('latin1',x,Math.min(x+1024,b.length));
 return /\d+\s+\d+\s+obj\b/.test(b.toString('latin1',0,Math.min(b.length,65536)))&&(/^xref\b/.test(ref)||/\/Type\s*\/XRef\b/.test(ref));
}
async function boxes(read,size,extension){
 let count=0,ftyp=false,moov=false,mdat=false,video=false;
 async function walk(start,end,depth){
  if(depth>8)return false;
  for(let o=start;o<end;){
   if(++count>4096||end-o<8)return false;
   const h=await read(o,16);let n=h.readUInt32BE(0),skip=8;const type=h.toString('ascii',4,8);
   if(n===1){if(h.length<16)return false;const big=h.readBigUInt64BE(8);if(big>BigInt(Number.MAX_SAFE_INTEGER))return false;n=Number(big);skip=16;}
   if(n===0)n=end-o;
   if(n<skip||n>end-o)return false;
   if(depth===0&&type==='ftyp'){if(n<16)return false;ftyp=true;}
   if(depth===0&&type==='moov')moov=true;
   if(depth===0&&type==='mdat'&&n>skip)mdat=true;
   if(type==='hdlr'&&depth>=2&&n>=skip+12){const handler=await read(o+skip,12);if(handler.toString('ascii',8,12)==='vide')video=true;}
   if(['moov','trak','mdia'].includes(type)&&!await walk(o+skip,o+n,depth+1))return false;
   o+=n;
  }return true;
 }
 return await walk(0,size,0)&&(ftyp||extension==='mov')&&moov&&mdat&&video;
}
async function avi(read,size){
 const h=await read(0,12);if(h.length!==12||h.toString('ascii',0,4)!=='RIFF'||h.toString('ascii',8,12)!=='AVI '||h.readUInt32LE(4)+8>size)return false;
 let count=0,video=false,media=false;
 async function walk(start,end,depth){
  if(depth>4)return false;
  for(let o=start;o<end;){if(++count>4096||end-o<8)return false;const h=await read(o,12),n=h.readUInt32LE(4),type=h.toString('ascii',0,4);if(n>end-o-8)return false;
   if(type==='LIST'){if(n<4)return false;const list=h.toString('ascii',8,12);if(list==='movi'){media=n>4;}else if(['hdrl','strl'].includes(list)&&!await walk(o+12,o+8+n,depth+1))return false;}
   if(type==='strh'&&n>=48&&(await read(o+8,4)).toString('ascii')==='vids')video=true;
   o+=8+n+(n%2);
  }return true;
 }
 const firstEnd=h.readUInt32LE(4)+8;
 if(!await walk(12,firstEnd,0))return false;
 for(let o=firstEnd;o<size;){
  const next=await read(o,12);if(next.length<12||next.toString('ascii',0,4)!=='RIFF'||next.toString('ascii',8,12)!=='AVIX')return false;
  const end=o+8+next.readUInt32LE(4);if(end<=o+12||end>size||!await walk(o+12,end,0))return false;o=end;
 }
 return video&&media;
}
async function ebml(read,size,ext){
 let count=0,doctype='',tracks=false,cluster=false,video=false;
 async function element(o,end){
  const b=await read(o,16);if(!b.length)return null;
  let idLength=1;while(idLength<=4&&!(b[0]&(128>>(idLength-1))))idLength++;if(idLength>4||idLength>=b.length)return null;
  let l=1;while(l<=8&&!(b[idLength]&(128>>(l-1))))l++;if(l>8||idLength+l>b.length)return null;
  const id=b.subarray(0,idLength).toString('hex');let n=BigInt(b[idLength]&((128>>(l-1))-1));for(let i=1;i<l;i++)n=(n<<8n)|BigInt(b[idLength+i]);
  const start=o+idLength+l,unknown=n===(1n<<BigInt(7*l))-1n;
  if(!unknown&&n>BigInt(end-start))return null;
  return {id,start,end:unknown?end:start+Number(n)};
 }
 async function walk(start,end,depth){
  if(depth>6)return false;
  for(let o=start;o<end;){if(++count>4096)return false;const e=await element(o,end);if(!e||e.end<=o)return false;
   if(e.id==='4282'&&e.end-e.start<32)doctype=(await read(e.start,e.end-e.start)).toString('ascii');
   if(e.id==='1654ae6b')tracks=true;
   if(e.id==='1f43b675'&&e.end>e.start)cluster=true;
   if(e.id==='83'&&e.end-e.start===1&&(await read(e.start,1))[0]===1)video=true;
   if(['1a45dfa3','18538067','1654ae6b','ae'].includes(e.id)&&!await walk(e.start,e.end,depth+1))return false;
   o=e.end;
  }return true;
 }
 return await walk(0,size,0)&&doctype===(ext==='webm'?'webm':'matroska')&&tracks&&video&&cluster;
}
async function validateFileContent(file,extension){
 const ext=extension.toLowerCase().replace(/^\./,'');
 const handle=await fs.promises.open(file,'r');
 try {
  const {size}=await handle.stat();if(!size)return false;
  const read=async(o,n)=>{const b=Buffer.alloc(Math.min(n,size-o));const r=await handle.read(b,0,b.length,o);return b.subarray(0,r.bytesRead);};
  if(['mp4','mov'].includes(ext))return await boxes(read,size,ext);
  if(ext==='avi')return await avi(read,size);
  if(['webm','mkv'].includes(ext))return await ebml(read,size,ext);
  if(size>5*1024*1024)return false;
  const b=await read(0,size);
  if(ext==='png')return png(b);if(['jpg','jpeg'].includes(ext))return jpeg(b);if(ext==='gif')return gif(b);if(ext==='webp')return riff(b,'WEBP');if(ext==='pdf')return pdf(b);
  return false;
 }finally{await handle.close();}
}
module.exports={validateFileContent};
