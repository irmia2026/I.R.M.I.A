import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeQuota,
  resolveCapabilityPolicy,
  type ApprovedCapabilityGrant,
} from '../src/adapter/capability-policy.ts';

test('intersects declared and approved capability constraints', () => {
  const result = resolveCapabilityPolicy({
    knownCapabilities: ['message.send'],
    declared: [{
      capability: 'message.send',
      scope: ['room-a', 'room-b', 'room-b'],
      quota: { maxUses: 10, maxBytes: 1_000 },
    }],
    approved: [{
      capability: 'message.send',
      scope: ['room-b', 'room-c'],
      expiresAt: '2026-11-01T00:00:00+00:00',
      quota: { maxUses: 4, maxBytes: 2_000 },
    }],
    now: '2026-10-31T00:00:00Z',
  });

  assert.deepEqual(result.grants, [{
    capability: 'message.send',
    scope: ['room-b'],
    expiresAt: '2026-11-01T00:00:00.000Z',
    quota: { maxUses: 4, maxBytes: 1_000 },
  }]);
  assert.deepEqual(result.effective, result.grants);
  assert.deepEqual(result.rejected, []);
});

test('fails closed for unknown, expired, empty, and malformed approvals', () => {
  const approved: ApprovedCapabilityGrant[] = [
    { capability: 'message.delete' },
    { capability: 'message.send', expiresAt: '2026-10-01T00:00:00Z' },
    { capability: 'message.send', scope: [] },
    { capability: 'message.send', quota: { maxUses: Number.NaN } },
  ];
  const result = resolveCapabilityPolicy({
    knownCapabilities: ['message.send'],
    declared: ['message.send', 'unknown.action'],
    approved,
    now: '2026-11-01T00:00:00Z',
  });

  assert.deepEqual(result.grants, []);
  assert.deepEqual(result.rejected.map(item => item.reason), [
    'unknown-capability',
    'unknown-capability',
    'expired',
    'scope-empty',
    'invalid-quota',
  ]);
});

test('normalizes quota to non-negative integer limits', () => {
  assert.deepEqual(normalizeQuota({ maxUses: 3.9, maxBytes: -2 }), { maxUses: 3, maxBytes: 0 });
  assert.deepEqual(normalizeQuota(2.9), { maxUses: 2 });
  assert.equal(normalizeQuota({ maxUses: Number.POSITIVE_INFINITY }), undefined);
});
