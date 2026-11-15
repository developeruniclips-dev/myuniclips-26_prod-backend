'use strict';
// Native password work only, no configured database or external endpoint.
const test = require('node:test'), assert = require('node:assert/strict');
const { createAuthAdmission } = require('../src/middleware/authAdmission');
const { hashPassword, verifyPassword } = require('../src/utils/passwordHasher');
test('bounded authentication work preserves real Argon2id hashing and verification', async () => {
  const admission = createAuthAdmission(); let active = 0, peak = 0;
  await Promise.all(Array.from({ length: 6 }, (_, index) => admission.run(async () => {
    active++; peak = Math.max(peak, active);
    try {
      const password = 'SyntheticStrong!9-' + index, hash = await hashPassword(password);
      assert.match(hash, /^\$argon2id\$v=19\$m=65536,t=3,p=4\$/);
      assert.equal((await verifyPassword(password, hash)).valid, true);
      assert.equal((await verifyPassword(password + 'wrong', hash)).valid, false);
    } finally { active--; }
  })));
  assert.equal(peak, 2); assert.equal(active, 0);
  assert.equal(admission.status().active, 0); assert.equal(admission.status().queued, 0);
});
