/*
 * config.js — Konfigurasi terpusat.
 *
 * Lokasi folder data pelamar ditentukan dengan urutan:
 *   1. Variabel lingkungan PELAMAR_DIR (paling diutamakan)
 *   2. Subfolder ./data (jika ada) di dalam folder aplikasi
 *   3. Folder induk (..) — default untuk struktur "satu folder per pelamar di samping _webapp"
 *
 * Setiap subfolder di dalam direktori tersebut dianggap satu pelamar.
 */
'use strict';

const path = require('path');
const fs = require('fs');

// Pemuat .env minimal (tanpa dependency). Tidak menimpa env yang sudah ada.
(function loadDotEnv() {
  try {
    const envPath = path.join(__dirname, '.env');
    if (!fs.existsSync(envPath)) return;
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      const key = m[1];
      let val = m[2].replace(/^["']|["']$/g, '');
      if (process.env[key] === undefined) process.env[key] = val;
    }
  } catch { /* abaikan */ }
})();

function resolveApplicantsDir() {
  if (process.env.PELAMAR_DIR) return path.resolve(process.env.PELAMAR_DIR);
  const dataDir = path.join(__dirname, 'data');
  try {
    const entries = fs.existsSync(dataDir) && fs.statSync(dataDir).isDirectory()
      ? fs.readdirSync(dataDir, { withFileTypes: true })
      : [];
    // Gunakan ./data hanya jika berisi minimal satu subfolder (pelamar)
    if (entries.some((e) => e.isDirectory())) return dataDir;
  } catch { /* abaikan */ }
  return path.resolve(__dirname, '..');
}

module.exports = {
  APPLICANTS_DIR: resolveApplicantsDir(),
  PORT: process.env.PORT || 3000,
};
