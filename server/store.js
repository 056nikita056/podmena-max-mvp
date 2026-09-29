import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

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

export function openStore(path) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;');
  db.exec(`
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
  `);
  if (!db.prepare('PRAGMA table_info(responses)').all().some(column => column.name === 'contact_source')) {
    db.exec('ALTER TABLE responses ADD COLUMN contact_source TEXT');
  }
  const get = (sql, ...args) => db.prepare(sql).get(...args);
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  const transaction = fn => { db.exec('BEGIN IMMEDIATE'); try { const result = fn(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; } };
  function ensureWorkspace(id) {
    if (get('SELECT id FROM workspaces WHERE id=?', id)) return;
    transaction(() => {
      run('INSERT INTO workspaces VALUES (?,?,?)', id, 'Кофейни «Смена»', 'Europe/Moscow');
      run('INSERT INTO sites(workspace_id,name,address) VALUES (?,?,?)', id, 'Точка на Покровке', 'Москва, ул. Покровка, 18');
      run('INSERT INTO sites(workspace_id,name,address) VALUES (?,?,?)', id, 'Точка на Бауманской', 'Москва, Бауманская ул., 12');
      for (const p of people) {
        const result = run('INSERT INTO candidates(workspace_id,name,source,skills,rate_kopecks,experience_years,available) VALUES (?,?,?,?,?,?,?)', id, p[0], p[1], JSON.stringify(p[2]), p[3] * 100, p[4], p[5]);
        if (p[1] === 'reserve') run('INSERT INTO reserve(workspace_id,candidate_id) VALUES (?,?)', id, result.lastInsertRowid);
      }
    });
  }
  return { db, get, all, run, transaction, ensureWorkspace };
}
