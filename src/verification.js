'use strict';
const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType,
  PermissionFlagsBits, SlashCommandBuilder, MessageFlags, Events
} = require('discord.js');

const EPHEMERAL = { flags: MessageFlags.Ephemeral };
const NO_PINGS = { parse: [] };
const VERIFY_BUTTON_ID = 'novara_verificar';
const BRAND_COLOR = 0x8b5cf6;
const OK_COLOR = 0x57f287;
const WARN_COLOR = 0xfee75c;
const CLICK_COOLDOWN_MS = 10_000;

// Permisos que necesita el bot para escribir embeds en un canal.
const SEND_PERMS = [
  [PermissionFlagsBits.ViewChannel, 'Ver canal'],
  [PermissionFlagsBits.SendMessages, 'Enviar mensajes'],
  [PermissionFlagsBits.EmbedLinks, 'Insertar enlaces']
];

const code = (v) => `\`${String(v).replace(/`/g, "'")}\``;

// ---------------------------------------------------------------- comandos
function buildVerificationCommands() {
  const admin = PermissionFlagsBits.Administrator;
  const textTypes = [ChannelType.GuildText, ChannelType.GuildAnnouncement];
  return [
    new SlashCommandBuilder()
      .setName('set')
      .setDescription('Admin: configura la verificacion')
      .addSubcommand((s) => s.setName('log').setDescription('Canal donde se envian los logs de verificacion')
        .addChannelOption((o) => o.setName('canal').setDescription('Canal de texto para los logs').addChannelTypes(...textTypes).setRequired(true)))
      .addSubcommand((s) => s.setName('rol').setDescription('Rol que reciben los jugadores al verificarse')
        .addRoleOption((o) => o.setName('rol').setDescription('Rol de verificado').setRequired(true)))
      .setDefaultMemberPermissions(admin),
    new SlashCommandBuilder()
      .setName('admin-panel')
      .setDescription('Admin: publica el panel de verificacion (boton Verificar)')
      .addChannelOption((o) => o.setName('canal').setDescription('Canal donde publicarlo (por defecto, este)').addChannelTypes(...textTypes))
      .setDefaultMemberPermissions(admin)
  ].map((c) => c.toJSON());
}

// ---------------------------------------------------------------- panel
function buildPanelPayload() {
  const embed = new EmbedBuilder()
    .setColor(BRAND_COLOR)
    .setTitle('VERIFICACIÓN NOVARA')
    .setDescription([
      'Bienvenido a nuestro servidor de MTA:SA. Para acceder y disfrutar de la comunidad, debes vincular tu cuenta de Discord con tu cuenta del servidor.',
      'Pulsa el botón de abajo para comenzar el proceso de verificación y sigue las instrucciones indicadas.',
      'Una vez completado correctamente, recibirás el rol correspondiente en Discord.'
    ].join('\n\n'))
    .setFooter({ text: 'NOVARA • Verificación MTA:SA' });
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(VERIFY_BUTTON_ID).setLabel('Verificar').setEmoji('✅').setStyle(ButtonStyle.Success)
  );
  return { embeds: [embed], components: [row] };
}

/**
 * client, guildId, store ({ db, save }), service (createApi: createCode / isLinked / setOnVerified)
 * Devuelve { handleInteraction, onVerified, assignVerifiedRole, registerCleanup }.
 */
function createVerification({ client, guildId, store, service, now = Date.now }) {
  const cfg = () => (store.db.config = store.db.config || {});
  const inFlight = new Set();   // usuarios con una pulsacion en curso
  const lastCode = new Map();   // discordId -> ms del ultimo codigo generado (anti-spam del boton)

  const getGuild = () => client.guilds.fetch(guildId);
  const getMe = async (guild) => guild.members.me || guild.members.fetchMe();
  const isAdmin = (i) => i.memberPermissions?.has(PermissionFlagsBits.Administrator) === true;
  const missingSendPerms = (channel, me) => {
    const perms = channel.permissionsFor?.(me);
    return SEND_PERMS.filter(([bit]) => !perms?.has(bit)).map(([, label]) => label);
  };

  // Responder dentro de los 3 s; si la interaccion ya caduco, se ignora sin romper el bot.
  async function ack(i) {
    try { await i.deferReply(EPHEMERAL); return true; }
    catch (e) { console.warn('[interaccion] caducada o ya respondida:', e.code || e.message); return false; }
  }
  const say = (i, content) => i.editReply({ content, allowedMentions: NO_PINGS })
    .catch((e) => console.warn('[interaccion] no pude responder:', e.code || e.message));

  // ------------------------------------------------------------ rol
  async function roleProblem(guild, role) {
    if (role.id === guild.id) return 'No puedes usar @everyone como rol de verificado.';
    if (role.managed) return 'Ese rol lo gestiona una integración o bot y no se puede asignar a mano.';
    const me = await getMe(guild);
    if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) return 'Me falta el permiso **Gestionar roles**.';
    if (role.comparePositionTo(me.roles.highest) >= 0) return 'Mi rol más alto debe estar **por encima** del rol de verificado (Ajustes del servidor → Roles).';
    return null;
  }

  // status: 'added' | 'already' | 'not_configured' | 'error'
  async function assignVerifiedRole(discordId, reason) {
    const roleId = cfg().verifiedRoleId;
    if (!roleId) return { status: 'not_configured' };
    try {
      const guild = await getGuild();
      const role = await guild.roles.fetch(roleId);
      if (!role) return { status: 'error', roleId, error: 'El rol configurado ya no existe. Usa /set rol.' };
      const problem = await roleProblem(guild, role);
      if (problem) return { status: 'error', roleId, error: problem };
      let member;
      try { member = await guild.members.fetch(discordId); }
      catch (e) {
        if (e.code === 10007) return { status: 'error', roleId, error: 'El usuario ya no está en el servidor de Discord.' };
        throw e;
      }
      if (member.roles.cache.has(roleId)) return { status: 'already', roleId };
      await member.roles.add(role, reason);
      return { status: 'added', roleId };
    } catch (e) {
      console.error('[rol] no se pudo asignar el rol:', e.code || e.message);
      return { status: 'error', roleId, error: `Discord rechazó la operación (${e.code || e.message}).` };
    }
  }

  // ------------------------------------------------------------ logs
  async function sendLog(payload) {
    const chId = cfg().logChannelId;
    if (!chId) { console.warn('[log] no hay canal de logs configurado (/set log).'); return false; }
    try {
      const ch = await client.channels.fetch(chId);
      await ch.send({ ...payload, allowedMentions: NO_PINGS });
      return true;
    } catch (e) {
      console.error(`[log] no pude enviar al canal ${chId}:`, e.code || e.message);
      return false;
    }
  }

  function buildLogEmbed(evt, role, user) {
    const ok = role.status === 'added' || role.status === 'already';
    const unix = Math.floor((evt.linkedAt || now()) / 1000);
    const roleText = {
      added: `<@&${role.roleId}>`,
      already: `<@&${role.roleId}> (ya lo tenía)`,
      not_configured: 'No configurado (usa /set rol)',
      error: 'No se pudo asignar'
    }[role.status];
    const result = ok
      ? '✅ Vinculación MTA:SA ↔ Discord confirmada por el servidor.'
      : role.status === 'not_configured'
        ? '⚠️ Vinculación confirmada, pero no hay rol de verificado configurado.'
        : `❌ Vinculación confirmada, pero falló la asignación del rol: ${role.error}`;
    const fields = [
      { name: 'Estado', value: ok ? 'Verificación completada' : 'Vinculada, rol sin asignar', inline: true },
      { name: 'Usuario de Discord', value: `<@${evt.discordId}> (${code(user?.tag || user?.username || 'desconocido')})`, inline: true },
      { name: 'Discord ID', value: code(evt.discordId), inline: true },
      { name: 'Jugador en MTA:SA', value: evt.name ? code(evt.name) : 'No disponible', inline: true },
      { name: 'ID en el servidor', value: evt.playerId ? code(evt.playerId) : 'No disponible', inline: true }
    ];
    if (evt.account) fields.push({ name: 'Cuenta MTA', value: code(evt.account), inline: true });
    fields.push(
      { name: 'Serial de MTA:SA', value: code(evt.serial) },
      { name: 'Fecha y hora', value: `<t:${unix}:F> (<t:${unix}:R>)`, inline: true },
      { name: 'Rol asignado', value: roleText, inline: true },
      { name: 'Resultado de la vinculación', value: result }
    );
    return new EmbedBuilder()
      .setColor(ok ? OK_COLOR : WARN_COLOR)
      .setTitle(ok ? '✅ Verificación completada' : '⚠️ Vinculación completada, pero el rol no se asignó')
      .addFields(fields)
      .setFooter({ text: 'NOVARA • Registro de verificación' })
      .setTimestamp(unix * 1000);
  }

  // La API lo llama una sola vez por cada codigo canjeado (la API ya valido codigo, miembro y unicidad).
  async function onVerified(evt) {
    const role = await assignVerifiedRole(evt.discordId, 'Verificación MTA:SA completada');
    // Misma vinculacion confirmada otra vez: solo se registra si de verdad cambio algo (rol nuevo) o fallo.
    if (evt.repeat && (role.status === 'already' || role.status === 'not_configured')) return;
    const user = await client.users.fetch(evt.discordId).catch(() => null);
    await sendLog({ embeds: [buildLogEmbed(evt, role, user)] });
  }

  // ------------------------------------------------------------ /set
  async function setLog(i, guild) {
    const picked = i.options.getChannel('canal', true);
    const channel = await guild.channels.fetch(picked.id).catch(() => null);
    if (!channel || !channel.isTextBased() || typeof channel.send !== 'function') return say(i, '❌ Ese canal no es válido o no puedo verlo.');
    const missing = missingSendPerms(channel, await getMe(guild));
    if (missing.length) return say(i, `❌ No puedo enviar logs en ${channel}. Me faltan estos permisos: **${missing.join(', ')}**.`);
    cfg().logChannelId = channel.id;
    store.save();
    let msg = `✅ Canal de logs configurado: ${channel}`;
    if (channel.permissionsFor(guild.roles.everyone)?.has(PermissionFlagsBits.ViewChannel)) {
      msg += '\n⚠️ Este canal lo puede ver cualquiera y los logs incluyen el serial de MTA. Te recomiendo un canal solo para staff.';
    }
    return say(i, msg);
  }

  async function setRole(i, guild) {
    const picked = i.options.getRole('rol', true);
    const role = await guild.roles.fetch(picked.id).catch(() => null);
    if (!role) return say(i, '❌ No encuentro ese rol.');
    const problem = await roleProblem(guild, role);
    if (problem) return say(i, `❌ ${problem}`);
    cfg().verifiedRoleId = role.id;
    store.save();
    return say(i, `✅ Rol de verificado configurado: ${role}\nSe asignará automáticamente cuando un jugador complete la verificación.`);
  }

  async function onSet(i) {
    if (!isAdmin(i)) return i.reply({ content: 'No tienes permiso para usar este comando.', ...EPHEMERAL });
    if (!(await ack(i))) return;
    try {
      const guild = await getGuild();
      const sub = i.options.getSubcommand();
      if (sub === 'log') return await setLog(i, guild);
      if (sub === 'rol') return await setRole(i, guild);
      return await say(i, 'Subcomando desconocido.');
    } catch (e) {
      console.error('[set] error:', e);
      return say(i, '❌ Ocurrió un error al guardar la configuración. Inténtalo de nuevo.');
    }
  }

  // ------------------------------------------------------------ /admin-panel
  async function onAdminPanel(i) {
    if (!isAdmin(i)) return i.reply({ content: 'No tienes permiso para usar este comando.', ...EPHEMERAL });
    if (!(await ack(i))) return;
    try {
      const guild = await getGuild();
      const picked = i.options.getChannel('canal');
      const target = await guild.channels.fetch(picked ? picked.id : i.channelId).catch(() => null);
      if (!target || !target.isTextBased() || typeof target.send !== 'function') return await say(i, '❌ No puedo publicar el panel en ese canal.');
      const missing = missingSendPerms(target, await getMe(guild));
      if (missing.length) return await say(i, `❌ No puedo publicar en ${target}. Me faltan estos permisos: **${missing.join(', ')}**.`);

      // Panel ya publicado antes? (sin duplicados: se edita en el sitio, o se mueve si cambia el canal)
      const saved = cfg().panel;
      let existing = null;
      if (saved?.channelId && saved?.messageId) {
        const oldCh = await guild.channels.fetch(saved.channelId).catch(() => null);
        existing = oldCh?.isTextBased?.() ? await oldCh.messages.fetch(saved.messageId).catch(() => null) : null;
      }

      let msg;
      let verb;
      if (existing && existing.channelId === target.id) {
        msg = await existing.edit(buildPanelPayload());
        verb = 'actualizado (ya existía en ese canal, no se publicó otro)';
      } else {
        msg = await target.send(buildPanelPayload());
        if (existing) await existing.delete().catch(() => {});
        verb = existing ? 'movido al nuevo canal (se borró el anterior)' : 'publicado';
      }
      cfg().panel = { channelId: target.id, messageId: msg.id };
      store.save();

      let out = `✅ Panel ${verb}: ${msg.url}`;
      if (!cfg().verifiedRoleId) out += '\n⚠️ Falta configurar el rol con `/set rol`: sin él, los jugadores se vincularán pero no recibirán rol.';
      if (!cfg().logChannelId) out += '\n⚠️ Falta configurar el canal de logs con `/set log`.';
      return await say(i, out);
    } catch (e) {
      console.error('[admin-panel] error:', e);
      return say(i, '❌ No pude publicar el panel. Revisa mis permisos en el canal e inténtalo de nuevo.');
    }
  }

  // ------------------------------------------------------------ boton Verificar
  async function onVerifyButton(i) {
    if (!(await ack(i))) return;
    const id = i.user.id;
    if (inFlight.has(id)) return say(i, 'Ya estoy procesando tu solicitud. Espera unos segundos.');
    inFlight.add(id);
    try {
      // Ya vinculado (confirmado antes por el servidor MTA): no hay nada que verificar de nuevo.
      if (service.isLinked(id)) {
        const r = await assignVerifiedRole(id, 'Verificación desde el panel (cuenta ya vinculada)');
        if (r.status === 'added') return await say(i, '✅ Tu cuenta ya estaba vinculada. Te acabo de asignar el rol de verificado.');
        if (r.status === 'error') {
          console.error('[verificar] usuario vinculado pero sin rol:', r.error);
          return await say(i, 'Tu cuenta ya está vinculada, pero no pude asignarte el rol. Avisa a un administrador.');
        }
        return await say(i, '✅ Tu cuenta ya está vinculada. No necesitas hacer nada más.');
      }

      const wait = (lastCode.get(id) || 0) + CLICK_COOLDOWN_MS - now();
      if (wait > 0) return await say(i, `Acabas de pedir un código. Espera ${Math.ceil(wait / 1000)} s para pedir otro (el anterior sigue siendo válido).`);

      const c = service.createCode(id);
      lastCode.set(id, now());
      setTimeout(() => lastCode.delete(id), CLICK_COOLDOWN_MS).unref?.();
      return await say(i, [
        '**Para verificarte sigue estos pasos:**',
        '1. Entra al servidor de MTA:SA.',
        `2. Escribe en el chat del juego: **/vincular ${c}**`,
        '3. Cuando el servidor lo confirme, recibirás el rol aquí en Discord automáticamente.',
        '',
        'Tu código caduca en 5 minutos. No lo compartas con nadie.'
      ].join('\n'));
    } catch (e) {
      console.error('[verificar] error:', e);
      return say(i, 'Ocurrió un error. Inténtalo de nuevo en unos segundos.');
    } finally {
      inFlight.delete(id);
    }
  }

  // true si la interaccion era de este modulo
  async function handleInteraction(i) {
    if (i.isButton()) {
      if (i.customId !== VERIFY_BUTTON_ID) return false;
      await onVerifyButton(i);
      return true;
    }
    if (i.isChatInputCommand()) {
      if (i.commandName === 'set') { await onSet(i); return true; }
      if (i.commandName === 'admin-panel') { await onAdminPanel(i); return true; }
    }
    return false;
  }

  // Si borran el canal de logs, el del panel o el rol, se limpia la config (y se avisa en consola).
  function registerCleanup() {
    client.on(Events.ChannelDelete, (ch) => {
      if (ch.guildId !== guildId) return;
      const c = cfg();
      let dirty = false;
      if (c.logChannelId === ch.id) { delete c.logChannelId; dirty = true; console.warn('[config] se borró el canal de logs: usa /set log.'); }
      if (c.panel?.channelId === ch.id) { delete c.panel; dirty = true; console.warn('[config] se borró el canal del panel: usa /admin-panel.'); }
      if (dirty) store.save();
    });
    client.on(Events.GuildRoleDelete, (role) => {
      if (role.guild?.id !== guildId || cfg().verifiedRoleId !== role.id) return;
      delete cfg().verifiedRoleId;
      store.save();
      console.warn('[config] se borró el rol de verificado: usa /set rol.');
    });
  }

  return { handleInteraction, onVerified, assignVerifiedRole, registerCleanup };
}

module.exports = { createVerification, buildVerificationCommands, buildPanelPayload, VERIFY_BUTTON_ID };
