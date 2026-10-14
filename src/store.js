'use strict';
const fs = require('node:fs');
const path = require('node:path');

// Persistencia en un JSON (sin dependencias nativas). Escritura atomica: tmp + rename.
function openStore(file) {
  const p = path.resolve(file);
  let db = { links: {}, codes: {}, meta: {} };
  if (fs.existsSync(p)) {
    const loaded = JSON.parse(fs.readFileSync(p, 'utf8'));
    db = { links: loaded.links || {}, codes: loaded.codes || {}, meta: loaded.meta || {} };
  }
  function save() {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = `${p}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, p);
  }
  return { db, save };
}

module.exports = { openStore };
