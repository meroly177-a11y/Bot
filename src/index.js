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
const service = createApi({
  store,
  apiSecret: env.API_SECRET,
  isAllowedMember: makeMemberCheck({ token: env.DISCORD_TOKEN, guildId: env.DISCORD_GUILD_ID, requiredRoleId: env.REQUIRED_ROLE_ID || '' })
});

(async () => {
  await startBot({ token: env.DISCORD_TOKEN, clientId: env.DISCORD_CLIENT_ID, guildId: env.DISCORD_GUILD_ID, service, store });
  const port = Number(env.PORT || 3000);
  service.app.listen(port, '0.0.0.0', () => console.log(`API escuchando en el puerto ${port}`));
})().catch((e) => { console.error('No se pudo iniciar:', e.message || e); process.exit(1); });
