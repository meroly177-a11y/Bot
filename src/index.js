'use strict';
require('dotenv').config();
const { openStore } = require('./store');
const { createApi } = require('./api');
const { startBot, makeMemberCheck } = require('./bot');

const env = process.env;
for (const k of ['DISCORD_TOKEN', 'DISCORD_CLIENT_ID', 'DISCORD_GUILD_ID', 'API_SECRET']) {
  if (!env[k]) { console.error(`Falta la variable ${k} en .env`); process.exit(1); }
}
if (env.API_SECRET.length < 32) { console.error('API_SECRET debe tener al menos 32 caracteres.'); process.exit(1); }

const store = openStore(env.DATA_FILE || './data.json');
const hooks = {}; // se conectan al bot cuando este ya inicio
const service = createApi({
  store,
  hooks,
  apiSecret: env.API_SECRET,
  isAllowedMember: makeMemberCheck({ token: env.DISCORD_TOKEN, guildId: env.DISCORD_GUILD_ID, requiredRoleId: env.REQUIRED_ROLE_ID || '' })
});

(async () => {
  const bot = await startBot({
    token: env.DISCORD_TOKEN, clientId: env.DISCORD_CLIENT_ID, guildId: env.DISCORD_GUILD_ID, service,
    options: {
      linkedRoleId: env.LINKED_ROLE_ID, logChannelId: env.LOG_CHANNEL_ID, nicknameFormat: env.NICKNAME_FORMAT,
      linkLogFormat: env.LINK_LOG_FORMAT, unlinkLogFormat: env.UNLINK_LOG_FORMAT
    }
  });
  hooks.onLinked = bot.onLinked;
  hooks.onNameChanged = bot.onNameChanged;
  if (!env.LINKED_ROLE_ID) console.log('Aviso: LINKED_ROLE_ID vacío -> no se asigna rol al vincular.');
  if (!env.LOG_CHANNEL_ID) console.log('Aviso: LOG_CHANNEL_ID vacío -> no se publican registros de vinculación.');
  const port = Number(env.PORT || 3000);
  service.app.listen(port, '0.0.0.0', () => console.log(`API escuchando en el puerto ${port}`));
})().catch((e) => { console.error('No se pudo iniciar:', e.message || e); process.exit(1); });
