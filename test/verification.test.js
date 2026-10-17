'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createVerification, buildVerificationCommands, buildPanelPayload, VERIFY_BUTTON_ID } = require('../src/verification');

// Fakes minimos de discord.js (sin conectarse a Discord)
function env({ hierarchyOk = true, hasManageRoles = true, memberGone = false, roleExists = true, config = {}, linked = [] } = {}) {
  const calls = { added: [], sent: [], panelSent: [], edits: [], deleted: [], saves: 0, codes: [] };
  const role = { id: 'ROLE', managed: false, toString: () => '<@&ROLE>', comparePositionTo: () => (hierarchyOk ? -1 : 1) };
  const member = { roles: { cache: new Map(), add: async (r) => { calls.added.push(r.id); member.roles.cache.set(r.id, r); } } };
  const me = { permissions: { has: () => hasManageRoles }, roles: { highest: {} } };
  const perms = (ok = true) => ({ has: () => ok });
  const logChannel = { id: 'LOG', isTextBased: () => true, permissionsFor: () => perms(), toString: () => '<#LOG>', send: async (m) => { calls.sent.push(m); return { id: 'm' }; } };
  const panelMsg = { id: 'PM1', channelId: 'PANEL', url: 'http://msg', edit: async (p) => { calls.edits.push(p); return panelMsg; }, delete: async () => { calls.deleted.push('PM1'); } };
  const panelChannel = { id: 'PANEL', isTextBased: () => true, permissionsFor: () => perms(), toString: () => '<#PANEL>', messages: { fetch: async (id) => { if (id === 'PM1') return panelMsg; throw new Error('Unknown Message'); } }, send: async (p) => { calls.panelSent.push(p); return { id: 'PM2', channelId: 'PANEL', url: 'http://new' }; } };
  const other = { id: 'OTHER', isTextBased: () => true, permissionsFor: () => perms(), toString: () => '<#OTHER>', send: async (p) => { calls.panelSent.push(p); return { id: 'PM3', channelId: 'OTHER', url: 'http://other' }; } };
  const channels = { LOG: logChannel, PANEL: panelChannel, OTHER: other };
  const guild = {
    id: 'G',
    members: { me, fetchMe: async () => me, fetch: async () => { if (memberGone) { const e = new Error('Unknown Member'); e.code = 10007; throw e; } return member; } },
    roles: { everyone: {}, fetch: async (id) => (id === 'ROLE' && roleExists ? role : null) },
    channels: { fetch: async (id) => channels[id] || null }
  };
  const client = {
    guilds: { fetch: async () => guild },
    channels: { fetch: async (id) => { if (!channels[id]) { const e = new Error('Unknown Channel'); e.code = 10003; throw e; } return channels[id]; } },
    users: { fetch: async () => ({ tag: 'juan', username: 'juan' }) },
    on() {}
  };
  const store = { db: { links: {}, codes: {}, meta: {}, config: { ...config } }, save() { calls.saves++; } };
  const service = { isLinked: (id) => linked.includes(id), createCode: (id) => { calls.codes.push(id); return '123456'; }, setOnVerified() {} };
  const v = createVerification({ client, guildId: 'G', store, service });
  return { v, calls, store, member, role };
}

function inter({ cmd, sub, opts = {}, admin = true, button = false, user = '111' } = {}) {
  const out = [];
  return {
    out, guildId: 'G', channelId: 'PANEL', user: { id: user }, customId: VERIFY_BUTTON_ID, commandName: cmd,
    memberPermissions: { has: () => admin },
    isButton: () => button, isChatInputCommand: () => !button,
    options: { getSubcommand: () => sub, getChannel: (n) => opts[n] ?? null, getRole: (n) => opts[n] ?? null },
    deferReply: async () => {}, reply: async (r) => { out.push(r); }, editReply: async (r) => { out.push(r); }
  };
}
const last = (i) => i.out[i.out.length - 1].content;
const evt = { discordId: '111', serial: 'A1B2C3D4E5F60718293A4B5C6D7E8F90', name: 'Juan_Perez', playerId: '12', account: 'juan', linkedAt: 1_800_000_000_000, repeat: false };
const fields = (embed) => Object.fromEntries(embed.data.fields.map((f) => [f.name, f.value]));

test('comandos: /set (log, rol) y /admin-panel, solo admin por defecto', () => {
  const cmds = buildVerificationCommands();
  assert.deepEqual(cmds.map((c) => c.name), ['set', 'admin-panel']);
  assert.deepEqual(cmds[0].options.map((o) => o.name), ['log', 'rol']);
  assert.ok(cmds.every((c) => BigInt(c.default_member_permissions) === 8n));
});

test('panel: titulo y boton Verificar', () => {
  const p = buildPanelPayload();
  assert.equal(p.embeds[0].data.title, 'VERIFICACIÓN NOVARA');
  const btn = p.components[0].components[0].data;
  assert.equal(btn.label, 'Verificar'); assert.equal(btn.custom_id, VERIFY_BUTTON_ID);
});

test('/set log y /set rol: rechazan a no admins y guardan la config', async () => {
  const e = env();
  let i = inter({ cmd: 'set', sub: 'log', opts: { canal: { id: 'LOG' } }, admin: false });
  await e.v.handleInteraction(i); assert.match(last(i), /No tienes permiso/); assert.equal(e.store.db.config.logChannelId, undefined);
  i = inter({ cmd: 'set', sub: 'log', opts: { canal: { id: 'LOG' } } });
  await e.v.handleInteraction(i); assert.equal(e.store.db.config.logChannelId, 'LOG'); assert.match(last(i), /✅/);
  i = inter({ cmd: 'set', sub: 'rol', opts: { rol: { id: 'ROLE' } } });
  await e.v.handleInteraction(i); assert.equal(e.store.db.config.verifiedRoleId, 'ROLE');
});

test('/set rol: rechaza si el rol esta por encima del bot o falta Gestionar roles', async () => {
  let e = env({ hierarchyOk: false });
  let i = inter({ cmd: 'set', sub: 'rol', opts: { rol: { id: 'ROLE' } } });
  await e.v.handleInteraction(i); assert.match(last(i), /por encima/); assert.equal(e.store.db.config.verifiedRoleId, undefined);
  e = env({ hasManageRoles: false });
  i = inter({ cmd: 'set', sub: 'rol', opts: { rol: { id: 'ROLE' } } });
  await e.v.handleInteraction(i); assert.match(last(i), /Gestionar roles/);
});

test('verificacion OK: asigna rol y envia embed con todos los datos', async () => {
  const e = env({ config: { verifiedRoleId: 'ROLE', logChannelId: 'LOG' } });
  await e.v.onVerified(evt);
  assert.deepEqual(e.calls.added, ['ROLE']);
  assert.equal(e.calls.sent.length, 1);
  const embed = e.calls.sent[0].embeds[0];
  assert.match(embed.data.title, /Verificación completada/);
  const f = fields(embed);
  assert.match(f['Discord ID'], /111/); assert.match(f['Jugador en MTA:SA'], /Juan_Perez/); assert.match(f['ID en el servidor'], /12/);
  assert.match(f['Serial de MTA:SA'], /A1B2C3D4E5F60718293A4B5C6D7E8F90/); assert.match(f['Rol asignado'], /ROLE/);
  assert.match(f['Fecha y hora'], /<t:1800000000:F>/); assert.match(f['Resultado de la vinculación'], /confirmada/);
  assert.deepEqual(e.calls.sent[0].allowedMentions, { parse: [] });
});

test('si falla el rol NO se afirma que se completo: embed de aviso con el error', async () => {
  const e = env({ hierarchyOk: false, config: { verifiedRoleId: 'ROLE', logChannelId: 'LOG' } });
  await e.v.onVerified(evt);
  assert.equal(e.calls.added.length, 0);
  const embed = e.calls.sent[0].embeds[0];
  assert.doesNotMatch(embed.data.title, /^✅/); assert.match(embed.data.title, /rol no se asignó/);
  assert.match(fields(embed)['Resultado de la vinculación'], /falló la asignación/);
});

test('rol borrado / usuario fuera del servidor / sin rol configurado: aviso, no exito', async () => {
  let e = env({ roleExists: false, config: { verifiedRoleId: 'ROLE', logChannelId: 'LOG' } });
  await e.v.onVerified(evt); assert.match(fields(e.calls.sent[0].embeds[0])['Resultado de la vinculación'], /ya no existe/);
  e = env({ memberGone: true, config: { verifiedRoleId: 'ROLE', logChannelId: 'LOG' } });
  await e.v.onVerified(evt); assert.match(fields(e.calls.sent[0].embeds[0])['Resultado de la vinculación'], /ya no está/);
  e = env({ config: { logChannelId: 'LOG' } });
  await e.v.onVerified(evt); assert.match(e.calls.sent[0].embeds[0].data.title, /falta configurar|rol no se asignó/);
});

test('canal de logs borrado o sin configurar: no revienta', async () => {
  let e = env({ config: { verifiedRoleId: 'ROLE', logChannelId: 'NOEXISTE' } });
  await e.v.onVerified(evt); assert.deepEqual(e.calls.added, ['ROLE']);
  e = env({ config: { verifiedRoleId: 'ROLE' } });
  await e.v.onVerified(evt); assert.equal(e.calls.sent.length, 0);
});

test('repeat: no duplica el log si no cambio nada; si el rol era nuevo, si registra', async () => {
  const e = env({ config: { verifiedRoleId: 'ROLE', logChannelId: 'LOG' } });
  await e.v.onVerified({ ...evt, repeat: true }); assert.equal(e.calls.sent.length, 1); // rol nuevo -> log
  await e.v.onVerified({ ...evt, repeat: true }); assert.equal(e.calls.sent.length, 1); // ya lo tenia -> nada
});

test('boton: no vinculado -> codigo (reutiliza createCode) y NO da rol; cooldown anti-spam', async () => {
  const e = env({ config: { verifiedRoleId: 'ROLE' } });
  let i = inter({ button: true });
  await e.v.handleInteraction(i);
  assert.match(last(i), /\/vincular 123456/); assert.equal(e.calls.added.length, 0); assert.deepEqual(e.calls.codes, ['111']);
  i = inter({ button: true });
  await e.v.handleInteraction(i);
  assert.match(last(i), /Espera/); assert.equal(e.calls.codes.length, 1);
});

test('boton: ya vinculado -> informa y sincroniza el rol si faltaba', async () => {
  const e = env({ linked: ['111'], config: { verifiedRoleId: 'ROLE' } });
  let i = inter({ button: true });
  await e.v.handleInteraction(i); assert.match(last(i), /ya estaba vinculada/); assert.deepEqual(e.calls.added, ['ROLE']);
  i = inter({ button: true });
  await e.v.handleInteraction(i); assert.match(last(i), /ya está vinculada/); assert.equal(e.calls.added.length, 1);
  assert.equal(e.calls.codes.length, 0);
});

test('boton: interaccion caducada no lanza error', async () => {
  const e = env();
  const i = inter({ button: true });
  i.deferReply = async () => { const x = new Error('Unknown interaction'); x.code = 10062; throw x; };
  assert.equal(await e.v.handleInteraction(i), true);
});

test('/admin-panel: publica, luego edita (sin duplicar) y mueve si cambia el canal', async () => {
  const e = env({ config: { verifiedRoleId: 'ROLE', logChannelId: 'LOG' } });
  let i = inter({ cmd: 'admin-panel', admin: false });
  await e.v.handleInteraction(i); assert.match(last(i), /No tienes permiso/); assert.equal(e.calls.panelSent.length, 0);
  i = inter({ cmd: 'admin-panel' });
  await e.v.handleInteraction(i);
  assert.equal(e.calls.panelSent.length, 1); assert.deepEqual(e.store.db.config.panel, { channelId: 'PANEL', messageId: 'PM2' });
  // el panel guardado ya no existe (PM2 no se encuentra) -> se publica de nuevo, sin romper
  i = inter({ cmd: 'admin-panel' }); await e.v.handleInteraction(i); assert.equal(e.calls.panelSent.length, 2);
  // panel existente (PM1) en el mismo canal -> se edita
  e.store.db.config.panel = { channelId: 'PANEL', messageId: 'PM1' };
  i = inter({ cmd: 'admin-panel' }); await e.v.handleInteraction(i);
  assert.equal(e.calls.edits.length, 1); assert.equal(e.calls.panelSent.length, 2); assert.match(last(i), /actualizado/);
  // otro canal -> se publica ahi y se borra el anterior
  i = inter({ cmd: 'admin-panel', opts: { canal: { id: 'OTHER' } } }); await e.v.handleInteraction(i);
  assert.deepEqual(e.calls.deleted, ['PM1']); assert.equal(e.store.db.config.panel.channelId, 'OTHER');
});

test('interacciones ajenas no son de este modulo', async () => {
  const e = env();
  assert.equal(await e.v.handleInteraction(inter({ cmd: 'vincular' })), false);
  const b = inter({ button: true }); b.customId = 'otro';
  assert.equal(await e.v.handleInteraction(b), false);
});
