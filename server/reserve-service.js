import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { AppError } from './domain.js';
import { maxProfileUrl } from './outbound-links.js';

const bad = message => { throw new AppError(400, message); };
const conflict = message => { throw new AppError(409, message); };
const tokenHash = token => createHash('sha256').update(token).digest('hex');
const keyedHash = (secret, value) => createHmac('sha256', secret).update(value).digest('hex');

export function normalizePhone(value) {
  let digits = String(value || '').replace(/\D/g, '');
  if (digits.length === 10 && digits.startsWith('9')) digits = `7${digits}`;
  if (digits.length === 11 && digits.startsWith('8')) digits = `7${digits.slice(1)}`;
  return /^7\d{10}$/.test(digits) ? digits : null;
}

export function verifiedContactPhone(body, botToken) {
  if (!botToken) return null;
  const attachment = body?.attachments?.find(x => x.type === 'contact');
  const vcf = attachment?.payload?.vcf_info?.replace(/\\r\\n/g, '\r\n');
  const signature = attachment?.payload?.hash;
  if (typeof vcf !== 'string' || typeof signature !== 'string' || !/^[a-f0-9]{64}$/i.test(signature)) return null;
  const expected = createHmac('sha256', botToken).update(vcf).digest();
  const supplied = Buffer.from(signature, 'hex');
  if (!timingSafeEqual(expected, supplied)) return null;
  const phone = /^TEL(?:;[^:]*)?:(.+)$/mi.exec(vcf)?.[1]?.trim();
  return normalizePhone(phone);
}

export function createReserveService(store, domain, { inviteSecret, botToken, botUsername = 't405_hakaton_max_bot' } = {}) {
  const { get, all, run, transaction } = store;
  if (!inviteSecret) throw new Error('Для приглашений резерва требуется секрет');
  const matchHash = (kind, value) => keyedHash(inviteSecret, `${kind}:${value}`);
  function parseTarget(input) {
    const value = String(input || '').trim();
    const phone = normalizePhone(value);
    if (phone) return { kind: 'phone', matchHash: matchHash('phone', phone), display: `+7••• ••• ${phone.slice(-4)}` };
    if (/^\+?[\d\s()-]+$/.test(value)) bad('Проверьте номер телефона: нужен российский номер из 10 цифр после +7.');
    const username = /^@?([A-Za-z0-9_]{3,64})$/.exec(value)?.[1]?.toLowerCase();
    if (username) return { kind: 'username', matchHash: matchHash('username', username), display: `@${username}` };
    bad('Укажите username MAX вида @name или российский номер телефона.');
  }
  async function createInvite(workspace, input) {
    await domain.bootstrap(workspace);
    const target = parseTarget(input);
    const token = randomBytes(18).toString('base64url');
    const expiresAt = Date.now() + 7 * 86400000;
    const result = await run('INSERT INTO bot_reserve_invitations(workspace_id,kind,match_hash,display,token_hash,expires_at,created_at) VALUES (?,?,?,?,?,?,?)', workspace, target.kind, target.matchHash, target.display, tokenHash(token), expiresAt, new Date().toISOString());
    return { id: result.lastInsertRowid, display: target.display, url: `https://max.ru/${botUsername}?start=reserve_${token}` };
  }
  async function findInvite(id) {
    const invite = await get('SELECT * FROM bot_reserve_invitations WHERE id=?', id);
    if (!invite || invite.expires_at < Date.now()) bad('Приглашение недоступно или истекло.');
    return invite;
  }
  async function beginInvite(payload, actor) {
    const token = /^reserve_([A-Za-z0-9_-]{20,64})$/.exec(payload || '')?.[1];
    if (!token) bad('Приглашение недоступно.');
    const invite = await get('SELECT * FROM bot_reserve_invitations WHERE token_hash=?', tokenHash(token));
    if (!invite || invite.expires_at < Date.now() || invite.claimed_user_id) bad('Приглашение недоступно или уже использовано.');
    if (invite.kind === 'username') {
      const username = String(actor?.username || '').toLowerCase();
      if (!username || matchHash('username', username) !== invite.match_hash) bad('Username MAX не совпадает с приглашением.');
    }
    return { id: invite.id, workspace: invite.workspace_id, needsContact: invite.kind === 'phone' };
  }
  async function checkContact(id, body) {
    const invite = await findInvite(id);
    if (invite.kind !== 'phone') bad('Подтверждение номера не требуется.');
    const phone = verifiedContactPhone(body, botToken);
    return Boolean(phone && matchHash('phone', phone) === invite.match_hash);
  }
  async function joinInvite(id, actor, verifiedIdentity) {
    const userId = Number(actor?.user_id);
    if (!Number.isSafeInteger(userId) || userId <= 0) bad('Неизвестный пользователь MAX.');
    const invite = await findInvite(id);
    if (invite.claimed_user_id) conflict('Приглашение уже использовано.');
    if (!verifiedIdentity) bad(invite.kind === 'phone' ? 'Сначала подтвердите свой номер кнопкой MAX.' : 'Откройте приглашение своим аккаунтом MAX.');
    if (invite.kind === 'username' && actor?.username && matchHash('username', String(actor.username).toLowerCase()) !== invite.match_hash) bad('Username MAX не совпадает с приглашением.');
    const name = [actor.first_name, actor.last_name].filter(Boolean).join(' ').trim().slice(0, 80) || 'Сотрудник резерва';
    const profileUrl = maxProfileUrl(`https://max.ru/${actor.username || ''}`);
    await transaction(async () => {
      const claim = await run('UPDATE bot_reserve_invitations SET claimed_user_id=? WHERE id=? AND claimed_user_id IS NULL', userId, id);
      if (!claim.changes) conflict('Приглашение уже использовано.');
      await run(`INSERT INTO candidates(workspace_id,name,source,skills,rate_kopecks,experience_years,available,max_user_id,max_profile_url) VALUES (?,?,?,?,?,?,?,?,?)
        ON CONFLICT(workspace_id,max_user_id) WHERE max_user_id IS NOT NULL DO UPDATE SET name=excluded.name,source='reserve',available=1,max_profile_url=excluded.max_profile_url`, invite.workspace_id, name, 'reserve', '[]', 0, 0, 1, userId, profileUrl);
      const person = await get('SELECT id FROM candidates WHERE workspace_id=? AND max_user_id=?', invite.workspace_id, userId);
      await run('INSERT OR IGNORE INTO reserve(workspace_id,candidate_id) VALUES (?,?)', invite.workspace_id, person.id);
    });
    return { managerId: Number(invite.workspace_id.slice(4)), name };
  }
  async function list(workspace) {
    const people = await all('SELECT c.name,c.max_user_id AS userId FROM reserve r JOIN candidates c ON c.id=r.candidate_id WHERE r.workspace_id=? ORDER BY c.name', workspace);
    const pending = await all('SELECT display FROM bot_reserve_invitations WHERE workspace_id=? AND claimed_user_id IS NULL AND expires_at>? ORDER BY id DESC LIMIT 8', workspace, Date.now());
    return { people, pending };
  }
  async function broadcast(workspace, shiftId) {
    const members = await all('SELECT c.id,c.max_user_id AS userId FROM reserve r JOIN candidates c ON c.id=r.candidate_id WHERE r.workspace_id=? AND c.max_user_id IS NOT NULL AND c.available=1', workspace);
    const newInvites = [];
    for (const member of members) {
      const created = await run('INSERT OR IGNORE INTO bot_reserve_shift_invites(shift_id,candidate_id,user_id,status,created_at) VALUES (?,?,?,?,?)', shiftId, member.id, member.userId, 'pending', new Date().toISOString());
      if (created.changes) newInvites.push(member);
    }
    return newInvites;
  }
  async function pending(userId) {
    return all(`SELECT i.shift_id AS shiftId,s.workspace_id AS workspace FROM bot_reserve_shift_invites i JOIN shifts s ON s.id=i.shift_id WHERE i.user_id=? AND i.status='pending' AND s.status IN ('searching','unfilled') ORDER BY i.created_at DESC LIMIT 8`, userId);
  }
  async function reply(managerId, shiftId, userId, answer) {
    if (!['yes', 'no'].includes(answer)) bad('Неизвестный ответ.');
    const workspace = `max:${managerId}`;
    const details = await domain.detail(workspace, shiftId);
    if (!['searching', 'unfilled'].includes(details.shift.status)) conflict('Эта смена уже закрыта.');
    const invite = await get('SELECT i.candidate_id AS candidateId,c.name FROM bot_reserve_shift_invites i JOIN candidates c ON c.id=i.candidate_id WHERE i.shift_id=? AND i.user_id=? AND i.status=? AND c.workspace_id=?', shiftId, userId, 'pending', workspace);
    if (!invite) bad('Приглашение на смену недоступно или ответ уже сохранён.');
    await transaction(async () => {
      const changed = await run("UPDATE bot_reserve_shift_invites SET status=? WHERE shift_id=? AND candidate_id=? AND status='pending'", answer === 'yes' ? 'accepted' : 'declined', shiftId, invite.candidateId);
      if (!changed.changes) conflict('Ответ уже сохранён.');
      if (answer === 'yes') {
        await run('INSERT OR IGNORE INTO responses(shift_id,candidate_id,status,reasons,contact_source) VALUES (?,?,?,?,?)', shiftId, invite.candidateId, 'new', JSON.stringify(['Сотрудник резерва сам откликнулся в MAX']), 'reserve');
        await run('INSERT INTO messages(shift_id,candidate_id,sender,text,modelled,created_at) VALUES (?,?,?,?,?,?)', shiftId, invite.candidateId, 'candidate', 'Здравствуйте! Могу выйти на смену, давайте обсудим детали.', 0, new Date().toISOString());
        await run("UPDATE shifts SET status='searching' WHERE id=?", shiftId);
        await run('INSERT INTO events(shift_id,kind,text,created_at) VALUES (?,?,?,?)', shiftId, 'reserve_reply', `${invite.name} откликнулся(ась) в MAX`, new Date().toISOString());
      }
    });
    return { managerId, name: invite.name, accepted: answer === 'yes' };
  }
  return { createInvite, beginInvite, checkContact, joinInvite, list, broadcast, pending, reply };
}
