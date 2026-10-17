# Bot + API de Discord para MTA:SA (v2)

El jugador entra si su serial esta vinculado a un Discord que pertenece a tu servidor oficial (y, opcionalmente, tiene un rol).
No hay usuarios ni contrasenas por chat.

## Arrancar
1. Node.js 20+.
2. `npm install`
3. `npm start`  (debe decir "Bot de Discord conectado" y "API escuchando en el puerto 3000")
4. `npm test` corre los tests (API + verificacion).

El backend tiene que ser alcanzable desde tu servidor de MTA (IP/dominio publico + puerto abierto).
`data.json` guarda las vinculaciones **y la configuracion** (canal de logs, rol, panel): ponlo en disco persistente
(en Render, un Disk montado y `DATA_FILE=/ruta/del/disco/data.json`). Sin disco persistente se pierde en cada reinicio.

## Comandos de Discord
- `/vincular`: te da un codigo de 6 digitos (5 min).
- `/desvincular`: quita tu vinculacion (por si cambias de PC).
- `/admin-desvincular usuario`: solo administradores.
- `/set log canal`: solo administradores. Canal donde se registran las verificaciones completadas.
- `/set rol rol`: solo administradores. Rol que se da al verificarse (el rol del bot debe estar por encima).
- `/admin-panel [canal]`: solo administradores. Publica (o actualiza, sin duplicar) el panel **VERIFICACIÓN NOVARA** con el boton **Verificar**.

## Verificacion
1. El jugador pulsa **Verificar** en el panel: recibe un codigo (o, si ya esta vinculado, se le avisa).
2. En MTA escribe `/vincular CODIGO`. El servidor MTA manda al backend serial, nombre, cuenta e ID (con `X-MTA-Secret`).
3. Si el backend lo confirma (codigo valido, miembro del Discord, 1 Discord = 1 serial), el bot da el rol y publica el log.
Si falla dar el rol, el log lo dice y NO afirma que se completo.

## Comandos en MTA
- `/vincular CODIGO`, `/verificar` (reintentar).
- Consola del servidor: `discauth_test` comprueba URL y secreto.
- Opcional en `config.lua` del resource: `PLAYER_ID_EXPORT = { resource = "...", func = "..." }` o
  `PLAYER_ID_ELEMENT_DATA = { "clave" }` para decir de donde sale el ID del jugador en los logs.

## Notas
- `REQUIRED_ROLE_ID` (opcional) exige un rol para poder vincular. **No pongas ahi el rol de verificado**: nadie podria verificarse.
- Permisos del bot: Gestionar roles; Ver canal, Enviar mensajes e Insertar enlaces en el canal de logs y en el del panel. No hacen falta intents nuevos.
