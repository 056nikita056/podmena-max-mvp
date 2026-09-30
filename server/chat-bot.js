import { AppError } from './domain.js';
import { randomBytes } from 'node:crypto';
import { maxProfileUrl, platformUrl } from './outbound-links.js';
import { createReserveService } from './reserve-service.js';

const button = (text, payload) => ({ text, payload });
const link = (text, url) => ({ text, url });
const send = (userId, text, buttons = [], extra = {}) => ({ userId, text, buttons, ...extra });
const home = [[button('Найти подмену', 'm:new')], [button('Мои смены', 'm:list')], [button('Резерв', 'm:reserve:home')]];
const candidateHome = [[button('Мои предложения', 'c:offers'), button('Мой профиль', 'c:profile')], [button('Поиск: вкл / выкл', 'c:toggle')], [button('Я управляющий', 'm:home')]];
const dateText = value => new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
const shortDate = value => new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
const statusText = { draft: 'Черновик', searching: 'Ищем кандидата', unfilled: 'Ищем кандидата', awaiting_confirmation: 'Ожидаем ответ', confirmed: 'Выход подтверждён', completed: 'Выход состоялся', cancelled: 'Отменена' };
const parseDraft = value => { try { return JSON.parse(value); } catch { return {}; } };
const moscowParts = value => Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(value).filter(x => x.type !== 'literal').map(x => [x.type, Number(x.value)]));
function fromMoscow(text) {
  const match = /^(\d{1,2})\.(\d{1,2})\.(\d{4})\s+(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!match) return null;
  const [, day, month, year, hour, minute] = match.map(Number);
  if (hour > 23 || minute > 59) return null;
  const date = new Date(Date.UTC(year, month - 1, day, hour - 3, minute));
  const actual = moscowParts(date);
  return actual.day === day && actual.month === month && actual.year === year && dateText(date).endsWith(`${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`) ? date : null;
}
function presetDay(offset, now = new Date()) {
  const parts = moscowParts(now);
  const day = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + offset));
  return `${String(day.getUTCDate()).padStart(2, '0')}.${String(day.getUTCMonth() + 1).padStart(2, '0')}.${day.getUTCFullYear()}`;
}
function dateButtons() {
  return [[button('Сегодня', 'm:day:0'), button('Завтра', 'm:day:1'), button('Послезавтра', 'm:day:2')], [button('Другая дата', 'm:day:custom')], [button('Отмена', 'm:home')]];
}
function timeButtons() {
  return [[button('09:00', 'm:time:09:00'), button('12:00', 'm:time:12:00'), button('18:00', 'm:time:18:00')], [button('Другое время', 'm:time:custom')], [button('Назад', 'm:date')]];
}
function shiftButton(id, label = 'Открыть смену') { return button(label, `m:shift:${id}`); }
function sourceName(source) { return source === 'youdo' ? 'YouDo' : source === 'profi' ? 'Профи.ру' : source === 'max' ? 'MAX' : source === 'staff' ? 'Сотрудники' : 'Резерв'; }
const descriptionPrompt = 'Описание смены: напишите его своими словами. Можно указать задачи, нужный опыт, оборудование, график и условия. Например: «Бариста на утро: готовить напитки, работать с кассой, закрыть смену». Этот текст будет показан в предложении сотруднику резерва.';
const cleanEdit = draft => { const { editField, editOriginal, ...rest } = draft; return rest; };
const editButtons = draft => draft.editOriginal ? [[button('К проверке', 'm:review')]] : [];
function reviewCard(userId, draft) {
  return send(userId, `Проверьте смену\n\n${draft.siteName}, ${draft.siteAddress}\n${shortDate(draft.startsAt)} · ${draft.hours} ч · ${draft.payRub.toLocaleString('ru-RU')} ₽\n\nОписание: «${draft.description}»\n\nСначала сообщим сотрудникам резерва и посмотрим учебные профили команды. Затем покажем тестовые отклики YouDo и Профи.ру.`, [[button('Опубликовать смену', 'm:publish')], [button('Изменить точку', 'm:edit:site'), button('Дату и время', 'm:edit:datetime')], [button('Длительность', 'm:edit:hours'), button('Оплату', 'm:edit:pay')], [button('Описание', 'm:edit:description')], [button('Отмена', 'm:home')]]);
}

export function createChatBot(store, domain, options = {}) {
  const candidateMode = options.enableCandidateMode === true;
  const makeOutboundLink = options.makeOutboundLink || (() => null);
  const { get, all, run } = store;
  const reserveService = createReserveService(store, domain, { inviteSecret: options.inviteSecret || randomBytes(32).toString('hex'), botToken: options.botToken, botUsername: options.botUsername });
  async function state(userId) {
    await run("INSERT OR IGNORE INTO bot_dialogs(user_id,mode,stage,draft_json,updated_at) VALUES (?,?,?,?,?)", userId, '', '', '{}', new Date().toISOString());
    return get('SELECT * FROM bot_dialogs WHERE user_id=?', userId);
  }
  async function save(userId, mode, stage = '', draft = {}) {
    await run('UPDATE bot_dialogs SET mode=?,stage=?,draft_json=?,updated_at=? WHERE user_id=?', mode, stage, JSON.stringify(draft), new Date().toISOString(), userId);
  }
  async function card(workspace, id) {
    const data = await domain.detail(workspace, id);
    const sh = data.shift;
    const lines = [`${sh.site_name} · ${statusText[sh.status] || sh.status}`, sh.site_address, `${shortDate(sh.starts_at)} · ${Math.round((Date.parse(sh.ends_at) - Date.parse(sh.starts_at)) / 3600000)} ч · ${sh.payRub.toLocaleString('ru-RU')} ₽`, `Описание: ${sh.description || sh.skills.join(', ')}`];
    if (data.offer) lines.push(`Кандидат: ${data.offer.name}`);
    const demo = data.publications.filter(x => ['youdo', 'profi'].includes(x.source));
    if (demo.length) lines.push(`Площадки: ${demo.map(x => `${sourceName(x.source)} (демо)`).join(', ')}`);
    return { data, text: lines.join('\n') };
  }
  function responseCard(userId, shiftId, response, data) {
    const modelled = !response.maxUserId;
    const reply = data.messages.find(x => x.candidateId === response.candidateId && x.sender === 'candidate');
    const lines = [`${response.name} · ${sourceName(response.source)}${modelled ? ' (демо)' : ' · MAX'}`];
    if (response.rateRub > 0) lines.push(`${response.experienceYears} года опыта · ${response.rateRub.toLocaleString('ru-RU')} ₽`);
    if (response.skills.length) lines.push(`В профиле: ${response.skills.join(', ')}`);
    if (reply) lines.push(`«${reply.text}»`);
    else if (response.source === 'max') lines.push('Зарегистрирован в MAX. Требование к навыку увидит в предложении.');
    if (modelled) lines.push('Тестовый профиль: реальное сообщение человеку не отправлялось.');
    const buttons = [];
    if (candidateMode && response.source === 'max') buttons.push([button('Предложить смену', `m:offer:${shiftId}:${response.candidateId}`)]);
    const sourceUrl = platformUrl(response.source);
    if (sourceUrl) {
      const url = makeOutboundLink({ managerId: userId, shiftId, candidateId: response.candidateId, target: 'platform' });
      if (url) buttons.push([link(`Открыть ${sourceName(response.source)}`, url)]);
    }
    if (maxProfileUrl(response.maxProfileUrl)) {
      const url = makeOutboundLink({ managerId: userId, shiftId, candidateId: response.candidateId, target: 'max' });
      if (url) buttons.push([link('Написать в MAX', url)]);
    }
    buttons.push([shiftButton(shiftId, 'К смене')]);
    return send(userId, lines.join('\n'), buttons);
  }
  async function showResponses(userId, workspace, id, sourceFilter = null, excludeCandidateId = null) {
    const data = await domain.detail(workspace, id);
    const responses = data.responses.filter(x => x.status === 'new' && (candidateMode || x.source !== 'max') && (!sourceFilter || sourceFilter.includes(x.source)) && x.candidateId !== excludeCandidateId).sort((a, b) => Number(Boolean(b.maxUserId)) - Number(Boolean(a.maxUserId)) || b.id - a.id).slice(0, 5);
    if (!responses.length) return [send(userId, excludeCandidateId ? 'Других откликов пока нет.' : 'Новых откликов пока нет. Поиск продолжается.', [[shiftButton(id)], [button('Меню', 'm:home')]])];
    return [send(userId, `Новые отклики по смене «${data.shift.site_name}». Описание смены: ${data.shift.description || data.shift.skills.join(', ')}.`, [[shiftButton(id)], [button('Меню', 'm:home')]]), ...responses.map(x => responseCard(userId, id, x, data))];
  }
  async function handle(update) {
    if (!['bot_started', 'message_created', 'message_callback'].includes(update?.update_type)) return [];
    if (update.update_type !== 'bot_started' && update.message?.recipient?.chat_type && update.message.recipient.chat_type !== 'dialog') return [];
    if (update.update_type === 'message_created' && update.message?.sender?.is_bot) return [];
    const actor = update.update_type === 'bot_started' ? update.user : update.update_type === 'message_callback' ? (update.callback?.user || update.user) : update.message?.sender;
    const userId = Number(actor?.user_id);
    if (!Number.isSafeInteger(userId) || userId <= 0) return [];
    const raw = update.update_type === 'bot_started' ? (update.payload?.startsWith('reserve_') ? `r:invite:${update.payload}` : '/start') : update.update_type === 'message_callback' ? update.callback?.payload : update.message?.body?.text || (update.message?.body?.attachments?.some(x => x.type === 'contact') ? 'r:contact' : '');
    if (typeof raw !== 'string' || !raw.trim()) return [];
    const input = raw.trim();
    const current = await state(userId);
    const workspace = `max:${userId}`;
    try {
      if (input.startsWith('r:') || current.mode === 'reserve_member' || input === '/reserve-inbox') return await reserveMember(userId, actor, input, current, update);
      if (input === '/start' || input === '/help' || input === 'Помощь') return [send(userId, 'Подмена\n\nРазместите смену и получите отклики. YouDo и Профи.ру сейчас работают как демонстрация.', candidateMode ? [...home, [button('Я кандидат', 'c:home')]] : home)];
      if (['/manager', 'Я управляющий', 'm:home', 'Меню'].includes(input)) { await domain.bootstrap(workspace); await save(userId, 'manager'); return [send(userId, 'Что хотите сделать?', home)]; }
      if (!candidateMode && (['/candidate', 'Я кандидат'].includes(input) || input.startsWith('c:') || (current.mode === 'candidate' && !input.startsWith('m:')))) { await save(userId, 'manager'); return [send(userId, 'Режим кандидата временно выключен. Сейчас доступен сценарий управляющего.', home)]; }
      if (['/candidate', 'Я кандидат', 'c:home'].includes(input)) return await candidateHomeView(userId);
      if (input === '/cancel' || input === 'Отмена') { await save(userId, current.mode); return [send(userId, 'Действие отменено.', current.mode === 'candidate' ? candidateHome : home)]; }
      if (candidateMode && (current.mode === 'candidate' || input.startsWith('c:'))) return await candidate(userId, actor, input, current);
      if (current.mode === 'manager' || input.startsWith('m:')) return await manager(userId, workspace, input, current);
      return [send(userId, 'Выберите действие.', candidateMode ? [...home, [button('Я кандидат', 'c:home')]] : home)];
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      return [send(userId, error.message, [[button('Меню', current.mode === 'candidate' ? 'c:home' : 'm:home')]])];
    }
  }
  async function reserveMember(userId, actor, input, current, update) {
    const draft = parseDraft(current.draft_json);
    if (input.startsWith('r:invite:')) {
      const invitation = await reserveService.beginInvite(input.slice(9), actor);
      await save(userId, 'reserve_member', invitation.needsContact ? 'reserve_contact' : 'reserve_confirm', { inviteId: invitation.id, verified: !invitation.needsContact, username: actor?.username || null, firstName: actor?.first_name || null, lastName: actor?.last_name || null });
      return invitation.needsContact
        ? [send(userId, 'Вас пригласили в резерв. Чтобы подтвердить, что приглашение адресовано вам, поделитесь своим номером кнопкой MAX. После этого вы сможете получать смены и отвечать в этом чате.', [[{ text: 'Поделиться своим контактом', type: 'request_contact' }], [button('Отмена', 'r:home')]])]
        : [send(userId, 'Вас пригласили в резерв. Принять приглашение и получать смены в этом чате?', [[button('Принять приглашение', `r:join:${invitation.id}`)], [button('Отмена', 'r:home')]])];
    }
    if (input === 'r:contact' && current.stage === 'reserve_contact') {
      if (!await reserveService.checkContact(draft.inviteId, update.message?.body)) return [send(userId, 'Номер не совпадает с приглашением или контакт не подтверждён MAX. Нажмите кнопку и поделитесь своим контактом.', [[{ text: 'Поделиться своим контактом', type: 'request_contact' }]])];
      await save(userId, 'reserve_member', 'reserve_confirm', { ...draft, verified: true });
      return [send(userId, 'Номер подтверждён. Принять приглашение в резерв?', [[button('Принять приглашение', `r:join:${draft.inviteId}`)], [button('Отмена', 'r:home')]])];
    }
    const join = /^r:join:(\d+)$/.exec(input);
    if (join) {
      if (current.stage !== 'reserve_confirm' || Number(join[1]) !== draft.inviteId) return [send(userId, 'Приглашение недоступно. Откройте свою ссылку ещё раз.')];
      const result = await reserveService.joinInvite(draft.inviteId, { ...actor, username: actor?.username || draft.username, first_name: draft.firstName || actor?.first_name, last_name: draft.lastName || actor?.last_name }, draft.verified);
      await save(userId, 'reserve_member');
      return [send(userId, 'Вы в резерве. Новые смены будут приходить сюда; на каждую можно откликнуться или отказаться.', [[button('Мои приглашения', 'r:home')]]), send(result.managerId, `${result.name} присоединился(ась) к вашему резерву MAX. Теперь человек получит следующую рассылку смен.`, [[button('Резерв', 'm:reserve:home')]])];
    }
    const reply = /^r:reply:(\d+):(\d+):(yes|no)$/.exec(input);
    if (reply) {
      const result = await reserveService.reply(Number(reply[1]), Number(reply[2]), userId, reply[3]);
      return result.accepted
        ? [send(userId, 'Вы откликнулись. Управляющий получил ваш ответ и может связаться с вами.', [[button('Мои приглашения', 'r:home')]]), send(result.managerId, `${result.name} откликнулся(ась) на смену в MAX.`, [[button('Посмотреть отклик', `m:responses:${Number(reply[2])}`)]])]
        : [send(userId, 'Ответ сохранён: вы не можете выйти на эту смену.', [[button('Мои приглашения', 'r:home')]])];
    }
    if (input === 'r:home' || input === '/reserve-inbox') {
      await save(userId, 'reserve_member');
      const pending = await reserveService.pending(userId);
      if (!pending.length) return [send(userId, 'Ожидающих приглашений на смены сейчас нет.', [[button('Меню управляющего', 'm:home')]])];
      const result = [];
      for (const item of pending) {
        const data = await domain.detail(item.workspace, item.shiftId);
        result.push(send(userId, `${data.shift.site_name}, ${data.shift.site_address}\n${shortDate(data.shift.starts_at)} · ${Math.round((Date.parse(data.shift.ends_at) - Date.parse(data.shift.starts_at)) / 3600000)} ч\n${data.shift.payRub.toLocaleString('ru-RU')} ₽\n${data.shift.description}`, [[button('Откликнуться', `r:reply:${Number(item.workspace.slice(4))}:${item.shiftId}:yes`), button('Не могу', `r:reply:${Number(item.workspace.slice(4))}:${item.shiftId}:no`)] ]));
      }
      return result;
    }
    if (input.startsWith('m:') || input === '/manager') { await save(userId, 'manager'); return manager(userId, `max:${userId}`, input, await state(userId)); }
    return [send(userId, 'Откройте приглашения резерва или меню управляющего.', [[button('Мои приглашения', 'r:home')], [button('Меню управляющего', 'm:home')]])];
  }
  async function candidateHomeView(userId) {
    const profile = await get('SELECT * FROM bot_candidate_profiles WHERE user_id=?', userId);
    await save(userId, 'candidate', profile ? '' : 'candidate_skill');
    return profile ? [send(userId, `Здравствуйте, ${profile.name}. Поиск ${profile.available ? 'включён' : 'приостановлен'}.`, candidateHome)] : [send(userId, 'Создадим профиль кандидата. Напишите ваш основной навык свободным текстом (например, «эспрессо и касса»). Это увидят управляющие.', [[button('Отмена', 'm:home')]])];
  }
  async function candidate(userId, actor, input, current) {
    const draft = parseDraft(current.draft_json);
    if (current.stage === 'candidate_skill') {
      if (input.length < 2 || input.length > 80 || input.startsWith('c:')) return [send(userId, 'Напишите навык словами, от 2 до 80 символов.')];
      await save(userId, 'candidate', 'candidate_rate', { skill: input });
      return [send(userId, 'Минимальная оплата за смену в рублях?', [[button('5 000 ₽', 'c:rate:5000'), button('6 000 ₽', 'c:rate:6000')]])];
    }
    if (current.stage === 'candidate_rate') {
      const rate = Number((input.startsWith('c:rate:') ? input.slice(7) : input).replace(/\s/g, ''));
      if (!Number.isInteger(rate) || rate < 1000 || rate > 100000) return [send(userId, 'Введите сумму от 1 000 до 100 000 ₽.')];
      const name = [actor?.first_name, actor?.last_name].filter(Boolean).join(' ').trim().slice(0, 80) || actor?.name?.slice(0, 80) || `Кандидат MAX`;
      await run(`INSERT INTO bot_candidate_profiles(user_id,name,skill,rate_kopecks,available,updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET name=excluded.name,skill=excluded.skill,rate_kopecks=excluded.rate_kopecks,available=excluded.available,updated_at=excluded.updated_at`, userId, name, draft.skill, rate * 100, 1, new Date().toISOString());
      await save(userId, 'candidate');
      return [send(userId, `Профиль готов: ${name} · ${draft.skill} · от ${rate.toLocaleString('ru-RU')} ₽. Предложения придут сюда.`, [...candidateHome, [button('Добавить ссылку MAX', 'c:link')]])];
    }
    const profile = await get('SELECT * FROM bot_candidate_profiles WHERE user_id=?', userId);
    if (!profile) return candidateHomeView(userId);
    if (input === 'c:link') { await save(userId, 'candidate', 'candidate_link'); return [send(userId, 'Пришлите ссылку на ваш профиль MAX. Управляющий увидит её в отклике и сможет написать вам.', [[button('Отмена', 'c:home')]])]; }
    if (current.stage === 'candidate_link') {
      const url = maxProfileUrl(input);
      if (!url) return [send(userId, 'Нужна ссылка на профиль вида https://max.ru/u/… или https://max.ru/имя.')];
      await run('UPDATE bot_candidate_profiles SET max_profile_url=?,updated_at=? WHERE user_id=?', url, new Date().toISOString(), userId);
      await run('UPDATE candidates SET max_profile_url=? WHERE max_user_id=?', url, userId);
      await save(userId, 'candidate');
      return [send(userId, 'Ссылка MAX сохранена.', candidateHome)];
    }
    if (input === 'c:profile' || input === 'Мой профиль') return [send(userId, `${profile.name}\n${profile.skill} · от ${(profile.rate_kopecks / 100).toLocaleString('ru-RU')} ₽\nПоиск ${profile.available ? 'включён' : 'приостановлен'}.`, [...candidateHome, [button('Добавить ссылку MAX', 'c:link')]])];
    if (input === 'c:toggle' || input === 'Приостановить поиск' || input === 'Возобновить поиск') {
      const available = input === 'c:toggle' ? Number(!profile.available) : Number(input === 'Возобновить поиск');
      await run('UPDATE bot_candidate_profiles SET available=?,updated_at=? WHERE user_id=?', available, new Date().toISOString(), userId);
      await run('UPDATE candidates SET available=? WHERE max_user_id=?', available, userId);
      return [send(userId, available ? 'Поиск включён.' : 'Поиск приостановлен. Уже полученные предложения доступны.', candidateHome)];
    }
    if (input === 'c:offers' || input === 'Предложения') {
      const offers = await all(`SELECT o.shift_id AS shiftId,s.workspace_id AS workspace FROM offers o JOIN candidates c ON c.id=o.candidate_id JOIN shifts s ON s.id=o.shift_id WHERE c.max_user_id=? AND o.status='pending' ORDER BY o.id DESC LIMIT 5`, userId);
      if (!offers.length) return [send(userId, 'Сейчас нет предложений.', candidateHome)];
      const result = [];
      for (const offer of offers) result.push(send(userId, (await card(offer.workspace, offer.shiftId)).text, [[button('Принять', `c:accept:${offer.shiftId}`), button('Отказаться', `c:decline:${offer.shiftId}`)]]));
      return result;
    }
    const decision = /^(?:c:(accept|decline):(\d+)|(Принять|Отказаться) #(\d+))$/.exec(input);
    if (decision) {
      const id = Number(decision[2] || decision[4]);
      const offer = await get(`SELECT s.workspace_id AS workspace FROM offers o JOIN shifts s ON s.id=o.shift_id JOIN candidates c ON c.id=o.candidate_id WHERE o.shift_id=? AND o.status='pending' AND c.max_user_id=?`, id, userId);
      if (!offer) return [send(userId, 'Предложение недоступно или уже закрыто.', candidateHome)];
      const value = decision[1] === 'accept' || decision[3] === 'Принять' ? 'confirm' : 'decline';
      const result = await domain.decision(offer.workspace, id, value);
      const managerId = Number(offer.workspace.slice(4));
      return [send(userId, value === 'confirm' ? 'Вы подтвердили выход. Управляющий получил уведомление.' : 'Вы отказались. Управляющий получил уведомление.', candidateHome), send(managerId, `${result.offer.name} ${value === 'confirm' ? 'подтвердил(а) выход' : 'отказался(ась)'} по смене ${shortDate(result.shift.starts_at)}.`, [[shiftButton(id)]])];
    }
    return [send(userId, 'Выберите действие.', candidateHome)];
  }
  async function manager(userId, workspace, input, current) {
    const draft = parseDraft(current.draft_json);
    if (input === 'm:reserve:home') {
      await domain.bootstrap(workspace);
      await save(userId, 'manager');
      const list = await reserveService.list(workspace);
      const people = list.people.map(x => `${x.name}${x.userId ? ' · подключён к MAX' : ' · учебный профиль'}`);
      const pending = list.pending.map(x => `${x.display} · ждём подтверждения`);
      return [send(userId, `Резерв\n\n${[...people, ...pending].length ? [...people, ...pending].join('\n') : 'Пока никого нет.'}\n\nЧтобы сотрудник получал смены, пригласите его по username или номеру. Он должен открыть ссылку и подтвердить участие.`, [[button('Добавить человека', 'm:reserve:add')], [button('Меню', 'm:home')]])];
    }
    if (input === 'm:reserve:add') { await save(userId, 'manager', 'manager_reserve_contact'); return [send(userId, 'Напишите username MAX (@name) или номер телефона сотрудника. Я создам приглашение, которое нужно отправить ему. После подтверждения он будет получать смены здесь.', [[button('Резерв', 'm:reserve:home')]])]; }
    if (current.stage === 'manager_reserve_contact') {
      const invite = await reserveService.createInvite(workspace, input);
      await save(userId, 'manager');
      const shareUrl = `https://max.ru/:share?text=${encodeURIComponent(`Приглашение в резерв: ${invite.url}`)}`;
      return [send(userId, `Приглашение для ${invite.display} создано. Отправьте человеку эту ссылку:\n${invite.url}\n\nСотрудник откроет бота, подтвердит свой username или номер и нажмёт «Принять приглашение». После этого ему будут приходить новые смены.`, [[link('Отправить через MAX', shareUrl)], [button('Резерв', 'm:reserve:home')], [button('Меню', 'm:home')]])];
    }
    if (input === 'm:new' || input === 'Создать смену') {
      const base = await domain.bootstrap(workspace);
      await save(userId, 'manager', 'manager_site');
      const sites = base.sites.slice(0, 6).map(x => [button(x.name, `m:site:${x.id}`)]);
      return [send(userId, 'Где нужна подмена? Выберите точку или добавьте новую.', [...sites, [button('Новая точка', 'm:site:new')], [button('Меню', 'm:home')]])];
    }
    if (input === 'm:list' || input === 'Мои смены') {
      const rows = (await domain.list(workspace)).slice(0, 8);
      return [send(userId, rows.length ? 'Ваши смены:' : 'Смен пока нет.', rows.length ? [...rows.map(x => [shiftButton(x.id, `${shortDate(x.starts_at)} · ${statusText[x.status] || x.status}`)]), [button('Новая смена', 'm:new')], [button('Меню', 'm:home')]] : home)];
    }
    const shiftMatch = /^(?:m:shift:|Смена #)(\d+)$/.exec(input);
    if (shiftMatch) {
      const id = Number(shiftMatch[1]);
      const { data, text } = await card(workspace, id);
      const buttons = [];
      if (['searching', 'unfilled'].includes(data.shift.status)) {
        buttons.push([button(`Отклики · ${data.responses.filter(x => x.status === 'new' && (candidateMode || x.source !== 'max')).length}`, `m:responses:${id}`)]);
        if (candidateMode) buttons.push([button('Повторить поиск в MAX', `m:search:${id}`)]);
      }
      if (data.shift.status === 'confirmed') buttons.push([button('Отметить выход', `m:attendance:${id}:arrived`), button('Невыход', `m:attendance:${id}:no_show`)], [button('Добавить в резерв', `m:reserve:${id}`)]);
      if (!['completed', 'cancelled'].includes(data.shift.status)) buttons.push([button('Отменить смену', `m:cancel:${id}`)]);
      buttons.push([button('Мои смены', 'm:list'), button('Меню', 'm:home')]);
      return [send(userId, text, buttons)];
    }
    const responsesMatch = /^m:responses:(\d+)$/.exec(input);
    if (responsesMatch) return showResponses(userId, workspace, Number(responsesMatch[1]));
    const contactDecision = /^m:contact:(yes|no):(\d+):(\d+)$/.exec(input);
    if (contactDecision) {
      const [, answer, shiftText, candidateText] = contactDecision;
      const shiftId = Number(shiftText), candidateId = Number(candidateText);
      const person = await domain.contactOutcome(workspace, shiftId, candidateId, userId, answer === 'yes');
      return answer === 'yes'
        ? [send(userId, `Отметил(а) вашу договорённость с ${person.name}. Добавить человека в резерв?`, [[button('Добавить в резерв', `m:contact:reserve:${shiftId}:${candidateId}`)], [shiftButton(shiftId)], [button('Меню', 'm:home')]])]
        : [send(userId, `Понятно, с ${person.name} договориться не удалось. Посмотрим других?`, [[button('Другие кандидаты', `m:contact:others:${shiftId}:${candidateId}`)], [shiftButton(shiftId)], [button('Меню', 'm:home')]])];
    }
    const contactReserve = /^m:contact:reserve:(\d+):(\d+)$/.exec(input);
    if (contactReserve) {
      const shiftId = Number(contactReserve[1]);
      await domain.addContactReserve(workspace, shiftId, Number(contactReserve[2]), userId);
      return [send(userId, 'Кандидат добавлен в резерв. Договорённость отмечена с ваших слов; подтвердите детали напрямую с человеком.', [[shiftButton(shiftId)], [button('Меню', 'm:home')]])];
    }
    const contactOthers = /^m:contact:others:(\d+):(\d+)$/.exec(input);
    if (contactOthers) return showResponses(userId, workspace, Number(contactOthers[1]), null, Number(contactOthers[2]));
    const searchMatch = /^(?:m:search:|Искать #)(\d+)$/.exec(input);
    if (searchMatch) {
      if (!candidateMode) return [send(userId, 'Поиск кандидатов MAX временно выключен.', [[shiftButton(Number(searchMatch[1]))]])];
      const id = Number(searchMatch[1]);
      await domain.search(workspace, id, { sources: ['max'] });
      return showResponses(userId, workspace, id, ['max']);
    }
    const offerMatch = /^(?:m:offer:(\d+):(\d+)|Предложить #(\d+) #(\d+))$/.exec(input);
    if (offerMatch) {
      if (!candidateMode) return [send(userId, 'Предложения кандидатам MAX временно выключены.', [[shiftButton(Number(offerMatch[1] || offerMatch[3]))]])];
      const id = Number(offerMatch[1] || offerMatch[3]);
      const candidateId = Number(offerMatch[2] || offerMatch[4]);
      const candidate = await get('SELECT max_user_id FROM candidates WHERE id=? AND workspace_id=? AND source=?', candidateId, workspace, 'max');
      if (!candidate?.max_user_id) return [send(userId, 'Предложение можно отправить только реальному кандидату MAX.', [[shiftButton(id)]])];
      const profile = await get('SELECT available FROM bot_candidate_profiles WHERE user_id=?', candidate.max_user_id);
      if (!profile?.available) return [send(userId, 'Кандидат приостановил поиск.', [[shiftButton(id)]])];
      const result = await domain.offer(workspace, id, candidateId);
      const sh = result.shift;
      return [send(userId, `Предложение отправлено ${result.offer.name}. Ожидаем решение в отдельном чате кандидата.`, [[shiftButton(id)]]), send(candidate.max_user_id, `Вам предложили смену:\n${sh.site_name}, ${sh.site_address}\n${shortDate(sh.starts_at)} · ${Math.round((Date.parse(sh.ends_at) - Date.parse(sh.starts_at)) / 3600000)} ч\nОплата ${sh.payRub.toLocaleString('ru-RU')} ₽\nОписание: ${sh.description || sh.skills.join(', ')}\n\nПодтвердите выход, если условия подходят.`, [[button('Принять', `c:accept:${id}`), button('Отказаться', `c:decline:${id}`)]])];
    }
    const attendance = /^m:attendance:(\d+):(arrived|no_show)$/.exec(input);
    if (attendance) { await domain.attendance(workspace, Number(attendance[1]), attendance[2]); return [send(userId, attendance[2] === 'arrived' ? 'Выход отмечен.' : 'Невыход отмечен.', [[shiftButton(Number(attendance[1]))], [button('Меню', 'm:home')]])]; }
    const reserve = /^m:reserve:(\d+)$/.exec(input);
    if (reserve) { const id = Number(reserve[1]); const data = await domain.detail(workspace, id); await domain.addReserve(workspace, id, data.offer?.candidateId); return [send(userId, 'Кандидат добавлен в резерв.', [[shiftButton(id)]])]; }
    const cancel = /^m:cancel:(\d+)$/.exec(input);
    if (cancel) {
      const id = Number(cancel[1]); const data = await domain.detail(workspace, id); await domain.cancel(workspace, id);
      const candidate = data.offer?.status === 'pending' || data.offer?.status === 'confirmed' ? await get('SELECT max_user_id FROM candidates WHERE id=?', data.offer.candidateId) : null;
      return [send(userId, 'Смена отменена.', [[button('Меню', 'm:home')]]), ...(candidateMode && candidate?.max_user_id ? [send(candidate.max_user_id, 'Управляющий отменил предложенную вам смену.')] : [])];
    }
    if (input === 'm:review' && draft.editOriginal) { await save(userId, 'manager', 'manager_review', draft.editOriginal); return [reviewCard(userId, draft.editOriginal)]; }
    const editing = /^m:edit:(site|datetime|hours|pay|description)$/.exec(input);
    if (current.stage === 'manager_review' && editing) {
      const field = editing[1];
      const next = { ...draft, editField: field, editOriginal: draft };
      const stage = { site: 'manager_site', datetime: 'manager_date', hours: 'manager_hours', pay: 'manager_pay', description: 'manager_description' }[field];
      await save(userId, 'manager', stage, next);
      if (field === 'site') {
        const base = await domain.bootstrap(workspace);
        return [send(userId, 'Выберите другую точку или добавьте новую.', [...base.sites.slice(0, 6).map(x => [button(x.name, `m:site:${x.id}`)]), [button('Новая точка', 'm:site:new')], ...editButtons(next)])];
      }
      if (field === 'datetime') return [send(userId, 'Выберите новую дату или напишите дату и время по Москве.', [...dateButtons(), ...editButtons(next)])];
      if (field === 'hours') return [send(userId, 'Сколько часов длится смена?', [[button('4 часа', 'm:hours:4'), button('6 часов', 'm:hours:6'), button('8 часов', 'm:hours:8')], [button('12 часов', 'm:hours:12'), button('Своё число', 'm:hours:custom')], ...editButtons(next)])];
      if (field === 'pay') return [send(userId, 'Оплата за всю смену?', [[button('4 000 ₽', 'm:pay:4000'), button('5 000 ₽', 'm:pay:5000'), button('6 000 ₽', 'm:pay:6000')], [button('Другая сумма', 'm:pay:custom')], ...editButtons(next)])];
      return [send(userId, descriptionPrompt, editButtons(next))];
    }
    if (current.stage === 'manager_site') {
      if (input === 'm:site:new') { await save(userId, 'manager', 'manager_site_name', draft); return [send(userId, 'Напишите название новой точки.', [...editButtons(draft), [button('Меню', 'm:home')]])]; }
      const selected = /^m:site:(\d+)$/.exec(input);
      if (!selected) return [send(userId, 'Выберите точку кнопкой.', [[button('Назад', 'm:new')]])];
      const site = await get('SELECT id,name,address FROM sites WHERE id=? AND workspace_id=?', Number(selected[1]), workspace);
      if (!site) return [send(userId, 'Точка не найдена.', [[button('Назад', 'm:new')]])];
      const next = { ...draft, siteId: site.id, siteName: site.name, siteAddress: site.address };
      if (draft.editOriginal) { const clean = cleanEdit(next); await save(userId, 'manager', 'manager_review', clean); return [reviewCard(userId, clean)]; }
      await save(userId, 'manager', 'manager_date', next);
      return [send(userId, `${site.name} · ${site.address}\nКогда нужна подмена?`, dateButtons())];
    }
    if (current.stage === 'manager_site_name') {
      if (input.length < 2 || input.length > 80) return [send(userId, 'Название точки: от 2 до 80 символов.')];
      await save(userId, 'manager', 'manager_site_address', { ...draft, siteId: null, siteName: input });
      return [send(userId, 'Напишите адрес. Он будет показан кандидату.', [[button('Меню', 'm:home')]])];
    }
    if (current.stage === 'manager_site_address') {
      if (input.length < 5 || input.length > 150) return [send(userId, 'Адрес: от 5 до 150 символов.')];
      const next = { ...draft, siteAddress: input };
      if (draft.editOriginal) { const clean = cleanEdit(next); await save(userId, 'manager', 'manager_review', clean); return [reviewCard(userId, clean)]; }
      await save(userId, 'manager', 'manager_date', next);
      return [send(userId, 'Когда нужна подмена?', dateButtons())];
    }
    if (current.stage === 'manager_date') {
      if (input === 'm:day:custom') return [send(userId, `Напишите дату и время по Москве, например ${presetDay(1)} 9:00.`, [[button('Назад', 'm:date')]])];
      const dayMatch = /^m:day:([012])$/.exec(input);
      if (dayMatch) { await save(userId, 'manager', 'manager_time', { ...draft, day: presetDay(Number(dayMatch[1])) }); return [send(userId, `Выбрано: ${presetDay(Number(dayMatch[1]))}. Во сколько начать?`, timeButtons())]; }
      const date = fromMoscow(input);
      if (!date || date.getTime() < Date.now() + 3600000) return [send(userId, `Нужно время минимум через час. Например ${presetDay(1)} 9:00 (Москва).`, dateButtons())];
      if (draft.editOriginal) { const clean = cleanEdit({ ...draft, startsAt: date.toISOString() }); await save(userId, 'manager', 'manager_review', clean); return [reviewCard(userId, clean)]; }
      await save(userId, 'manager', 'manager_hours', { ...draft, startsAt: date.toISOString() });
      return [send(userId, 'Сколько часов длится смена?', [[button('4 часа', 'm:hours:4'), button('6 часов', 'm:hours:6'), button('8 часов', 'm:hours:8')], [button('12 часов', 'm:hours:12')], [button('Своё количество часов', 'm:hours:custom')], [button('Назад', 'm:date')]])];
    }
    if (input === 'm:date' && ['manager_time', 'manager_hours'].includes(current.stage)) { await save(userId, 'manager', 'manager_date', draft); return [send(userId, 'Когда нужна подмена?', dateButtons())]; }
    if (current.stage === 'manager_time') {
      if (input === 'm:time:custom') return [send(userId, `Напишите время по Москве, например 9:00. Дата ${draft.day}.`, timeButtons())];
      const time = /^m:time:(\d{2}:\d{2})$/.exec(input)?.[1] || (/^\d{1,2}:\d{2}$/.test(input) ? input : null);
      const date = time ? fromMoscow(`${draft.day} ${time}`) : null;
      if (!date || date.getTime() < Date.now() + 3600000) return [send(userId, 'Выберите время минимум через час или другой день.', timeButtons())];
      if (draft.editOriginal) { const clean = cleanEdit({ ...draft, startsAt: date.toISOString() }); await save(userId, 'manager', 'manager_review', clean); return [reviewCard(userId, clean)]; }
      await save(userId, 'manager', 'manager_hours', { ...draft, startsAt: date.toISOString() });
      return [send(userId, `${shortDate(date)}. Сколько часов длится смена?`, [[button('4 часа', 'm:hours:4'), button('6 часов', 'm:hours:6'), button('8 часов', 'm:hours:8')], [button('12 часов', 'm:hours:12')], [button('Своё количество часов', 'm:hours:custom')], [button('Назад', 'm:date')]])];
    }
    if (current.stage === 'manager_hours') {
      if (input === 'm:hours:custom') return [send(userId, 'Напишите своё количество часов числом от 1 до 24.')];
      const hours = Number(input.startsWith('m:hours:') ? input.slice(8) : input);
      if (!Number.isInteger(hours) || hours < 1 || hours > 24) return [send(userId, 'Введите число часов от 1 до 24.')];
      if (draft.editOriginal) { const clean = cleanEdit({ ...draft, hours }); await save(userId, 'manager', 'manager_review', clean); return [reviewCard(userId, clean)]; }
      await save(userId, 'manager', 'manager_pay', { ...draft, hours });
      return [send(userId, 'Оплата за всю смену?', [[button('4 000 ₽', 'm:pay:4000'), button('5 000 ₽', 'm:pay:5000'), button('6 000 ₽', 'm:pay:6000')], [button('Другая сумма', 'm:pay:custom')]])];
    }
    if (current.stage === 'manager_pay') {
      if (input === 'm:pay:custom') return [send(userId, 'Напишите сумму за смену в рублях, от 1 000 до 100 000.')];
      const payRub = Number((input.startsWith('m:pay:') ? input.slice(6) : input).replace(/\s/g, ''));
      if (!Number.isInteger(payRub) || payRub < 1000 || payRub > 100000) return [send(userId, 'Введите сумму от 1 000 до 100 000 ₽.')];
      if (draft.editOriginal) { const clean = cleanEdit({ ...draft, payRub }); await save(userId, 'manager', 'manager_review', clean); return [reviewCard(userId, clean)]; }
      await save(userId, 'manager', 'manager_description', { ...draft, payRub });
      return [send(userId, descriptionPrompt, [[button('Меню', 'm:home')]])];
    }
    if (['manager_skill', 'manager_description'].includes(current.stage)) {
      if (input.length < 2 || input.length > 500 || input.startsWith('m:')) return [send(userId, 'Напишите описание смены своими словами, от 2 до 500 символов. Например: задачи, опыт, оборудование и условия.')];
      const next = cleanEdit({ ...draft, description: input });
      await save(userId, 'manager', 'manager_review', next);
      return [reviewCard(userId, next)];
    }
    if (current.stage === 'manager_review' && (input === 'm:publish' || input === 'Подтвердить смену')) {
      const start = Date.parse(draft.startsAt);
      let site = draft.siteId ? await get('SELECT id FROM sites WHERE id=? AND workspace_id=?', draft.siteId, workspace) : await get('SELECT id FROM sites WHERE workspace_id=? AND name=? AND address=?', workspace, draft.siteName, draft.siteAddress);
      if (!site) { const saved = await run('INSERT INTO sites(workspace_id,name,address) VALUES (?,?,?)', workspace, draft.siteName, draft.siteAddress); site = { id: saved.lastInsertRowid }; }
      const created = await domain.create(workspace, { siteId: site.id, role: 'Бариста', startsAt: draft.startsAt, endsAt: new Date(start + draft.hours * 3600000).toISOString(), payRub: draft.payRub, skills: [], description: draft.description, decisionDeadline: new Date(start - 60000).toISOString(), sources: candidateMode ? ['staff', 'reserve', 'max', 'youdo', 'profi'] : ['staff', 'reserve', 'youdo', 'profi'] });
      await save(userId, 'manager');
      const found = await domain.search(workspace, created.shift.id, { sources: candidateMode ? ['staff', 'reserve', 'max'] : ['staff', 'reserve'] });
      const immediate = found.responses.filter(x => x.status === 'new');
      const members = await reserveService.broadcast(workspace, created.shift.id);
      const managerMessage = send(userId, `Смена опубликована. ${immediate.length ? `Сейчас есть ${immediate.length} учебный отклик из команды или резерва.` : 'В учебных профилях команды и резерва пока никого нет.'} ${members.length ? `Уведомления отправляем ${members.length} подключённым сотрудникам резерва; их ответы придут отдельно.` : 'Подключённых к MAX сотрудников резерва пока нет.'}\n\nYouDo и Профи.ру: тестовые заявки отправлены. Примерно через 10 секунд покажу учебные отклики отдельным сообщением.`, [[shiftButton(created.shift.id)], [button('Отклики', `m:responses:${created.shift.id}`)], [button('Меню', 'm:home')]], { demoShiftId: created.shift.id });
      return [managerMessage, ...members.map(member => send(member.userId, `Новая смена из вашего резерва:\n${created.shift.site_name}, ${created.shift.site_address}\n${shortDate(created.shift.starts_at)} · ${draft.hours} ч\nОплата ${created.shift.payRub.toLocaleString('ru-RU')} ₽\nОписание: ${created.shift.description}\n\nМожете выйти?`, [[button('Откликнуться', `r:reply:${userId}:${created.shift.id}:yes`), button('Не могу', `r:reply:${userId}:${created.shift.id}:no`)] ]))];
    }
    return [send(userId, 'Выберите действие в меню.', home)];
  }
  async function demoArrivals(userId, shiftId) {
    const workspace = `max:${userId}`;
    const details = await domain.detail(workspace, shiftId);
    if (!['searching', 'unfilled'].includes(details.shift.status)) return [];
    await domain.search(workspace, shiftId, { sources: ['youdo', 'profi'], modelledReplies: true });
    const result = await domain.detail(workspace, shiftId);
    const picks = ['youdo', 'profi'].map(source => result.responses.find(x => x.source === source && x.status === 'new')).filter(Boolean);
    const lines = picks.map(person => {
      const reply = result.messages.find(x => x.candidateId === person.candidateId && x.sender === 'candidate');
      return `${sourceName(person.source)} (демо) · ${person.name} · ${person.rateRub.toLocaleString('ru-RU')} ₽${person.rateRub > result.shift.payRub ? ' (выше бюджета)' : ''}\n«${reply?.text || 'Готов(а) обсудить смену.'}»`;
    });
    return [send(userId, `Тестовые площадки ответили (демо)\n\n${lines.length ? lines.join('\n\n') : 'Подходящих откликов пока нет.'}\n\nЭто учебные данные: реальные заявки на YouDo и Профи.ру не отправлялись.`, [[button('Все отклики', `m:responses:${shiftId}`)], [shiftButton(shiftId)]])];
  }
  return { handle, demoArrivals };
}
