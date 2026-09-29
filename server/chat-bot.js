import { AppError } from './domain.js';

const button = (text, payload) => ({ text, payload });
const send = (userId, text, buttons = [], extra = {}) => ({ userId, text, buttons, ...extra });
const home = [[button('Найти подмену', 'm:new')], [button('Мои смены', 'm:list')], [button('Я кандидат', 'c:home')]];
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

export function createChatBot(store, domain) {
  const { get, all, run } = store;
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
    const lines = [`${sh.site_name} · ${statusText[sh.status] || sh.status}`, sh.site_address, `${shortDate(sh.starts_at)} · ${Math.round((Date.parse(sh.ends_at) - Date.parse(sh.starts_at)) / 3600000)} ч · ${sh.payRub.toLocaleString('ru-RU')} ₽`, `Важно для кандидата: ${sh.skills.join(', ')}`];
    if (data.offer) lines.push(`Кандидат: ${data.offer.name}`);
    const demo = data.publications.filter(x => ['youdo', 'profi'].includes(x.source));
    if (demo.length) lines.push(`Площадки: ${demo.map(x => `${sourceName(x.source)} (демо)`).join(', ')}`);
    return { data, text: lines.join('\n') };
  }
  function responseCard(userId, shiftId, response, data) {
    const modelled = response.source !== 'max';
    const reply = data.messages.find(x => x.candidateId === response.candidateId && x.sender === 'candidate');
    const lines = [`${response.name} · ${sourceName(response.source)}${modelled ? ' (демо)' : ''}`, `${response.experienceYears} года опыта · ${response.rateRub.toLocaleString('ru-RU')} ₽`, `В профиле: ${response.skills.join(', ')}`];
    if (reply) lines.push(`«${reply.text}»`);
    else if (response.source === 'max') lines.push('Зарегистрирован в MAX. Требование к навыку увидит в предложении.');
    if (modelled) lines.push('Тестовый профиль: реальное сообщение человеку не отправлялось.');
    return send(userId, lines.join('\n'), response.source === 'max' ? [[button('Предложить смену', `m:offer:${shiftId}:${response.candidateId}`)]] : [[shiftButton(shiftId, 'К смене')]]);
  }
  async function showResponses(userId, workspace, id, sourceFilter = null) {
    const data = await domain.detail(workspace, id);
    const responses = data.responses.filter(x => x.status === 'new' && (!sourceFilter || sourceFilter.includes(x.source))).slice(0, 5);
    if (!responses.length) return [send(userId, 'Новых откликов пока нет. Поиск продолжается.', [[shiftButton(id)], [button('Меню', 'm:home')]])];
    return [send(userId, `Новые отклики по смене «${data.shift.site_name}». Требование к навыку кандидат видит до ответа.`, [[shiftButton(id)], [button('Меню', 'm:home')]]), ...responses.map(x => responseCard(userId, id, x, data))];
  }
  async function handle(update) {
    if (!['bot_started', 'message_created', 'message_callback'].includes(update?.update_type)) return [];
    if (update.update_type !== 'bot_started' && update.message?.recipient?.chat_type && update.message.recipient.chat_type !== 'dialog') return [];
    if (update.update_type === 'message_created' && update.message?.sender?.is_bot) return [];
    const actor = update.update_type === 'bot_started' ? update.user : update.update_type === 'message_callback' ? (update.callback?.user || update.user) : update.message?.sender;
    const userId = Number(actor?.user_id);
    if (!Number.isSafeInteger(userId) || userId <= 0) return [];
    const raw = update.update_type === 'bot_started' ? '/start' : update.update_type === 'message_callback' ? update.callback?.payload : update.message?.body?.text;
    if (typeof raw !== 'string' || !raw.trim()) return [];
    const input = raw.trim();
    const current = await state(userId);
    const workspace = `max:${userId}`;
    try {
      if (input === '/start' || input === '/help' || input === 'Помощь') return [send(userId, 'Подмена\n\nУправляющий размещает смену и получает отклики. Кандидат подтверждает реальное предложение в своём чате MAX. Отклики YouDo и Профи.ру здесь тестовые.', [[button('Найти подмену', 'm:new')], [button('Я кандидат', 'c:home')]])];
      if (['/manager', 'Я управляющий', 'm:home', 'Меню'].includes(input)) { await domain.bootstrap(workspace); await save(userId, 'manager'); return [send(userId, 'Что хотите сделать?', home)]; }
      if (['/candidate', 'Я кандидат', 'c:home'].includes(input)) return candidateHomeView(userId);
      if (input === '/cancel' || input === 'Отмена') { await save(userId, current.mode); return [send(userId, 'Действие отменено.', current.mode === 'candidate' ? candidateHome : home)]; }
      if (current.mode === 'candidate' || input.startsWith('c:')) return candidate(userId, actor, input, current);
      if (current.mode === 'manager' || input.startsWith('m:')) return manager(userId, workspace, input, current);
      return [send(userId, 'Выберите действие.', [[button('Найти подмену', 'm:new')], [button('Я кандидат', 'c:home')]])];
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      return [send(userId, error.message, [[button('Меню', current.mode === 'candidate' ? 'c:home' : 'm:home')]])];
    }
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
      return [send(userId, `Профиль готов: ${name} · ${draft.skill} · от ${rate.toLocaleString('ru-RU')} ₽. Предложения придут сюда.`, candidateHome)];
    }
    const profile = await get('SELECT * FROM bot_candidate_profiles WHERE user_id=?', userId);
    if (!profile) return candidateHomeView(userId);
    if (input === 'c:profile' || input === 'Мой профиль') return [send(userId, `${profile.name}\n${profile.skill} · от ${(profile.rate_kopecks / 100).toLocaleString('ru-RU')} ₽\nПоиск ${profile.available ? 'включён' : 'приостановлен'}.`, candidateHome)];
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
      if (['searching', 'unfilled'].includes(data.shift.status)) buttons.push([button(`Отклики · ${data.responses.filter(x => x.status === 'new').length}`, `m:responses:${id}`)], [button('Повторить поиск в MAX', `m:search:${id}`)]);
      if (data.shift.status === 'confirmed') buttons.push([button('Отметить выход', `m:attendance:${id}:arrived`), button('Невыход', `m:attendance:${id}:no_show`)], [button('Добавить в резерв', `m:reserve:${id}`)]);
      if (!['completed', 'cancelled'].includes(data.shift.status)) buttons.push([button('Отменить смену', `m:cancel:${id}`)]);
      buttons.push([button('Мои смены', 'm:list'), button('Меню', 'm:home')]);
      return [send(userId, text, buttons)];
    }
    const responsesMatch = /^m:responses:(\d+)$/.exec(input);
    if (responsesMatch) return showResponses(userId, workspace, Number(responsesMatch[1]));
    const searchMatch = /^(?:m:search:|Искать #)(\d+)$/.exec(input);
    if (searchMatch) {
      const id = Number(searchMatch[1]);
      await domain.search(workspace, id, { sources: ['max'] });
      return showResponses(userId, workspace, id, ['max']);
    }
    const offerMatch = /^(?:m:offer:(\d+):(\d+)|Предложить #(\d+) #(\d+))$/.exec(input);
    if (offerMatch) {
      const id = Number(offerMatch[1] || offerMatch[3]);
      const candidateId = Number(offerMatch[2] || offerMatch[4]);
      const candidate = await get('SELECT max_user_id FROM candidates WHERE id=? AND workspace_id=? AND source=?', candidateId, workspace, 'max');
      if (!candidate?.max_user_id) return [send(userId, 'Предложение можно отправить только реальному кандидату MAX.', [[shiftButton(id)]])];
      const profile = await get('SELECT available FROM bot_candidate_profiles WHERE user_id=?', candidate.max_user_id);
      if (!profile?.available) return [send(userId, 'Кандидат приостановил поиск.', [[shiftButton(id)]])];
      const result = await domain.offer(workspace, id, candidateId);
      const sh = result.shift;
      return [send(userId, `Предложение отправлено ${result.offer.name}. Ожидаем решение в отдельном чате кандидата.`, [[shiftButton(id)]]), send(candidate.max_user_id, `Вам предложили смену:\n${sh.site_name}, ${sh.site_address}\n${shortDate(sh.starts_at)} · ${Math.round((Date.parse(sh.ends_at) - Date.parse(sh.starts_at)) / 3600000)} ч\nОплата ${sh.payRub.toLocaleString('ru-RU')} ₽\nОбязательное требование управляющего: ${sh.skills.join(', ')}\n\nПодтвердите выход только если можете выполнить это требование.`, [[button('Принять', `c:accept:${id}`), button('Отказаться', `c:decline:${id}`)]])];
    }
    const attendance = /^m:attendance:(\d+):(arrived|no_show)$/.exec(input);
    if (attendance) { await domain.attendance(workspace, Number(attendance[1]), attendance[2]); return [send(userId, attendance[2] === 'arrived' ? 'Выход отмечен.' : 'Невыход отмечен.', [[shiftButton(Number(attendance[1]))], [button('Меню', 'm:home')]])]; }
    const reserve = /^m:reserve:(\d+)$/.exec(input);
    if (reserve) { const id = Number(reserve[1]); const data = await domain.detail(workspace, id); await domain.addReserve(workspace, id, data.offer?.candidateId); return [send(userId, 'Кандидат добавлен в резерв.', [[shiftButton(id)]])]; }
    const cancel = /^m:cancel:(\d+)$/.exec(input);
    if (cancel) {
      const id = Number(cancel[1]); const data = await domain.detail(workspace, id); await domain.cancel(workspace, id);
      const candidate = data.offer?.status === 'pending' || data.offer?.status === 'confirmed' ? await get('SELECT max_user_id FROM candidates WHERE id=?', data.offer.candidateId) : null;
      return [send(userId, 'Смена отменена.', [[button('Меню', 'm:home')]]), ...(candidate?.max_user_id ? [send(candidate.max_user_id, 'Управляющий отменил предложенную вам смену.')] : [])];
    }
    if (current.stage === 'manager_site') {
      if (input === 'm:site:new') { await save(userId, 'manager', 'manager_site_name'); return [send(userId, 'Напишите название новой точки.', [[button('Меню', 'm:home')]])]; }
      const selected = /^m:site:(\d+)$/.exec(input);
      if (!selected) return [send(userId, 'Выберите точку кнопкой.', [[button('Назад', 'm:new')]])];
      const site = await get('SELECT id,name,address FROM sites WHERE id=? AND workspace_id=?', Number(selected[1]), workspace);
      if (!site) return [send(userId, 'Точка не найдена.', [[button('Назад', 'm:new')]])];
      await save(userId, 'manager', 'manager_date', { siteId: site.id, siteName: site.name, siteAddress: site.address });
      return [send(userId, `${site.name} · ${site.address}\nКогда нужна подмена?`, dateButtons())];
    }
    if (current.stage === 'manager_site_name') {
      if (input.length < 2 || input.length > 80) return [send(userId, 'Название точки: от 2 до 80 символов.')];
      await save(userId, 'manager', 'manager_site_address', { siteName: input });
      return [send(userId, 'Напишите адрес. Он будет показан кандидату.', [[button('Меню', 'm:home')]])];
    }
    if (current.stage === 'manager_site_address') {
      if (input.length < 5 || input.length > 150) return [send(userId, 'Адрес: от 5 до 150 символов.')];
      await save(userId, 'manager', 'manager_date', { ...draft, siteAddress: input });
      return [send(userId, 'Когда нужна подмена?', dateButtons())];
    }
    if (current.stage === 'manager_date') {
      if (input === 'm:day:custom') return [send(userId, `Напишите дату и время по Москве, например ${presetDay(1)} 9:00.`, [[button('Назад', 'm:date')]])];
      const dayMatch = /^m:day:([012])$/.exec(input);
      if (dayMatch) { await save(userId, 'manager', 'manager_time', { ...draft, day: presetDay(Number(dayMatch[1])) }); return [send(userId, `Выбрано: ${presetDay(Number(dayMatch[1]))}. Во сколько начать?`, timeButtons())]; }
      const date = fromMoscow(input);
      if (!date || date.getTime() < Date.now() + 3600000) return [send(userId, `Нужно время минимум через час. Например ${presetDay(1)} 9:00 (Москва).`, dateButtons())];
      await save(userId, 'manager', 'manager_hours', { ...draft, startsAt: date.toISOString() });
      return [send(userId, 'Сколько часов длится смена?', [[button('4 часа', 'm:hours:4'), button('6 часов', 'm:hours:6'), button('8 часов', 'm:hours:8')], [button('12 часов', 'm:hours:12')], [button('Назад', 'm:date')]])];
    }
    if (input === 'm:date' && ['manager_time', 'manager_hours'].includes(current.stage)) { await save(userId, 'manager', 'manager_date', draft); return [send(userId, 'Когда нужна подмена?', dateButtons())]; }
    if (current.stage === 'manager_time') {
      if (input === 'm:time:custom') return [send(userId, `Напишите время по Москве, например 9:00. Дата ${draft.day}.`, timeButtons())];
      const time = /^m:time:(\d{2}:\d{2})$/.exec(input)?.[1] || (/^\d{1,2}:\d{2}$/.test(input) ? input : null);
      const date = time ? fromMoscow(`${draft.day} ${time}`) : null;
      if (!date || date.getTime() < Date.now() + 3600000) return [send(userId, 'Выберите время минимум через час или другой день.', timeButtons())];
      await save(userId, 'manager', 'manager_hours', { ...draft, startsAt: date.toISOString() });
      return [send(userId, `${shortDate(date)}. Сколько часов длится смена?`, [[button('4 часа', 'm:hours:4'), button('6 часов', 'm:hours:6'), button('8 часов', 'm:hours:8')], [button('12 часов', 'm:hours:12')], [button('Назад', 'm:date')]])];
    }
    if (current.stage === 'manager_hours') {
      const hours = Number(input.startsWith('m:hours:') ? input.slice(8) : input);
      if (!Number.isInteger(hours) || hours < 1 || hours > 24) return [send(userId, 'Введите число часов от 1 до 24.')];
      await save(userId, 'manager', 'manager_pay', { ...draft, hours });
      return [send(userId, 'Оплата за всю смену?', [[button('4 000 ₽', 'm:pay:4000'), button('5 000 ₽', 'm:pay:5000'), button('6 000 ₽', 'm:pay:6000')], [button('Другая сумма', 'm:pay:custom')]])];
    }
    if (current.stage === 'manager_pay') {
      if (input === 'm:pay:custom') return [send(userId, 'Напишите сумму за смену в рублях, от 1 000 до 100 000.')];
      const payRub = Number((input.startsWith('m:pay:') ? input.slice(6) : input).replace(/\s/g, ''));
      if (!Number.isInteger(payRub) || payRub < 1000 || payRub > 100000) return [send(userId, 'Введите сумму от 1 000 до 100 000 ₽.')];
      await save(userId, 'manager', 'manager_skill', { ...draft, payRub });
      return [send(userId, 'Какое требование к кандидату обязательно? Напишите своими словами, например: «Уверенно готовит эспрессо и умеет закрывать кассу». Этот текст кандидат увидит в предложении до подтверждения.', [[button('Меню', 'm:home')]])];
    }
    if (current.stage === 'manager_skill') {
      if (input.length < 2 || input.length > 120 || input.startsWith('m:')) return [send(userId, 'Напишите требование своими словами, от 2 до 120 символов. Его увидит кандидат.')];
      const next = { ...draft, skill: input };
      await save(userId, 'manager', 'manager_review', next);
      return [send(userId, `Проверьте смену\n\n${next.siteName}, ${next.siteAddress}\n${shortDate(next.startsAt)} · ${next.hours} ч · ${next.payRub.toLocaleString('ru-RU')} ₽\n\nКандидат увидит: «${next.skill}»\n\nСначала ищем в команде, резерве и MAX. Затем покажем тестовые отклики YouDo и Профи.ру.`, [[button('Опубликовать смену', 'm:publish')], [button('Отмена', 'm:home')]])];
    }
    if (current.stage === 'manager_review' && (input === 'm:publish' || input === 'Подтвердить смену')) {
      const start = Date.parse(draft.startsAt);
      let site = draft.siteId ? await get('SELECT id FROM sites WHERE id=? AND workspace_id=?', draft.siteId, workspace) : await get('SELECT id FROM sites WHERE workspace_id=? AND name=? AND address=?', workspace, draft.siteName, draft.siteAddress);
      if (!site) { const saved = await run('INSERT INTO sites(workspace_id,name,address) VALUES (?,?,?)', workspace, draft.siteName, draft.siteAddress); site = { id: saved.lastInsertRowid }; }
      const created = await domain.create(workspace, { siteId: site.id, role: 'Бариста', startsAt: draft.startsAt, endsAt: new Date(start + draft.hours * 3600000).toISOString(), payRub: draft.payRub, skills: [draft.skill], description: 'Создано в чате MAX', decisionDeadline: new Date(start - 60000).toISOString(), sources: ['staff', 'reserve', 'max', 'youdo', 'profi'] });
      await save(userId, 'manager');
      const found = await domain.search(workspace, created.shift.id, { sources: ['staff', 'reserve', 'max'] });
      const immediate = found.responses.filter(x => x.status === 'new');
      return [send(userId, `Смена опубликована. ${immediate.length ? `Сейчас есть ${immediate.length} отклик(а) из команды, резерва и MAX.` : 'В команде, резерве и MAX пока никого нет.'}\n\nYouDo и Профи.ру: тестовые заявки отправлены. Примерно через 10 секунд покажу учебные отклики отдельным сообщением.`, [[shiftButton(created.shift.id)], [button('Отклики', `m:responses:${created.shift.id}`)], [button('Меню', 'm:home')]], { demoShiftId: created.shift.id })];
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
