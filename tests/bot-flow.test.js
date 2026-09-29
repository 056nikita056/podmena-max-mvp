import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../server/store.js';
import { createDomain } from '../server/domain.js';
import { createChatBot } from '../server/chat-bot.js';
import { createServer } from '../server/http.js';

const update = (userId, text, mid = `${userId}-${text}`) => ({ update_type: 'message_created', timestamp: Date.now(), message: { sender: { user_id: userId, first_name: userId === 202 ? 'Кандидат' : 'Управляющий', last_name: 'MAX' }, recipient: { chat_type: 'dialog' }, body: { mid, text } } });
async function botFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'podmena-chat-'));
  const store = await openStore(join(dir, 'chat.sqlite'));
  const domain = createDomain(store);
  const bot = createChatBot(store, domain);
  return { dir, store, domain, bot, say: (id, text) => bot.handle(update(id, text)), close: async () => { await store.db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('a real MAX candidate is found without model candidates', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'podmena-bot-'));
  const store = await openStore(join(dir, 'bot.sqlite'));
  try {
    const domain = createDomain(store);
    await store.run('INSERT INTO bot_candidate_profiles(user_id,name,skill,rate_kopecks,available,updated_at) VALUES (?,?,?,?,?,?)', 202, 'Кандидат MAX', 'Эспрессо', 500000, 1, new Date().toISOString());
    const workspace = 'max:101';
    const bootstrap = await domain.bootstrap(workspace);
    const start = Date.now() + 3 * 86400000;
    const result = await domain.create(workspace, { siteId: bootstrap.sites[0].id, role: 'Бариста', startsAt: new Date(start).toISOString(), endsAt: new Date(start + 8 * 3600000).toISOString(), payRub: 6000, skills: ['Эспрессо'], description: 'Тест', decisionDeadline: new Date(start - 3600000).toISOString(), sources: ['max'] });
    const found = await domain.search(workspace, result.shift.id);
    assert.equal(found.responses.length, 1);
    assert.equal(found.responses[0].name, 'Кандидат MAX');
    assert.equal(found.responses[0].source, 'max');
    assert.equal((await domain.list('max:303')).length, 0);
  } finally { await store.db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('one candidate cannot receive overlapping offers from two managers', async () => {
  const fx = await botFixture();
  try {
    await fx.store.run('INSERT INTO bot_candidate_profiles(user_id,name,skill,rate_kopecks,available,updated_at) VALUES (?,?,?,?,?,?)', 202, 'Кандидат MAX', 'Эспрессо', 500000, 1, new Date().toISOString());
    const create = async managerId => {
      const workspace = `max:${managerId}`;
      const base = await fx.domain.bootstrap(workspace);
      const start = '2030-10-03T06:00:00.000Z';
      const result = await fx.domain.create(workspace, { siteId: base.sites[0].id, role: 'Бариста', startsAt: start, endsAt: '2030-10-03T14:00:00.000Z', payRub: 6000, skills: ['Эспрессо'], description: '', decisionDeadline: '2030-10-03T05:59:00.000Z', sources: ['max'] });
      return { workspace, id: result.shift.id };
    };
    const first = await create(101), second = await create(303);
    const result = await fx.domain.search(first.workspace, first.id);
    await fx.domain.offer(first.workspace, first.id, result.responses[0].candidateId);
    assert.equal((await fx.domain.search(second.workspace, second.id)).responses.length, 0);
    await fx.domain.decision(first.workspace, first.id, 'decline');
    assert.equal((await fx.domain.search(second.workspace, second.id)).responses.length, 1);
  } finally { await fx.close(); }
});

test('two MAX chats complete registration, offer and candidate-only confirmation', async () => {
  const fx = await botFixture();
  try {
    await fx.say(202, '/candidate');
    await fx.say(202, 'Эспрессо');
    assert.match((await fx.say(202, '5000'))[0].text, /Профиль сохранён/);
    await fx.say(101, '/manager');
    await fx.say(101, 'Создать смену');
    await fx.say(101, 'Кофейня Ритм');
    await fx.say(101, 'Москва, ул. Лесная, 12');
    await fx.say(101, '03.10.2030 09:00');
    await fx.say(101, '8');
    await fx.say(101, '6000');
    await fx.say(101, 'Эспрессо');
    const found = (await fx.say(101, 'Подтвердить смену'))[0];
    assert.match(found.text, /Кандидат MAX/);
    const offerButton = found.buttons.flat().find(x => x.startsWith('Предложить #'));
    const offered = await fx.say(101, offerButton);
    assert.equal(offered.length, 2);
    assert.equal(offered[1].userId, 202);
    assert.equal(offered[1].buttons[0][0].startsWith('Принять #'), true);
    const shiftId = Number(/#(\d+)/.exec(offerButton)[1]);
    await fx.say(303, '/candidate');
    await fx.say(303, 'Эспрессо');
    await fx.say(303, '5000');
    assert.match((await fx.say(303, `Принять #${shiftId}`))[0].text, /недоступно/);
    const decision = await fx.say(202, `Принять #${shiftId}`);
    assert.equal(decision[1].userId, 101);
    assert.match(decision[1].text, /подтвердил выход/);
    assert.equal((await fx.domain.detail('max:101', shiftId)).shift.status, 'confirmed');
    assert.match((await fx.say(101, `Смена #${shiftId}`))[0].text, /Выход подтверждён/);
  } finally { await fx.close(); }
});

test('webhook authenticates, ignores group messages, and retries an undelivered reply once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'podmena-hook-'));
  const delivered = [];
  let fail = true;
  const app = createServer({ databasePath: join(dir, 'hook.sqlite'), webhookSecret: 'hook-secret', sessionSecret: 'session-secret', sendBotMessage: async (userId, payload) => {
    if (fail) { fail = false; throw new Error('delivery unavailable'); }
    delivered.push({ userId, payload });
  } });
  try {
    await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${app.address().port}/api/max/webhook`;
    const post = (data, secret) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-max-bot-api-secret': secret }, body: JSON.stringify(data) });
    const start = update(101, '/start', 'unique-1');
    assert.equal((await post(start, 'bad-secret')).status, 401);
    assert.equal((await post(start, 'hook-secret')).status, 500);
    assert.equal((await post(start, 'hook-secret')).status, 200);
    assert.equal((await post(start, 'hook-secret')).status, 200);
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].userId, 101);
    assert.deepEqual(delivered[0].payload.attachments[0].payload.buttons[0][0], { type: 'message', text: 'Я управляющий' });
    const group = update(101, '/start', 'unique-2');
    group.message.recipient.chat_type = 'chat';
    assert.equal((await post(group, 'hook-secret')).status, 200);
    assert.equal(delivered.length, 1);
  } finally { if (app.listening) await new Promise(resolve => app.close(resolve)); rmSync(dir, { recursive: true, force: true }); }
});
