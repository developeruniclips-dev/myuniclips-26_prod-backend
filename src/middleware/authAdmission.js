'use strict';

const busy = () => Object.assign(new Error('Authentication is busy'), { code: 'AUTH_CAPACITY_BUSY', status: 503 });
const aborted = () => Object.assign(new Error('Request was cancelled'), { code: 'AUTH_REQUEST_CANCELLED' });

// Share the same bounded work budget across login, registration and recovery.
// A disconnected active handler keeps its slot until its work really settles.
function createAuthAdmission({ maxActive = 2, maxQueued = 40, waitMs = 10000 } = {}) {
  if (![maxActive, maxQueued, waitMs].every(Number.isSafeInteger) || maxActive < 1 || maxQueued < 0 || waitMs < 1) throw Error('Invalid authentication capacity');
  let active = 0;
  const queue = [];
  function pump() {
    while (active < maxActive && queue.length) {
      const item = queue.shift();
      item.cleanup(); active++;
      item.resolve();
    }
  }
  function acquire(signal) {
    if (signal?.aborted) return Promise.reject(aborted());
    if (active < maxActive) { active++; return Promise.resolve(); }
    if (queue.length >= maxQueued) return Promise.reject(busy());
    return new Promise((resolve, reject) => {
      const cancel = error => {
        const index = queue.indexOf(item);
        if (index < 0) return;
        queue.splice(index, 1); item.cleanup(); reject(error);
      };
      const onAbort = () => cancel(aborted());
      const timer = setTimeout(() => cancel(busy()), waitMs);
      const item = { resolve, cleanup() { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); } };
      queue.push(item); signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
  async function run(work, { signal } = {}) {
    await acquire(signal);
    try { if (signal?.aborted) throw aborted(); return await work(); }
    finally { active--; pump(); }
  }
  function wrap(handler) {
    return async (req, res, next) => {
      const controller = new AbortController();
      const cancel = () => controller.abort();
      req.once('aborted', cancel); res.once('close', cancel);
      if (req.aborted || res.destroyed) cancel();
      try { await run(() => handler(req, res, next), { signal: controller.signal }); }
      catch (error) {
        if (error.code === 'AUTH_REQUEST_CANCELLED' || res.destroyed || res.writableEnded) return;
        if (error.code === 'AUTH_CAPACITY_BUSY') return res.set('Retry-After', '2').status(503).json({
          message: 'Sign-in and account services are busy. Please wait a moment and try again.', code: error.code
        });
        next(error);
      } finally { req.removeListener('aborted', cancel); res.removeListener('close', cancel); }
    };
  }
  return { run, wrap, status: () => ({ active, queued: queue.length, maxActive, maxQueued }) };
}
module.exports = {
  createAuthAdmission,
  sharedAuthAdmission: createAuthAdmission(),
  // SMTP can settle after the HTTP response. It must not occupy both password
  // work slots and prevent other students from signing in during an event.
  sharedRecoveryAdmission: createAuthAdmission({ maxActive: 1, maxQueued: 10, waitMs: 10000 })
};
