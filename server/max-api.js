import { request } from 'node:https';
import { readFileSync } from 'node:fs';

const rootCA = readFileSync(new URL('../certs/russian-trusted-root-ca.pem', import.meta.url));
const baseURL = 'https://platform-api2.max.ru';

export function maxApi(path, { token, method = 'GET', body } = {}) {
  if (!token) throw new Error('MAX_BOT_TOKEN не задан');
  if (!path.startsWith('/') || path.startsWith('//')) throw new Error('Некорректный путь MAX API');
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = request(new URL(path, baseURL), {
      method,
      ca: rootCA,
      headers: {
        Authorization: token,
        ...(payload === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) })
      }
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => {
        let data;
        try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { data = {}; }
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, data });
      });
    });
    req.setTimeout(15000, () => req.destroy(new Error('MAX API: превышено время ожидания')));
    req.on('error', reject);
    req.end(payload);
  });
}
