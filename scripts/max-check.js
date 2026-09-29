import { maxApi } from '../server/max-api.js';
const token = process.env.MAX_BOT_TOKEN;
if (!token) { console.error('MAX_BOT_TOKEN не задан в окружении'); process.exit(2); }
const me = await maxApi('/me', { token });
if (!me.ok) { console.error(`MAX /me: HTTP ${me.status}`); process.exit(1); }
const bot = me.data;
console.log(`MAX бот доступен: ${bot.name || bot.username || bot.user_id || 'имя не указано'}`);
const response = await maxApi('/subscriptions', { token });
if (!response.ok) { console.error(`MAX /subscriptions: HTTP ${response.status}`); process.exit(1); }
const result = response.data;
console.log(`Активных webhook-подписок: ${result.subscriptions?.length ?? 0}`);
