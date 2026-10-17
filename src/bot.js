'use strict';
const {
  Client, GatewayIntentBits, Events, REST, Routes, SlashCommandBuilder,
  PermissionFlagsBits, MessageFlags
} = require('discord.js');
const { createVerification, buildVerificationCommands } = require('./verification');

const EPHEMERAL = { flags: MessageFlags.Ephemeral };

function buildCommands() {
  return [
    new SlashCommandBuilder().setName('vincular').setDescription('Genera un codigo para vincular tu Discord con tu cuenta de MTA'),
    new SlashCommandBuilder().setName('desvincular').setDescription('Quita la vinculacion de tu Discord (por ejemplo, si cambiaste de PC)'),
    new SlashCommandBuilder()
      .setName('admin-desvincular')
      .setDescription('Admin: quita la vinculacion de un usuario')
      .addUserOption((o) => o.setName('usuario').setDescription('Usuario a desvincular').setRequired(true))
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  ].map((c) => c.toJSON()).concat(buildVerificationCommands());
}

async function startBot({ token, clientId, guildId, service, store }) {
  const rest = new REST({ version: '10' }).setToken(token);
  await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: buildCommands() });

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  client.once(Events.ClientReady, (c) => console.log(`Bot de Discord conectado como ${c.user.tag}`));

  // Verificacion MTA + Discord: /set log, /set rol, /admin-panel, boton Verificar, rol automatico y logs.
  const verification = createVerification({ client, guildId, store, service });
  service.setOnVerified(verification.onVerified);
  verification.registerCleanup();

  client.on(Events.InteractionCreate, async (i) => {
    try {
      if (i.isButton()) {
        if (i.guildId !== guildId) return i.reply({ content: 'Usa este boton dentro del Discord oficial.', ...EPHEMERAL });
        await verification.handleInteraction(i);
        return;
      }
      if (!i.isChatInputCommand()) return;
      if (i.guildId !== guildId) return i.reply({ content: 'Usa este comando dentro del Discord oficial.', ...EPHEMERAL });
      if (await verification.handleInteraction(i)) return;

      if (i.commandName === 'vincular') {
        const code = service.createCode(i.user.id);
        return i.reply({
          content: `Tu codigo es: **${code}**\nEntra a MTA y escribe: **/vincular ${code}**\nCaduca en 5 minutos. No lo compartas.`,
          ...EPHEMERAL
        });
      }
      if (i.commandName === 'desvincular') {
        const n = service.unlinkDiscord(i.user.id);
        return i.reply({ content: n ? 'Listo, tu Discord ya no esta vinculado. Usa /vincular para vincularlo de nuevo.' : 'No tenias ninguna vinculacion.', ...EPHEMERAL });
      }
      if (i.commandName === 'admin-desvincular') {
        if (!i.memberPermissions?.has(PermissionFlagsBits.Administrator)) return i.reply({ content: 'No tienes permiso.', ...EPHEMERAL });
        const target = i.options.getUser('usuario', true);
        const n = service.unlinkDiscord(target.id);
        return i.reply({ content: n ? `Vinculacion de <@${target.id}> eliminada.` : `<@${target.id}> no tenia vinculacion.`, ...EPHEMERAL });
      }
    } catch (e) {
      console.error('Error en interaccion:', e);
      if (i.isRepliable() && !i.replied && !i.deferred) i.reply({ content: 'Ocurrio un error. Intenta de nuevo.', ...EPHEMERAL }).catch(() => {});
    }
  });

  await client.login(token);
  return client;
}

// Comprueba contra la API de Discord si el usuario esta en el servidor (y tiene el rol, si se exige).
function makeMemberCheck({ token, guildId, requiredRoleId }) {
  return async function isAllowedMember(userId) {
    const r = await fetch(`https://discord.com/api/v10/guilds/${guildId}/members/${userId}`, {
      headers: { Authorization: `Bot ${token}` },
      signal: AbortSignal.timeout(8000)
    });
    if (r.status === 404) return false;
    if (!r.ok) throw new Error(`Discord API respondio ${r.status}`);
    if (!requiredRoleId) return true;
    const member = await r.json();
    return Array.isArray(member.roles) && member.roles.includes(requiredRoleId);
  };
}

module.exports = { startBot, makeMemberCheck };
