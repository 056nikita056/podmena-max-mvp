import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { openStore } from './store.js';
import { createDomain, AppError } from './domain.js';
import { createSession, readSession, verifyMaxInitData, verifyWebhookSecret } from './auth.js';
import { maxApi } from './max-api.js';

const root = resolve('dist');
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };
function json(res, code, value, headers = {}) { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers }); res.end(JSON.stringify(value)); }
async function body(req) {
  // Vercel may parse the body before handing the Node request to the function.
  try {
    if (req.body !== undefined && req.body !== null) {
      const parsed = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      if (JSON.stringify(parsed).length > 65536) throw new AppError(413, 'Запрос слишком большой');
      return parsed;
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(400, 'Некорректный JSON');
  }
  let text = '';
  for await (const chunk of req) { text += chunk; if (text.length > 65536) throw new AppError(413, 'Запрос слишком большой'); }
  if (!text) return {};
  try { return JSON.parse(text); } catch { throw new AppError(400, 'Некорректный JSON'); }
}
function idFrom(path, suffix = '') { const match = new RegExp(`^/api/shifts/(\\d+)${suffix}$`).exec(path); return match ? Number(match[1]) : null; }

export function createServer(config = {}) {
  if (process.env.VERCEL && !process.env.SESSION_SECRET && !config.sessionSecret) throw new Error('Для Vercel требуется SESSION_SECRET');
  const ready = openStore(config.databasePath || process.env.DATABASE_PATH || './data/podmena.sqlite').then(store => ({ store, domain: createDomain(store) }));
  const botToken = config.botToken || process.env.MAX_BOT_TOKEN;
  const publicUrl = config.publicUrl || process.env.APP_PUBLIC_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : '');
  const sessionSecret = config.sessionSecret || process.env.SESSION_SECRET || randomBytes(32).toString('hex');
  const demoMode = config.demoMode ?? process.env.DEMO_MODE !== '0';
  async function sendBot(userId, text) {
    if (!botToken || !userId) return;
    try {
      const result = await maxApi(`/messages?user_id=${encodeURIComponent(userId)}`, { token: botToken, method: 'POST', body: { text } });
      if (!result.ok) console.error(`MAX notification failed: HTTP ${result.status}`);
    } catch (error) { console.error('MAX notification failed:', error.message); }
  }
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const path = url.pathname;
      const method = req.method;
      const { store, domain } = await ready;
      if (method !== 'GET' && req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) throw new AppError(403, 'Недоверенный источник запроса');
      if (path === '/api/health' && method === 'GET') return json(res, 200, { ok: true, database: 'ready' });
      if (path === '/api/auth/demo' && method === 'POST') {
        if (!demoMode || (!config.browserDemo && process.env.ENABLE_BROWSER_DEMO !== '1')) throw new AppError(403, 'Вход для браузерной демонстрации выключен');
        const input = await body(req);
        if (!['manager', 'reviewer'].includes(input.persona)) throw new AppError(400, 'Неизвестный демо-профиль');
        const workspace = `demo:${input.persona}`;
        await domain.bootstrap(workspace);
        const token = await createSession(store, workspace, sessionSecret);
        return json(res, 200, { ok: true }, { 'set-cookie': `podmena_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800${publicUrl.startsWith('https://') ? '; Secure' : ''}` });
      }
      if (path === '/api/auth/max' && method === 'POST') {
        const input = await body(req);
        const workspace = verifyMaxInitData(input.initData, botToken);
        await domain.bootstrap(workspace);
        const token = await createSession(store, workspace, sessionSecret);
        return json(res, 200, { ok: true }, { 'set-cookie': `podmena_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800; Secure` });
      }
      if (path === '/api/max/webhook' && method === 'POST') {
        if (!verifyWebhookSecret(req.headers['x-max-bot-api-secret'], config.webhookSecret || process.env.MAX_WEBHOOK_SECRET)) throw new AppError(401, 'Webhook secret не совпал');
        const update = await body(req);
        const userId = update.user?.user_id || update.message?.sender?.user_id;
        const key = `${update.update_type}:${update.timestamp}:${update.chat_id || update.message?.recipient?.chat_id || ''}`;
        if (!await store.get('SELECT 1 FROM bot_updates WHERE update_key=?', key)) {
          await store.run('INSERT INTO bot_updates(update_key,created_at) VALUES (?,?)', key, new Date().toISOString());
          if (userId && (update.update_type === 'bot_started' || (update.update_type === 'message_created' && /^\/start\b/.test(update.message?.body?.text || '')))) {
            const workspace = `max:${userId}`;
            await domain.bootstrap(workspace);
            if (update.chat_id) await store.run('INSERT INTO bot_chats(workspace_id,chat_id) VALUES (?,?) ON CONFLICT(workspace_id) DO UPDATE SET chat_id=excluded.chat_id', workspace, String(update.chat_id));
            await sendBot(userId, `Подмена: откройте мини-приложение кнопкой в чате бота. Там можно создать смену и согласовать выход.${publicUrl ? ` Адрес: ${publicUrl}` : ''}`);
          }
        }
        return json(res, 200, { ok: true });
      }
      if (path.startsWith('/api/')) {
        const workspace = await readSession(store, req.headers.cookie, sessionSecret);
        if (path === '/api/bootstrap' && method === 'GET') return json(res, 200, await domain.bootstrap(workspace));
        if (path === '/api/shifts' && method === 'GET') return json(res, 200, { shifts: await domain.list(workspace) });
        if (path === '/api/shifts' && method === 'POST') return json(res, 201, await domain.create(workspace, await body(req)));
        let id;
        if ((id = idFrom(path)) && method === 'GET') return json(res, 200, await domain.detail(workspace, id));
        if ((id = idFrom(path, '/search')) && method === 'POST') return json(res, 200, await domain.search(workspace, id));
        if ((id = idFrom(path, '/messages')) && method === 'POST') return json(res, 201, await domain.message(workspace, id, await body(req)));
        if ((id = idFrom(path, '/offer')) && method === 'POST') return json(res, 200, await domain.offer(workspace, id, (await body(req)).candidateId));
        if ((id = idFrom(path, '/demo-decision')) && method === 'POST') {
          if (!demoMode) throw new AppError(403, 'Демо-события выключены');
          const result = await domain.decision(workspace, id, (await body(req)).decision);
          if (result.shift.status === 'confirmed' && workspace.startsWith('max:')) await sendBot(workspace.slice(4), `Подмена: демо-кандидат ${result.offer.name} подтвердил смену. ${result.offer.siteName}, ${result.offer.payRub} ₽. Это модельное подтверждение.`);
          return json(res, 200, result);
        }
        if ((id = idFrom(path, '/attendance')) && method === 'POST') return json(res, 200, await domain.attendance(workspace, id, (await body(req)).value));
        if ((id = idFrom(path, '/cancel')) && method === 'POST') return json(res, 200, await domain.cancel(workspace, id));
        if ((id = idFrom(path, '/reserve')) && method === 'POST') return json(res, 200, { reserve: await domain.addReserve(workspace, id, (await body(req)).candidateId) });
        if (path === '/api/reserve' && method === 'GET') return json(res, 200, { reserve: await domain.reserve(workspace) });
        if (path === '/api/demo/reset' && method === 'POST') { if (!demoMode) throw new AppError(403, 'Демо-события выключены'); return json(res, 200, await domain.reset(workspace)); }
        throw new AppError(404, 'Метод не найден');
      }
      if (method !== 'GET') throw new AppError(405, 'Метод не поддерживается');
      const file = path === '/' ? '/index.html' : path;
      if (!(/^\/assets\/[a-zA-Z0-9_.-]+$/.test(file) || file === '/index.html')) throw new AppError(404, 'Файл не найден');
      const target = join(root, file);
      if (!existsSync(target)) throw new AppError(404, 'Файл не найден');
      const data = readFileSync(target);
      res.writeHead(200, { 'content-type': mime[extname(file)], 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' });
      res.end(data);
    } catch (error) {
      const code = error.status || 500;
      if (code === 500) console.error(error);
      json(res, code, { error: code === 500 ? 'Ошибка сервера' : error.message });
    }
  });
  server.on('close', () => { void ready.then(({ store }) => store.db.close()); });
  return server;
}
