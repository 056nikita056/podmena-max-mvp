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
const callback = (userId, payload, id = `${userId}-${payload}`) => ({ update_type: 'message_callback', timestamp: Date.now(), callback: { callback_id: id, payload, user: { user_id: userId, first_name: userId === 202 ? 'Кандидат' : 'Управляющий', last_name: 'MAX' } }, message: { sender: { user_id: 999, is_bot: true }, recipient: { chat_type: 'dialog' } } });
async function botFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'podmena-chat-'));
  const store = await openStore(join(dir, 'chat.sqlite'));
  const domain = createDomain(store);
  const bot = createChatBot(store, domain);
  return { dir, store, domain, bot, say: (id, text) => bot.handle(update(id, text)), tap: (id, payload) => bot.handle(callback(id, payload)), close: async () => { await store.db.close(); rmSync(dir, { recursive: true, force: true }); } };
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
    assert.match((await fx.say(202, '5000'))[0].text, /Профиль готов/);
    await fx.say(101, '/manager');
    const sites = await fx.tap(101, 'm:new');
    assert.match(sites[0].text, /Выберите точку/);
    const site = sites[0].buttons.flat().find(x => x.payload?.startsWith('m:site:') && x.payload !== 'm:site:new');
    await fx.tap(101, site.payload);
    await fx.tap(101, 'm:day:1');
    await fx.tap(101, 'm:time:09:00');
    await fx.tap(101, 'm:hours:8');
    const skillPrompt = await fx.tap(101, 'm:pay:6000');
    assert.match(skillPrompt[0].text, /кандидат увидит/);
    await fx.say(101, 'Эспрессо');
    const published = (await fx.tap(101, 'm:publish'))[0];
    assert.match(published.text, /YouDo и Профи\.ру/);
    const shiftId = published.demoShiftId;
    assert.ok(shiftId);
    const candidates = await fx.tap(101, `m:responses:${shiftId}`);
    const offerButton = candidates.flatMap(x => x.buttons.flat()).find(x => x.payload?.startsWith('m:offer:'));
    const offered = await fx.tap(101, offerButton.payload);
    assert.equal(offered.length, 2);
    assert.equal(offered[1].userId, 202);
    assert.match(offered[1].text, /Обязательное требование управляющего: Эспрессо/);
    assert.equal(offered[1].buttons[0][0].payload, `c:accept:${shiftId}`);
    await fx.say(303, '/candidate');
    await fx.say(303, 'Эспрессо');
    await fx.say(303, '5000');
    assert.match((await fx.tap(303, `c:accept:${shiftId}`))[0].text, /недоступно/);
    const decision = await fx.tap(202, `c:accept:${shiftId}`);
    assert.equal(decision[1].userId, 101);
    assert.match(decision[1].text, /подтвердил/);
    assert.equal((await fx.domain.detail('max:101', shiftId)).shift.status, 'confirmed');
    assert.match((await fx.tap(101, `m:shift:${shiftId}`))[0].text, /Выход подтверждён/);
  } finally { await fx.close(); }
});

test('custom requirement, flexible time and modelled external replies are clear in the bot', async () => {
  const fx = await botFixture();
  try {
    await fx.say(101, '/manager');
    await fx.tap(101, 'm:new');
    await fx.tap(101, 'm:site:new');
    await fx.say(101, 'Кофейня Ритм');
    await fx.say(101, 'Москва, ул. Лесная, 12');
    const manual = await fx.tap(101, 'm:day:custom');
    assert.match(manual[0].text, /9:00/);
    assert.match((await fx.say(101, '03.10.2030 9:00'))[0].text, /Сколько часов/);
    await fx.tap(101, 'm:hours:8');
    await fx.tap(101, 'm:pay:6000');
    const requirement = 'Умеет работать с рожковой кофемашиной и спокойно закрывает кассу';
    assert.match((await fx.say(101, requirement))[0].text, /Кандидат увидит/);
    const published = (await fx.tap(101, 'm:publish'))[0];
    const arrivals = await fx.bot.demoArrivals(101, published.demoShiftId);
    assert.match(arrivals[0].text, /Тестовые площадки ответили/);
    assert.ok(arrivals.some(x => /YouDo \(демо\)|Профи\.ру \(демо\)/.test(x.text) && /«/.test(x.text)));
    assert.ok(arrivals.every(x => x.buttons.flat().every(b => !b.payload?.startsWith('m:offer:'))));
    const shift = await fx.domain.detail('max:101', published.demoShiftId);
    assert.equal(shift.shift.skills[0], requirement);
    assert.ok(shift.messages.some(x => x.modelled));
  } finally { await fx.close(); }
});

test('webhook authenticates, ignores group messages, and retries an undelivered reply once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'podmena-hook-'));
  const delivered = [];
  const answered = [];
  let fail = true;
  const app = createServer({ databasePath: join(dir, 'hook.sqlite'), webhookSecret: 'hook-secret', sessionSecret: 'session-secret', answerBotCallback: async (id, body) => answered.push({ id, body }), sendBotMessage: async (userId, payload) => {
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
    assert.deepEqual(delivered[0].payload.attachments[0].payload.buttons[0][0], { type: 'callback', text: 'Найти подмену', payload: 'm:new' });
    assert.equal((await post(callback(101, 'm:home', 'callback-1'), 'hook-secret')).status, 200);
    assert.equal(delivered.length, 2);
    assert.match(delivered[1].payload.text, /Что хотите сделать/);
    assert.deepEqual(answered, [{ id: 'callback-1', body: { notification: 'Готово' } }]);
    const group = update(101, '/start', 'unique-2');
    group.message.recipient.chat_type = 'chat';
    assert.equal((await post(group, 'hook-secret')).status, 200);
    assert.equal(delivered.length, 2);
  } finally { if (app.listening) await new Promise(resolve => app.close(resolve)); rmSync(dir, { recursive: true, force: true }); }
});

test('webhook sends modelled YouDo and Profi replies after publishing without delaying the response', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'podmena-demo-hook-'));
  const delivered = [], tasks = [];
  const app = createServer({ databasePath: join(dir, 'demo.sqlite'), webhookSecret: 'hook-secret', sessionSecret: 'session-secret', demoDelayMs: 20, deferTask: task => tasks.push(task), answerBotCallback: async () => {}, sendBotMessage: async (userId, payload) => delivered.push({ userId, payload }) });
  try {
    await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${app.address().port}/api/max/webhook`;
    const post = data => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-max-bot-api-secret': 'hook-secret' }, body: JSON.stringify(data) });
    const tap = (payload, id) => post(callback(101, payload, id));
    assert.equal((await post(update(101, '/manager', 'demo-manager'))).status, 200);
    assert.equal((await tap('m:new', 'demo-new')).status, 200);
    const site = delivered.at(-1).payload.attachments[0].payload.buttons.flat().find(x => x.payload?.startsWith('m:site:') && x.payload !== 'm:site:new');
    await tap(site.payload, 'demo-site');
    await tap('m:day:1', 'demo-day');
    await tap('m:time:09:00', 'demo-time');
    await tap('m:hours:8', 'demo-hours');
    await tap('m:pay:6000', 'demo-pay');
    await post(update(101, 'Эспрессо', 'demo-skill'));
    const start = Date.now();
    assert.equal((await tap('m:publish', 'demo-publish')).status, 200);
    assert.ok(Date.now() - start < 1000);
    assert.match(delivered.at(-1).payload.text, /тестовые заявки отправлены/);
    await Promise.all(tasks);
    assert.ok(delivered.some(x => /Тестовые площадки ответили/.test(x.payload.text)));
    assert.ok(delivered.some(x => /YouDo \(демо\)|Профи\.ру \(демо\)/.test(x.payload.text)));
  } finally { if (app.listening) await new Promise(resolve => app.close(resolve)); rmSync(dir, { recursive: true, force: true }); }
});
