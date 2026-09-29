const token = process.env.MAX_BOT_TOKEN;
if (!token) { console.error('MAX_BOT_TOKEN не задан в окружении'); process.exit(2); }
const headers = { Authorization: token };
const me = await fetch('https://platform-api2.max.ru/me', { headers });
if (!me.ok) { console.error(`MAX /me: HTTP ${me.status}`); process.exit(1); }
const bot = await me.json();
console.log(`MAX бот доступен: ${bot.name || bot.username || bot.user_id || 'имя не указано'}`);
const response = await fetch('https://platform-api2.max.ru/subscriptions', { headers });
if (!response.ok) { console.error(`MAX /subscriptions: HTTP ${response.status}`); process.exit(1); }
const result = await response.json();
console.log(`Активных webhook-подписок: ${result.subscriptions?.length ?? 0}`);
