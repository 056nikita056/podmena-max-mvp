import { createHmac, timingSafeEqual } from 'node:crypto';

const platforms = { youdo: 'https://youdo.com/', profi: 'https://profi.ru/' };

export function platformUrl(source) { return platforms[source] || null; }

export function maxProfileUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' || url.hostname !== 'max.ru' || url.port || url.search || url.hash) return null;
    if (!/^\/(?:u\/[A-Za-z0-9_-]{8,256}|[A-Za-z0-9_]{3,64})\/?$/.test(url.pathname)) return null;
    return `https://max.ru${url.pathname.replace(/\/$/, '')}`;
  } catch { return null; }
}

export function createOutboundLink(baseUrl, secret, { managerId, shiftId, candidateId, target }, now = Date.now()) {
  if (!baseUrl || !secret || !['platform', 'max'].includes(target)) return null;
  const encoded = Buffer.from(JSON.stringify({ m: managerId, s: shiftId, c: candidateId, t: target, e: now + 7 * 86400000 })).toString('base64url');
  const signature = createHmac('sha256', secret).update(encoded).digest('base64url');
  return `${baseUrl.replace(/\/$/, '')}/api/outbound?token=${encoded}.${signature}`;
}

export function readOutboundLink(token, secret, now = Date.now()) {
  if (typeof token !== 'string' || !secret || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) return null;
  const [encoded, signature] = token.split('.');
  const expected = createHmac('sha256', secret).update(encoded).digest();
  let supplied;
  try { supplied = Buffer.from(signature, 'base64url'); } catch { return null; }
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;
  try {
    const value = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (![value.m, value.s, value.c].every(x => Number.isSafeInteger(x) && x > 0) || !['platform', 'max'].includes(value.t) || !Number.isSafeInteger(value.e) || value.e < now) return null;
    return { managerId: value.m, shiftId: value.s, candidateId: value.c, target: value.t };
  } catch { return null; }
}
