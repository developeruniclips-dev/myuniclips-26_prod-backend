// Small structural fixtures only, used in local isolated tests; not user media.
function chunk(type,data){const b=Buffer.alloc(12+data.length);b.writeUInt32BE(data.length);b.write(type,4);data.copy(b,8);let crc=0xffffffff;for(const v of b.subarray(4,8+data.length)){crc^=v;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}b.writeUInt32BE((crc^0xffffffff)>>>0,8+data.length);return b;}
const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(1);ihdr.writeUInt32BE(1,4);ihdr[8]=8;ihdr[9]=2;
const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',require('node:zlib').deflateSync(Buffer.from([0,0,0,0]))),chunk('IEND',Buffer.alloc(0))]);
const jpg=Buffer.from([255,216,255,192,0,11,8,0,1,0,1,1,1,17,0,255,218,0,8,1,1,0,0,63,0,17,255,217]);
const gif=Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==','base64');
function riff(kind,parts){const data=Buffer.concat(parts),h=Buffer.alloc(12);h.write('RIFF');h.writeUInt32LE(data.length+4,4);h.write(kind,8);return Buffer.concat([h,data]);}
function riffChunk(type,data){const h=Buffer.alloc(8);h.write(type);h.writeUInt32LE(data.length,4);return Buffer.concat([h,data,Buffer.alloc(data.length%2)]);}
const webp=riff('WEBP',[riffChunk('VP8L',Buffer.from([47,0,0,0,0,0,0,0]))]);
const pdfStart=Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n');
const pdf=Buffer.concat([pdfStart,Buffer.from(`xref\n0 2\n0000000000 65535 f \n0000000009 00000 n \ntrailer\n<< /Root 1 0 R /Size 2 >>\nstartxref\n${pdfStart.length}\n%%EOF\n`)]);
function box(type,data){const b=Buffer.alloc(8);b.writeUInt32BE(data.length+8);b.write(type,4);return Buffer.concat([b,data]);}
const handler=Buffer.alloc(24);handler.write('vide',8);
const mp4=Buffer.concat([box('ftyp',Buffer.from('isom\0\0\0\0isom')),box('moov',box('trak',box('mdia',box('hdlr',handler)))),box('mdat',Buffer.from([1,2,3,4]))]);
const mov=Buffer.concat([box('ftyp',Buffer.from('qt  \0\0\0\0qt  ')),mp4.subarray(20)]);
const avi=riff('AVI ',[riffChunk('LIST',Buffer.concat([Buffer.from('hdrl'),riffChunk('LIST',Buffer.concat([Buffer.from('strl'),riffChunk('strh',Buffer.concat([Buffer.from('vids'),Buffer.alloc(44)]))]))])),riffChunk('LIST',Buffer.concat([Buffer.from('movi'),riffChunk('00dc',Buffer.from([1,2,3,4]))]))]);
function ebml(id,data){if(data.length>=127)throw Error('Fixture too large');return Buffer.concat([Buffer.from(id,'hex'),Buffer.from([128|data.length]),data]);}
function matroska(type){return Buffer.concat([ebml('1a45dfa3',ebml('4282',Buffer.from(type))),ebml('18538067',Buffer.concat([ebml('1654ae6b',ebml('ae',ebml('83',Buffer.from([1])))),ebml('1f43b675',Buffer.from([1,2,3]))]))]);}
module.exports={png,jpg,jpeg:jpg,gif,webp,pdf,mp4,mov,avi,webm:matroska('webm'),mkv:matroska('matroska')};
