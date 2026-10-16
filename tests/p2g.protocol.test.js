'use strict';
// Bounded loopback and in-memory protocol fixtures. No configured DB or real files.
const test=require('node:test'),assert=require('node:assert/strict'),net=require('node:net'),path=require('node:path'),zlib=require('node:zlib');
const {EventEmitter}=require('node:events'),{PassThrough}=require('node:stream');
if(process.env.P2G_ISOLATED_TEST!=='1')throw Error('Explicit P2-G isolated fixture required');
const mysql=require('mysql2/promise'),root=path.dirname(require.resolve('mysql2/package.json'));
const Handshake=require(path.join(root,'lib/packets/handshake')),Query=require(path.join(root,'lib/commands/query'));
const {enableCompression}=require(path.join(root,'lib/compressed_protocol'));
function packet(body,sequence){const p=Buffer.alloc(body.length+4);p.writeUIntLE(body.length,0,3);p[3]=sequence;body.copy(p,4);return p;}
async function switchingServer(t,plugin){
 const sockets=new Set(),received=[];let connections=0;
 const server=net.createServer(socket=>{connections++;sockets.add(socket);socket.on('error',()=>{});socket.on('close',()=>sockets.delete(socket));
  const hello=new Handshake({protocolVersion:10,serverVersion:'8.0-p2g-isolated',connectionId:1,capabilityFlags:1|512|32768|524288,characterSet:45,statusFlags:2,authPluginData1:Buffer.alloc(8,1),authPluginData2:Buffer.alloc(12,2)});
  const p=hello.toPacket(0);p.writeHeader(0);socket.write(p.buffer);let bytes=Buffer.alloc(0),sent=false;
  socket.on('data',chunk=>{received.push(chunk);bytes=Buffer.concat([bytes,chunk]);if(sent||bytes.length<4||bytes.length<bytes.readUIntLE(0,3)+4)return;sent=true;socket.write(packet(Buffer.concat([Buffer.from([254]),Buffer.from(plugin+'\0'),Buffer.alloc(20,1)]),2));});
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{for(const s of sockets)s.destroy();await new Promise(resolve=>server.close(resolve));});
 return{port:server.address().port,received,connections:()=>connections};
}
test('clear-password auth switch is disabled by default without disclosing the synthetic password',{timeout:5000},async t=>{
 const f=await switchingServer(t,'mysql_clear_password'),secret='P2G_SYNTHETIC_NOT_A_CREDENTIAL';
 await assert.rejects(mysql.createConnection({host:'127.0.0.1',port:f.port,user:'p2g_fixture',password:secret,connectTimeout:2000}),e=>e.code==='MYSQL_CLEAR_PASSWORD_NOT_ENABLED');
 assert.equal(f.connections(),1);assert.equal(Buffer.concat(f.received).includes(Buffer.from(secret)),false);
});
for(const plugin of ['constructor','__proto__','toString'])test('server-selected inherited auth name '+plugin+' cannot select a plugin',{timeout:5000},async t=>{
 const f=await switchingServer(t,plugin);
 await assert.rejects(mysql.createConnection({host:'127.0.0.1',port:f.port,user:'p2g_fixture',password:'P2G_SYNTHETIC',connectTimeout:2000}),/unknown plugin/);assert.equal(f.connections(),1);
});
async function compressed(payload,advertised){
 let timer;const result=await new Promise((resolve,reject)=>{
  const connection={write(){},handlePacket(p){clearTimeout(timer);resolve({packet:p});},_handleNetworkError(error){clearTimeout(timer);resolve({error});},_bumpCompressedSequenceId(){}};
  enableCompression(connection);const body=zlib.deflateSync(payload),frame=Buffer.alloc(body.length+7);frame.writeUIntLE(body.length,0,3);frame.writeUIntLE(advertised,4,3);body.copy(frame,7);
  timer=setTimeout(()=>reject(Error('Bounded compression fixture deadline')),2000);connection.packetParser.execute(frame);
 });return result;
}
test('normal small compressed frame still decodes one valid MySQL packet',async()=>{const p=packet(Buffer.from([0]),0);const r=await compressed(p,p.length);assert.ok(r.packet);assert.equal(r.error,undefined);});
test('small compressed frame cannot inflate beyond its advertised size',async()=>{const r=await compressed(Buffer.alloc(256),16);assert.equal(r.error?.code,'ERR_BUFFER_TOO_LARGE');assert.equal(r.packet,undefined);});
test('asynchronous compressed frame cannot inflate beyond its advertised size',async()=>{const r=await compressed(Buffer.alloc(20000),17000);assert.equal(r.error?.code,'ERR_BUFFER_TOO_LARGE');assert.equal(r.packet,undefined);});
test('normal asynchronous compressed frame retains its complete packet',async()=>{const p=packet(Buffer.alloc(20000,1),0);const r=await compressed(p,p.length);assert.ok(r.packet);assert.equal(r.error,undefined);});
function infileConnection(){const c=new EventEmitter();c.stream=new EventEmitter();c.packets=[];c.writePacket=p=>{p.writeHeader(c.packets.length+1);c.packets.push(p);};return c;}
test('LOCAL INFILE rejects implicit file access and uses distinct terminators per request',()=>{
 const c=infileConnection();for(let n=0;n<2;n++){const q={infileOk(){}};Query.prototype._streamLocalInfile.call(q,c,'synthetic-unopened-path');assert.match(q._localStreamError.message,/streamFactory/);}
 assert.equal(c.packets.length,2);assert.notEqual(c.packets[0],c.packets[1]);assert.notEqual(c.packets[0].buffer,c.packets[1].buffer);assert.equal(c.packets[0].buffer[3],1);assert.equal(c.packets[1].buffer[3],2);
});
for(const outcome of ['end','error'])test('LOCAL INFILE '+outcome+' writes a fresh terminator without mutating a prior packet',async()=>{
 const c=infileConnection();for(let n=0;n<2;n++){const stream=new PassThrough(),q={_streamFactory:()=>stream,infileOk(){}};Query.prototype._streamLocalInfile.call(q,c,'synthetic-memory-only');if(outcome==='end')stream.end();else stream.emit('error',Error('Synthetic source failure'));await new Promise(r=>setImmediate(r));q._unpipeStream();}
 assert.equal(c.packets.length,2);assert.notEqual(c.packets[0].buffer,c.packets[1].buffer);assert.equal(c.packets[0].buffer[3],1);assert.equal(c.packets[1].buffer[3],2);
});