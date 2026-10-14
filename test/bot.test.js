'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createBotLogic, buildCommands, fmt } = require('../src/bot');

function fakeEnv(extra = {}) {
  const calls = { roleAdd: [], roleRemove: [], nick: [], sent: [] };
  const member = {
    id: '111', nickname: null,
    roles: { add: async (r) => { calls.roleAdd.push(r); }, remove: async (r) => { calls.roleRemove.push(r); } },
    setNickname: async (n) => { calls.nick.push(n); member.nickname = n; }
  };
  const client = {
    guilds: { fetch: async () => ({ members: { fetch: async () => member } }) },
    channels: { fetch: async () => ({ send: async (m) => { calls.sent.push(m); } }) },
    users: { fetch: async () => ({ username: 'juan#1' }) }
  };
  const service = { listLinked: () => [1, 2, 3], ...extra };
  return { calls, client, service, member };
}

test('comandos slash validos', () => {
  const names = buildCommands().map((c) => c.name);
  assert.deepEqual(names, ['vincular', 'desvincular', 'estado', 'admin-desvincular', 'admin-info', 'admin-lista', 'admin-panel']);
});

test('fmt reemplaza variables y \\n', () => {
  assert.equal(fmt('A {x}\\nB {y} {z}', { x: 1, y: 'k' }), 'A 1\nB k {z}');
});

test('al vincular: da rol, cambia apodo y publica el log con formato', async () => {
  const e = fakeEnv();
  const logic = createBotLogic({ client: e.client, guildId: 'G', service: e.service, options: { linkedRoleId: 'ROLE', logChannelId: 'CH', nicknameFormat: '[MTA] {name}' } });
  await logic.onLinked({ discordId: '111', name: 'Juan_Perez', count: 7 });
  assert.deepEqual(e.calls.roleAdd, ['ROLE']);
  assert.deepEqual(e.calls.nick, ['[MTA] Juan_Perez']);
  const msg = e.calls.sent[0].content;
  assert.match(msg, /<@111>/); assert.match(msg, /Juan_Perez/); assert.match(msg, /\*\*7\*\*/);
  assert.deepEqual(e.calls.sent[0].allowedMentions, { parse: [] });
});

test('apodo: maximo 32 caracteres y no repite si ya esta igual', async () => {
  const e = fakeEnv();
  const logic = createBotLogic({ client: e.client, guildId: 'G', service: e.service, options: { nicknameFormat: '[MTA] {name}' } });
  await logic.onNameChanged({ discordId: '111', name: 'x'.repeat(32) });
  assert.equal(e.calls.nick[0].length, 32);
  await logic.onNameChanged({ discordId: '111', name: 'x'.repeat(32) });
  assert.equal(e.calls.nick.length, 1);
});

test('sin rol ni canal configurados: no hace nada raro ni falla', async () => {
  const e = fakeEnv();
  const logic = createBotLogic({ client: e.client, guildId: 'G', service: e.service, options: {} });
  await logic.onLinked({ discordId: '111', name: 'Ana', count: 1 });
  assert.equal(e.calls.roleAdd.length, 0); assert.equal(e.calls.sent.length, 0); assert.deepEqual(e.calls.nick, ['Ana']);
});

test('si falla dar el rol (permisos), igual cambia apodo y publica', async () => {
  const e = fakeEnv();
  e.member.roles.add = async () => { throw new Error('Missing Permissions'); };
  const logic = createBotLogic({ client: e.client, guildId: 'G', service: e.service, options: { linkedRoleId: 'ROLE', logChannelId: 'CH' } });
  await logic.onLinked({ discordId: '111', name: 'Ana', count: 1 });
  assert.deepEqual(e.calls.nick, ['Ana']); assert.equal(e.calls.sent.length, 1);
});

test('al desvincular: quita el rol y publica', async () => {
  const e = fakeEnv();
  const logic = createBotLogic({ client: e.client, guildId: 'G', service: e.service, options: { linkedRoleId: 'ROLE', logChannelId: 'CH' } });
  await logic.onUnlinked('111', { name: 'Ana' });
  assert.deepEqual(e.calls.roleRemove, ['ROLE']); assert.match(e.calls.sent[0].content, /Ana/);
});

test('comandos admin rechazan a no administradores', async () => {
  const e = fakeEnv();
  const logic = createBotLogic({ client: e.client, guildId: 'G', service: e.service, options: {} });
  let reply;
  const i = { guildId: 'G', isButton: () => false, isChatInputCommand: () => true, commandName: 'admin-lista', memberPermissions: { has: () => false }, reply: async (r) => { reply = r; } };
  await logic.handleInteraction(i);
  assert.match(reply.content, /No tienes permiso/);
});
