import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../server/http.js';

async function fixture({ browserDemo = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'podmena-'));
  const app = createServer({ databasePath: join(dir, 'app.sqlite'), browserDemo, sessionSecret: 'test-secret' });
  await new Promise(resolve => app.listen(0, resolve));
  const base = `http://127.0.0.1:${app.address().port}`;
  const cookies = new Map();
  async function request(path, method = 'GET', body, who = 'manager') {
    const headers = { 'content-type': 'application/json' };
    if (cookies.get(who)) headers.cookie = cookies.get(who);
    const response = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookies.set(who, setCookie.split(';')[0]);
    return { status: response.status, data: await response.json() };
  }
  return { app, dir, request, close: async () => { await new Promise(resolve => app.close(resolve)); rmSync(dir, { recursive: true, force: true }); } };
}

test('public configuration hides browser demo when its login is disabled', async () => {
  const fx = await fixture({ browserDemo: false });
  try {
    assert.deepEqual((await fx.request('/api/config')).data, { browserDemo: false });
    assert.equal((await fx.request('/api/auth/demo', 'POST', { persona: 'manager' })).status, 403);
  } finally { await fx.close(); }
});

const shiftInput = {
  siteId: 1, role: 'Бариста', startsAt: '2026-10-02T06:00:00.000Z', endsAt: '2026-10-02T14:00:00.000Z',
  payRub: 6000, skills: ['Эспрессо'], description: 'Утренняя смена', decisionDeadline: '2026-10-01T18:00:00.000Z',
  sources: ['staff', 'reserve', 'youdo', 'profi']
};

test('manager completes replacement only after separate candidate confirmation; data survives reopen', async () => {
  const fx = await fixture();
  try {
    assert.equal((await fx.request('/api/auth/demo', 'POST', { persona: 'manager' })).status, 200);
    const created = await fx.request('/api/shifts', 'POST', shiftInput);
    assert.equal(created.status, 201);
    const id = created.data.shift.id;
    const searched = await fx.request(`/api/shifts/${id}/search`, 'POST', {});
    assert.equal(searched.status, 200);
    assert.ok(searched.data.responses.length > 0);
    const candidateId = searched.data.responses[0].candidateId;
    assert.equal((await fx.request(`/api/shifts/${id}/messages`, 'POST', { candidateId, text: 'Сможете выйти?' })).status, 201);
    const offered = await fx.request(`/api/shifts/${id}/offer`, 'POST', { candidateId });
    assert.equal(offered.data.shift.status, 'awaiting_confirmation');
    assert.equal((await fx.request(`/api/shifts/${id}`)).data.shift.status, 'awaiting_confirmation');
    const confirmed = await fx.request(`/api/shifts/${id}/demo-decision`, 'POST', { decision: 'confirm' });
    assert.equal(confirmed.data.shift.status, 'confirmed');
    assert.equal((await fx.request(`/api/shifts/${id}/demo-decision`, 'POST', { decision: 'confirm' })).status, 409);
    const saved = await fx.request(`/api/shifts/${id}`);
    assert.equal(saved.data.messages.length, 2);
    assert.equal(saved.data.shift.status, 'confirmed');
  } finally { await fx.close(); }
});

test('invalid time and cross-workspace access are rejected', async () => {
  const fx = await fixture();
  try {
    await fx.request('/api/auth/demo', 'POST', { persona: 'manager' });
    const bad = await fx.request('/api/shifts', 'POST', { ...shiftInput, endsAt: shiftInput.startsAt });
    assert.equal(bad.status, 400);
    const created = await fx.request('/api/shifts', 'POST', shiftInput);
    await fx.request('/api/auth/demo', 'POST', { persona: 'reviewer' }, 'reviewer');
    assert.equal((await fx.request(`/api/shifts/${created.data.shift.id}`, 'GET', undefined, 'reviewer')).status, 404);
  } finally { await fx.close(); }
});

test('empty results, one failed source, refusal, cancellation and restart remain coherent', async () => {
  const fx = await fixture();
  try {
    await fx.request('/api/auth/demo', 'POST', { persona: 'manager' });
    const empty = await fx.request('/api/shifts', 'POST', { ...shiftInput, scenario: 'no_results' });
    const emptyResult = await fx.request(`/api/shifts/${empty.data.shift.id}/search`, 'POST', {});
    assert.equal(emptyResult.data.responses.length, 0);
    assert.equal(emptyResult.data.shift.status, 'unfilled');
    const failed = await fx.request('/api/shifts', 'POST', { ...shiftInput, scenario: 'source_error' });
    const found = await fx.request(`/api/shifts/${failed.data.shift.id}/search`, 'POST', {});
    assert.ok(found.data.responses.length > 0);
    assert.equal(found.data.publications.find(x => x.source === 'profi').status, 'failed');
    const person = found.data.responses[0].candidateId;
    await fx.request(`/api/shifts/${failed.data.shift.id}/offer`, 'POST', { candidateId: person });
    const refused = await fx.request(`/api/shifts/${failed.data.shift.id}/demo-decision`, 'POST', { decision: 'decline' });
    assert.equal(refused.data.shift.status, 'searching');
    assert.equal((await fx.request(`/api/shifts/${failed.data.shift.id}/cancel`, 'POST', {})).data.shift.status, 'cancelled');
  } finally { await fx.close(); }
});

test('search and offer resist duplicates; occupied candidate is excluded on overlapping shift', async () => {
  const fx = await fixture();
  try {
    await fx.request('/api/auth/demo', 'POST', { persona: 'manager' });
    const first = await fx.request('/api/shifts', 'POST', shiftInput);
    const id = first.data.shift.id;
    const result = await fx.request(`/api/shifts/${id}/search`, 'POST', {});
    assert.equal((await fx.request(`/api/shifts/${id}/search`, 'POST', {})).data.responses.length, result.data.responses.length);
    const candidateId = result.data.responses[0].candidateId;
    assert.equal((await fx.request(`/api/shifts/${id}/offer`, 'POST', { candidateId })).status, 200);
    assert.equal((await fx.request(`/api/shifts/${id}/offer`, 'POST', { candidateId })).status, 409);
    const second = await fx.request('/api/shifts', 'POST', shiftInput);
    const secondResult = await fx.request(`/api/shifts/${second.data.shift.id}/search`, 'POST', {});
    assert.equal(secondResult.data.responses.some(x => x.candidateId === candidateId), false);
  } finally { await fx.close(); }
});

test('confirmed shift and conversation persist through server restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'podmena-restart-'));
  const databasePath = join(dir, 'app.sqlite');
  let app = createServer({ databasePath, browserDemo: true, sessionSecret: 'restart-secret' });
  try {
    await new Promise(resolve => app.listen(0, resolve));
    let base = `http://127.0.0.1:${app.address().port}`;
    let response = await fetch(base + '/api/auth/demo', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ persona: 'manager' }) });
    const cookie = response.headers.get('set-cookie').split(';')[0];
    const send = async (path, body) => (await fetch(base + path, { method: body ? 'POST' : 'GET', headers: { cookie, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })).json();
    const created = await send('/api/shifts', shiftInput); const id = created.shift.id;
    const searched = await send(`/api/shifts/${id}/search`, {}); const candidateId = searched.responses[0].candidateId;
    await send(`/api/shifts/${id}/messages`, { candidateId, text: 'Тест' });
    await send(`/api/shifts/${id}/offer`, { candidateId });
    await send(`/api/shifts/${id}/demo-decision`, { decision: 'confirm' });
    await new Promise(resolve => app.close(resolve));
    app = createServer({ databasePath, browserDemo: true, sessionSecret: 'restart-secret' });
    await new Promise(resolve => app.listen(0, resolve));
    base = `http://127.0.0.1:${app.address().port}`;
    const saved = await send(`/api/shifts/${id}`);
    assert.equal(saved.shift.status, 'confirmed');
    assert.equal(saved.messages.length, 2);
    assert.equal(saved.offer.status, 'confirmed');
  } finally { if (app.listening) await new Promise(resolve => app.close(resolve)); rmSync(dir, { recursive: true, force: true }); }
});

test('saved external candidate can be found through reserve on a later non-overlapping shift', async () => {
  const fx = await fixture();
  try {
    await fx.request('/api/auth/demo', 'POST', { persona: 'manager' });
    const first = await fx.request('/api/shifts', 'POST', shiftInput);
    const searched = await fx.request(`/api/shifts/${first.data.shift.id}/search`, 'POST', {});
    const external = searched.data.responses.find(x => x.source === 'youdo');
    await fx.request(`/api/shifts/${first.data.shift.id}/offer`, 'POST', { candidateId: external.candidateId });
    await fx.request(`/api/shifts/${first.data.shift.id}/demo-decision`, 'POST', { decision: 'confirm' });
    await fx.request(`/api/shifts/${first.data.shift.id}/reserve`, 'POST', { candidateId: external.candidateId });
    const later = await fx.request('/api/shifts', 'POST', { ...shiftInput, startsAt: '2026-10-04T06:00:00.000Z', endsAt: '2026-10-04T14:00:00.000Z', decisionDeadline: '2026-10-03T18:00:00.000Z', sources: ['reserve'] });
    const found = await fx.request(`/api/shifts/${later.data.shift.id}/search`, 'POST', {});
    const saved = found.data.responses.find(x => x.candidateId === external.candidateId);
    assert.ok(saved);
    assert.equal(saved.source, 'reserve');
  } finally { await fx.close(); }
});
