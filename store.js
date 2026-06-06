/*
 * store.js — Penyimpanan ringan berbasis file JSON (tanpa database)
 * Menyimpan penilaian kandidat (status pipeline, rating, catatan, tag, favorit)
 * dan pengaturan (syarat lowongan untuk Job Match).
 */
'use strict';

const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, 'data.json');

const STATUSES = ['Baru', 'Direview', 'Wawancara', 'Tawaran', 'Diterima', 'Ditolak'];

const DEFAULT_DATA = {
  version: 1,
  evaluations: {}, // { [name]: { status, rating, criteria:{}, note, tags:[], favorite, updatedAt } }
  settings: {
    requirements: {
      title: 'Fullstack Developer',
      skills: ['React', 'Node.js', 'Laravel', 'MySQL', 'JavaScript'],
      minYears: 1,
      eduLevel: 'S1',
      weights: { skills: 50, experience: 35, education: 15 },
    },
  },
};

function load() {
  try {
    const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    // Gabung dengan default agar field baru selalu ada
    return {
      version: d.version || 1,
      evaluations: d.evaluations || {},
      settings: {
        requirements: { ...DEFAULT_DATA.settings.requirements, ...(d.settings && d.settings.requirements) },
      },
    };
  } catch {
    return JSON.parse(JSON.stringify(DEFAULT_DATA));
  }
}

function save(data) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
    return true;
  } catch (e) {
    return false;
  }
}

function getAll() {
  return load();
}

function setEval(name, patch, nowIso) {
  if (!name) return null;
  const data = load();
  const cur = data.evaluations[name] || {
    status: 'Baru', rating: 0, criteria: {}, note: '', tags: [], favorite: false,
  };
  const next = {
    ...cur,
    ...patch,
    criteria: { ...(cur.criteria || {}), ...(patch && patch.criteria) },
    updatedAt: nowIso || cur.updatedAt || null,
  };
  if (next.status && !STATUSES.includes(next.status)) next.status = cur.status || 'Baru';
  data.evaluations[name] = next;
  save(data);
  return next;
}

function setSettings(patch) {
  const data = load();
  data.settings.requirements = { ...data.settings.requirements, ...(patch || {}) };
  save(data);
  return data.settings;
}

module.exports = { getAll, setEval, setSettings, STATUSES, DATA_FILE };
