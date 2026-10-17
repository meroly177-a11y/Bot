'use strict';
const express = require('express');
const crypto = require('node:crypto');

const CODE_TTL_MS = 5 * 60 * 1000;
const MAX_FAILS = 5;
const FAIL_WINDOW_MS = 10 * 60 * 1000;

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const normSerial = (s) => {
  const v = String(s || '').trim().toUpperCase();
  return /^[A-F0-9]{20,64}$/.test(v) ? v : null;
};
// Datos informativos que manda el resource de MTA (solo se usan en los logs). Se sanean y se limitan.
const cleanText = (s, max) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
const cleanName = (s) => cleanText(s, 64) || null;
const cleanPlayerId = (s) => { const v = cleanText(s, 16); return /^[\w.-]{1,16}$/.test(v) ? v : null; };

/**
 * store: { db, save }          -> persistencia
 * apiSecret: string            -> secreto compartido con el resource de MTA
 * isAllowedMember(userId)      -> Promise<boolean> (miembro del servidor y, si aplica, con el rol)
 * onVerified(evt)              -> (opcional) se llama UNA vez por cada vinculacion confirmada por MTA:
 *                                 { discordId, serial, name, account, playerId, linkedAt, repeat }
 *                                 (tambien se puede fijar despues con setOnVerified)
 */
function createApi({ store, apiSecret, isAllowedMember, onVerified: onVerifiedInit, now = Date.now }) {
  const { db, save } = store;
  db.meta = db.meta || {};
  let onVerified = typeof onVerifiedInit === 'function' ? onVerifiedInit : null;
  const fails = new Map(); // serial -> { count, reset }

  const isBlocked = (serial) => {
    const f = fails.get(serial);
    if (!f) return false;
    if (f.reset < now()) { fails.delete(serial); return false; }
    return f.count >= MAX_FAILS;
  };
  const registerFail = (serial) => {
    const t = now();
    let f = fails.get(serial);
    if (!f || f.reset < t) f = { count: 0, reset: t + FAIL_WINDOW_MS };
    f.count += 1;
    fails.set(serial, f);
  };
  const sweepCodes = () => {
    const t = now();
    for (const [h, c] of Object.entries(db.codes)) if (c.expiresAt < t) delete db.codes[h];
  };
  const serialOfDiscord = (discordId) => Object.keys(db.links).find((s) => db.links[s] === discordId);
  const notifyVerified = (evt) => {
    if (!onVerified) return;
    Promise.resolve().then(() => onVerified(evt)).catch((e) => console.error('[verified] handler:', e.message || e));
  };

  // ---- operaciones que usa el bot de Discord ----
  function createCode(discordId) {
    sweepCodes();
    for (const [h, c] of Object.entries(db.codes)) if (c.discordId === discordId) delete db.codes[h];
    let code, h;
    do { code = crypto.randomInt(0, 1000000).toString().padStart(6, '0'); h = sha256(code); } while (db.codes[h]);
    db.codes[h] = { discordId, expiresAt: now() + CODE_TTL_MS };
    save();
    return code;
  }
  function unlinkDiscord(discordId) {
    let n = 0;
    for (const s of Object.keys(db.links)) if (db.links[s] === discordId) { delete db.links[s]; n++; }
    for (const [h, c] of Object.entries(db.codes)) if (c.discordId === discordId) delete db.codes[h];
    delete db.meta[discordId];
    save();
    return n;
  }
  const isLinked = (discordId) => Boolean(serialOfDiscord(discordId));
  const setOnVerified = (fn) => { onVerified = typeof fn === 'function' ? fn : null; };

  // ---- API HTTP para el resource de MTA ----
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '4kb' }));

  app.get('/health', (_req, res) => res.json({ ok: true, service: 'mta-discord-gate' }));

  app.use('/api', (req, res, next) => {
    const got = Buffer.from(req.get('x-mta-secret') || '');
    const want = Buffer.from(apiSecret);
    if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }
    next();
  });

  app.post('/api/verify', async (req, res) => {
    const serial = normSerial(req.body?.serial);
    if (!serial) return res.status(400).json({ ok: false, error: 'invalid_input' });
    const discordId = db.links[serial];
    if (!discordId) return res.status(403).json({ ok: false, error: 'not_linked' });
    let allowed;
    try { allowed = await isAllowedMember(discordId); }
    catch (e) { console.error('[verify] Discord:', e.message); return res.status(503).json({ ok: false, error: 'discord_unavailable' }); }
    if (!allowed) return res.status(403).json({ ok: false, error: 'not_guild_member' });
    res.json({ ok: true, discordId });
  });

  app.post('/api/claim', async (req, res) => {
    const serial = normSerial(req.body?.serial);
    const code = String(req.body?.code || '').trim();
    if (!serial || !/^\d{6}$/.test(code)) return res.status(400).json({ ok: false, error: 'invalid_input' });
    if (isBlocked(serial)) return res.status(429).json({ ok: false, error: 'too_many_attempts' });

    const h = sha256(code);
    const item = db.codes[h];
    if (!item || item.expiresAt < now()) { registerFail(serial); return res.status(400).json({ ok: false, error: 'code_invalid_or_expired' }); }

    let allowed;
    try { allowed = await isAllowedMember(item.discordId); }
    catch (e) { console.error('[claim] Discord:', e.message); return res.status(503).json({ ok: false, error: 'discord_unavailable' }); }
    if (!allowed) return res.status(403).json({ ok: false, error: 'not_guild_member' });

    // Revalidar despues del await: otro request pudo haber consumido el codigo.
    if (db.codes[h] !== item) { registerFail(serial); return res.status(400).json({ ok: false, error: 'code_invalid_or_expired' }); }
    const otherSerial = serialOfDiscord(item.discordId);
    const serialTaken = db.links[serial] && db.links[serial] !== item.discordId;
    if ((otherSerial && otherSerial !== serial) || serialTaken) return res.status(409).json({ ok: false, error: 'already_linked' });

    const repeat = db.links[serial] === item.discordId; // mismo serial + mismo Discord: no es una vinculacion nueva
    const prev = db.meta[item.discordId];
    delete db.codes[h];
    db.links[serial] = item.discordId;
    db.meta[item.discordId] = {
      name: cleanName(req.body?.name),
      account: cleanName(req.body?.account),
      playerId: cleanPlayerId(req.body?.playerId),
      linkedAt: repeat && prev?.linkedAt ? prev.linkedAt : now()
    };
    save();
    res.json({ ok: true, discordId: item.discordId });
    notifyVerified({ discordId: item.discordId, serial, ...db.meta[item.discordId], repeat });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => res.status(400).json({ ok: false, error: 'invalid_input' }));

  return { app, createCode, unlinkDiscord, isLinked, setOnVerified };
}

module.exports = { createApi };
