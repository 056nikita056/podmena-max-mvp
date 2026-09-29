const SOURCES = ['staff', 'reserve', 'youdo', 'profi'];
const SCENARIOS = ['success', 'no_results', 'decline', 'source_error'];
const now = () => new Date().toISOString();
const parse = value => { try { return JSON.parse(value); } catch { return []; } };
export class AppError extends Error { constructor(status, message) { super(message); this.status = status; } }
const bad = message => { throw new AppError(400, message); };
const conflict = message => { throw new AppError(409, message); };

export function createDomain(store) {
  const { get, all, run, transaction, ensureWorkspace } = store;
  function bootstrap(workspace) {
    ensureWorkspace(workspace);
    return { business: get('SELECT * FROM workspaces WHERE id=?', workspace), sites: all('SELECT id,name,address FROM sites WHERE workspace_id=?', workspace), reserve: reserve(workspace) };
  }
  function shift(workspace, id) {
    const row = get('SELECT sh.*, si.name AS site_name, si.address AS site_address FROM shifts sh JOIN sites si ON si.id=sh.site_id WHERE sh.id=? AND sh.workspace_id=?', id, workspace);
    if (!row) throw new AppError(404, 'Заявка не найдена');
    return { ...row, skills: parse(row.skills), sources: parse(row.sources), payRub: row.pay_kopecks / 100 };
  }
  function list(workspace) { return all('SELECT id FROM shifts WHERE workspace_id=? ORDER BY id DESC', workspace).map(x => shift(workspace, x.id)); }
  function detail(workspace, id) {
    const sh = shift(workspace, id);
    const publications = all('SELECT source,status,detail FROM publications WHERE shift_id=? ORDER BY id', id);
    const responses = all('SELECT r.id,r.candidate_id AS candidateId,r.status,r.reasons,c.name,c.source,c.skills,c.rate_kopecks,c.experience_years,c.available FROM responses r JOIN candidates c ON c.id=r.candidate_id WHERE r.shift_id=? ORDER BY r.id', id).map(r => ({ ...r, reasons: parse(r.reasons), skills: parse(r.skills), rateRub: r.rate_kopecks / 100, experienceYears: r.experience_years, available: Boolean(r.available) }));
    const messages = all('SELECT id,candidate_id AS candidateId,sender,text,modelled,created_at AS createdAt FROM messages WHERE shift_id=? ORDER BY id', id).map(m => ({ ...m, modelled: Boolean(m.modelled) }));
    const offer = get('SELECT o.id,o.candidate_id AS candidateId,o.status,o.starts_at AS startsAt,o.ends_at AS endsAt,o.pay_kopecks/100 AS payRub,o.site_name AS siteName,o.created_at AS createdAt,c.name FROM offers o JOIN candidates c ON c.id=o.candidate_id WHERE o.shift_id=? ORDER BY o.id DESC LIMIT 1', id) || null;
    const events = all('SELECT kind,text,created_at AS createdAt FROM events WHERE shift_id=? ORDER BY id DESC', id);
    return { shift: sh, publications, responses, messages, offer, events };
  }
  function event(id, kind, text) { run('INSERT INTO events(shift_id,kind,text,created_at) VALUES (?,?,?,?)', id, kind, text, now()); }
  function create(workspace, body) {
    ensureWorkspace(workspace);
    if (!body || typeof body !== 'object') bad('Заполните заявку');
    const site = get('SELECT id FROM sites WHERE id=? AND workspace_id=?', body.siteId, workspace);
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
    const result = run('INSERT INTO shifts(workspace_id,site_id,role,starts_at,ends_at,pay_kopecks,skills,description,decision_deadline,sources,scenario,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', workspace, site.id, body.role, new Date(start).toISOString(), new Date(end).toISOString(), body.payRub * 100, JSON.stringify(body.skills), body.description.trim(), new Date(deadline).toISOString(), JSON.stringify(body.sources), scenario, 'draft', now());
    event(result.lastInsertRowid, 'created', 'Заявка создана');
    return detail(workspace, result.lastInsertRowid);
  }
  function hasOverlap(workspace, candidateId, sh) {
    return Boolean(get(`SELECT 1 FROM offers o JOIN shifts s ON s.id=o.shift_id WHERE s.workspace_id=? AND o.candidate_id=? AND o.status IN ('pending','confirmed') AND s.id<>? AND o.starts_at<? AND o.ends_at>? LIMIT 1`, workspace, candidateId, sh.id, sh.ends_at, sh.starts_at));
  }
  function search(workspace, id) {
    const sh = shift(workspace, id);
    if (!['draft', 'searching', 'unfilled'].includes(sh.status)) conflict('Поиск сейчас недоступен');
    transaction(() => {
      for (const source of sh.sources) {
        const failed = sh.scenario === 'source_error' && source === 'profi';
        run('INSERT INTO publications(shift_id,source,status,detail) VALUES (?,?,?,?) ON CONFLICT(shift_id,source) DO UPDATE SET status=excluded.status,detail=excluded.detail', id, source, failed ? 'failed' : 'sent', failed ? 'Демо: источник временно недоступен' : 'Демо: обращение создано');
        if (failed || sh.scenario === 'no_results') continue;
        const people = all('SELECT * FROM candidates WHERE workspace_id=? AND source=?', workspace, source);
        for (const person of people) {
          const skills = parse(person.skills);
          if (!person.available || !sh.skills.every(x => skills.includes(x)) || person.rate_kopecks > sh.pay_kopecks || hasOverlap(workspace, person.id, sh)) continue;
          const reasons = [`Навыки: ${sh.skills.join(', ')}`, `Ставка ${person.rate_kopecks / 100} ₽ в бюджете`, 'Доступность указана в демо-профиле'];
          run('INSERT OR IGNORE INTO responses(shift_id,candidate_id,status,reasons) VALUES (?,?,?,?)', id, person.id, 'new', JSON.stringify(reasons));
        }
      }
      const count = get('SELECT COUNT(*) AS n FROM responses WHERE shift_id=?', id).n;
      run('UPDATE shifts SET status=? WHERE id=?', count ? 'searching' : 'unfilled', id);
      event(id, 'search', count ? `Получено откликов: ${count}` : 'Подходящих откликов нет');
    });
    return detail(workspace, id);
  }
  function message(workspace, id, body) {
    const sh = shift(workspace, id);
    if (!['searching', 'awaiting_confirmation', 'confirmed'].includes(sh.status)) conflict('Переписка сейчас недоступна');
    const response = get('SELECT id FROM responses WHERE shift_id=? AND candidate_id=?', id, body?.candidateId);
    if (!response) bad('Выберите кандидата из откликов');
    if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > 1000) bad('Введите сообщение до 1000 символов');
    transaction(() => {
      run('INSERT INTO messages(shift_id,candidate_id,sender,text,modelled,created_at) VALUES (?,?,?,?,?,?)', id, body.candidateId, 'manager', body.text.trim(), 0, now());
      run('INSERT INTO messages(shift_id,candidate_id,sender,text,modelled,created_at) VALUES (?,?,?,?,?,?)', id, body.candidateId, 'candidate', 'Демо-ответ: спасибо, условия получил(а). Готов(а) обсудить выход.', 1, now());
      event(id, 'message', 'Сообщение отправлено; получен модельный ответ');
    });
    return detail(workspace, id);
  }
  function offer(workspace, id, candidateId) {
    const sh = shift(workspace, id);
    if (sh.status !== 'searching') conflict('Для предложения нужен активный поиск');
    const response = get('SELECT r.*,c.available,c.rate_kopecks FROM responses r JOIN candidates c ON c.id=r.candidate_id WHERE r.shift_id=? AND r.candidate_id=?', id, candidateId);
    if (!response) bad('Кандидат не откликнулся');
    if (!response.available || response.rate_kopecks > sh.pay_kopecks || hasOverlap(workspace, candidateId, sh)) conflict('Кандидат недоступен или не подходит по оплате');
    transaction(() => {
      run('INSERT INTO offers(shift_id,candidate_id,status,starts_at,ends_at,pay_kopecks,site_name,created_at) VALUES (?,?,?,?,?,?,?,?)', id, candidateId, 'pending', sh.starts_at, sh.ends_at, sh.pay_kopecks, sh.site_name, now());
      run('UPDATE responses SET status=? WHERE shift_id=? AND candidate_id=?', 'offered', id, candidateId);
      run('UPDATE shifts SET status=? WHERE id=?', 'awaiting_confirmation', id);
      event(id, 'offer', 'Предложение отправлено. Ожидаем отдельного подтверждения кандидата');
    });
    return detail(workspace, id);
  }
  function decision(workspace, id, value) {
    const sh = shift(workspace, id);
    if (sh.status !== 'awaiting_confirmation') conflict('Нет предложения в ожидании');
    if (!['confirm', 'decline'].includes(value)) bad('Неизвестное решение');
    const current = get("SELECT * FROM offers WHERE shift_id=? AND status='pending'", id);
    if (!current) conflict('Нет активного предложения');
    transaction(() => {
      run('UPDATE offers SET status=? WHERE id=?', value === 'confirm' ? 'confirmed' : 'declined', current.id);
      run('UPDATE shifts SET status=? WHERE id=?', value === 'confirm' ? 'confirmed' : 'searching', id);
      run('UPDATE responses SET status=? WHERE shift_id=? AND candidate_id=?', value === 'confirm' ? 'selected' : 'declined', id, current.candidate_id);
      if (value === 'confirm') run("UPDATE publications SET status='closed',detail='Демо: поиск остановлен после подтверждения' WHERE shift_id=? AND status='sent'", id);
      event(id, value, value === 'confirm' ? 'Демо: кандидат отдельно подтвердил выход' : 'Демо: кандидат отказался; поиск можно продолжить');
    });
    return detail(workspace, id);
  }
  function attendance(workspace, id, value) {
    const sh = shift(workspace, id);
    if (sh.status !== 'confirmed') conflict('Сначала нужно подтверждение');
    if (!['arrived', 'no_show'].includes(value)) bad('Неизвестная отметка');
    transaction(() => {
      if (value === 'no_show') run("UPDATE offers SET status='cancelled' WHERE shift_id=? AND status='confirmed'", id);
      run('UPDATE shifts SET status=? WHERE id=?', value === 'arrived' ? 'completed' : 'unfilled', id);
      event(id, value, value === 'arrived' ? 'Демо: управляющий отметил фактический выход' : 'Демо: управляющий отметил невыход');
    });
    return detail(workspace, id);
  }
  function cancel(workspace, id) {
    const sh = shift(workspace, id);
    if (['cancelled', 'completed'].includes(sh.status)) conflict('Заявка уже завершена');
    transaction(() => {
      run("UPDATE offers SET status='cancelled' WHERE shift_id=? AND status IN ('pending','confirmed')", id);
      run("UPDATE publications SET status='closed',detail='Демо: обращение закрыто' WHERE shift_id=? AND status='sent'", id);
      run("UPDATE shifts SET status='cancelled' WHERE id=?", id);
      event(id, 'cancel', 'Заявка отменена');
    });
    return detail(workspace, id);
  }
  function reserve(workspace) { return all('SELECT c.id,c.name,c.skills,c.rate_kopecks/100 AS rateRub,c.source FROM reserve r JOIN candidates c ON c.id=r.candidate_id WHERE r.workspace_id=? ORDER BY c.name', workspace).map(x => ({ ...x, skills: parse(x.skills) })); }
  function addReserve(workspace, id, candidateId) {
    const sh = shift(workspace, id);
    if (!['confirmed', 'completed'].includes(sh.status)) conflict('Добавить в резерв можно после согласования');
    const offer = get("SELECT candidate_id FROM offers WHERE shift_id=? AND status='confirmed'", id);
    if (!offer || offer.candidate_id !== candidateId) bad('Выберите согласованного кандидата');
    run('INSERT OR IGNORE INTO reserve(workspace_id,candidate_id) VALUES (?,?)', workspace, candidateId);
    return reserve(workspace);
  }
  function reset(workspace) {
    transaction(() => {
      for (const row of all('SELECT id FROM shifts WHERE workspace_id=?', workspace)) {
        for (const table of ['events','messages','offers','responses','publications']) run(`DELETE FROM ${table} WHERE shift_id=?`, row.id);
      }
      run('DELETE FROM shifts WHERE workspace_id=?', workspace);
      run('DELETE FROM reserve WHERE workspace_id=?', workspace);
    });
    return bootstrap(workspace);
  }
  return { bootstrap, list, detail, create, search, message, offer, decision, attendance, cancel, reserve, addReserve, reset };
}
