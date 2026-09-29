import { AppError } from './domain.js';

const skills = ['Эспрессо', 'Касса', 'Латте-арт'];
const send = (userId, text, buttons = []) => ({ userId, text, buttons });
const menu = [['Я управляющий', 'Я кандидат'], ['Помощь']];
const managerMenu = [['Создать смену', 'Мои смены'], ['Я кандидат', 'Помощь']];
const candidateMenu = [['Мой профиль', 'Предложения'], ['Приостановить поиск', 'Возобновить поиск'], ['Я управляющий']];
const dateText = value => new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
const statusText = { draft: 'Черновик', searching: 'Ищем кандидата', unfilled: 'Кандидатов пока нет', awaiting_confirmation: 'Ожидаем ответ кандидата', confirmed: 'Выход подтверждён', completed: 'Выход состоялся', cancelled: 'Отменена' };
const fromMoscow = text => {
  const match = /^(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2})$/.exec(text);
  if (!match) return null;
  const [, day, month, year, hour, minute] = match.map(Number);
  const utc = Date.UTC(year, month - 1, day, hour - 3, minute);
  const date = new Date(utc);
  if (dateText(date) !== `${String(day).padStart(2, '0')}.${String(month).padStart(2, '0')}.${year}, ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`) return null;
  return date;
};
const parseDraft = value => { try { return JSON.parse(value); } catch { return {}; } };

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
    const person = data.offer ? `\nКандидат: ${data.offer.name}` : '';
    return { data, text: `Смена #${sh.id} · ${statusText[sh.status] || sh.status}\n${sh.site_name}, ${sh.site_address}\n${dateText(sh.starts_at)} · ${Math.round((Date.parse(sh.ends_at) - Date.parse(sh.starts_at)) / 3600000)} ч\n${sh.payRub.toLocaleString('ru-RU')} ₽ · ${sh.skills.join(', ')}${person}` };
  }
  async function candidateOffers(userId) {
    return all(`SELECT o.shift_id AS shiftId,o.status,s.workspace_id AS workspace FROM offers o JOIN candidates c ON c.id=o.candidate_id JOIN shifts s ON s.id=o.shift_id WHERE c.max_user_id=? AND o.status='pending' ORDER BY o.id DESC`, userId);
  }
  async function handle(update) {
    if (!['bot_started', 'message_created'].includes(update?.update_type)) return [];
    if (update.update_type === 'message_created' && update.message?.recipient?.chat_type && update.message.recipient.chat_type !== 'dialog') return [];
    if (update.message?.sender?.is_bot) return [];
    const actor = update.update_type === 'bot_started' ? update.user : update.message?.sender;
    const userId = Number(actor?.user_id);
    if (!Number.isSafeInteger(userId) || userId <= 0) return [];
    const raw = update.update_type === 'bot_started' ? '/start' : update.message?.body?.text;
    if (typeof raw !== 'string' || !raw.trim()) return [];
    const input = raw.trim();
    const current = await state(userId);
    const workspace = `max:${userId}`;
    try {
      if (input === '/start' || input === '/help' || input === 'Помощь') {
        return [send(userId, 'Подмена работает прямо в чате MAX. Управляющий создаёт смену и предлагает её кандидату. Кандидат подтверждает выход только в своём чате. Выберите роль:', menu)];
      }
      if (input === '/manager' || input === 'Я управляющий') {
        await domain.bootstrap(workspace);
        await save(userId, 'manager');
        return [send(userId, 'Режим управляющего. Создайте смену или откройте список заявок.', managerMenu)];
      }
      if (input === '/candidate' || input === 'Я кандидат') {
        const profile = await get('SELECT * FROM bot_candidate_profiles WHERE user_id=?', userId);
        await save(userId, 'candidate', profile ? '' : 'candidate_skill');
        return profile
          ? [send(userId, `Ваш профиль: ${profile.name}, ${profile.skill}, от ${profile.rate_kopecks / 100} ₽. Поиск ${profile.available ? 'включён' : 'приостановлен'}.`, candidateMenu)]
          : [send(userId, 'Регистрация кандидата. Ваше имя из MAX, навык и минимальная ставка будут видны управляющим при поиске. Выберите основной навык:', [skills])];
      }
      if (input === '/cancel' || input === 'Отмена') {
        await save(userId, current.mode);
        return [send(userId, 'Действие отменено.', current.mode === 'manager' ? managerMenu : current.mode === 'candidate' ? candidateMenu : menu)];
      }
      if (current.mode === 'candidate') return candidate(userId, actor, input, current);
      if (current.mode === 'manager') return manager(userId, workspace, input, current);
      return [send(userId, 'Выберите роль, чтобы начать.', menu)];
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      return [send(userId, error.message, current.mode === 'manager' ? managerMenu : candidateMenu)];
    }
  }
  async function candidate(userId, actor, input, current) {
    const draft = parseDraft(current.draft_json);
    if (current.stage === 'candidate_skill') {
      if (!skills.includes(input)) return [send(userId, 'Выберите навык кнопкой.', [skills])];
      await save(userId, 'candidate', 'candidate_rate', { skill: input });
      return [send(userId, 'Укажите минимальную оплату за смену в рублях (от 1 000 до 100 000).', [['Отмена']])];
    }
    if (current.stage === 'candidate_rate') {
      const rate = Number(input.replace(/\s/g, ''));
      if (!Number.isInteger(rate) || rate < 1000 || rate > 100000) return [send(userId, 'Введите сумму от 1 000 до 100 000 ₽.')];
      const name = [actor?.first_name, actor?.last_name].filter(Boolean).join(' ').trim().slice(0, 80) || `Кандидат MAX #${userId}`;
      await run(`INSERT INTO bot_candidate_profiles(user_id,name,skill,rate_kopecks,available,updated_at) VALUES (?,?,?,?,?,?)
        ON CONFLICT(user_id) DO UPDATE SET name=excluded.name,skill=excluded.skill,rate_kopecks=excluded.rate_kopecks,available=excluded.available,updated_at=excluded.updated_at`, userId, name, draft.skill, rate * 100, 1, new Date().toISOString());
      await save(userId, 'candidate');
      return [send(userId, `Профиль сохранён: ${name} · ${draft.skill} · от ${rate} ₽. Предложения придут в этот чат.`, candidateMenu)];
    }
    const profile = await get('SELECT * FROM bot_candidate_profiles WHERE user_id=?', userId);
    if (!profile) { await save(userId, 'candidate', 'candidate_skill'); return [send(userId, 'Сначала выберите навык.', [skills])]; }
    if (input === 'Мой профиль') return [send(userId, `${profile.name}\n${profile.skill} · от ${profile.rate_kopecks / 100} ₽\nПоиск ${profile.available ? 'включён' : 'приостановлен'}.`, candidateMenu)];
    if (input === 'Приостановить поиск' || input === 'Возобновить поиск') {
      const available = input === 'Возобновить поиск' ? 1 : 0;
      await run('UPDATE bot_candidate_profiles SET available=?,updated_at=? WHERE user_id=?', available, new Date().toISOString(), userId);
      await run('UPDATE candidates SET available=? WHERE max_user_id=?', available, userId);
      return [send(userId, available ? 'Поиск снова включён.' : 'Новые предложения приостановлены. Уже полученные предложения остаются доступны.', candidateMenu)];
    }
    if (input === 'Предложения') {
      const offers = await candidateOffers(userId);
      if (!offers.length) return [send(userId, 'Ожидающих предложений нет.', candidateMenu)];
      const parts = [];
      for (const offer of offers.slice(0, 8)) parts.push((await card(offer.workspace, offer.shiftId)).text);
      return [send(userId, parts.join('\n\n'), offers.slice(0, 8).map(x => [`Принять #${x.shiftId}`, `Отказаться #${x.shiftId}`]))];
    }
    const decision = /^(Принять|Отказаться) #(\d+)$/.exec(input);
    if (decision) {
      const id = Number(decision[2]);
      const offer = await get(`SELECT s.workspace_id AS workspace FROM offers o JOIN shifts s ON s.id=o.shift_id JOIN candidates c ON c.id=o.candidate_id WHERE o.shift_id=? AND o.status='pending' AND c.max_user_id=?`, id, userId);
      if (!offer) return [send(userId, 'Это предложение вам недоступно или уже закрыто.', candidateMenu)];
      const value = decision[1] === 'Принять' ? 'confirm' : 'decline';
      const result = await domain.decision(offer.workspace, id, value);
      const managerId = Number(offer.workspace.slice(4));
      const answer = value === 'confirm' ? 'Кандидат подтвердил выход' : 'Кандидат отказался';
      return [send(userId, value === 'confirm' ? 'Вы подтвердили смену. Управляющий получил уведомление.' : 'Вы отказались от смены. Управляющий получил уведомление.', candidateMenu), send(managerId, `${answer} по смене #${id}: ${result.offer.name}.`, [[`Смена #${id}`]])];
    }
    return [send(userId, 'Выберите действие.', candidateMenu)];
  }
  async function manager(userId, workspace, input, current) {
    const draft = parseDraft(current.draft_json);
    if (input === 'Создать смену') {
      await domain.bootstrap(workspace);
      await save(userId, 'manager', 'manager_site_name');
      return [send(userId, 'Название вашей точки или места смены (2–80 символов):', [['Отмена']])];
    }
    if (current.stage === 'manager_site_name') {
      if (input.length < 2 || input.length > 80) return [send(userId, 'Введите название от 2 до 80 символов.')];
      await save(userId, 'manager', 'manager_site_address', { siteName: input });
      return [send(userId, 'Укажите точный адрес точки (5–150 символов). Его увидит кандидат.', [['Отмена']])];
    }
    if (current.stage === 'manager_site_address') {
      if (input.length < 5 || input.length > 150) return [send(userId, 'Введите адрес от 5 до 150 символов.')];
      await save(userId, 'manager', 'manager_start', { ...draft, siteAddress: input });
      return [send(userId, 'Когда начинается смена? Формат: ДД.ММ.ГГГГ ЧЧ:ММ, московское время. Например, 03.10.2026 09:00.', [['Отмена']])];
    }
    if (current.stage === 'manager_start') {
      const date = fromMoscow(input);
      if (!date || date.getTime() < Date.now() + 3600000) return [send(userId, 'Введите будущую дату минимум через час, например 03.10.2026 09:00 (Москва).')];
      await save(userId, 'manager', 'manager_hours', { ...draft, startsAt: date.toISOString() });
      return [send(userId, 'Сколько часов длится смена? От 1 до 24.', [['4', '6', '8', '12'], ['Отмена']])];
    }
    if (current.stage === 'manager_hours') {
      const hours = Number(input);
      if (!Number.isInteger(hours) || hours < 1 || hours > 24) return [send(userId, 'Введите целое число часов от 1 до 24.')];
      await save(userId, 'manager', 'manager_pay', { ...draft, hours });
      return [send(userId, 'Сколько заплатите за смену? Сумма в рублях от 1 000 до 100 000.', [['4000', '5000', '6000'], ['Отмена']])];
    }
    if (current.stage === 'manager_pay') {
      const payRub = Number(input.replace(/\s/g, ''));
      if (!Number.isInteger(payRub) || payRub < 1000 || payRub > 100000) return [send(userId, 'Введите сумму от 1 000 до 100 000 ₽.')];
      await save(userId, 'manager', 'manager_skill', { ...draft, payRub });
      return [send(userId, 'Какой навык обязателен?', [skills, ['Отмена']])];
    }
    if (current.stage === 'manager_skill') {
      if (!skills.includes(input)) return [send(userId, 'Выберите навык кнопкой.', [skills])];
      const next = { ...draft, skill: input };
      await save(userId, 'manager', 'manager_review', next);
      return [send(userId, `Проверьте смену:\n${next.siteName}, ${next.siteAddress}\n${dateText(next.startsAt)} · ${next.hours} ч\n${next.payRub} ₽ · ${next.skill}\nПоиск среди зарегистрированных кандидатов MAX.`, [['Подтвердить смену', 'Отмена']])];
    }
    if (current.stage === 'manager_review' && input === 'Подтвердить смену') {
      const start = Date.parse(draft.startsAt);
      let site = await get('SELECT id FROM sites WHERE workspace_id=? AND name=? AND address=?', workspace, draft.siteName, draft.siteAddress);
      if (!site) { const saved = await run('INSERT INTO sites(workspace_id,name,address) VALUES (?,?,?)', workspace, draft.siteName, draft.siteAddress); site = { id: saved.lastInsertRowid }; }
      const created = await domain.create(workspace, { siteId: site.id, role: 'Бариста', startsAt: draft.startsAt, endsAt: new Date(start + draft.hours * 3600000).toISOString(), payRub: draft.payRub, skills: [draft.skill], description: 'Создано в чате MAX', decisionDeadline: new Date(start - 60000).toISOString(), sources: ['max'] });
      await save(userId, 'manager');
      const found = await domain.search(workspace, created.shift.id);
      const rows = found.responses.map(x => `${x.name} · ${x.rateRub} ₽ · кандидат #${x.candidateId}`);
      return [send(userId, `${(await card(workspace, created.shift.id)).text}\n\n${rows.length ? `Подходят:\n${rows.join('\n')}` : 'Пока нет зарегистрированных подходящих кандидатов. Повторите поиск позже.'}`, rows.length ? rows.map(x => { const id = /#(\d+)$/.exec(x)[1]; return [`Предложить #${created.shift.id} #${id}`]; }).concat([[`Смена #${created.shift.id}`]]) : [[`Искать #${created.shift.id}`, `Смена #${created.shift.id}`]])];
    }
    if (input === 'Мои смены') {
      const rows = (await domain.list(workspace)).slice(0, 10);
      return [send(userId, rows.length ? rows.map(x => `#${x.id} · ${statusText[x.status] || x.status} · ${dateText(x.starts_at)}`).join('\n') : 'Смен пока нет.', rows.length ? rows.map(x => [`Смена #${x.id}`]).concat([['Создать смену']]) : managerMenu)];
    }
    const selected = /^Смена #(\d+)$/.exec(input);
    if (selected) {
      const id = Number(selected[1]);
      const { data, text } = await card(workspace, id);
      const buttons = [];
      if (['searching', 'unfilled'].includes(data.shift.status)) buttons.push([`Искать #${id}`]);
      if (data.shift.status === 'confirmed') buttons.push([`Выход #${id}`, `Невыход #${id}`], [`В резерв #${id}`]);
      if (!['completed', 'cancelled'].includes(data.shift.status)) buttons.push([`Отменить #${id}`]);
      if (data.shift.status === 'searching') for (const x of data.responses.filter(x => x.source === 'max' && x.status === 'new').slice(0, 8)) buttons.push([`Предложить #${id} #${x.candidateId}`]);
      return [send(userId, text, buttons.length ? buttons : managerMenu)];
    }
    const search = /^Искать #(\d+)$/.exec(input);
    if (search) {
      const id = Number(search[1]);
      const found = await domain.search(workspace, id);
      const rows = found.responses.filter(x => x.source === 'max' && x.status === 'new');
      return [send(userId, rows.length ? `Смена #${id}. Подходят:\n${rows.map(x => `${x.name} · ${x.rateRub} ₽ · кандидат #${x.candidateId}`).join('\n')}` : 'Подходящих зарегистрированных кандидатов пока нет.', rows.length ? rows.slice(0, 8).map(x => [`Предложить #${id} #${x.candidateId}`]) : [[`Смена #${id}`]])];
    }
    const offer = /^Предложить #(\d+) #(\d+)$/.exec(input);
    if (offer) {
      const id = Number(offer[1]), candidateId = Number(offer[2]);
      const candidate = await get('SELECT max_user_id FROM candidates WHERE id=? AND workspace_id=? AND source=?', candidateId, workspace, 'max');
      if (!candidate?.max_user_id) return [send(userId, 'Предложение доступно только зарегистрированному кандидату MAX.', managerMenu)];
      const profile = await get('SELECT available FROM bot_candidate_profiles WHERE user_id=?', candidate.max_user_id);
      if (!profile?.available) return [send(userId, 'Кандидат приостановил поиск.', managerMenu)];
      const result = await domain.offer(workspace, id, candidateId);
      const sh = result.shift;
      return [send(userId, `Предложение по смене #${id} отправлено кандидату ${result.offer.name}. Ожидаем его ответ в отдельном чате.`, [[`Смена #${id}`]]), send(candidate.max_user_id, `Вам предложили смену #${id}:\n${sh.site_name}, ${sh.site_address}\n${dateText(sh.starts_at)} · ${Math.round((Date.parse(sh.ends_at) - Date.parse(sh.starts_at)) / 3600000)} ч\nОплата: ${sh.payRub} ₽ · навык: ${sh.skills.join(', ')}`, [[`Принять #${id}`, `Отказаться #${id}`]])];
    }
    const attendance = /^(Выход|Невыход) #(\d+)$/.exec(input);
    if (attendance) {
      const id = Number(attendance[2]);
      await domain.attendance(workspace, id, attendance[1] === 'Выход' ? 'arrived' : 'no_show');
      return [send(userId, attendance[1] === 'Выход' ? `Выход по смене #${id} отмечен.` : `Невыход по смене #${id} отмечен.`, managerMenu)];
    }
    const reserve = /^В резерв #(\d+)$/.exec(input);
    if (reserve) {
      const id = Number(reserve[1]);
      const details = await domain.detail(workspace, id);
      await domain.addReserve(workspace, id, details.offer?.candidateId);
      return [send(userId, `Кандидат добавлен в резерв по смене #${id}.`, managerMenu)];
    }
    const cancel = /^Отменить #(\d+)$/.exec(input);
    if (cancel) {
      const id = Number(cancel[1]);
      const details = await domain.detail(workspace, id);
      await domain.cancel(workspace, id);
      const candidate = details.offer?.status === 'pending' || details.offer?.status === 'confirmed' ? await get('SELECT max_user_id FROM candidates WHERE id=?', details.offer.candidateId) : null;
      return [send(userId, `Смена #${id} отменена.`, managerMenu), ...(candidate?.max_user_id ? [send(candidate.max_user_id, `Смена #${id} отменена управляющим.`)] : [])];
    }
    return [send(userId, 'Выберите действие.', managerMenu)];
  }
  return { handle };
}
