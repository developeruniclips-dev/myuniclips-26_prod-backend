'use strict';
// Analysis-only Windows test confinement. Linux additionally has --network=none.
const net=require('node:net'),dns=require('node:dns'),os=require('node:os'),path=require('node:path');
const connect=net.Socket.prototype.connect;
net.Socket.prototype.connect=function(...args){const first=Array.isArray(args[0])?args[0][0]:args[0],opts=first&&typeof first==='object'?first:null;let host=opts?.host,pipe=opts?.path;if(typeof first==='string'&&!/^\d+$/.test(first))pipe=first;else if(!opts)host=typeof args[1]==='string'?args[1]:undefined;
 if(pipe){const p=path.resolve(pipe),tmp=path.resolve(os.tmpdir());if(!(p===tmp||p.startsWith(tmp+path.sep)||/^\\\\\.\\pipe\\uniclips-/.test(pipe)))throw Error('J2_NONFIXTURE_IPC_BLOCKED');}
 else if(host!==undefined&&!['127.0.0.1','::1','localhost'].includes(host))throw Error('J2_EXTERNAL_NETWORK_BLOCKED');
 return connect.apply(this,args);
};
const lookup=dns.lookup;dns.lookup=function(host,...args){if(!['127.0.0.1','::1','localhost'].includes(host))throw Error('J2_EXTERNAL_DNS_BLOCKED');return lookup.call(this,host,...args);};
for(const key of Object.keys(dns))if(/^resolve|^reverse$/.test(key)&&typeof dns[key]==='function')dns[key]=()=>{throw Error('J2_EXTERNAL_DNS_BLOCKED');};
