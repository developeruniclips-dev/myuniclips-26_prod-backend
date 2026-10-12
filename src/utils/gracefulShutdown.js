'use strict';
// Observe request promises and upload leases; never force-exit on a deadline.
const requestKey=Symbol('gracefulRequest'),wrappedKey=Symbol('gracefulWrapped');
function createGracefulShutdown({barrier,pool,signals=process,report=value=>console.log(JSON.stringify(value)),diagnosticDelayMs=25000}){
 let stopping=false,startupPending=true,server,operator,activeHttp=0,closing,diagnostic;
 const snapshot=()=>({shuttingDown:stopping,startupPending,activeHttp,activeUploads:barrier.status().activeTotal,cleanupFailures:barrier.status().observedCleanupFailures,lifecycleInvariantFailures:barrier.status().lifecycleInvariantFailures});
 const emit=event=>{try{report({event,...snapshot()});}catch{ /* No raw exception output. */ }};
 const wait=async predicate=>{while(!predicate())await new Promise(r=>setTimeout(r,15));};
 function admit(req,res,next){
  if(stopping)return res.status(503).json({code:'SERVICE_SHUTTING_DOWN',message:'Service is restarting. Please try again later.'});
  let pending=1,ended=false,released=false;activeHttp++;
  const release=()=>{if(!released&&ended&&pending===0){released=true;activeHttp--;}};
  req[requestKey]={hold(){pending++;let done=false;return()=>{if(!done){done=true;pending--;release();}};}};
  res.once('finish',()=>{ended=true;release();});res.once('close',()=>{ended=true;release();});
  try{return next();}finally{pending--;release();}
 }
 function track(fn){
  if(fn[wrappedKey]||fn===admit||fn.length>4)return fn;
  function invoke(context,args,req,next){
   const ticket=req[requestKey];if(!ticket)return fn.apply(context,args);
   const done=ticket.hold();let result;
   try{result=fn.apply(context,args);}catch(error){done();throw error;}
   if(result&&typeof result.then==='function')return Promise.resolve(result).then(value=>{done();return value;},error=>{try{return next(error);}finally{done();}});
   done();return result;
  }
  const wrapped=fn.length===4?function(error,req,res,next){return invoke(this,[error,req,res,next],req,next);}:function(req,res,next){return invoke(this,[req,res,next],req,next);};
  wrapped[wrappedKey]=true;return wrapped;
 }
 function instrument(app){
  // Express 4's already-registered route graph; preserve router objects and arity.
  const seen=new Set();
  function walk(stack){for(const layer of stack||[]){
   if(seen.has(layer))continue;seen.add(layer);
   if(layer.route)walk(layer.route.stack);
   else if(layer.handle&&layer.handle.stack)walk(layer.handle.stack);
   else if(typeof layer.handle==='function')layer.handle=track(layer.handle);
  }}
  walk(app._router?.stack);
 }
 async function drain(){
  await wait(()=>!startupPending);
  const httpClosed=server?new Promise((resolve,reject)=>server.close(error=>error&&error.code!=='ERR_SERVER_NOT_RUNNING'?reject(error):resolve())):Promise.resolve();
  // Response close alone is insufficient; async handlers and upload cleanup remain held.
  await Promise.all([httpClosed,wait(()=>activeHttp===0&&barrier.status().activeTotal===0)]);
  if(operator)await operator.close();
  await pool.end();
  clearTimeout(diagnostic);
  signals.removeListener('SIGTERM',onSignal);
  emit('SHUTDOWN_COMPLETE');
 }
 function begin(){
  if(closing)return closing;
  stopping=true;barrier.shutdown();
  emit('SHUTDOWN_STARTED');
  // Diagnostic only: neither success nor forced termination, regardless of platform budget.
  diagnostic=setTimeout(()=>emit('SHUTDOWN_INCOMPLETE'),diagnosticDelayMs);diagnostic.unref?.();
  closing=drain().catch(()=>{clearTimeout(diagnostic);signals.exitCode=1;emit('SHUTDOWN_FAILED');});
  return closing;
 }
 const onSignal=()=>{begin();};
 signals.on('SIGTERM',onSignal);
 function ready(nextServer,nextOperator){server=nextServer;operator=nextOperator;startupPending=false;}
 return {admit,instrument,begin,ready,snapshot,get stopping(){return stopping;}};
}
module.exports={createGracefulShutdown};
