import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { AppError } from './domain.js';

const hash = (value, secret) => createHmac('sha256', secret).update(value).digest('hex');
const safeEqual = (a, b) => {
  const left = Buffer.from(String(a)), right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
};

export function verifyMaxInitData(initData, botToken, current = Date.now()) {
  if (!botToken || typeof initData !== 'string' || initData.length > 8192) throw new AppError(401, 'Данные MAX недоступны');
  const pairs = initData.split('&').map(item => {
    const at = item.indexOf('=');
    if (at < 1) throw new AppError(401, 'Некорректные данные MAX');
    return [decodeURIComponent(item.slice(0, at)), decodeURIComponent(item.slice(at + 1).replaceAll('+', ' '))];
  });
  const keys = pairs.map(x => x[0]);
  if (new Set(keys).size !== keys.length || keys.filter(x => x === 'hash').length !== 1) throw new AppError(401, 'Некорректные данные MAX');
  const original = pairs.find(x => x[0] === 'hash')[1];
  const check = pairs.filter(x => x[0] !== 'hash').sort((a, b) => a[0].localeCompare(b[0], 'en')).map(x => `${x[0]}=${x[1]}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expected = createHmac('sha256', secret).update(check).digest('hex');
  if (!safeEqual(original, expected)) throw new AppError(401, 'Подпись MAX не совпала');
  const fields = Object.fromEntries(pairs);
  const date = Number(fields.auth_date);
  if (!Number.isSafeInteger(date) || date * 1000 > current + 60000 || current - date * 1000 > 3600000) throw new AppError(401, 'Данные MAX устарели');
  let user;
  try { user = JSON.parse(fields.user); } catch { throw new AppError(401, 'Некорректный пользователь MAX'); }
  if (!user || !Number.isSafeInteger(user.id) || user.id <= 0) throw new AppError(401, 'Некорректный пользователь MAX');
  return `max:${user.id}`;
}

export function createSession(store, workspace, secret) {
  const token = randomBytes(32).toString('base64url');
  store.run('INSERT INTO sessions(token_hash,workspace_id,expires_at) VALUES (?,?,?)', hash(token, secret), workspace, Date.now() + 8 * 3600000);
  return token;
}

export function readSession(store, cookie, secret) {
  const token = /(?:^|;\s*)podmena_session=([^;]+)/.exec(cookie || '')?.[1];
  if (!token) throw new AppError(401, 'Откройте приложение через MAX');
  const row = store.get('SELECT workspace_id,expires_at FROM sessions WHERE token_hash=?', hash(token, secret));
  if (!row || row.expires_at < Date.now()) throw new AppError(401, 'Сессия истекла');
  return row.workspace_id;
}

export function verifyWebhookSecret(value, expected) {
  return Boolean(expected && safeEqual(value || '', expected));
}
