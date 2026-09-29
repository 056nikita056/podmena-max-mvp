import { createClient } from '@libsql/client';
import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const people = [
  ['Анна Л.', 'staff', ['Эспрессо', 'Касса', 'Латте-арт'], 5200, 3, 1],
  ['Илья К.', 'staff', ['Эспрессо', 'Касса'], 5000, 2, 0],
  ['Мария Д.', 'reserve', ['Эспрессо', 'Латте-арт'], 5600, 4, 1],
  ['Артём П.', 'reserve', ['Касса'], 4700, 1, 1],
  ['София Р.', 'youdo', ['Эспрессо', 'Касса', 'Латте-арт'], 5900, 5, 1],
  ['Денис В.', 'youdo', ['Эспрессо'], 6500, 2, 1],
  ['Ольга Н.', 'youdo', ['Эспрессо', 'Касса'], 5800, 3, 0],
  ['Егор С.', 'profi', ['Эспрессо', 'Касса'], 5700, 4, 1],
  ['Лиза Т.', 'profi', ['Латте-арт'], 5400, 2, 1],
  ['Никита М.', 'profi', ['Эспрессо', 'Касса'], 6200, 5, 1]
];

export async function openStore(path) {
  const remoteURL = process.env.TURSO_DATABASE_URL;
  if (process.env.VERCEL && !remoteURL) throw new Error('Для Vercel требуется TURSO_DATABASE_URL');
  if (!remoteURL) mkdirSync(dirname(path), { recursive: true });
  if (remoteURL && !process.env.TURSO_AUTH_TOKEN) throw new Error('TURSO_AUTH_TOKEN не задан');
  const db = createClient({ url: remoteURL || `file:${resolve(path)}`, authToken: process.env.TURSO_AUTH_TOKEN });
  const schema = `
    CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, timezone TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sites (id INTEGER PRIMARY KEY, workspace_id TEXT NOT NULL, name TEXT NOT NULL, address TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS candidates (id INTEGER PRIMARY KEY, workspace_id TEXT NOT NULL, name TEXT NOT NULL, source TEXT NOT NULL, skills TEXT NOT NULL, rate_kopecks INTEGER NOT NULL, experience_years INTEGER NOT NULL, available INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS shifts (id INTEGER PRIMARY KEY, workspace_id TEXT NOT NULL, site_id INTEGER NOT NULL, role TEXT NOT NULL, starts_at TEXT NOT NULL, ends_at TEXT NOT NULL, pay_kopecks INTEGER NOT NULL, skills TEXT NOT NULL, description TEXT NOT NULL, decision_deadline TEXT NOT NULL, sources TEXT NOT NULL, scenario TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS publications (id INTEGER PRIMARY KEY, shift_id INTEGER NOT NULL, source TEXT NOT NULL, status TEXT NOT NULL, detail TEXT NOT NULL, UNIQUE(shift_id, source));
    CREATE TABLE IF NOT EXISTS responses (id INTEGER PRIMARY KEY, shift_id INTEGER NOT NULL, candidate_id INTEGER NOT NULL, status TEXT NOT NULL, reasons TEXT NOT NULL, contact_source TEXT, UNIQUE(shift_id, candidate_id));
    CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY, shift_id INTEGER NOT NULL, candidate_id INTEGER NOT NULL, sender TEXT NOT NULL, text TEXT NOT NULL, modelled INTEGER NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS offers (id INTEGER PRIMARY KEY, shift_id INTEGER NOT NULL, candidate_id INTEGER NOT NULL, status TEXT NOT NULL, starts_at TEXT NOT NULL, ends_at TEXT NOT NULL, pay_kopecks INTEGER NOT NULL, site_name TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS one_active_offer ON offers(shift_id) WHERE status IN ('pending','confirmed');
    CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, shift_id INTEGER NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS reserve (workspace_id TEXT NOT NULL, candidate_id INTEGER NOT NULL, PRIMARY KEY(workspace_id,candidate_id));
    CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS bot_chats (workspace_id TEXT PRIMARY KEY, chat_id TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS bot_updates (update_key TEXT PRIMARY KEY, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS bot_dialogs (user_id INTEGER PRIMARY KEY, mode TEXT NOT NULL DEFAULT '', stage TEXT NOT NULL DEFAULT '', draft_json TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS bot_candidate_profiles (user_id INTEGER PRIMARY KEY, name TEXT NOT NULL, skill TEXT NOT NULL, rate_kopecks INTEGER NOT NULL, available INTEGER NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS bot_outbox (update_key TEXT NOT NULL, seq INTEGER NOT NULL, user_id INTEGER NOT NULL, payload_json TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(update_key,seq));
    CREATE TABLE IF NOT EXISTS bot_demo_jobs (shift_id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, due_at INTEGER NOT NULL, completed_at TEXT);
    CREATE TABLE IF NOT EXISTS bot_contact_outcomes (shift_id INTEGER NOT NULL, candidate_id INTEGER NOT NULL, manager_id INTEGER NOT NULL, agreed INTEGER NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(shift_id,candidate_id));
  `;
  for (const sql of schema.split(';').map(part => part.trim()).filter(Boolean)) await db.execute(sql);
  const txContext = new AsyncLocalStorage();
  const execute = (sql, args) => (txContext.getStore() || db).execute({ sql, args });
  const get = async (sql, ...args) => (await execute(sql, args)).rows[0];
  const all = async (sql, ...args) => (await execute(sql, args)).rows;
  const run = async (sql, ...args) => {
    const result = await execute(sql, args);
    return { lastInsertRowid: result.lastInsertRowid == null ? null : Number(result.lastInsertRowid), changes: result.rowsAffected };
  };
  const transaction = async fn => {
    const tx = await db.transaction('write');
    try { const result = await txContext.run(tx, fn); await tx.commit(); return result; }
    catch (error) { await tx.rollback(); throw error; }
  };
  if (!(await all('PRAGMA table_info(responses)')).some(column => column.name === 'contact_source')) {
    await db.execute('ALTER TABLE responses ADD COLUMN contact_source TEXT');
  }
  if (!(await all('PRAGMA table_info(candidates)')).some(column => column.name === 'max_user_id')) {
    await db.execute('ALTER TABLE candidates ADD COLUMN max_user_id INTEGER');
  }
  if (!(await all('PRAGMA table_info(candidates)')).some(column => column.name === 'max_profile_url')) {
    await db.execute('ALTER TABLE candidates ADD COLUMN max_profile_url TEXT');
  }
  if (!(await all('PRAGMA table_info(bot_candidate_profiles)')).some(column => column.name === 'max_profile_url')) {
    await db.execute('ALTER TABLE bot_candidate_profiles ADD COLUMN max_profile_url TEXT');
  }
  await db.execute('CREATE UNIQUE INDEX IF NOT EXISTS candidates_workspace_max_user ON candidates(workspace_id,max_user_id) WHERE max_user_id IS NOT NULL');
  async function ensureWorkspace(id) {
    await transaction(async () => {
      if (await get('SELECT id FROM workspaces WHERE id=?', id)) return;
      await run('INSERT INTO workspaces VALUES (?,?,?)', id, 'Кофейни «Смена»', 'Europe/Moscow');
      await run('INSERT INTO sites(workspace_id,name,address) VALUES (?,?,?)', id, 'Точка на Покровке', 'Москва, ул. Покровка, 18');
      await run('INSERT INTO sites(workspace_id,name,address) VALUES (?,?,?)', id, 'Точка на Бауманской', 'Москва, Бауманская ул., 12');
      for (const p of people) {
        const result = await run('INSERT INTO candidates(workspace_id,name,source,skills,rate_kopecks,experience_years,available) VALUES (?,?,?,?,?,?,?)', id, p[0], p[1], JSON.stringify(p[2]), p[3] * 100, p[4], p[5]);
        if (p[1] === 'reserve') await run('INSERT INTO reserve(workspace_id,candidate_id) VALUES (?,?)', id, result.lastInsertRowid);
      }
    });
  }
  return { db, get, all, run, transaction, ensureWorkspace };
}
