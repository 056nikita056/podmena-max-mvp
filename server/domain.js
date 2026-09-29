const SOURCES = ['staff', 'reserve', 'youdo', 'profi', 'max'];
const SCENARIOS = ['success', 'no_results', 'decline', 'source_error'];
const now = () => new Date().toISOString();
const parse = value => { try { return JSON.parse(value); } catch { return []; } };
export class AppError extends Error { constructor(status, message) { super(message); this.status = status; } }
const bad = message => { throw new AppError(400, message); };
const conflict = message => { throw new AppError(409, message); };

export function createDomain(store) {
  const { get, all, run, transaction, ensureWorkspace } = store;
  async function bootstrap(workspace) {
    await ensureWorkspace(workspace);
    return { business: await get('SELECT * FROM workspaces WHERE id=?', workspace), sites: await all('SELECT id,name,address FROM sites WHERE workspace_id=?', workspace), reserve: await reserve(workspace) };
  }
  async function shift(workspace, id) {
    const row = await get('SELECT sh.*, si.name AS site_name, si.address AS site_address FROM shifts sh JOIN sites si ON si.id=sh.site_id WHERE sh.id=? AND sh.workspace_id=?', id, workspace);
    if (!row) throw new AppError(404, 'Заявка не найдена');
    return { ...row, skills: parse(row.skills), sources: parse(row.sources), payRub: row.pay_kopecks / 100 };
  }
  async function list(workspace) { return Promise.all((await all('SELECT id FROM shifts WHERE workspace_id=? ORDER BY id DESC', workspace)).map(x => shift(workspace, x.id))); }
  async function detail(workspace, id) {
    const sh = await shift(workspace, id);
    const publications = await all('SELECT source,status,detail FROM publications WHERE shift_id=? ORDER BY id', id);
    const responses = (await all('SELECT r.id,r.candidate_id AS candidateId,r.status,r.reasons,c.name,COALESCE(r.contact_source,c.source) AS source,c.skills,c.rate_kopecks,c.experience_years,c.available FROM responses r JOIN candidates c ON c.id=r.candidate_id WHERE r.shift_id=? ORDER BY r.id', id)).map(r => ({ ...r, reasons: parse(r.reasons), skills: parse(r.skills), rateRub: r.rate_kopecks / 100, experienceYears: r.experience_years, available: Boolean(r.available) }));
    const messages = (await all('SELECT id,candidate_id AS candidateId,sender,text,modelled,created_at AS createdAt FROM messages WHERE shift_id=? ORDER BY id', id)).map(m => ({ ...m, modelled: Boolean(m.modelled) }));
    const offer = await get('SELECT o.id,o.candidate_id AS candidateId,o.status,o.starts_at AS startsAt,o.ends_at AS endsAt,o.pay_kopecks/100 AS payRub,o.site_name AS siteName,o.created_at AS createdAt,c.name FROM offers o JOIN candidates c ON c.id=o.candidate_id WHERE o.shift_id=? ORDER BY o.id DESC LIMIT 1', id) || null;
    const events = await all('SELECT kind,text,created_at AS createdAt FROM events WHERE shift_id=? ORDER BY id DESC', id);
    return { shift: sh, publications, responses, messages, offer, events };
  }
  async function event(id, kind, text) { await run('INSERT INTO events(shift_id,kind,text,created_at) VALUES (?,?,?,?)', id, kind, text, now()); }
  async function create(workspace, body) {
    await ensureWorkspace(workspace);
    if (!body || typeof body !== 'object') bad('Заполните заявку');
    const site = await get('SELECT id FROM sites WHERE id=? AND workspace_id=?', body.siteId, workspace);
    if (!site) bad('Выберите точку');
    if (body.role !== 'Бариста') bad('Сейчас доступна роль «Бариста»');
    const start = Date.parse(body.startsAt), end = Date.parse(body.endsAt), deadline = Date.parse(body.decisionDeadline);
    if (![start, end, deadline].every(Number.isFinite) || end <= start || end - start > 24 * 3600000) bad('Проверьте время смены');
    if (deadline >= start) bad('Срок решения должен быть до начала смены');
    if (!Number.isInteger(body.payRub) || body.payRub < 1000 || body.payRub > 100000) bad('Укажите оплату за смену от 1 000 до 100 000 ₽');
    if (!Array.isArray(body.skills) || !body.skills.length || body.skills.length > 8 || body.skills.some(x => typeof x !== 'string' || x.length > 40)) bad('Укажите обязательные навыки');
    if (!Array.isArray(body.sources) || !body.sources.length || body.sources.some(x => !SOURCES.includes(x)) || new Set(body.sources).size !== body.sources.length) bad('Выберите источники');
    if (typeof body.description !== 'string' || body.description.length > 500) bad('Описание не должно превышать 500 символов');
    const scenario = body.scenario || 'success';
    if (!SCENARIOS.includes(scenario)) bad('Неизвестный демо-сценарий');
    const result = await run('INSERT INTO shifts(workspace_id,site_id,role,starts_at,ends_at,pay_kopecks,skills,description,decision_deadline,sources,scenario,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', workspace, site.id, body.role, new Date(start).toISOString(), new Date(end).toISOString(), body.payRub * 100, JSON.stringify(body.skills), body.description.trim(), new Date(deadline).toISOString(), JSON.stringify(body.sources), scenario, 'draft', now());
    await event(result.lastInsertRowid, 'created', 'Заявка создана');
    return detail(workspace, result.lastInsertRowid);
  }
  async function hasOverlap(workspace, candidateId, sh) {
    const candidate = await get('SELECT max_user_id FROM candidates WHERE id=? AND workspace_id=?', candidateId, workspace);
    if (candidate?.max_user_id) return Boolean(await get(`SELECT 1 FROM offers o JOIN candidates c ON c.id=o.candidate_id WHERE c.max_user_id=? AND o.status IN ('pending','confirmed') AND o.shift_id<>? AND o.starts_at<? AND o.ends_at>? LIMIT 1`, candidate.max_user_id, sh.id, sh.ends_at, sh.starts_at));
    return Boolean(await get(`SELECT 1 FROM offers o JOIN shifts s ON s.id=o.shift_id WHERE s.workspace_id=? AND o.candidate_id=? AND o.status IN ('pending','confirmed') AND s.id<>? AND o.starts_at<? AND o.ends_at>? LIMIT 1`, workspace, candidateId, sh.id, sh.ends_at, sh.starts_at));
  }
  async function syncMaxCandidates(workspace) {
    for (const profile of await all('SELECT * FROM bot_candidate_profiles')) {
      if (workspace === `max:${profile.user_id}`) continue;
      await run(`INSERT INTO candidates(workspace_id,name,source,skills,rate_kopecks,experience_years,available,max_user_id) VALUES (?,?,?,?,?,?,?,?)
        ON CONFLICT(workspace_id,max_user_id) WHERE max_user_id IS NOT NULL DO UPDATE SET name=excluded.name,skills=excluded.skills,rate_kopecks=excluded.rate_kopecks,available=excluded.available`,
        workspace, profile.name, 'max', JSON.stringify([profile.skill]), profile.rate_kopecks, 0, profile.available, profile.user_id);
    }
  }
  async function search(workspace, id) {
    const sh = await shift(workspace, id);
    if (!['draft', 'searching', 'unfilled'].includes(sh.status)) conflict('Поиск сейчас недоступен');
    if (sh.sources.includes('max')) await syncMaxCandidates(workspace);
    await transaction(async () => {
      for (const source of sh.sources) {
        const failed = sh.scenario === 'source_error' && source === 'profi';
        await run('INSERT INTO publications(shift_id,source,status,detail) VALUES (?,?,?,?) ON CONFLICT(shift_id,source) DO UPDATE SET status=excluded.status,detail=excluded.detail', id, source, failed ? 'failed' : 'sent', source === 'max' ? 'Поиск среди зарегистрированных кандидатов MAX' : failed ? 'Демо: источник временно недоступен' : 'Демо: обращение создано');
        if (failed || sh.scenario === 'no_results') continue;
        const people = source === 'reserve'
          ? await all('SELECT c.* FROM candidates c JOIN reserve r ON r.candidate_id=c.id AND r.workspace_id=c.workspace_id WHERE c.workspace_id=?', workspace)
          : await all('SELECT * FROM candidates WHERE workspace_id=? AND source=?', workspace, source);
        for (const person of people) {
          const skills = parse(person.skills);
          if (!person.available || !sh.skills.every(x => skills.includes(x)) || person.rate_kopecks > sh.pay_kopecks || await hasOverlap(workspace, person.id, sh)) continue;
          const reasons = [`Навыки: ${sh.skills.join(', ')}`, `Ставка ${person.rate_kopecks / 100} ₽ в бюджете`, source === 'max' ? 'Доступность указана кандидатом в MAX' : 'Доступность указана в демо-профиле'];
          await run('INSERT OR IGNORE INTO responses(shift_id,candidate_id,status,reasons,contact_source) VALUES (?,?,?,?,?)', id, person.id, 'new', JSON.stringify(reasons), source);
        }
      }
      const count = (await get('SELECT COUNT(*) AS n FROM responses WHERE shift_id=?', id)).n;
      await run('UPDATE shifts SET status=? WHERE id=?', count ? 'searching' : 'unfilled', id);
      await event(id, 'search', count ? `Получено откликов: ${count}` : 'Подходящих откликов нет');
    });
    return detail(workspace, id);
  }
  async function message(workspace, id, body) {
    const sh = await shift(workspace, id);
    if (sh.sources.includes('max')) throw new AppError(403, 'Сообщения кандидату MAX отправляются только через чат бота');
    if (!['searching', 'awaiting_confirmation', 'confirmed'].includes(sh.status)) conflict('Переписка сейчас недоступна');
    const response = await get('SELECT id FROM responses WHERE shift_id=? AND candidate_id=?', id, body?.candidateId);
    if (!response) bad('Выберите кандидата из откликов');
    if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > 1000) bad('Введите сообщение до 1000 символов');
    await transaction(async () => {
      await run('INSERT INTO messages(shift_id,candidate_id,sender,text,modelled,created_at) VALUES (?,?,?,?,?,?)', id, body.candidateId, 'manager', body.text.trim(), 0, now());
      await run('INSERT INTO messages(shift_id,candidate_id,sender,text,modelled,created_at) VALUES (?,?,?,?,?,?)', id, body.candidateId, 'candidate', 'Демо-ответ: спасибо, условия получил(а). Готов(а) обсудить выход.', 1, now());
      await event(id, 'message', 'Сообщение отправлено; получен модельный ответ');
    });
    return detail(workspace, id);
  }
  async function offer(workspace, id, candidateId) {
    const sh = await shift(workspace, id);
    if (sh.status !== 'searching') conflict('Для предложения нужен активный поиск');
    const response = await get('SELECT r.*,c.available,c.rate_kopecks FROM responses r JOIN candidates c ON c.id=r.candidate_id WHERE r.shift_id=? AND r.candidate_id=?', id, candidateId);
    if (!response) bad('Кандидат не откликнулся');
    if (!response.available || response.rate_kopecks > sh.pay_kopecks || await hasOverlap(workspace, candidateId, sh)) conflict('Кандидат недоступен или не подходит по оплате');
    await transaction(async () => {
      await run('INSERT INTO offers(shift_id,candidate_id,status,starts_at,ends_at,pay_kopecks,site_name,created_at) VALUES (?,?,?,?,?,?,?,?)', id, candidateId, 'pending', sh.starts_at, sh.ends_at, sh.pay_kopecks, sh.site_name, now());
      await run('UPDATE responses SET status=? WHERE shift_id=? AND candidate_id=?', 'offered', id, candidateId);
      await run('UPDATE shifts SET status=? WHERE id=?', 'awaiting_confirmation', id);
      await event(id, 'offer', 'Предложение отправлено. Ожидаем отдельного подтверждения кандидата');
    });
    return detail(workspace, id);
  }
  async function decision(workspace, id, value) {
    const sh = await shift(workspace, id);
    if (sh.status !== 'awaiting_confirmation') conflict('Нет предложения в ожидании');
    if (!['confirm', 'decline'].includes(value)) bad('Неизвестное решение');
    const current = await get("SELECT * FROM offers WHERE shift_id=? AND status='pending'", id);
    if (!current) conflict('Нет активного предложения');
    await transaction(async () => {
      await run('UPDATE offers SET status=? WHERE id=?', value === 'confirm' ? 'confirmed' : 'declined', current.id);
      await run('UPDATE shifts SET status=? WHERE id=?', value === 'confirm' ? 'confirmed' : 'searching', id);
      await run('UPDATE responses SET status=? WHERE shift_id=? AND candidate_id=?', value === 'confirm' ? 'selected' : 'declined', id, current.candidate_id);
      if (value === 'confirm') await run("UPDATE publications SET status='closed',detail=? WHERE shift_id=? AND status='sent'", sh.sources.includes('max') ? 'Поиск остановлен после подтверждения' : 'Демо: поиск остановлен после подтверждения', id);
      await event(id, value, sh.sources.includes('max') ? (value === 'confirm' ? 'Кандидат подтвердил выход в своём чате MAX' : 'Кандидат отказался в своём чате MAX') : (value === 'confirm' ? 'Демо: кандидат отдельно подтвердил выход' : 'Демо: кандидат отказался; поиск можно продолжить'));
    });
    return detail(workspace, id);
  }
  async function attendance(workspace, id, value) {
    const sh = await shift(workspace, id);
    if (sh.status !== 'confirmed') conflict('Сначала нужно подтверждение');
    if (!['arrived', 'no_show'].includes(value)) bad('Неизвестная отметка');
    await transaction(async () => {
      if (value === 'no_show') await run("UPDATE offers SET status='cancelled' WHERE shift_id=? AND status='confirmed'", id);
      await run('UPDATE shifts SET status=? WHERE id=?', value === 'arrived' ? 'completed' : 'unfilled', id);
      await event(id, value, sh.sources.includes('max') ? (value === 'arrived' ? 'Управляющий отметил выход' : 'Управляющий отметил невыход') : (value === 'arrived' ? 'Демо: управляющий отметил фактический выход' : 'Демо: управляющий отметил невыход'));
    });
    return detail(workspace, id);
  }
  async function cancel(workspace, id) {
    const sh = await shift(workspace, id);
    if (['cancelled', 'completed'].includes(sh.status)) conflict('Заявка уже завершена');
    await transaction(async () => {
      await run("UPDATE offers SET status='cancelled' WHERE shift_id=? AND status IN ('pending','confirmed')", id);
      await run("UPDATE publications SET status='closed',detail='Демо: обращение закрыто' WHERE shift_id=? AND status='sent'", id);
      await run("UPDATE shifts SET status='cancelled' WHERE id=?", id);
      await event(id, 'cancel', 'Заявка отменена');
    });
    return detail(workspace, id);
  }
  async function reserve(workspace) { return (await all('SELECT c.id,c.name,c.skills,c.rate_kopecks/100 AS rateRub,c.source FROM reserve r JOIN candidates c ON c.id=r.candidate_id WHERE r.workspace_id=? ORDER BY c.name', workspace)).map(x => ({ ...x, skills: parse(x.skills) })); }
  async function addReserve(workspace, id, candidateId) {
    const sh = await shift(workspace, id);
    if (!['confirmed', 'completed'].includes(sh.status)) conflict('Добавить в резерв можно после согласования');
    const offer = await get("SELECT candidate_id FROM offers WHERE shift_id=? AND status='confirmed'", id);
    if (!offer || offer.candidate_id !== candidateId) bad('Выберите согласованного кандидата');
    await run('INSERT OR IGNORE INTO reserve(workspace_id,candidate_id) VALUES (?,?)', workspace, candidateId);
    return reserve(workspace);
  }
  async function reset(workspace) {
    await transaction(async () => {
      for (const row of await all('SELECT id FROM shifts WHERE workspace_id=?', workspace)) {
        for (const table of ['events','messages','offers','responses','publications']) await run(`DELETE FROM ${table} WHERE shift_id=?`, row.id);
      }
      await run('DELETE FROM shifts WHERE workspace_id=?', workspace);
      await run('DELETE FROM reserve WHERE workspace_id=?', workspace);
    });
    return bootstrap(workspace);
  }
  return { bootstrap, list, detail, create, search, message, offer, decision, attendance, cancel, reserve, addReserve, reset };
}
