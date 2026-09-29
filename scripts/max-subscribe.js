import { maxApi } from '../server/max-api.js';
const token = process.env.MAX_BOT_TOKEN;
const secret = process.env.MAX_WEBHOOK_SECRET;
const publicUrl = process.env.APP_PUBLIC_URL;
if (!token || !secret || !publicUrl) { console.error('Нужны MAX_BOT_TOKEN, MAX_WEBHOOK_SECRET и APP_PUBLIC_URL'); process.exit(2); }
if (!/^https:\/\/[a-zA-Z0-9.-]+$/.test(publicUrl) || !/^[A-Za-z0-9_-]{5,256}$/.test(secret)) { console.error('Проверьте HTTPS-адрес без пути и формат webhook secret'); process.exit(2); }
const url = publicUrl + '/api/max/webhook';
const current = await maxApi('/subscriptions', { token });
if (!current.ok) { console.error(`Не удалось проверить подписки: HTTP ${current.status}`); process.exit(1); }
const subscriptions = current.data.subscriptions || [];
if (subscriptions.some(s => s.url === url)) { console.log('Webhook уже подписан на этот адрес'); process.exit(0); }
if (subscriptions.length) { console.error('У бота есть другая активная подписка. Проверьте её вручную перед изменением.'); process.exit(1); }
const response = await maxApi('/subscriptions', { token, method: 'POST', body: { url, update_types: ['bot_started', 'message_created'], secret } });
const result = response.data;
if (!response.ok || result.success === false) { console.error(`Не удалось создать подписку: HTTP ${response.status}`); process.exit(1); }
console.log('Webhook подписан на подготовленный HTTPS-адрес');
