'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createApi } = require('../src/api');

const SECRET = 'a'.repeat(40);
const S1 = 'A1B2C3D4E5F60718293A4B5C6D7E8F90';
const S2 = '0F1E2D3C4B5A69788796A5B4C3D2E1F0';

function setup(allowed = () => true) {
  const store = { db: { links: {}, codes: {} }, save() {} };
  const svc = createApi({ store, apiSecret: SECRET, isAllowedMember: async (id) => allowed(id) });
  return new Promise((resolve) => {
    const server = svc.app.listen(0, '127.0.0.1', () => {
      const base = `http://127.0.0.1:${server.address().port}`;
      const post = async (path, body, secret = SECRET) => {
        const r = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-MTA-Secret': secret }, body: JSON.stringify(body) });
        return { status: r.status, json: await r.json() };
      };
      resolve({ svc, store, post, base, close: () => server.close() });
    });
  });
}

test('health y secreto', async () => {
  const t = await setup();
  assert.equal((await (await fetch(t.base + '/health')).json()).ok, true);
  const r = await t.post('/api/verify', { serial: S1 }, 'mal');
  assert.equal(r.status, 401); assert.equal(r.json.error, 'unauthorized');
  t.close();
});

test('flujo completo: no vinculado -> codigo -> claim -> verify ok -> desvincular', async () => {
  const t = await setup();
  let r = await t.post('/api/verify', { serial: S1 });
  assert.equal(r.status, 403); assert.equal(r.json.error, 'not_linked');
  const code = t.svc.createCode('111');
  r = await t.post('/api/claim', { serial: S1, code });
  assert.equal(r.status, 200); assert.equal(r.json.ok, true);
  r = await t.post('/api/verify', { serial: S1.toLowerCase() });
  assert.equal(r.status, 200); assert.equal(r.json.discordId, '111');
  r = await t.post('/api/claim', { serial: S1, code });           // codigo de un solo uso
  assert.equal(r.json.error, 'code_invalid_or_expired');
  assert.equal(t.svc.unlinkDiscord('111'), 1);
  r = await t.post('/api/verify', { serial: S1 });
  assert.equal(r.json.error, 'not_linked');
  t.close();
});

test('un discord = un serial y viceversa', async () => {
  const t = await setup();
  await t.post('/api/claim', { serial: S1, code: t.svc.createCode('111') });
  let r = await t.post('/api/claim', { serial: S2, code: t.svc.createCode('111') });
  assert.equal(r.status, 409); assert.equal(r.json.error, 'already_linked');
  r = await t.post('/api/claim', { serial: S1, code: t.svc.createCode('222') });
  assert.equal(r.status, 409);
  t.close();
});

test('no miembro del servidor / Discord caido (fail closed)', async () => {
  let mode = 'ok';
  const t = await setup(() => { if (mode === 'down') throw new Error('x'); return mode === 'ok'; });
  await t.post('/api/claim', { serial: S1, code: t.svc.createCode('111') });
  mode = 'out'; let r = await t.post('/api/verify', { serial: S1 });
  assert.equal(r.status, 403); assert.equal(r.json.error, 'not_guild_member');
  mode = 'down'; r = await t.post('/api/verify', { serial: S1 });
  assert.equal(r.status, 503); assert.equal(r.json.error, 'discord_unavailable');
  mode = 'ok'; r = await t.post('/api/verify', { serial: S1 });
  assert.equal(r.status, 200);                                        // el vinculo no se pierde
  t.close();
});

test('limite de intentos de codigo por serial', async () => {
  const t = await setup();
  let r;
  for (let i = 0; i < 5; i++) r = await t.post('/api/claim', { serial: S1, code: '000000' });
  assert.equal(r.json.error, 'code_invalid_or_expired');
  r = await t.post('/api/claim', { serial: S1, code: t.svc.createCode('111') });
  assert.equal(r.status, 429); assert.equal(r.json.error, 'too_many_attempts');
  t.close();
});

test('carrera: el mismo codigo no se puede usar con dos seriales a la vez', async () => {
  const t = await setup();
  const code = t.svc.createCode('111');
  const [a, b] = await Promise.all([t.post('/api/claim', { serial: S1, code }), t.post('/api/claim', { serial: S2, code })]);
  assert.equal([a, b].filter((x) => x.json.ok).length, 1);
  assert.equal(Object.keys(t.store.db.links).length, 1);
  t.close();
});

test('entradas invalidas y JSON roto', async () => {
  const t = await setup();
  assert.equal((await t.post('/api/verify', { serial: 'xx' })).json.error, 'invalid_input');
  assert.equal((await t.post('/api/claim', { serial: S1, code: 'abc' })).json.error, 'invalid_input');
  const r = await fetch(t.base + '/api/verify', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-MTA-Secret': SECRET }, body: '{roto' });
  assert.equal(r.status, 400);
  t.close();
});

test('nombre del servidor: se guarda al vincular, se limpia y se sincroniza en verify', async () => {
  const events = [];
  const store = { db: { links: {}, codes: {}, meta: {} }, save() {} };
  const svc = createApi({
    store, apiSecret: SECRET, isAllowedMember: async () => true,
    hooks: { onLinked: (p) => events.push(['linked', p]), onNameChanged: (p) => events.push(['name', p]) }
  });
  const server = await new Promise((r) => { const s = svc.app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (path, body) => (await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-MTA-Secret': SECRET }, body: JSON.stringify(body) })).json();

  await post('/api/claim', { serial: S1, code: svc.createCode('111'), name: '#FF0000Juan_Perez' });
  assert.equal(events[0][0], 'linked');
  assert.equal(events[0][1].name, 'Juan_Perez');
  assert.equal(events[0][1].count, 1);
  assert.equal(svc.getInfo('111').name, 'Juan_Perez');
  assert.equal(svc.getInfo('999'), null);

  await post('/api/verify', { serial: S1, name: 'Juan_Perez' });          // mismo nombre: no dispara nada
  assert.equal(events.length, 1);
  await post('/api/verify', { serial: S1, name: 'Juan_Nuevo' });          // cambio de nombre
  assert.deepEqual(events[1], ['name', { discordId: '111', name: 'Juan_Nuevo' }]);
  assert.equal(svc.listLinked()[0].name, 'Juan_Nuevo');

  svc.unlinkDiscord('111');
  assert.equal(svc.getInfo('111'), null);
  assert.equal(store.db.meta['111'], undefined);
  server.close();
});
