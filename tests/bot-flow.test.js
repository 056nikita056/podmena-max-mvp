import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { openStore } from '../server/store.js';
import { createDomain } from '../server/domain.js';
import { createChatBot } from '../server/chat-bot.js';
import { createServer } from '../server/http.js';
import { createOutboundLink, readOutboundLink } from '../server/outbound-links.js';

const update = (userId, text, mid = `${userId}-${text}`) => ({ update_type: 'message_created', timestamp: Date.now(), message: { sender: { user_id: userId, first_name: userId === 202 ? 'Кандидат' : 'Управляющий', last_name: 'MAX' }, recipient: { chat_type: 'dialog' }, body: { mid, text } } });
const callback = (userId, payload, id = `${userId}-${payload}`) => ({ update_type: 'message_callback', timestamp: Date.now(), callback: { callback_id: id, payload, user: { user_id: userId, first_name: userId === 202 ? 'Кандидат' : 'Управляющий', last_name: 'MAX' } }, message: { sender: { user_id: 999, is_bot: true }, recipient: { chat_type: 'dialog' } } });
const started = (userId, payload, username) => ({ update_type: 'bot_started', timestamp: Date.now(), user: { user_id: userId, first_name: 'Сотрудник', last_name: 'Резерва', username }, payload });
const sharedContact = (userId, phone, token) => {
  const vcf = `BEGIN:VCARD\r\nVERSION:3.0\r\nTEL;TYPE=cell:${phone}\r\nFN:Сотрудник Резерва\r\nEND:VCARD\r\n`;
  return { update_type: 'message_created', timestamp: Date.now(), message: { sender: { user_id: userId, first_name: 'Сотрудник', last_name: 'Резерва' }, recipient: { chat_type: 'dialog' }, body: { mid: `contact-${userId}-${phone}`, attachments: [{ type: 'contact', payload: { vcf_info: vcf, hash: createHmac('sha256', token).update(vcf).digest('hex') } }] } } };
};
async function botFixture(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'podmena-chat-'));
  const store = await openStore(join(dir, 'chat.sqlite'));
  const domain = createDomain(store);
  const bot = createChatBot(store, domain, { makeOutboundLink: details => createOutboundLink('https://app.test', 'test-secret', details), ...options });
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
  const fx = await botFixture({ enableCandidateMode: true });
  try {
    await fx.say(202, '/candidate');
    await fx.say(202, 'Эспрессо');
    assert.match((await fx.say(202, '5000'))[0].text, /Профиль готов/);
    assert.match((await fx.tap(202, 'c:link'))[0].text, /ссылку.*MAX/i);
    assert.match((await fx.say(202, 'https://max.ru/u/candidate-shared-link'))[0].text, /сохранена/);
    await fx.say(101, '/manager');
    const sites = await fx.tap(101, 'm:new');
    assert.match(sites[0].text, /Выберите точку/);
    const site = sites[0].buttons.flat().find(x => x.payload?.startsWith('m:site:') && x.payload !== 'm:site:new');
    await fx.tap(101, site.payload);
    await fx.tap(101, 'm:day:1');
    await fx.tap(101, 'm:time:09:00');
    await fx.tap(101, 'm:hours:8');
    const skillPrompt = await fx.tap(101, 'm:pay:6000');
    assert.match(skillPrompt[0].text, /Описание смены/);
    await fx.say(101, 'Эспрессо');
    const published = (await fx.tap(101, 'm:publish'))[0];
    assert.match(published.text, /YouDo и Профи\.ру/);
    const shiftId = published.demoShiftId;
    assert.ok(shiftId);
    const candidates = await fx.tap(101, `m:responses:${shiftId}`);
    const offerButton = candidates.flatMap(x => x.buttons.flat()).find(x => x.payload?.startsWith('m:offer:'));
    assert.ok(candidates.flatMap(x => x.buttons.flat()).some(x => x.text === 'Написать в MAX' && readOutboundLink(new URL(x.url).searchParams.get('token'), 'test-secret')?.target === 'max'));
    const offered = await fx.tap(101, offerButton.payload);
    assert.equal(offered.length, 2);
    assert.equal(offered[1].userId, 202);
    assert.match(offered[1].text, /Описание: Эспрессо/);
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
    const hoursPrompt = await fx.tap(101, 'm:hours:custom');
    assert.match(hoursPrompt[0].text, /количество часов/i);
    await fx.say(101, '7');
    await fx.tap(101, 'm:pay:6000');
    const requirement = 'Умеет работать с рожковой кофемашиной и спокойно закрывает кассу';
    assert.match((await fx.say(101, requirement))[0].text, /Описание:/);
    const published = (await fx.tap(101, 'm:publish'))[0];
    const arrivals = await fx.bot.demoArrivals(101, published.demoShiftId);
    assert.match(arrivals[0].text, /Тестовые площадки ответили/);
    assert.ok(arrivals.some(x => /YouDo \(демо\)|Профи\.ру \(демо\)/.test(x.text) && /«/.test(x.text)));
    assert.ok(arrivals.every(x => x.buttons.flat().every(b => !b.payload?.startsWith('m:offer:'))));
    const shift = await fx.domain.detail('max:101', published.demoShiftId);
    assert.equal(shift.shift.description, requirement);
    assert.deepEqual(shift.shift.skills, []);
    assert.equal((Date.parse(shift.shift.ends_at) - Date.parse(shift.shift.starts_at)) / 3600000, 7);
    assert.ok(shift.messages.some(x => x.modelled));
    await fx.store.run('UPDATE candidates SET max_profile_url=? WHERE workspace_id=? AND name=?', 'https://max.ru/u/demo-contact', 'max:101', 'София Р.');
    const cards = await fx.tap(101, `m:responses:${published.demoShiftId}`);
    const youdo = cards.find(x => x.text.includes('София Р.'));
    assert.ok(youdo.buttons.flat().some(x => x.text === 'Открыть YouDo' && readOutboundLink(new URL(x.url).searchParams.get('token'), 'test-secret')?.target === 'platform'));
    assert.ok(youdo.buttons.flat().some(x => x.text === 'Написать в MAX' && readOutboundLink(new URL(x.url).searchParams.get('token'), 'test-secret')?.target === 'max'));
  } finally { await fx.close(); }
});

test('manager edits each review field and publishes the revised description', async () => {
  const fx = await botFixture();
  try {
    await fx.say(101, '/manager');
    const sites = (await fx.tap(101, 'm:new'))[0].buttons.flat().filter(x => /^m:site:\d+$/.test(x.payload || ''));
    await fx.tap(101, sites[0].payload);
    await fx.tap(101, 'm:day:custom');
    await fx.say(101, '03.10.2030 09:00');
    await fx.tap(101, 'm:hours:8');
    const prompt = (await fx.tap(101, 'm:pay:5000'))[0];
    assert.match(prompt.text, /описание/i);
    const review = (await fx.say(101, 'Бариста на утреннюю смену, работа с кофемашиной.'))[0];
    assert.ok(review.buttons.flat().some(x => x.payload === 'm:edit:site'));
    assert.ok(review.buttons.flat().some(x => x.payload === 'm:edit:datetime'));
    assert.ok(review.buttons.flat().some(x => x.payload === 'm:edit:hours'));
    assert.ok(review.buttons.flat().some(x => x.payload === 'm:edit:pay'));
    assert.ok(review.buttons.flat().some(x => x.payload === 'm:edit:description'));
    await fx.tap(101, 'm:edit:site');
    const changedSite = (await fx.tap(101, sites[1].payload))[0];
    assert.match(changedSite.text, /Проверьте смену/);
    await fx.tap(101, 'm:edit:datetime');
    assert.match((await fx.say(101, '04.10.2030 12:00'))[0].text, /Проверьте смену/);
    await fx.tap(101, 'm:edit:hours');
    assert.match((await fx.say(101, '7'))[0].text, /Проверьте смену/);
    await fx.tap(101, 'm:edit:pay');
    assert.match((await fx.say(101, '7500'))[0].text, /Проверьте смену/);
    await fx.tap(101, 'm:edit:description');
    assert.match((await fx.say(101, 'Бариста на вечернюю смену; касса и кофемашина.'))[0].text, /Проверьте смену/);
    await fx.tap(101, 'm:edit:site');
    await fx.tap(101, 'm:site:new');
    await fx.say(101, 'Кофейня Лист');
    assert.match((await fx.say(101, 'Москва, улица Новая, 7'))[0].text, /Проверьте смену/);
    await fx.tap(101, 'm:edit:hours');
    assert.match((await fx.tap(101, 'm:review'))[0].text, /7 ч/);
    const published = (await fx.tap(101, 'm:publish'))[0];
    const detail = await fx.domain.detail('max:101', published.demoShiftId);
    assert.equal(detail.shift.site_name, 'Кофейня Лист');
    assert.equal(new Date(detail.shift.starts_at).toISOString(), '2030-10-04T09:00:00.000Z');
    assert.equal((Date.parse(detail.shift.ends_at) - Date.parse(detail.shift.starts_at)) / 3600000, 7);
    assert.equal(detail.shift.payRub, 7500);
    assert.equal(detail.shift.description, 'Бариста на вечернюю смену; касса и кофемашина.');
    assert.deepEqual(detail.shift.skills, []);
  } finally { await fx.close(); }
});

test('phone invite requires verified contact, then reserve member gets and answers a shift broadcast', async () => {
  const fx = await botFixture({ inviteSecret: 'invite-secret', botToken: 'test-bot-token', botUsername: 't405_hakaton_max_bot' });
  try {
    await fx.say(101, '/manager');
    assert.match((await fx.tap(101, 'm:reserve:home'))[0].text, /Резерв/);
    assert.match((await fx.tap(101, 'm:reserve:add'))[0].text, /username.*номер/i);
    const invited = (await fx.say(101, '+79990001122'))[0];
    const inviteUrl = invited.text.match(/https:\/\/max\.ru\/t405_hakaton_max_bot\?start=reserve_[A-Za-z0-9_-]+/)?.[0];
    assert.ok(inviteUrl);
    const token = new URL(inviteUrl).searchParams.get('start');
    const prompt = (await fx.bot.handle(started(202, token)))[0];
    assert.ok(prompt.buttons.flat().some(x => x.type === 'request_contact'));
    assert.match((await fx.bot.handle(sharedContact(202, '79990000000', 'test-bot-token')))[0].text, /не совпадает/i);
    const confirmed = (await fx.bot.handle(sharedContact(202, '79990001122', 'test-bot-token')))[0];
    assert.ok(confirmed.buttons.flat().some(x => x.payload?.startsWith('r:join:')));
    const joinPayload = confirmed.buttons.flat().find(x => x.payload?.startsWith('r:join:')).payload;
    const joined = await fx.tap(202, joinPayload);
    assert.ok(joined.some(x => x.userId === 101 && /присоединился/i.test(x.text)));
    const member = await fx.store.get('SELECT c.id,c.max_user_id FROM candidates c JOIN reserve r ON r.candidate_id=c.id WHERE r.workspace_id=? AND c.max_user_id=?', 'max:101', 202);
    assert.equal(member.max_user_id, 202);
    const sites = (await fx.tap(101, 'm:new'))[0].buttons.flat();
    await fx.tap(101, sites.find(x => /^m:site:\d+$/.test(x.payload || '')).payload);
    await fx.tap(101, 'm:day:1');
    await fx.tap(101, 'm:time:09:00');
    await fx.tap(101, 'm:hours:8');
    await fx.tap(101, 'm:pay:6000');
    await fx.say(101, 'Бариста на смену: касса, кофемашина, помощь команде.');
    const published = await fx.tap(101, 'm:publish');
    const shiftId = published[0].demoShiftId;
    const broadcast = published.find(x => x.userId === 202);
    assert.ok(broadcast);
    assert.match(broadcast.text, /касса, кофемашина/);
    assert.ok(!(await fx.domain.detail('max:101', shiftId)).responses.some(x => x.candidateId === member.id));
    const responsePayload = broadcast.buttons.flat().find(x => /Откликнуться/.test(x.text)).payload;
    assert.match((await fx.tap(303, responsePayload))[0].text, /недоступно/i);
    const answered = await fx.tap(202, responsePayload);
    assert.ok(answered.some(x => x.userId === 101 && /откликнулся/i.test(x.text)));
    assert.ok((await fx.domain.detail('max:101', shiftId)).responses.some(x => x.candidateId === member.id && x.source === 'reserve'));
    await fx.bot.demoArrivals(101, shiftId);
    const cards = await fx.tap(101, `m:responses:${shiftId}`);
    assert.ok(cards.some(x => x.text.includes('Сотрудник Резерва')));
  } finally { await fx.close(); }
});

test('username reserve invite can only be accepted by that MAX username', async () => {
  const fx = await botFixture({ inviteSecret: 'invite-secret', botUsername: 't405_hakaton_max_bot' });
  try {
    await fx.say(101, '/manager');
    await fx.tap(101, 'm:reserve:add');
    assert.match((await fx.say(101, 'not-a-number@'))[0].text, /Укажите username/);
    const invite = (await fx.say(101, '@coffee_helper'))[0];
    const payload = new URL(invite.text.match(/https:\/\/max\.ru\/[^\s]+/)?.[0]).searchParams.get('start');
    assert.match((await fx.bot.handle(started(202, payload, 'someone_else')))[0].text, /не совпадает/i);
    const accepted = (await fx.bot.handle(started(202, payload, 'coffee_helper')))[0];
    const join = accepted.buttons.flat().find(x => x.payload?.startsWith('r:join:'));
    assert.ok(join);
    await fx.tap(202, join.payload);
    assert.equal((await fx.store.get('SELECT max_profile_url AS url FROM candidates WHERE workspace_id=? AND max_user_id=?', 'max:101', 202)).url, 'https://max.ru/coffee_helper');
  } finally { await fx.close(); }
});

test('candidate mode is disabled by default while manager can publish without MAX sourcing', async () => {
  const fx = await botFixture();
  try {
    const start = (await fx.say(202, '/start'))[0];
    assert.ok(start.buttons.flat().every(x => x.payload !== 'c:home'));
    assert.match((await fx.say(202, '/candidate'))[0].text, /временно выключен/);
    assert.match((await fx.tap(202, 'c:home'))[0].text, /временно выключен/);
    await fx.store.run('UPDATE bot_dialogs SET mode=? WHERE user_id=?', 'candidate', 202);
    assert.match((await fx.tap(202, 'm:new'))[0].text, /Выберите точку/);
    await fx.say(101, '/manager');
    const sites = await fx.tap(101, 'm:new');
    const site = sites[0].buttons.flat().find(x => x.payload?.startsWith('m:site:') && x.payload !== 'm:site:new');
    await fx.tap(101, site.payload);
    await fx.tap(101, 'm:day:1');
    await fx.tap(101, 'm:time:09:00');
    await fx.tap(101, 'm:hours:8');
    await fx.tap(101, 'm:pay:6000');
    await fx.say(101, 'Эспрессо');
    const published = (await fx.tap(101, 'm:publish'))[0];
    assert.ok(published.demoShiftId);
    const data = await fx.domain.detail('max:101', published.demoShiftId);
    assert.ok(!data.shift.sources.includes('max'));
    assert.ok(data.shift.sources.includes('youdo'));
    assert.match((await fx.tap(101, `m:search:${published.demoShiftId}`))[0].text, /временно выключен/);
  } finally { await fx.close(); }
});

test('outbound link redirects and asks the manager; yes offers reserve, no offers other candidates', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'podmena-outbound-'));
  const path = join(dir, 'outbound.sqlite');
  const delivered = [];
  const app = createServer({ databasePath: path, webhookSecret: 'hook-secret', sessionSecret: 'test-secret', publicUrl: 'https://app.test', sendBotMessage: async (userId, payload) => delivered.push({ userId, payload }), answerBotCallback: async () => {} });
  let seed;
  try {
    await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${app.address().port}`;
    assert.equal((await fetch(`${origin}/api/health`)).status, 200);
    seed = await openStore(path);
    const domain = createDomain(seed);
    const workspace = 'max:101';
    const base = await domain.bootstrap(workspace);
    const start = Date.now() + 3 * 86400000;
    const created = await domain.create(workspace, { siteId: base.sites[0].id, role: 'Бариста', startsAt: new Date(start).toISOString(), endsAt: new Date(start + 8 * 3600000).toISOString(), payRub: 6000, skills: ['Эспрессо'], description: '', decisionDeadline: new Date(start - 60000).toISOString(), sources: ['youdo', 'profi'] });
    await domain.search(workspace, created.shift.id, { sources: ['youdo', 'profi'], modelledReplies: true });
    const responses = (await domain.detail(workspace, created.shift.id)).responses;
    const person = responses.find(x => x.source === 'youdo');
    assert.ok(person);
    const signed = createOutboundLink('https://app.test', 'test-secret', { managerId: 101, shiftId: created.shift.id, candidateId: person.candidateId, target: 'platform' });
    const outbound = await fetch(`${origin}${new URL(signed).pathname}${new URL(signed).search}`, { redirect: 'manual' });
    assert.equal(outbound.status, 302);
    assert.equal(outbound.headers.get('location'), 'https://youdo.com/');
    assert.match(delivered.at(-1).payload.text, /Удалось договориться/);
    assert.deepEqual(delivered.at(-1).payload.attachments[0].payload.buttons[0].map(x => x.text), ['Да', 'Нет']);
    const post = payload => fetch(`${origin}/api/max/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-max-bot-api-secret': 'hook-secret' }, body: JSON.stringify(callback(101, payload, `contact-${payload}`)) });
    assert.equal((await post(`m:contact:yes:${created.shift.id}:${person.candidateId}`)).status, 200);
    assert.match(delivered.at(-1).payload.text, /Добавить человека в резерв/);
    assert.equal((await post(`m:contact:reserve:${created.shift.id}:${person.candidateId}`)).status, 200);
    assert.ok((await domain.reserve(workspace)).some(x => x.id === person.candidateId));
    const other = responses.find(x => x.candidateId !== person.candidateId);
    assert.equal((await post(`m:contact:no:${created.shift.id}:${other.candidateId}`)).status, 200);
    assert.ok(delivered.at(-1).payload.attachments[0].payload.buttons.flat().some(x => x.text === 'Другие кандидаты'));
    assert.equal((await post(`m:contact:others:${created.shift.id}:${other.candidateId}`)).status, 200);
    assert.ok(delivered.some(x => x.payload.text.includes(person.name)));
    const tampered = `${signed}x`;
    assert.equal((await fetch(`${origin}${new URL(tampered).pathname}${new URL(tampered).search}`, { redirect: 'manual' })).status, 404);
  } finally {
    if (seed) await seed.db.close();
    if (app.listening) await new Promise(resolve => app.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('webhook authenticates, ignores group messages, and retries an undelivered reply once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'podmena-hook-'));
  const delivered = [];
  const answered = [];
  let fail = true;
  const app = createServer({ databasePath: join(dir, 'hook.sqlite'), webhookSecret: 'hook-secret', sessionSecret: 'session-secret', botToken: 'test-bot-token', answerBotCallback: async (id, body) => answered.push({ id, body }), sendBotMessage: async (userId, payload) => {
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
    assert.equal((await post(callback(101, 'm:reserve:add', 'reserve-add'), 'hook-secret')).status, 200);
    assert.equal((await post(update(101, '+79990001122', 'reserve-contact'), 'hook-secret')).status, 200);
    const inviteUrl = delivered.at(-1).payload.text.match(/https:\/\/max\.ru\/t405_hakaton_max_bot\?start=reserve_[A-Za-z0-9_-]+/)?.[0];
    assert.ok(inviteUrl);
    assert.equal((await post(started(202, new URL(inviteUrl).searchParams.get('start')), 'hook-secret')).status, 200);
    assert.equal(delivered.at(-1).payload.attachments[0].payload.buttons[0][0].type, 'request_contact');
    assert.equal((await post(sharedContact(202, '79990001122', 'test-bot-token'), 'hook-secret')).status, 200);
    assert.ok(delivered.at(-1).payload.attachments[0].payload.buttons.flat().some(x => x.payload?.startsWith('r:join:')));
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
