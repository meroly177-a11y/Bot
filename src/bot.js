'use strict';

const {
  Client,
  GatewayIntentBits,
  Events,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags
} = require('discord.js');

const {
  createVerification,
  buildVerificationCommands
} = require('./verification');

const EPHEMERAL = {
  flags: MessageFlags.Ephemeral
};

// ======================================================
// COMANDOS DE NOVARA
// ======================================================

function buildCommands() {
  return [
    new SlashCommandBuilder()
      .setName('vincular')
      .setDescription(
        'Genera un codigo para vincular tu Discord con tu cuenta de MTA'
      ),

    new SlashCommandBuilder()
      .setName('desvincular')
      .setDescription(
        'Quita la vinculacion de tu Discord'
      ),

    new SlashCommandBuilder()
      .setName('admin-desvincular')
      .setDescription(
        'Admin: quita la vinculacion de un usuario'
      )
      .addUserOption((option) =>
        option
          .setName('usuario')
          .setDescription('Usuario a desvincular')
          .setRequired(true)
      )
      .setDefaultMemberPermissions(
        PermissionFlagsBits.Administrator
      )
  ]
    .map((command) => command.toJSON())
    .concat(buildVerificationCommands());
}

// ======================================================
// INICIAR BOT
// ======================================================

async function startBot({
  token,
  clientId,
  guildId,
  service,
  store
}) {
  console.log('[NOVARA] Preparando el bot...');

  // Crear cliente de Discord.
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds
    ]
  });

  // Confirmar conexión.
  client.once(Events.ClientReady, (connectedClient) => {
    console.log(
      `[NOVARA] Discord conectado como ${connectedClient.user.tag}`
    );
  });

  // Registrar errores del cliente.
  client.on('error', (error) => {
    console.error(
      '[NOVARA] Error del cliente Discord:',
      error
    );
  });

  // ====================================================
  // SISTEMA DE VERIFICACIÓN
  // ====================================================

  const verification = createVerification({
    client,
    guildId,
    store,
    service
  });

  service.setOnVerified(verification.onVerified);

  verification.registerCleanup();

  console.log('[NOVARA] Sistema de verificación preparado.');

  // ====================================================
  // MANEJADOR DE INTERACCIONES
  // ====================================================

  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      // -----------------------------------------------
      // BOTONES
      // -----------------------------------------------

      if (interaction.isButton()) {
        if (interaction.guildId !== guildId) {
          if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({
              content: 'Usa este boton dentro del Discord oficial.',
              ...EPHEMERAL
            });
          }

          return;
        }

        await verification.handleInteraction(interaction);

        return;
      }

      // Ignorar interacciones que no sean comandos.
      if (!interaction.isChatInputCommand()) {
        return;
      }

      // -----------------------------------------------
      // VALIDAR SERVIDOR
      // -----------------------------------------------

      if (interaction.guildId !== guildId) {
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({
            content: 'Usa este comando dentro del Discord oficial.',
            ...EPHEMERAL
          });
        }

        return;
      }

      // -----------------------------------------------
      // COMANDOS DE VERIFICACIÓN Y ADMINISTRACIÓN
      // -----------------------------------------------

      const handled = await verification.handleInteraction(
        interaction
      );

      if (handled) {
        return;
      }

      // -----------------------------------------------
      // /VINCULAR
      // -----------------------------------------------

      if (interaction.commandName === 'vincular') {
        const code = service.createCode(
          interaction.user.id
        );

        await interaction.reply({
          content:
            `Tu codigo es: **${code}**\n` +
            `Entra a MTA y escribe: **/vincular ${code}**\n` +
            'Caduca en 5 minutos. No lo compartas.',
          ...EPHEMERAL
        });

        return;
      }

      // -----------------------------------------------
      // /DESVINCULAR
      // -----------------------------------------------

      if (interaction.commandName === 'desvincular') {
        const result = service.unlinkDiscord(
          interaction.user.id
        );

        await interaction.reply({
          content: result
            ? 'Listo, tu Discord ya no esta vinculado. Usa /vincular para vincularlo de nuevo.'
            : 'No tenias ninguna vinculacion.',
          ...EPHEMERAL
        });

        return;
      }

      // -----------------------------------------------
      // /ADMIN-DESVINCULAR
      // -----------------------------------------------

      if (interaction.commandName === 'admin-desvincular') {
        const isAdministrator =
          interaction.memberPermissions?.has(
            PermissionFlagsBits.Administrator
          );

        if (!isAdministrator) {
          await interaction.reply({
            content: 'No tienes permiso.',
            ...EPHEMERAL
          });

          return;
        }

        const target = interaction.options.getUser(
          'usuario',
          true
        );

        const result = service.unlinkDiscord(
          target.id
        );

        await interaction.reply({
          content: result
            ? `Vinculacion de <@${target.id}> eliminada.`
            : `<@${target.id}> no tenia vinculacion.`,
          ...EPHEMERAL
        });

        return;
      }

      // -----------------------------------------------
      // COMANDO DESCONOCIDO
      // -----------------------------------------------

      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          content: 'No reconozco ese comando.',
          ...EPHEMERAL
        });
      }

    } catch (error) {
      console.error(
        `[NOVARA] Error en el comando ${interaction.commandName || interaction.customId || 'desconocido'}:`,
        error
      );

      // Intentar responder sin duplicar la respuesta.
      if (
        interaction.isRepliable() &&
        !interaction.replied &&
        !interaction.deferred
      ) {
        await interaction.reply({
          content:
            'Ocurrio un error al ejecutar el comando. Intenta de nuevo.',
          ...EPHEMERAL
        }).catch((replyError) => {
          console.error(
            '[NOVARA] No se pudo responder a la interacción:',
            replyError.message
          );
        });
      }
    }
  });

  // ====================================================
  // CONECTAR CON DISCORD
  // ====================================================

  console.log('[NOVARA] Conectando con Discord...');

  await client.login(token);

  console.log('[NOVARA] Inicio de sesión completado.');

  // ====================================================
  // REGISTRAR COMANDOS
  // ====================================================

  const rest = new REST({
    version: '10'
  }).setToken(token);

  console.log('[NOVARA] Registrando comandos...');

  rest.put(
    Routes.applicationGuildCommands(
      clientId,
      guildId
    ),
    {
      body: buildCommands()
    }
  ).then(() => {
    console.log(
      '[NOVARA] Comandos registrados correctamente.'
    );
  }).catch((error) => {
    console.error(
      '[NOVARA] Error al registrar los comandos:',
      error
    );
  });

  console.log('[NOVARA] Inicialización completada.');

  return client;
}

// ======================================================
// COMPROBAR SI UN USUARIO PERTENECE AL SERVIDOR
// ======================================================

function makeMemberCheck({
  token,
  guildId,
  requiredRoleId
}) {
  return async function isAllowedMember(userId) {
    const response = await fetch(
      `https://discord.com/api/v10/guilds/${guildId}/members/${userId}`,
      {
        headers: {
          Authorization: `Bot ${token}`
        },
        signal: AbortSignal.timeout(8000)
      }
    );

    if (response.status === 404) {
      return false;
    }

    if (!response.ok) {
      throw new Error(
        `Discord API respondio ${response.status}`
      );
    }

    if (!requiredRoleId) {
      return true;
    }

    const member = await response.json();

    return (
      Array.isArray(member.roles) &&
      member.roles.includes(requiredRoleId)
    );
  };
}

// ======================================================
// EXPORTAR FUNCIONES
// ======================================================

module.exports = {
  startBot,
  makeMemberCheck
};