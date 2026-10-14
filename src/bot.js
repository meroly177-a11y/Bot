'use strict';
const {
  Client, GatewayIntentBits, Events, REST, Routes, SlashCommandBuilder, PermissionFlagsBits,
  MessageFlags, ActivityType, ActionRowBuilder, ButtonBuilder, ButtonStyle
} = require('discord.js');

const EPHEMERAL = { flags: MessageFlags.Ephemeral };
const NO_PINGS = { parse: [] };
const BUTTON_ID = 'mta_vincular_btn';

const DEFAULT_LINK_LOG =
  '✅ **Nuevo jugador vinculado**\n👤 Discord: {mention} (`{tag}`)\n🎮 Nombre en el servidor: **{name}**\n📅 Fecha: {date}\n🔢 Vinculados en total: **{count}**';
const DEFAULT_UNLINK_LOG = '❌ {mention} (`{tag}`) se desvinculó. Nombre en el servidor: **{name}** • {date}';

// Reemplaza {variables}. Acepta "\n" literal en las plantillas del .env.
function fmt(template, vars) {
  return String(template).replace(/\\n/g, '\n').replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

function buildCommands() {
  const admin = PermissionFlagsBits.Administrator;
  return [
    new SlashCommandBuilder().setName('vincular').setDescription('Genera un código para vincular tu Discord con tu cuenta de MTA'),
    new SlashCommandBuilder().setName('desvincular').setDescription('Quita tu vinculación (por ejemplo, si cambiaste de PC)'),
    new SlashCommandBuilder().setName('estado').setDescription('Mira si tu Discord está vinculado y con qué nombre'),
    new SlashCommandBuilder().setName('admin-desvincular').setDescription('Admin: quita la vinculación de un usuario')
      .addUserOption((o) => o.setName('usuario').setDescription('Usuario').setRequired(true)).setDefaultMemberPermissions(admin),
    new SlashCommandBuilder().setName('admin-info').setDescription('Admin: datos de vinculación de un usuario')
      .addUserOption((o) => o.setName('usuario').setDescription('Usuario').setRequired(true)).setDefaultMemberPermissions(admin),
    new SlashCommandBuilder().setName('admin-lista').setDescription('Admin: últimos jugadores vinculados').setDefaultMemberPermissions(admin),
    new SlashCommandBuilder().setName('admin-panel').setDescription('Admin: publica en este canal un panel con botón para vincular').setDefaultMemberPermissions(admin)
  ].map((c) => c.toJSON());
}

/**
 * Logica del bot (sin conectarse a Discord, para poder probarla).
 * options: { linkedRoleId, logChannelId, nicknameFormat, linkLogFormat, unlinkLogFormat }
 */
function createBotLogic({ client, guildId, service, options = {} }) {
  const o = {
    linkedRoleId: options.linkedRoleId || '',
    logChannelId: options.logChannelId || '',
    nicknameFormat: options.nicknameFormat || '{name}',
    linkLogFormat: options.linkLogFormat || DEFAULT_LINK_LOG,
    unlinkLogFormat: options.unlinkLogFormat || DEFAULT_UNLINK_LOG
  };
  const unix = (ms) => Math.floor((ms || Date.now()) / 1000);

  async function fetchMember(discordId) {
    const guild = await client.guilds.fetch(guildId);
    return guild.members.fetch(discordId);
  }

  async function sendLog(text) {
    if (!o.logChannelId) return;
    try {
      const ch = await client.channels.fetch(o.logChannelId);
      await ch.send({ content: text, allowedMentions: NO_PINGS });
    } catch (e) { console.error('No pude enviar el log al canal:', e.message); }
  }

  async function setNickname(member, name) {
    if (!name) return;
    const nick = fmt(o.nicknameFormat, { name }).slice(0, 32);
    if (member.nickname === nick) return;
    try { await member.setNickname(nick, 'Nombre en el servidor de MTA'); }
    catch (e) { console.error(`No pude cambiar el apodo de ${member.id}: ${e.message} (¿rol del bot por encima del usuario y permiso Gestionar apodos? el dueño del server no se puede renombrar)`); }
  }

  async function onLinked({ discordId, name, count }) {
    try {
      const member = await fetchMember(discordId);
      if (o.linkedRoleId) {
        try { await member.roles.add(o.linkedRoleId, 'Vinculado con MTA'); }
        catch (e) { console.error(`No pude dar el rol: ${e.message} (el rol del bot debe estar POR ENCIMA del rol vinculado y tener Gestionar roles)`); }
      }
      await setNickname(member, name);
    } catch (e) { console.error('onLinked:', e.message); }
    let tag = discordId;
    try { tag = (await client.users.fetch(discordId)).username; } catch { /* usa el id */ }
    await sendLog(fmt(o.linkLogFormat, { mention: `<@${discordId}>`, tag, discordId, name: name || 'Sin nombre', date: `<t:${unix()}:f>`, count }));
  }

  async function onNameChanged({ discordId, name }) {
    try { await setNickname(await fetchMember(discordId), name); }
    catch (e) { console.error('onNameChanged:', e.message); }
  }

  async function onUnlinked(discordId, info) {
    try {
      if (o.linkedRoleId) { const m = await fetchMember(discordId); await m.roles.remove(o.linkedRoleId, 'Desvinculado de MTA'); }
    } catch (e) { console.error('No pude quitar el rol:', e.message); }
    let tag = discordId;
    try { tag = (await client.users.fetch(discordId)).username; } catch { /* usa el id */ }
    await sendLog(fmt(o.unlinkLogFormat, { mention: `<@${discordId}>`, tag, discordId, name: info?.name || 'Sin nombre', date: `<t:${unix()}:f>`, count: service.listLinked().length }));
  }

  const codeMessage = (code) => ({
    content: `Tu código es: **${code}**\nEntra a MTA y escribe: **/vincular ${code}**\nCaduca en 5 minutos. No lo compartas.`, ...EPHEMERAL
  });

  async function handleInteraction(i) {
    if (i.guildId !== guildId) return i.reply({ content: 'Usa esto dentro del Discord oficial.', ...EPHEMERAL });

    if (i.isButton()) {
      if (i.customId === BUTTON_ID) return i.reply(codeMessage(service.createCode(i.user.id)));
      return;
    }
    if (!i.isChatInputCommand()) return;
    const isAdmin = i.memberPermissions?.has(PermissionFlagsBits.Administrator);
    const adminOnly = () => i.reply({ content: 'No tienes permiso.', ...EPHEMERAL });

    switch (i.commandName) {
      case 'vincular':
        return i.reply(codeMessage(service.createCode(i.user.id)));

      case 'estado': {
        const info = service.getInfo(i.user.id);
        if (!info) return i.reply({ content: 'No estás vinculado. Usa /vincular.', ...EPHEMERAL });
        return i.reply({ content: `✅ Vinculado como **${info.name || 'sin nombre aún'}**${info.linkedAt ? ` desde <t:${unix(info.linkedAt)}:R>` : ''}.`, ...EPHEMERAL });
      }

      case 'desvincular': {
        const info = service.getInfo(i.user.id);
        const n = service.unlinkDiscord(i.user.id);
        if (!n) return i.reply({ content: 'No tenías ninguna vinculación.', ...EPHEMERAL });
        await i.reply({ content: 'Listo, tu Discord ya no está vinculado. Usa /vincular para vincularlo de nuevo.', ...EPHEMERAL });
        return onUnlinked(i.user.id, info);
      }

      case 'admin-desvincular': {
        if (!isAdmin) return adminOnly();
        const t = i.options.getUser('usuario', true);
        const info = service.getInfo(t.id);
        const n = service.unlinkDiscord(t.id);
        await i.reply({ content: n ? `Vinculación de <@${t.id}> eliminada.` : `<@${t.id}> no tenía vinculación.`, allowedMentions: NO_PINGS, ...EPHEMERAL });
        if (n) await onUnlinked(t.id, info);
        return;
      }

      case 'admin-info': {
        if (!isAdmin) return adminOnly();
        const t = i.options.getUser('usuario', true);
        const info = service.getInfo(t.id);
        if (!info) return i.reply({ content: `<@${t.id}> no está vinculado.`, allowedMentions: NO_PINGS, ...EPHEMERAL });
        return i.reply({
          content: `👤 <@${t.id}>\n🎮 Nombre: **${info.name || 'sin nombre'}**\n🔑 Serial: \`${info.serial}\`${info.linkedAt ? `\n📅 Vinculado: <t:${unix(info.linkedAt)}:f>` : ''}`,
          allowedMentions: NO_PINGS, ...EPHEMERAL
        });
      }

      case 'admin-lista': {
        if (!isAdmin) return adminOnly();
        const rows = service.listLinked();
        const lines = rows.slice(0, 20).map((r) => `• <@${r.discordId}> — **${r.name || 'sin nombre'}**`);
        return i.reply({ content: `**${rows.length}** vinculados${rows.length ? ' (últimos 20):\n' + lines.join('\n') : '.'}`, allowedMentions: NO_PINGS, ...EPHEMERAL });
      }

      case 'admin-panel': {
        if (!isAdmin) return adminOnly();
        const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(BUTTON_ID).setLabel('Vincular mi cuenta de MTA').setStyle(ButtonStyle.Success));
        await i.channel.send({ content: '🎮 **Vinculación con el servidor**\nPulsa el botón, copia tu código y escribe en MTA: `/vincular CODIGO`.', components: [row] });
        return i.reply({ content: 'Panel publicado.', ...EPHEMERAL });
      }
    }
  }

  return { onLinked, onNameChanged, onUnlinked, handleInteraction };
}

async function startBot({ token, clientId, guildId, service, options }) {
  const rest = new REST({ version: '10' }).setToken(token);
  await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: buildCommands() });

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  const logic = createBotLogic({ client, guildId, service, options });

  client.once(Events.ClientReady, (c) => {
    console.log(`Bot de Discord conectado como ${c.user.tag}`);
    c.user.setPresence({ activities: [{ name: '/vincular para jugar', type: ActivityType.Playing }], status: 'online' });
  });
  client.on(Events.InteractionCreate, async (i) => {
    try { await logic.handleInteraction(i); }
    catch (e) {
      console.error('Error en interacción:', e);
      if (i.isRepliable() && !i.replied && !i.deferred) i.reply({ content: 'Ocurrió un error. Intenta de nuevo.', ...EPHEMERAL }).catch(() => {});
    }
  });

  await client.login(token);
  return { client, ...logic };
}

// Comprueba contra la API de Discord si el usuario está en el servidor (y tiene el rol, si se exige).
function makeMemberCheck({ token, guildId, requiredRoleId }) {
  return async function isAllowedMember(userId) {
    const r = await fetch(`https://discord.com/api/v10/guilds/${guildId}/members/${userId}`, {
      headers: { Authorization: `Bot ${token}` },
      signal: AbortSignal.timeout(8000)
    });
    if (r.status === 404) return false;
    if (!r.ok) throw new Error(`Discord API respondió ${r.status}`);
    if (!requiredRoleId) return true;
    const member = await r.json();
    return Array.isArray(member.roles) && member.roles.includes(requiredRoleId);
  };
}

module.exports = { startBot, makeMemberCheck, createBotLogic, buildCommands, fmt };
