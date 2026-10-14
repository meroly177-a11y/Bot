# Bot + API de Discord para MTA:SA (v2.1)

El jugador entra si su serial esta vinculado a un Discord del servidor oficial (y, opcionalmente, con un rol).

## Arrancar
1. Node.js 20+  ->  `npm install`  ->  `npm start`
2. Debe decir "Bot de Discord conectado" y "API escuchando en el puerto 3000".
3. `npm test` corre los tests (opcional).

## Al vincularse
- Le da el rol `LINKED_ROLE_ID`.
- Le pone de apodo su nombre en el servidor de MTA (`NICKNAME_FORMAT`, ej. `[MTA] {name}`). Si cambia de nombre en MTA, el apodo se actualiza en su siguiente entrada.
- Publica un mensaje en `LOG_CHANNEL_ID` con el formato de `LINK_LOG_FORMAT`
  (variables: `{mention}` `{tag}` `{discordId}` `{name}` `{date}` `{count}`, `\n` = salto de linea).

## Permisos del bot en Discord
- Gestionar roles y Gestionar apodos.
- Enviar mensajes en el canal de registros.
- En Ajustes del servidor -> Roles, arrastra el rol del bot POR ENCIMA del rol de vinculado y de los usuarios que quieras renombrar.
- Discord no deja a ningun bot cambiar el apodo del dueno del servidor.

## Comandos de Discord
- `/vincular`, `/desvincular`, `/estado`
- Admin: `/admin-desvincular`, `/admin-info` (muestra serial), `/admin-lista`, `/admin-panel` (publica un boton "Vincular mi cuenta de MTA")

## Comandos en MTA
- `/vincular CODIGO`, `/verificar`. Consola del servidor: `discauth_test`.
