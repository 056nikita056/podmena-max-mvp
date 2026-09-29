import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { verifyMaxInitData, verifyWebhookSecret } from '../server/auth.js';

function signed(token, date, user = { id: 123, first_name: 'Test' }) {
  const entries = [['auth_date', String(date)], ['query_id', 'q1'], ['user', JSON.stringify(user)]];
  const check = entries.map(([k,v]) => `${k}=${v}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  const hash = createHmac('sha256', secret).update(check).digest('hex');
  return [...entries, ['hash', hash]].map(([k,v]) => `${k}=${encodeURIComponent(v)}`).join('&');
}

test('MAX initData signature and age are checked before workspace creation', () => {
  const now = Date.now(), token = 'test-bot-token';
  const good = signed(token, Math.floor(now / 1000));
  assert.equal(verifyMaxInitData(good, token, now), 'max:123');
  assert.throws(() => verifyMaxInitData(good.replace('q1', 'q2'), token, now), /Подпись/);
  assert.throws(() => verifyMaxInitData(signed(token, Math.floor(now / 1000) - 3601), token, now), /устарели/);
  assert.throws(() => verifyMaxInitData(good + '&user=other', token, now), /Некорректные/);
});

test('webhook requires configured matching secret', () => {
  assert.equal(verifyWebhookSecret('abcde', 'abcde'), true);
  assert.equal(verifyWebhookSecret('wrong', 'abcde'), false);
  assert.equal(verifyWebhookSecret('anything', ''), false);
});
