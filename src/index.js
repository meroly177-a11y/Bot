'use strict';

require('dotenv').config();

const { openStore } = require('./store');
const { createApi } = require('./api');
const { startBot, makeMemberCheck } = require('./bot');

const env = process.env;

for (const key of [
  'DISCORD_TOKEN',
  'DISCORD_CLIENT_ID',
  'DISCORD_GUILD_ID',
  'API_SECRET'
]) {
  if (!env[key]) {
    console.error(`Falta la variable ${key}`);
    process.exit(1);
  }
}

if (env.API_SECRET.length < 32) {
  console.error('API_SECRET debe tener al menos 32 caracteres.');
  process.exit(1);
}

const store = openStore(env.DATA_FILE || './data.json');

const service = createApi({
  store,
  apiSecret: env.API_SECRET,
  isAllowedMember: makeMemberCheck({
    token: env.DISCORD_TOKEN,
    guildId: env.DISCORD_GUILD_ID,
    requiredRoleId: env.REQUIRED_ROLE_ID || ''
  })
});

const port = Number(env.PORT || 3000);

// Abrir el puerto primero para que Render detecte la API.
const server = service.app.listen(port, '0.0.0.0', () => {
  console.log(`API escuchando en el puerto ${port}`);
});

// Iniciar Discord después de abrir el puerto.
startBot({
  token: env.DISCORD_TOKEN,
  clientId: env.DISCORD_CLIENT_ID,
  guildId: env.DISCORD_GUILD_ID,
  service,
  store
}).then(() => {
  console.log('Bot de Discord iniciado correctamente.');
}).catch((error) => {
  console.error('Error iniciando el bot de Discord:', error);
});

// Registrar errores del servidor HTTP.
server.on('error', (error) => {
  console.error('Error del servidor HTTP:', error);
});