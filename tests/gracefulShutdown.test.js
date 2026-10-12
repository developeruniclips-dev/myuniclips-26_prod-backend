'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const {createUploadBarrier}=require('../src/utils/uploadBarrier'),{createGracefulShutdown}=require('../src/utils/gracefulShutdown'),{command}=require('../src/utils/uploadOperator');
function fixture(){const signals=new EventEmitter(),b=createUploadBarrier(),events=[];const shutdown=createGracefulShutdown({barrier:b,signals,pool:{end:async()=>events.push('pool')},report:r=>events.push(r.event),diagnosticDelayMs:1000});return {signals,b,events,shutdown};}
test('signal before startup completion never reopens admission and awaits readiness',async()=>{
 const {signals,b,events,shutdown}=fixture();signals.emit('SIGTERM');const pending=shutdown.begin();assert(shutdown.stopping);assert(b.status().shuttingDown);assert.throws(()=>b.resume());assert(!events.includes('pool'));shutdown.ready();await pending;assert.deepEqual(events,['SHUTDOWN_STARTED','pool','SHUTDOWN_COMPLETE']);assert.equal(signals.listenerCount('SIGTERM'),0);
});
test('operator cannot resume a terminally closed generation even with reconciliation acknowledgement',async()=>{
 const {signals,b,shutdown}=fixture();b.resume();signals.emit('SIGTERM');assert.throws(()=>command(b,{operation:'resume',generation:b.status().generation,confirmation:'RESUME UPLOADS',reconciliationConfirmation:'RECONCILIATION VERIFIED'}));shutdown.ready();await shutdown.begin();
});
test('repeated signals close HTTP, operator and pool once in order',async()=>{
 const {signals,events,shutdown}=fixture();shutdown.ready({close:fn=>{events.push('http');fn();}},{close:async()=>events.push('operator')});signals.emit('SIGTERM');signals.emit('SIGTERM');await shutdown.begin();assert.deepEqual(events,['SHUTDOWN_STARTED','http','operator','pool','SHUTDOWN_COMPLETE']);
});
test('resource close failure is sanitized, unsuccessful and never reported complete',async()=>{
 const {signals,events,shutdown}=fixture();shutdown.ready(undefined,{close:async()=>{throw Error('private_fixture');}});await shutdown.begin();assert.equal(signals.exitCode,1);assert(!events.includes('pool'));assert(!events.includes('SHUTDOWN_COMPLETE'));assert(events.includes('SHUTDOWN_FAILED'));
});
test('ordinary readiness without shutdown leaves resources and admission unchanged',()=>{
 const {b,events,shutdown,signals}=fixture();shutdown.ready();assert(b.status().paused);assert.deepEqual(events,[]);signals.removeAllListeners();
});
