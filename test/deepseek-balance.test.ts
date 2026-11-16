import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DeepSeekBalanceService, deepSeekBalanceUrl, formatDeepSeekBalance, isDeepSeekBaseUrl,
} from '../src/model/deepseek-balance.ts';

test('仅识别 DeepSeek API 端点，余额请求走 origin 的 /user/balance', () => {
  assert.equal(isDeepSeekBaseUrl('https://api.deepseek.com'), true);
  assert.equal(isDeepSeekBaseUrl('https://api.deepseek.com/v1'), true);
  assert.equal(isDeepSeekBaseUrl('https://example.com'), false);
  assert.equal(deepSeekBalanceUrl('https://api.deepseek.com/v1'), 'https://api.deepseek.com/user/balance');
});

test('余额快照：Authorization 只用于请求，快照与展示都不带 key', async () => {
  let seenUrl = '';
  let seenAuth = '';
  const service = new DeepSeekBalanceService({
    baseUrl: 'https://api.deepseek.com',
    apiKey: 'sk-test-key',
    autoStart: false,
    now: () => 123,
    fetchImpl: async (url, init) => {
      seenUrl = String(url);
      seenAuth = String((init?.headers as Record<string, string>)['authorization'] ?? '');
      return new Response(JSON.stringify({
        is_available: true,
        balance_infos: [{
          currency: 'CNY', total_balance: '12.34',
          granted_balance: '2.00', topped_up_balance: '10.34',
        }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  await service.refresh();
  assert.equal(seenUrl, 'https://api.deepseek.com/user/balance');
  assert.equal(seenAuth, 'Bearer sk-test-key');
  const snapshot = service.snapshot();
  assert.deepEqual(snapshot, {
    isAvailable: true,
    balances: [{ currency: 'CNY', total: '12.34', granted: '2.00', toppedUp: '10.34' }],
    fetchedAtMs: 123,
  });
  const rendered = formatDeepSeekBalance(snapshot);
  assert.equal(rendered, 'DeepSeek API 余额：CNY 12.34（赠金 2.00 · 充值 10.34）');
  assert.equal(rendered?.includes('sk-test-key'), false);
});
