/*
 * Pelamar Fullstack — Web Viewer & Ranking
 * Aplikasi Node.js murni (hanya bergantung pada pdf-parse) untuk:
 *   1. Dashboard   (/)         — menu awal
 *   2. Daftar      (/pelamar)  — semua pelamar + dokumen (lihat/unduh)
 *   3. Perankingan (/ranking)  — analisis CV → estimasi pengalaman IT, lalu ranking
 *
 * Jalankan:  node server.js   →   http://localhost:3000
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const analyzer = require('./analyzer');
const store = require('./store');
const { APPLICANTS_DIR, PORT } = require('./config');

// ── Util ─────────────────────────────────────────────────────────────────────
const MIME = {
  '.pdf': 'application/pdf', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.zip': 'application/zip', '.txt': 'text/plain; charset=utf-8',
};
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg']);

function humanSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  const units = ['KB', 'MB', 'GB'];
  let i = -1;
  do { bytes /= 1024; i++; } while (bytes >= 1024 && i < units.length - 1);
  return bytes.toFixed(1) + ' ' + units[i];
}

function categorize(name) {
  const n = name.toLowerCase().replace(/[_\-.]+/g, ' ');
  if (/portof|porto|portfolio/.test(n)) return 'Portofolio';
  if (/\bcv\b|curriculum|resume|daftar riwayat/.test(n)) return 'CV';
  if (/skck/.test(n)) return 'SKCK';
  if (/ijaz|transk|transcript|nilai/.test(n)) return 'Ijazah & Transkrip';
  if (/lamaran|cover|application|surat lamaran/.test(n)) return 'Surat Lamaran';
  if (/sehat|kesehatan|medical/.test(n)) return 'Surat Sehat';
  if (/ktp|identitas/.test(n)) return 'KTP';
  if (/sertif|certificate|certif/.test(n)) return 'Sertifikat';
  if (/foto|photo|pas foto/.test(n)) return 'Foto';
  return 'Dokumen Lain';
}

function initials(name) {
  const clean = name.replace(/^M\.?\s+/i, '').replace(/[^A-Za-z\s]/g, ' ').trim();
  const parts = clean.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function isSafe(target) {
  const resolved = path.resolve(target);
  const baseWithSep = APPLICANTS_DIR.endsWith(path.sep) ? APPLICANTS_DIR : APPLICANTS_DIR + path.sep;
  return resolved === APPLICANTS_DIR || resolved.startsWith(baseWithSep);
}

// ── Pengumpulan data pelamar ──────────────────────────────────────────────────
function listFilesRecursive(dir, acc) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) { listFilesRecursive(full, acc); }
    else if (ent.isFile()) {
      let stat;
      try { stat = fs.statSync(full); } catch { continue; }
      const ext = path.extname(ent.name).toLowerCase();
      acc.push({
        name: ent.name, ext,
        rel: path.relative(APPLICANTS_DIR, full).split(path.sep).join('/'),
        size: stat.size, sizeHuman: humanSize(stat.size),
        category: categorize(ent.name), mime: MIME[ext] || 'application/octet-stream',
        isImage: IMAGE_EXT.has(ext), isPdf: ext === '.pdf',
      });
    }
  }
  return acc;
}

function getApplicants() {
  let dirs;
  try { dirs = fs.readdirSync(APPLICANTS_DIR, { withFileTypes: true }); } catch { return []; }
  const applicants = [];
  for (const d of dirs) {
    if (!d.isDirectory() || d.name === '_webapp' || d.name.startsWith('.')) continue;
    const files = listFilesRecursive(path.join(APPLICANTS_DIR, d.name), []);
    if (files.length === 0) continue;
    files.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
    const cats = [...new Set(files.map((f) => f.category))];
    applicants.push({
      name: d.name, initials: initials(d.name), fileCount: files.length,
      categories: cats, hasCV: cats.includes('CV'), hasPortfolio: cats.includes('Portofolio'),
      files,
    });
  }
  applicants.sort((a, b) => a.name.localeCompare(b.name, 'id'));
  return applicants;
}

// ── Server ─────────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = decodeURIComponent(parsed.pathname);

  try {
    if (pathname === '/api/applicants') {
      const data = getApplicants();
      // Perkaya dengan hasil analisis CV (skill, link, pengalaman, pendidikan)
      const analyzed = await analyzer.analyzeAll(data, { refresh: !!parsed.query.refresh });
      const byName = {};
      analyzed.forEach((a) => { byName[a.name] = a; });
      const evals = store.getAll().evaluations;
      data.forEach((a) => {
        const an = byName[a.name] || {};
        a.tech = an.tech || [];
        a.links = an.links || { github: null, linkedin: null, website: null };
        a.education = an.education || null;
        a.estimateYears = an.estimateYears || 0;
        a.estimateLabel = an.estimateLabel || 'Tidak terdeteksi';
        a.cvRel = an.cvRel || (a.files.find((f) => f.category === 'CV') || {}).rel || null;
        a.eval = evals[a.name] || null;
      });
      const stats = {
        total: data.length,
        totalFiles: data.reduce((s, a) => s + a.fileCount, 0),
        withCV: data.filter((a) => a.hasCV).length,
        withPortfolio: data.filter((a) => a.hasPortfolio).length,
      };
      return json(res, { stats, applicants: data });
    }

    if (pathname === '/api/data') {
      const d = store.getAll();
      return json(res, { evaluations: d.evaluations, settings: d.settings, statuses: store.STATUSES });
    }

    if (pathname === '/api/eval' && req.method === 'POST') {
      const body = await readBody(req);
      const saved = store.setEval(body.name, body.patch || {}, new Date().toISOString());
      return json(res, { ok: !!saved, eval: saved });
    }

    if (pathname === '/api/settings' && req.method === 'POST') {
      const body = await readBody(req);
      const settings = store.setSettings(body.requirements || body || {});
      return json(res, { ok: true, settings });
    }

    if (pathname === '/api/ocr' && req.method === 'POST') {
      const body = await readBody(req);
      const app = getApplicants().find((a) => a.name === body.name);
      if (!app) return json(res, { ok: false, error: 'Pelamar tidak ditemukan.' });
      const out = await analyzer.ocrApplicant(app);
      return json(res, out);
    }

    if (pathname === '/api/ranking') {
      const refresh = !!parsed.query.refresh;
      const ranked = await analyzer.rankAll(getApplicants(), { refresh });
      const withExp = ranked.filter((r) => r.estimateYears > 0);
      const stats = {
        total: ranked.length,
        analyzed: ranked.filter((r) => r.confidence !== 'rendah' || r.estimateYears > 0).length,
        withExperience: withExp.length,
        avgYears: withExp.length ? +(withExp.reduce((s, r) => s + r.estimateYears, 0) / withExp.length).toFixed(1) : 0,
        maxYears: ranked.length ? Math.max(...ranked.map((r) => r.estimateYears)) : 0,
        unreadable: ranked.filter((r) => r.confidence === 'rendah').length,
      };
      return json(res, { stats, ranking: ranked });
    }

    if (pathname === '/api/contacts') {
      const refresh = !!parsed.query.refresh;
      const all = await analyzer.analyzeAll(getApplicants(), { refresh });
      const contacts = all.map((a) => ({
        name: a.name, initials: a.initials, cvRel: a.cvRel, fileCount: a.fileCount,
        phones: a.phones || [], phonesPretty: a.phonesPretty || [],
        emails: a.emails || [], phoneSource: a.phoneSource || null,
      }));
      const withPhone = contacts.filter((c) => c.phones.length).length;
      return json(res, {
        stats: { total: contacts.length, withPhone, withoutPhone: contacts.length - withPhone },
        contacts,
      });
    }

    if (pathname === '/file') {
      const rel = parsed.query.path;
      if (!rel) { res.writeHead(400); return res.end('Bad request'); }
      const target = path.resolve(APPLICANTS_DIR, rel);
      if (!isSafe(target) || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
        res.writeHead(404); return res.end('Not found');
      }
      const ext = path.extname(target).toLowerCase();
      const stat = fs.statSync(target);
      const disposition = parsed.query.download ? 'attachment' : 'inline';
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Content-Length': stat.size,
        'Content-Disposition': `${disposition}; filename*=UTF-8''${encodeURIComponent(path.basename(target))}`,
        'Cache-Control': 'private, max-age=300',
      });
      return fs.createReadStream(target).pipe(res);
    }

    if (pathname === '/' || pathname === '/index.html') return html(res, pageDashboard());
    if (pathname === '/pelamar') return html(res, pagePelamar());
    if (pathname === '/ranking') return html(res, pageRanking());
    if (pathname === '/undang') return html(res, pageUndang());
    if (pathname === '/cocok') return html(res, pageCocok());
    if (pathname === '/seleksi') return html(res, pageSeleksi());
    if (pathname === '/analitik') return html(res, pageAnalitik());

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('500 Error: ' + e.message);
  }
});

function json(res, obj) {
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve) => {
    let buf = '';
    req.on('data', (c) => { buf += c; if (buf.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(buf || '{}')); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}
function html(res, body) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(body);
}

server.listen(PORT, () => {
  console.log('\n  ╭───────────────────────────────────────────────╮');
  console.log('  │   Pelamar Fullstack — Web Viewer & Ranking    │');
  console.log('  ╰───────────────────────────────────────────────╯\n');
  console.log('  Direktori : ' + APPLICANTS_DIR);
  console.log('  Server    : http://localhost:' + PORT + '\n');
  console.log('  Halaman   : /  (dashboard)  ·  /pelamar  ·  /ranking\n');
  console.log('  Tekan Ctrl+C untuk menghentikan.\n');
});

/* ════════════════════════════════════════════════════════════════════════════
 *  TEMPLATE HTML
 * ════════════════════════════════════════════════════════════════════════════ */

const SHARED_CSS = `
  :root{
    --bg:#0b0f1a;--bg2:#0f1525;--card:#141b2e;--card2:#1a2238;
    --line:rgba(255,255,255,.08);--line2:rgba(255,255,255,.14);
    --text:#eef2ff;--muted:#9aa6c4;--muted2:#6b7694;
    --brand:#6366f1;--brand2:#22d3ee;--accent:#f59e0b;
    --green:#34d399;--pink:#f472b6;--gold:#fbbf24;--silver:#cbd5e1;--bronze:#d29062;
    --radius:18px;--shadow:0 10px 40px rgba(0,0,0,.45);
    --soft:rgba(255,255,255,.03);--barbg:rgba(255,255,255,.07);--inset:rgba(0,0,0,.2);
    --navbg:rgba(11,15,26,.75);--viewerbg:#0a0d16;
    --glow1:rgba(99,102,241,.20);--glow2:rgba(34,211,238,.14);--glow3:rgba(244,114,182,.10);
  }
  [data-theme="light"]{
    --bg:#f4f7fc;--bg2:#ffffff;--card:#ffffff;--card2:#f5f8fe;
    --line:rgba(15,23,42,.09);--line2:rgba(15,23,42,.16);
    --text:#0f1b33;--muted:#5a6480;--muted2:#94a0b8;
    --brand:#5457e6;--brand2:#0891b2;--accent:#d97706;
    --green:#059669;--pink:#db2777;--gold:#d99a00;--silver:#94a3b8;--bronze:#b87333;
    --shadow:0 12px 34px rgba(15,23,42,.12);
    --soft:rgba(15,23,42,.035);--barbg:rgba(15,23,42,.08);--inset:rgba(15,23,42,.04);
    --navbg:rgba(255,255,255,.78);--viewerbg:#eef2f8;
    --glow1:rgba(99,102,241,.14);--glow2:rgba(34,211,238,.12);--glow3:rgba(244,114,182,.08);
  }
  *{box-sizing:border-box;margin:0;padding:0}
  html{scroll-behavior:smooth}
  body{font-family:'Inter',system-ui,sans-serif;background:var(--bg);color:var(--text);
    -webkit-font-smoothing:antialiased;min-height:100vh;
    transition:background-color .3s ease,color .3s ease;
    background-image:
      radial-gradient(900px 500px at 8% -8%,var(--glow1),transparent 60%),
      radial-gradient(800px 500px at 100% 0%,var(--glow2),transparent 55%),
      radial-gradient(700px 600px at 50% 120%,var(--glow3),transparent 60%);}
  .wrap{max-width:1240px;margin:0 auto;padding:0 24px}
  h1,h2,h3,.brand,.num,.name{font-family:'Plus Jakarta Sans',sans-serif}
  a{color:inherit;text-decoration:none}

  /* Navbar */
  .nav{position:sticky;top:0;z-index:50;backdrop-filter:blur(14px);
    background:var(--navbg);border-bottom:1px solid var(--line);transition:background-color .3s ease}
  .nav-in{max-width:1240px;margin:0 auto;padding:14px 24px;display:flex;align-items:center;gap:14px;position:relative}
  .brand{font-weight:800;font-size:18px;display:flex;align-items:center;gap:10px;margin-right:auto}
  .brand .logo{width:32px;height:32px;border-radius:9px;display:grid;place-items:center;
    background:linear-gradient(135deg,var(--brand),var(--brand2));font-size:16px;color:#fff}
  .nav-links{display:flex;gap:6px}
  .nav-links a{padding:9px 16px;border-radius:10px;font-size:14px;font-weight:500;color:var(--muted);transition:.15s;white-space:nowrap}
  .nav-links a:hover{color:var(--text);background:var(--soft)}
  .nav-links a.active{color:#fff;background:linear-gradient(100deg,var(--brand),#4f46e5)}
  .theme-toggle{width:40px;height:40px;border-radius:11px;border:1px solid var(--line2);
    background:var(--soft);color:var(--text);font-size:17px;cursor:pointer;transition:.18s;
    display:grid;place-items:center;flex-shrink:0;line-height:1}
  .theme-toggle:hover{border-color:var(--brand);transform:translateY(-1px)}
  .nav-burger{display:none;width:42px;height:42px;border-radius:11px;border:1px solid var(--line2);
    background:var(--soft);color:var(--text);cursor:pointer;place-items:center;flex-shrink:0;transition:.18s}
  .nav-burger:hover{border-color:var(--brand)}

  .eyebrow{display:inline-flex;align-items:center;gap:8px;font-size:12.5px;letter-spacing:.14em;
    text-transform:uppercase;color:var(--brand2);font-weight:600;margin-bottom:16px;
    border:1px solid var(--line2);padding:7px 14px;border-radius:999px;background:rgba(34,211,238,.06)}
  .eyebrow .dot{width:7px;height:7px;border-radius:50%;background:var(--green);box-shadow:0 0 0 4px rgba(52,211,153,.18)}
  h1{font-size:clamp(28px,4.2vw,46px);font-weight:800;line-height:1.06;letter-spacing:-.02em}
  h1 .grad{background:linear-gradient(100deg,var(--brand),var(--brand2));-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent}
  .sub{color:var(--muted);margin-top:14px;font-size:16px;max-width:640px;line-height:1.6}

  .stats{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;margin:30px 0 8px}
  .stat{background:linear-gradient(180deg,var(--card),var(--card2));border:1px solid var(--line);
    border-radius:var(--radius);padding:20px 22px;position:relative;overflow:hidden}
  .stat::after{content:"";position:absolute;inset:0;background:radial-gradient(120px 80px at 90% 0%,rgba(99,102,241,.18),transparent 70%)}
  .stat .num{font-size:32px;font-weight:800;line-height:1}
  .stat .lbl{color:var(--muted);font-size:13px;margin-top:8px;font-weight:500}
  .stat .ico{position:absolute;top:18px;right:18px;font-size:20px;opacity:.85}

  .avatar{border-radius:14px;display:grid;place-items:center;flex-shrink:0;
    font-family:'Plus Jakarta Sans';font-weight:800;color:#fff;letter-spacing:.02em}

  footer{border-top:1px solid var(--line);padding:26px 0 40px;color:var(--muted2);font-size:13px;text-align:center;margin-top:30px}

  /* Modal viewer (shared) */
  .modal{position:fixed;inset:0;background:rgba(5,8,15,.82);backdrop-filter:blur(8px);z-index:100;
    display:none;align-items:center;justify-content:center;padding:24px;animation:fade .18s ease}
  .modal.open{display:flex}
  @keyframes fade{from{opacity:0}to{opacity:1}}
  .viewer{background:var(--bg2);border:1px solid var(--line2);border-radius:16px;width:100%;max-width:1000px;
    height:90vh;display:flex;flex-direction:column;overflow:hidden;box-shadow:var(--shadow)}
  .viewer-top{display:flex;align-items:center;gap:12px;padding:15px 20px;border-bottom:1px solid var(--line);background:var(--card)}
  .viewer-top .vt-name{font-weight:600;font-size:15px;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .vt-btn{background:var(--card2);border:1px solid var(--line2);color:var(--text);padding:9px 15px;border-radius:10px;
    font-size:13.5px;cursor:pointer;display:inline-flex;align-items:center;gap:7px;font-family:inherit;transition:.15s}
  .vt-btn:hover{border-color:var(--brand);color:#fff}
  .viewer-body{flex:1;background:var(--viewerbg);overflow:auto;display:grid;place-items:center}
  .viewer-body iframe{width:100%;height:100%;border:0;background:#fff}
  .viewer-body img{max-width:100%;max-height:100%;display:block}
  .viewer-body .nopreview{text-align:center;color:var(--muted);padding:40px}
  .viewer-body .nopreview .big{font-size:54px;margin-bottom:14px}

  /* Modal penilaian kandidat (shared) */
  .emodal{background:var(--bg2);border:1px solid var(--line2);border-radius:16px;width:100%;max-width:560px;max-height:92vh;display:flex;flex-direction:column;overflow:hidden;box-shadow:var(--shadow)}
  .ebody{padding:22px;overflow:auto;display:flex;flex-direction:column;gap:18px}
  .efoot{padding:14px 20px;border-top:1px solid var(--line);display:flex;gap:10px;justify-content:flex-end;flex-wrap:wrap;background:var(--card)}
  .ebtn{background:linear-gradient(100deg,var(--brand),#4f46e5);color:#fff;border:0;padding:10px 18px;border-radius:10px;font-weight:600;cursor:pointer;font-family:inherit;font-size:14px;transition:.15s}
  .ebtn:hover{filter:brightness(1.1)}
  .efield label{display:block;font-size:13px;font-weight:600;color:var(--muted);margin-bottom:9px}
  .estatus{display:flex;gap:7px;flex-wrap:wrap}
  .sopt{padding:8px 13px;border-radius:9px;border:1px solid var(--line2);font-size:13px;cursor:pointer;color:var(--muted);font-weight:600;transition:.12s;background:var(--soft)}
  .sopt.active{color:#fff;border-color:transparent}
  .stars{display:flex;gap:4px}
  .stars .st{font-size:24px;cursor:pointer;color:var(--line2);transition:.1s;line-height:1;user-select:none}
  .stars .st.on{color:#fbbf24}
  .crit{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:5px 0}
  .crit .cl{font-size:13.5px}
  .crit .stars .st{font-size:19px}
  .etags{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px}
  .etag-chip{background:rgba(99,102,241,.12);border:1px solid rgba(99,102,241,.35);color:#c7d2fe;padding:4px 10px;border-radius:7px;font-size:12px;display:inline-flex;gap:7px;align-items:center}
  [data-theme="light"] .etag-chip{color:#4338ca}
  .etag-chip b{cursor:pointer;opacity:.65;font-weight:700}.etag-chip b:hover{opacity:1}
  .einput,.etext{width:100%;background:var(--bg);border:1px solid var(--line2);color:var(--text);padding:10px 12px;border-radius:10px;font-family:inherit;font-size:14px;outline:none;transition:.15s}
  .einput:focus,.etext:focus{border-color:var(--brand)}
  .etext{min-height:88px;resize:vertical;line-height:1.5}
  .efav{display:inline-flex;align-items:center;gap:9px;cursor:pointer;font-size:14px;user-select:none}
  .efav .box{width:22px;height:22px;border-radius:7px;border:1px solid var(--line2);display:grid;place-items:center;font-size:13px}
  .efav.on .box{background:#f59e0b;border-color:transparent;color:#fff}
  /* Badge status & rating kecil (dipakai di kartu) */
  .sbadge{font-size:11px;padding:4px 9px;border-radius:7px;font-weight:700;color:#fff;display:inline-flex;align-items:center;gap:5px}
  .rstars{color:#fbbf24;font-size:12px;letter-spacing:1px}
  .lnkbtn{width:34px;height:34px;border-radius:9px;border:1px solid var(--line2);display:grid;place-items:center;color:var(--muted);transition:.15s;flex-shrink:0}
  .lnkbtn:hover{color:#fff;border-color:var(--brand);transform:translateY(-1px)}
  .lnkbtn svg{width:17px;height:17px}

  .stat,.card,.mcard,.row,.pod,.doc,.iconbtn,.btn,.chip,.badge,.bar,.ev,.note,.search input,.viewer,.viewer-top,.theme-toggle{transition:background-color .3s ease,border-color .3s ease,color .3s ease,box-shadow .3s ease}
  /* Penyesuaian kontras warna untuk tema terang */
  [data-theme="light"] .eyebrow{color:#0e7490}
  [data-theme="light"] .badge.cv{color:#4338ca}
  [data-theme="light"] .badge.porto{color:#047857}
  [data-theme="light"] .ft.pdf{color:#dc2626}
  [data-theme="light"] .ft.img{color:#0e7490}
  [data-theme="light"] .ft.oth{color:#475569}
  [data-theme="light"] .conf.tinggi{color:#047857}
  [data-theme="light"] .conf.sedang{color:#b45309}
  [data-theme="light"] .conf.rendah{color:#475569}
  [data-theme="light"] .tg{color:#4338ca}
  [data-theme="light"] .etag.kerja{color:#047857}
  [data-theme="light"] .etag.pendidikan{color:#4338ca}
  [data-theme="light"] .etag.organisasi{color:#475569}
  [data-theme="light"] .etag.klaim{color:#b45309}
  [data-theme="light"] .note{color:#8a5414}
  [data-theme="light"] .note b{color:#6b3f0c}
  [data-theme="light"] .pod.g1{box-shadow:0 0 36px rgba(217,154,0,.18)}
  /* ── Responsif ──────────────────────────────────────────── */
  @media(max-width:1040px){
    .nav-burger{display:grid}
    .nav-links{position:absolute;top:calc(100% + 1px);left:0;right:0;flex-direction:column;gap:4px;
      background:var(--bg2);border-bottom:1px solid var(--line);padding:10px 16px 16px;display:none;
      box-shadow:0 16px 30px rgba(0,0,0,.25)}
    .nav-links.open{display:flex}
    .nav-links a{padding:13px 14px;font-size:15px;border-radius:11px}
  }
  @media(max-width:720px){
    .wrap{padding:0 16px}
    .nav-in{padding:12px 16px}
    .brand{font-size:16px}
    .stats{grid-template-columns:repeat(2,1fr);gap:12px}
    .stat{padding:16px 16px}
    .stat .num{font-size:26px}
    .stat .ico{font-size:17px;top:14px;right:14px}
    .sub{font-size:15px}
    .modal{padding:0}
    .viewer{height:100vh;max-width:100%;border-radius:0;border:0}
    .viewer-top{flex-wrap:wrap;gap:8px;padding:12px 14px}
    .viewer-top .vt-name{flex-basis:100%;font-size:13.5px}
    .vt-btn{padding:8px 12px;font-size:12.5px}
  }
  @media(max-width:420px){
    .stats{grid-template-columns:1fr}
  }
`;

const MODAL_HTML = `
<div class="modal" id="modal">
  <div class="viewer">
    <div class="viewer-top">
      <div class="vt-name" id="vName">Dokumen</div>
      <a class="vt-btn" id="vOpen" target="_blank" rel="noopener">Tab Baru</a>
      <a class="vt-btn" id="vDownload">Unduh</a>
      <button class="vt-btn" onclick="closeModal()">Tutup &times;</button>
    </div>
    <div class="viewer-body" id="vBody"></div>
  </div>
</div>
<div class="modal" id="evalModal">
  <div class="emodal">
    <div class="viewer-top">
      <div class="vt-name" id="evTitle">Nilai Kandidat</div>
      <button class="vt-btn" onclick="closeEval()">Tutup &times;</button>
    </div>
    <div class="ebody" id="evBody"></div>
    <div class="efoot">
      <button class="vt-btn" id="evCv" style="display:none">📄 Lihat CV</button>
      <button class="ebtn" onclick="saveEval()">💾 Simpan Penilaian</button>
    </div>
  </div>
</div>`;

const SHARED_JS = `
const AVATAR_GRADIENTS=['linear-gradient(135deg,#6366f1,#8b5cf6)','linear-gradient(135deg,#22d3ee,#3b82f6)','linear-gradient(135deg,#f59e0b,#f43f5e)','linear-gradient(135deg,#34d399,#10b981)','linear-gradient(135deg,#f472b6,#a855f7)','linear-gradient(135deg,#fb7185,#f59e0b)','linear-gradient(135deg,#38bdf8,#6366f1)','linear-gradient(135deg,#a3e635,#22c55e)'];
function gradFor(s){let h=0;for(let i=0;i<s.length;i++)h=(h*31+s.charCodeAt(i))>>>0;return AVATAR_GRADIENTS[h%AVATAR_GRADIENTS.length];}
function esc(s){return (s==null?'':String(s)).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function fileMeta(rel){const ext=(rel.split('.').pop()||'').toLowerCase();return{isPdf:ext==='pdf',isImage:['jpg','jpeg','png','gif','webp','bmp','svg'].includes(ext)};}
function openFile(rel,title){
  const src='/file?path='+encodeURIComponent(rel);const meta=fileMeta(rel);
  document.getElementById('vName').textContent=title||rel.split('/').pop();
  document.getElementById('vOpen').href=src;document.getElementById('vDownload').href=src+'&download=1';
  const body=document.getElementById('vBody');
  if(meta.isPdf)body.innerHTML='<iframe src="'+src+'#toolbar=1"></iframe>';
  else if(meta.isImage)body.innerHTML='<img src="'+src+'" alt="">';
  else body.innerHTML='<div class="nopreview"><div class="big">\\uD83D\\uDCC4</div>Pratinjau tidak tersedia.<br><br><a class="vt-btn" href="'+src+'&download=1">Unduh Berkas</a></div>';
  document.getElementById('modal').classList.add('open');
}
function closeModal(){document.getElementById('modal').classList.remove('open');document.getElementById('vBody').innerHTML='';}
document.addEventListener('click',e=>{if(e.target.id==='modal')closeModal();});
document.addEventListener('keydown',e=>{if(e.key==='Escape')closeModal();});
function updateThemeIcon(){var b=document.getElementById('themeToggle');if(!b)return;var light=document.documentElement.getAttribute('data-theme')==='light';b.textContent=light?'\\u2600\\uFE0F':'\\uD83C\\uDF19';b.title=light?'Beralih ke tema gelap':'Beralih ke tema terang';}
function toggleTheme(){var h=document.documentElement;var next=h.getAttribute('data-theme')==='light'?'dark':'light';h.setAttribute('data-theme',next);try{localStorage.setItem('theme',next);}catch(e){}updateThemeIcon();}
updateThemeIcon();
function toggleNav(){var n=document.querySelector('.nav-links');if(n)n.classList.toggle('open');}
document.addEventListener('click',function(e){var n=document.querySelector('.nav-links');var b=document.getElementById('navBurger');if(n&&n.classList.contains('open')&&!n.contains(e.target)&&b&&!b.contains(e.target))n.classList.remove('open');});
let _toastT;
function toast(msg){let t=document.getElementById('_toast');if(!t){t=document.createElement('div');t.id='_toast';t.style.cssText='position:fixed;left:50%;bottom:28px;transform:translateX(-50%) translateY(20px);background:var(--card2);color:var(--text);border:1px solid var(--line2);padding:12px 20px;border-radius:12px;font-size:14px;font-weight:500;z-index:200;box-shadow:var(--shadow);opacity:0;transition:.25s;pointer-events:none;max-width:90vw';document.body.appendChild(t);}t.textContent=msg;requestAnimationFrame(()=>{t.style.opacity='1';t.style.transform='translateX(-50%) translateY(0)';});clearTimeout(_toastT);_toastT=setTimeout(()=>{t.style.opacity='0';t.style.transform='translateX(-50%) translateY(20px)';},2200);}
function copyText(txt,msg){if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(txt).then(()=>toast(msg||'Disalin')).catch(()=>fallbackCopy(txt,msg));}else fallbackCopy(txt,msg);}
function fallbackCopy(txt,msg){const ta=document.createElement('textarea');ta.value=txt;ta.style.position='fixed';ta.style.opacity='0';document.body.appendChild(ta);ta.select();try{document.execCommand('copy');toast(msg||'Disalin');}catch(e){toast('Gagal menyalin');}document.body.removeChild(ta);}
function downloadFile(name,content,mime){const blob=new Blob([content],{type:mime||'text/plain;charset=utf-8'});const u=URL.createObjectURL(blob);const a=document.createElement('a');a.href=u;a.download=name;document.body.appendChild(a);a.click();document.body.removeChild(a);setTimeout(()=>URL.revokeObjectURL(u),1500);}

/* ── Penilaian kandidat (modal bersama) ── */
const STATUSES=['Baru','Direview','Wawancara','Tawaran','Diterima','Ditolak'];
const STATUS_COLORS={Baru:'#64748b',Direview:'#6366f1',Wawancara:'#0891b2',Tawaran:'#f59e0b',Diterima:'#22c55e',Ditolak:'#ef4444'};
const EVAL_CRITERIA=['Teknis','Komunikasi','Kecocokan Budaya'];
let _ev=null;
function starsHtml(val,key){var h='<div class="stars">';for(var i=1;i<=5;i++){h+='<span class="st'+(i<=val?' on':'')+'" onclick="pickStar(\\''+key+'\\','+i+')">\\u2605</span>';}return h+'</div>';}
function openEval(name,opts){opts=opts||{};_ev={name:name,cvRel:opts.cvRel||null,onSave:opts.onSave||null,data:Object.assign({status:'Baru',rating:0,criteria:{},note:'',tags:[],favorite:false},opts.ev||{})};buildEval();document.getElementById('evalModal').classList.add('open');}
function closeEval(){document.getElementById('evalModal').classList.remove('open');}
function buildEval(){
  var d=_ev.data;
  document.getElementById('evTitle').textContent='Nilai — '+_ev.name;
  var cv=document.getElementById('evCv');
  if(_ev.cvRel){cv.style.display='';cv.onclick=function(){openFile(_ev.cvRel,_ev.name+' — CV');};}else cv.style.display='none';
  var statusH=STATUSES.map(function(s){var on=d.status===s;return '<div class="sopt'+(on?' active':'')+'" style="'+(on?'background:'+STATUS_COLORS[s]:'')+'" onclick="setEvStatus(\\''+s+'\\')">'+s+'</div>';}).join('');
  var critH=EVAL_CRITERIA.map(function(c){return '<div class="crit"><span class="cl">'+c+'</span>'+starsHtml(d.criteria[c]||0,'crit:'+c)+'</div>';}).join('');
  var tagsH=(d.tags||[]).map(function(t,i){return '<span class="etag-chip">'+esc(t)+'<b onclick="removeTag('+i+')">\\u00d7</b></span>';}).join('');
  document.getElementById('evBody').innerHTML=
    '<div class="efield"><label>Status Tahapan</label><div class="estatus">'+statusH+'</div></div>'+
    '<div class="efield"><label>Rating Keseluruhan</label>'+starsHtml(d.rating,'rating')+'</div>'+
    '<div class="efield"><label>Penilaian Kriteria</label>'+critH+'</div>'+
    '<div class="efield"><label>Tag / Label</label><div class="etags">'+tagsH+'</div><input class="einput" id="evTagInput" placeholder="Ketik tag lalu Enter (mis. Strong, Backend)..." onkeydown="if(event.key===\\'Enter\\'){event.preventDefault();addTag();}"></div>'+
    '<div class="efield"><label>Catatan</label><textarea class="etext" id="evNote" placeholder="Catatan tim perekrut..." oninput="_ev.data.note=this.value">'+esc(d.note||'')+'</textarea></div>'+
    '<div class="efield"><div class="efav'+(d.favorite?' on':'')+'" onclick="toggleFav()"><span class="box">'+(d.favorite?'\\u2605':'')+'</span> Tandai sebagai favorit</div></div>';
}
function pickStar(key,i){if(key==='rating')_ev.data.rating=i;else if(key.indexOf('crit:')===0)_ev.data.criteria[key.slice(5)]=i;buildEval();}
function setEvStatus(s){_ev.data.status=s;buildEval();}
function toggleFav(){_ev.data.favorite=!_ev.data.favorite;buildEval();}
function addTag(){var el=document.getElementById('evTagInput');var v=(el.value||'').trim();if(v){if(!_ev.data.tags)_ev.data.tags=[];if(_ev.data.tags.indexOf(v)<0)_ev.data.tags.push(v);el.value='';buildEval();setTimeout(function(){var n=document.getElementById('evTagInput');if(n)n.focus();},0);}}
function removeTag(i){_ev.data.tags.splice(i,1);buildEval();}
function saveEval(){
  fetch('/api/eval',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:_ev.name,patch:_ev.data})})
   .then(function(r){return r.json();}).then(function(res){toast('Penilaian disimpan');var cb=_ev.onSave;var saved=res.eval;closeEval();if(cb)cb(saved);}).catch(function(){toast('Gagal menyimpan');});
}
function statusBadge(ev){if(!ev||!ev.status)return '';return '<span class="sbadge" style="background:'+(STATUS_COLORS[ev.status]||'#64748b')+'">'+ev.status+'</span>';}
function ratingStars(ev){if(!ev||!ev.rating)return '';var s='';for(var i=0;i<ev.rating;i++)s+='\\u2605';return '<span class="rstars">'+s+'</span>';}
`;

function layout({ active, title, head = '', body, script = '' }) {
  return `<!DOCTYPE html>
<html lang="id"><head>
<meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${title}</title>
<link rel="preconnect" href="https://fonts.googleapis.com" /><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=Inter:wght@400;500;600&display=swap" rel="stylesheet" />
<script>(function(){try{var t=localStorage.getItem('theme');if(!t){t=window.matchMedia&&window.matchMedia('(prefers-color-scheme: light)').matches?'light':'dark';}document.documentElement.setAttribute('data-theme',t);}catch(e){document.documentElement.setAttribute('data-theme','dark');}})();</script>
<style>${SHARED_CSS}${head}</style>
</head><body>
<nav class="nav"><div class="nav-in">
  <a href="/" class="brand"><span class="logo">◈</span> Talent Pool</a>
  <div class="nav-links">
    <a href="/" class="${active === 'dash' ? 'active' : ''}">Dashboard</a>
    <a href="/pelamar" class="${active === 'pelamar' ? 'active' : ''}">Pelamar</a>
    <a href="/ranking" class="${active === 'ranking' ? 'active' : ''}">Ranking</a>
    <a href="/cocok" class="${active === 'cocok' ? 'active' : ''}">Pencocokan</a>
    <a href="/seleksi" class="${active === 'seleksi' ? 'active' : ''}">Seleksi</a>
    <a href="/analitik" class="${active === 'analitik' ? 'active' : ''}">Analitik</a>
    <a href="/undang" class="${active === 'undang' ? 'active' : ''}">Undang WA</a>
  </div>
  <button class="theme-toggle" id="themeToggle" title="Ganti tema terang/gelap" aria-label="Ganti tema" onclick="toggleTheme()">🌙</button>
  <button class="nav-burger" id="navBurger" aria-label="Menu" onclick="toggleNav()">
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M3 12h18M3 18h18"/></svg>
  </button>
</div></nav>
<div class="wrap">${body}</div>
${MODAL_HTML}
<script>${SHARED_JS}${script}</script>
</body></html>`;
}

/* ── Halaman: Dashboard ─────────────────────────────────────────────────────── */
function pageDashboard() {
  const head = `
  .hero{padding:54px 0 10px}
  .menu{display:grid;grid-template-columns:repeat(3,1fr);gap:18px;margin:34px 0 10px}
  .mcard{background:linear-gradient(180deg,var(--card),var(--card2));border:1px solid var(--line);
    border-radius:20px;padding:26px;transition:.22s;position:relative;overflow:hidden;display:block}
  .mcard:hover{transform:translateY(-5px);border-color:var(--line2);box-shadow:var(--shadow)}
  .mcard::before{content:"";position:absolute;top:0;left:0;right:0;height:3px;background:linear-gradient(90deg,var(--brand),var(--brand2));opacity:0;transition:.22s}
  .mcard:hover::before{opacity:1}
  .mcard .mico{width:54px;height:54px;border-radius:15px;display:grid;place-items:center;font-size:25px;margin-bottom:18px}
  .mcard h3{font-size:18px;font-weight:700}
  .mcard p{color:var(--muted);font-size:13.5px;margin-top:9px;line-height:1.55}
  .mcard .go{margin-top:16px;color:var(--brand2);font-weight:600;font-size:13.5px;display:inline-flex;align-items:center;gap:7px}
  .mcard:hover .go{gap:11px}
  @media(max-width:920px){.menu{grid-template-columns:repeat(2,1fr)}}
  @media(max-width:560px){.menu{grid-template-columns:1fr}}`;

  const body = `
  <div class="hero">
    <span class="eyebrow"><span class="dot"></span> Sistem Rekrutmen · Fullstack Developer</span>
    <h1>Selamat datang di <span class="grad">Talent Pool</span></h1>
    <p class="sub">Pusat kendali rekrutmen kandidat Fullstack Developer. Telusuri profil & dokumen pelamar, atau lihat perankingan otomatis berdasarkan estimasi pengalaman di bidang IT.</p>
  </div>
  <div class="stats" id="stats"></div>
  <div class="menu">
    <a href="/pelamar" class="mcard">
      <div class="mico" style="background:linear-gradient(135deg,#6366f1,#8b5cf6)">👥</div>
      <h3>Daftar Pelamar</h3>
      <p>Seluruh kandidat + dokumen (CV, portofolio, dll), skill terdeteksi, tautan GitHub/LinkedIn, dan tombol penilaian cepat.</p>
      <span class="go">Buka daftar &rarr;</span>
    </a>
    <a href="/ranking" class="mcard">
      <div class="mico" style="background:linear-gradient(135deg,#f59e0b,#f43f5e)">🏆</div>
      <h3>Perankingan</h3>
      <p>Estimasi otomatis lama pengalaman IT dari isi CV, lalu mengurutkan kandidat — lengkap dengan bukti & tech-stack.</p>
      <span class="go">Lihat ranking &rarr;</span>
    </a>
    <a href="/cocok" class="mcard">
      <div class="mico" style="background:linear-gradient(135deg,#22d3ee,#3b82f6)">🎯</div>
      <h3>Pencocokan Lowongan</h3>
      <p>Tentukan syarat lowongan (skill, pengalaman, pendidikan) → sistem menghitung % kecocokan tiap pelamar untuk shortlist objektif.</p>
      <span class="go">Cocokkan kandidat &rarr;</span>
    </a>
    <a href="/seleksi" class="mcard">
      <div class="mico" style="background:linear-gradient(135deg,#34d399,#10b981)">📋</div>
      <h3>Papan Seleksi</h3>
      <p>Pipeline Kanban: seret-tempel kandidat antar tahapan (Baru → Wawancara → Diterima), beri rating & catatan. Tersimpan otomatis.</p>
      <span class="go">Kelola pipeline &rarr;</span>
    </a>
    <a href="/analitik" class="mcard">
      <div class="mico" style="background:linear-gradient(135deg,#f472b6,#a855f7)">📊</div>
      <h3>Analitik & Laporan</h3>
      <p>Grafik sebaran pengalaman, skill terpopuler, pendidikan & status. Export ke Excel/CSV atau cetak PDF untuk laporan.</p>
      <span class="go">Lihat analitik &rarr;</span>
    </a>
    <a href="/undang" class="mcard">
      <div class="mico" style="background:linear-gradient(135deg,#25d366,#16a34a)">💬</div>
      <h3>Undang Grup WA</h3>
      <p>Ambil nomor WhatsApp tiap pelamar dari CV, lalu undang ke grup dengan pesan personal — atau ekspor kontak.</p>
      <span class="go">Undang peserta &rarr;</span>
    </a>
  </div>`;

  const script = `
  fetch('/api/applicants').then(r=>r.json()).then(d=>{
    const s=d.stats;const items=[
      {n:s.total,l:'Total Pelamar',i:'\\uD83D\\uDC65'},
      {n:s.withCV,l:'Melampirkan CV',i:'\\uD83D\\uDCC4'},
      {n:s.withPortfolio,l:'Dengan Portofolio',i:'\\uD83C\\uDFA8'},
      {n:s.totalFiles,l:'Total Dokumen',i:'\\uD83D\\uDCC1'}];
    document.getElementById('stats').innerHTML=items.map(x=>'<div class="stat"><div class="ico">'+x.i+'</div><div class="num">'+x.n+'</div><div class="lbl">'+x.l+'</div></div>').join('');
  });`;

  return layout({ active: 'dash', title: 'Dashboard — Talent Pool', head, body, script });
}

/* ── Halaman: Daftar Pelamar ────────────────────────────────────────────────── */
function pagePelamar() {
  const head = `
  header{padding:46px 0 8px}
  .toolbar{display:flex;gap:14px;align-items:center;margin:26px 0 8px;flex-wrap:wrap}
  .search{flex:1;min-width:240px;position:relative}
  .search input{width:100%;background:var(--card);border:1px solid var(--line2);color:var(--text);
    padding:14px 16px 14px 46px;border-radius:14px;font-size:15px;outline:none;transition:.2s;font-family:inherit}
  .search input:focus{border-color:var(--brand);box-shadow:0 0 0 4px rgba(99,102,241,.18)}
  .search svg{position:absolute;left:15px;top:50%;transform:translateY(-50%);opacity:.55}
  .filters{display:flex;gap:8px;flex-wrap:wrap}
  .chip{background:var(--card);border:1px solid var(--line2);color:var(--muted);padding:11px 16px;border-radius:999px;font-size:13.5px;cursor:pointer;transition:.18s;font-weight:500;font-family:inherit;white-space:nowrap}
  .chip:hover{color:var(--text);border-color:var(--brand)}
  .chip.active{background:linear-gradient(100deg,var(--brand),#4f46e5);color:#fff;border-color:transparent}
  .count-line{color:var(--muted2);font-size:13.5px;margin:18px 2px 6px}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,300px),1fr));gap:18px;padding-bottom:30px}
  .card{background:linear-gradient(180deg,var(--card),var(--card2));border:1px solid var(--line);border-radius:var(--radius);padding:22px;transition:.22s;position:relative;overflow:hidden;display:flex;flex-direction:column}
  .card:hover{transform:translateY(-4px);border-color:var(--line2);box-shadow:var(--shadow)}
  .card::before{content:"";position:absolute;top:0;left:0;right:0;height:3px;background:linear-gradient(90deg,var(--brand),var(--brand2));opacity:0;transition:.22s}
  .card:hover::before{opacity:1}
  .card-head{display:flex;align-items:center;gap:14px;margin-bottom:16px}
  .card .avatar{width:54px;height:54px;font-size:19px}
  .name{font-weight:700;font-size:17px;line-height:1.25}
  .meta{color:var(--muted2);font-size:12.5px;margin-top:3px}
  .badges{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:16px}
  .badge{font-size:11px;padding:5px 10px;border-radius:8px;font-weight:600;border:1px solid var(--line2);color:var(--muted)}
  .badge.cv{color:#c7d2fe;border-color:rgba(99,102,241,.45);background:rgba(99,102,241,.10)}
  .badge.porto{color:#a7f3d0;border-color:rgba(52,211,153,.4);background:rgba(52,211,153,.08)}
  .cardtop{margin-left:auto;display:flex;flex-direction:column;align-items:flex-end;gap:5px}
  .skills{display:flex;flex-wrap:wrap;gap:5px;margin-bottom:14px}
  .sk{font-size:11px;padding:4px 9px;border-radius:7px;background:rgba(99,102,241,.10);border:1px solid rgba(99,102,241,.3);color:#c7d2fe;font-weight:500}
  [data-theme="light"] .sk{color:#4338ca}
  .sk.more{background:var(--soft);border-color:var(--line2);color:var(--muted)}
  .exppill{font-size:11.5px;color:var(--muted);display:inline-flex;align-items:center;gap:5px;margin-bottom:12px;font-weight:500}
  .linkrow{display:flex;gap:8px;align-items:center;margin-bottom:14px;flex-wrap:wrap}
  .nbtn{margin-left:auto;background:linear-gradient(100deg,var(--brand),#4f46e5);color:#fff;border:0;padding:9px 14px;border-radius:10px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;display:inline-flex;align-items:center;gap:6px;transition:.15s}
  .nbtn:hover{filter:brightness(1.1)}
  .docs{display:flex;flex-direction:column;gap:8px;margin-top:auto}
  .doc{display:flex;align-items:center;gap:11px;background:var(--soft);border:1px solid var(--line);padding:10px 12px;border-radius:11px;transition:.16s;cursor:pointer}
  .doc:hover{background:rgba(99,102,241,.10);border-color:rgba(99,102,241,.4)}
  .doc .ft{width:34px;height:34px;border-radius:9px;display:grid;place-items:center;font-size:13px;font-weight:700;flex-shrink:0}
  .ft.pdf{background:rgba(244,63,94,.15);color:#fb7185}.ft.img{background:rgba(34,211,238,.15);color:#22d3ee}.ft.oth{background:rgba(148,163,184,.15);color:#cbd5e1}
  .doc-info{flex:1;min-width:0}
  .doc-name{font-size:13px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .doc-sub{font-size:11px;color:var(--muted2);margin-top:1px}
  .doc-dl{opacity:0;transition:.16s;color:var(--muted);padding:4px;border-radius:6px;flex-shrink:0}
  .doc:hover .doc-dl{opacity:1}.doc-dl:hover{color:var(--brand2);background:var(--soft)}
  .empty{text-align:center;padding:70px 20px;color:var(--muted)}.empty .big{font-size:48px;margin-bottom:16px;opacity:.6}
  .skl{background:linear-gradient(90deg,var(--card) 25%,var(--card2) 50%,var(--card) 75%);background-size:200% 100%;animation:shimmer 1.3s infinite;border-radius:var(--radius);height:220px}
  @keyframes shimmer{to{background-position:-200% 0}}`;

  const body = `
  <header>
    <span class="eyebrow"><span class="dot"></span> Talent Pool · Kandidat</span>
    <h1>Daftar <span class="grad">Pelamar</span></h1>
    <p class="sub">Telusuri seluruh kandidat beserta dokumen lamaran. Klik dokumen untuk melihat langsung, atau unduh.</p>
    <div class="stats" id="stats"></div>
  </header>
  <div class="toolbar">
    <div class="search">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>
      <input id="search" type="text" placeholder="Cari nama atau skill (mis. React, Laravel)..." autocomplete="off" />
    </div>
    <div class="filters" id="filters"></div>
  </div>
  <div class="count-line" id="countLine"></div>
  <div class="grid" id="grid"></div>`;

  const script = `
  let ALL=[],activeFilter='Semua',searchTerm='';
  function nilai(name){const a=ALL.find(x=>x.name===name);if(!a)return;openEval(name,{cvRel:a.cvRel,ev:a.eval,onSave:(saved)=>{a.eval=saved;render();}});}
  function linkBtn(url,svg,title){return url?'<a class="lnkbtn" href="'+url+'" target="_blank" rel="noopener" title="'+title+'">'+svg+'</a>':'';}
  const GH='<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.58 2 12.25c0 4.53 2.87 8.37 6.84 9.73.5.1.68-.22.68-.49v-1.7c-2.78.62-3.37-1.37-3.37-1.37-.45-1.18-1.11-1.5-1.11-1.5-.91-.64.07-.62.07-.62 1 .07 1.53 1.06 1.53 1.06.9 1.57 2.36 1.12 2.94.86.09-.67.35-1.12.64-1.38-2.22-.26-4.56-1.14-4.56-5.06 0-1.12.39-2.03 1.03-2.75-.1-.26-.45-1.3.1-2.7 0 0 .84-.27 2.75 1.05a9.3 9.3 0 0 1 5 0c1.91-1.32 2.75-1.05 2.75-1.05.55 1.4.2 2.44.1 2.7.64.72 1.03 1.63 1.03 2.75 0 3.93-2.34 4.79-4.57 5.05.36.32.68.94.68 1.9v2.82c0 .27.18.6.69.49A10.26 10.26 0 0 0 22 12.25C22 6.58 17.52 2 12 2z"/></svg>';
  const LI='<svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 3a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h14zM8.34 18.34V9.99H5.67v8.35h2.67zM7 8.82a1.55 1.55 0 1 0 0-3.1 1.55 1.55 0 0 0 0 3.1zm11.34 9.52v-4.58c0-2.45-1.31-3.59-3.06-3.59-1.41 0-2.04.78-2.39 1.32v-1.13h-2.67c.04.75 0 8.35 0 8.35h2.67v-4.66c0-.24.02-.48.09-.65.19-.48.63-.97 1.37-.97.97 0 1.36.74 1.36 1.81v4.47h2.63z"/></svg>';
  const WEB='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18"/></svg>';
  async function load(){
    document.getElementById('grid').innerHTML='<div class="skl"></div>'.repeat(6);
    const d=await (await fetch('/api/applicants')).json();ALL=d.applicants;
    const s=d.stats;const items=[{n:s.total,l:'Total Pelamar',i:'\\uD83D\\uDC65'},{n:s.withCV,l:'Melampirkan CV',i:'\\uD83D\\uDCC4'},{n:s.withPortfolio,l:'Dengan Portofolio',i:'\\uD83C\\uDFA8'},{n:s.totalFiles,l:'Total Dokumen',i:'\\uD83D\\uDCC1'}];
    document.getElementById('stats').innerHTML=items.map(x=>'<div class="stat"><div class="ico">'+x.i+'</div><div class="num">'+x.n+'</div><div class="lbl">'+x.l+'</div></div>').join('');
    renderFilters();render();
  }
  function renderFilters(){
    const cats=new Set(['Semua']);ALL.forEach(a=>a.categories.forEach(c=>cats.add(c)));
    const order=['Semua','CV','Portofolio','SKCK','Ijazah & Transkrip','Surat Lamaran','Surat Sehat','Sertifikat','Foto','KTP','Dokumen Lain'];
    const sorted=[...cats].sort((a,b)=>{const ia=order.indexOf(a),ib=order.indexOf(b);return(ia<0?99:ia)-(ib<0?99:ib);});
    document.getElementById('filters').innerHTML=sorted.map(c=>'<div class="chip'+(c===activeFilter?' active':'')+'" data-c="'+esc(c)+'">'+esc(c)+'</div>').join('');
    document.querySelectorAll('.chip').forEach(ch=>ch.onclick=()=>{activeFilter=ch.dataset.c;renderFilters();render();});
  }
  function ftClass(f){return f.isPdf?'pdf':f.isImage?'img':'oth';}
  function ftLabel(f){return f.isPdf?'PDF':f.isImage?'IMG':(f.ext.replace('.','').toUpperCase().slice(0,3)||'?');}
  function matchSearch(a){if(!searchTerm)return true;const q=searchTerm;if(a.name.toLowerCase().includes(q))return true;return (a.tech||[]).some(t=>t.toLowerCase().includes(q));}
  function render(){
    const grid=document.getElementById('grid');
    let list=ALL.filter(a=>matchSearch(a)&&(activeFilter==='Semua'||a.categories.includes(activeFilter)));
    document.getElementById('countLine').textContent='Menampilkan '+list.length+' dari '+ALL.length+' pelamar';
    if(!list.length){grid.innerHTML='<div class="empty" style="grid-column:1/-1"><div class="big">\\uD83D\\uDD0D</div>Tidak ada pelamar yang cocok.</div>';return;}
    grid.innerHTML=list.map(a=>{
      const files=activeFilter==='Semua'?a.files:a.files.filter(f=>f.category===activeFilter);
      const docs=files.map(f=>'<div class="doc" onclick="openFile(\\''+f.rel.replace(/'/g,"\\\\'")+'\\',\\''+esc(a.name).replace(/'/g,"")+' — '+esc(f.name).replace(/'/g,"")+'\\')">'+
        '<div class="ft '+ftClass(f)+'">'+ftLabel(f)+'</div>'+
        '<div class="doc-info"><div class="doc-name">'+esc(f.name)+'</div><div class="doc-sub">'+esc(f.category)+' \\u00b7 '+f.sizeHuman+'</div></div>'+
        '<a class="doc-dl" href="/file?path='+encodeURIComponent(f.rel)+'&download=1" onclick="event.stopPropagation()" title="Unduh"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v12m0 0 4-4m-4 4-4-4M5 21h14"/></svg></a></div>').join('');
      const badges=[];if(a.hasCV)badges.push('<span class="badge cv">CV</span>');if(a.hasPortfolio)badges.push('<span class="badge porto">Portofolio</span>');
      a.categories.filter(c=>c!=='CV'&&c!=='Portofolio').forEach(c=>badges.push('<span class="badge">'+esc(c)+'</span>'));
      const tech=(a.tech||[]).slice(0,6).map(t=>'<span class="sk">'+esc(t)+'</span>').join('')+((a.tech||[]).length>6?'<span class="sk more">+'+((a.tech||[]).length-6)+'</span>':'');
      const exp=a.estimateYears>0?'<div class="exppill">\\uD83D\\uDCBC '+esc(a.estimateLabel)+' pengalaman'+(a.education?' \\u00b7 \\uD83C\\uDF93 '+esc(a.education):'')+'</div>':(a.education?'<div class="exppill">\\uD83C\\uDF93 '+esc(a.education)+'</div>':'');
      const lk=a.links||{};
      const links=linkBtn(lk.github,GH,'GitHub')+linkBtn(lk.linkedin,LI,'LinkedIn')+linkBtn(lk.website,WEB,'Website/Portfolio');
      const top=(a.eval&&(a.eval.status||a.eval.rating))?'<div class="cardtop">'+statusBadge(a.eval)+ratingStars(a.eval)+'</div>':'';
      return '<div class="card"><div class="card-head"><div class="avatar" style="background:'+gradFor(a.name)+'">'+esc(a.initials)+'</div><div><div class="name">'+esc(a.name)+'</div><div class="meta">'+a.fileCount+' dokumen</div></div>'+top+'</div>'+
        exp+
        (tech?'<div class="skills">'+tech+'</div>':'')+
        '<div class="linkrow">'+links+'<button class="nbtn" onclick="nilai(\\''+a.name.replace(/'/g,"\\\\'")+'\\')">\\u2605 Nilai</button></div>'+
        '<div class="badges">'+badges.join('')+'</div><div class="docs">'+docs+'</div></div>';
    }).join('');
  }
  let t;document.getElementById('search').addEventListener('input',e=>{clearTimeout(t);t=setTimeout(()=>{searchTerm=e.target.value.trim().toLowerCase();render();},120);});
  load();`;

  return layout({ active: 'pelamar', title: 'Daftar Pelamar — Talent Pool', head, body, script });
}

/* ── Halaman: Perankingan ───────────────────────────────────────────────────── */
function pageRanking() {
  const head = `
  header{padding:46px 0 8px}
  .topbar{display:flex;align-items:center;gap:14px;margin:24px 0 6px;flex-wrap:wrap}
  .btn{background:linear-gradient(100deg,var(--brand),#4f46e5);color:#fff;border:0;padding:12px 20px;border-radius:12px;font-size:14px;font-weight:600;cursor:pointer;font-family:inherit;display:inline-flex;align-items:center;gap:9px;transition:.15s}
  .btn:hover{filter:brightness(1.1)}.btn:disabled{opacity:.6;cursor:wait}
  .btn.ghost{background:var(--card);border:1px solid var(--line2)}
  .note{background:rgba(245,158,11,.08);border:1px solid rgba(245,158,11,.3);color:#fcd9a3;border-radius:14px;padding:14px 18px;font-size:13.5px;line-height:1.6;margin:6px 0 8px}
  .note b{color:#fde7c4}
  /* Podium */
  .podium{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin:24px 0 10px;align-items:end}
  .pod{background:linear-gradient(180deg,var(--card),var(--card2));border:1px solid var(--line2);border-radius:20px;padding:24px 20px;text-align:center;position:relative;overflow:hidden}
  .pod .medal{font-size:34px;margin-bottom:8px}
  .pod .avatar{width:64px;height:64px;font-size:22px;margin:0 auto 12px}
  .pod .pname{font-weight:700;font-size:16px;line-height:1.25}
  .pod .pyears{font-size:24px;font-weight:800;font-family:'Plus Jakarta Sans';margin-top:8px}
  .pod.g1{border-color:rgba(251,191,36,.55);box-shadow:0 0 40px rgba(251,191,36,.12)}
  .pod.g1::before{content:"";position:absolute;inset:0;background:radial-gradient(160px 80px at 50% 0,rgba(251,191,36,.18),transparent 70%)}
  .pod.g1 .pyears{color:var(--gold)}.pod.g2 .pyears{color:var(--silver)}.pod.g3 .pyears{color:var(--bronze)}
  /* Rows */
  .rows{display:flex;flex-direction:column;gap:10px;padding-bottom:20px}
  .row{background:linear-gradient(180deg,var(--card),var(--card2));border:1px solid var(--line);border-radius:14px;padding:14px 18px;display:flex;align-items:center;gap:16px;transition:.16s}
  .row:hover{border-color:var(--line2)}
  .rank-no{font-family:'Plus Jakarta Sans';font-weight:800;font-size:18px;color:var(--muted2);width:34px;text-align:center;flex-shrink:0}
  .row .avatar{width:46px;height:46px;font-size:16px}
  .who{min-width:160px;flex-shrink:0}
  .who .nm{font-weight:700;font-size:15px}
  .who .ed{color:var(--muted2);font-size:12px;margin-top:2px}
  .barwrap{flex:1;min-width:120px}
  .barwrap .bartop{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px}
  .yrs{font-weight:700;font-size:14px}
  .conf{font-size:10.5px;padding:3px 8px;border-radius:6px;font-weight:600;text-transform:uppercase;letter-spacing:.04em}
  .conf.tinggi{color:#a7f3d0;background:rgba(52,211,153,.12);border:1px solid rgba(52,211,153,.35)}
  .conf.sedang{color:#fcd9a3;background:rgba(245,158,11,.12);border:1px solid rgba(245,158,11,.35)}
  .conf.rendah{color:#cbd5e1;background:rgba(148,163,184,.12);border:1px solid rgba(148,163,184,.3)}
  .bar{height:8px;background:var(--barbg);border-radius:99px;overflow:hidden}
  .bar > i{display:block;height:100%;border-radius:99px;background:linear-gradient(90deg,var(--brand),var(--brand2))}
  .tech{display:flex;gap:5px;flex-wrap:wrap;margin-top:8px}
  .tg{font-size:10.5px;padding:3px 8px;border-radius:6px;background:rgba(99,102,241,.10);border:1px solid rgba(99,102,241,.3);color:#c7d2fe}
  .ractions{display:flex;gap:8px;flex-shrink:0}
  .iconbtn{background:var(--card);border:1px solid var(--line2);color:var(--muted);padding:9px 13px;border-radius:10px;font-size:12.5px;cursor:pointer;font-family:inherit;transition:.15s;white-space:nowrap}
  .iconbtn:hover{color:#fff;border-color:var(--brand)}
  .ev{margin-top:10px;background:var(--inset);border:1px solid var(--line);border-radius:10px;padding:12px 14px;font-size:12.5px;display:none}
  .ev.open{display:block}
  .ev h4{font-size:12px;color:var(--muted);font-weight:600;margin-bottom:8px;text-transform:uppercase;letter-spacing:.05em}
  .ev .eitem{display:flex;gap:10px;padding:5px 0;border-bottom:1px solid var(--line);align-items:flex-start}
  .ev .eitem:last-child{border:0}
  .etag{font-size:10px;padding:2px 7px;border-radius:5px;font-weight:600;flex-shrink:0;margin-top:1px}
  .etag.kerja{background:rgba(52,211,153,.14);color:#a7f3d0}.etag.pendidikan{background:rgba(99,102,241,.14);color:#c7d2fe}.etag.organisasi{background:rgba(148,163,184,.14);color:#cbd5e1}.etag.klaim{background:rgba(245,158,11,.14);color:#fcd9a3}
  .etxt{color:var(--muted);line-height:1.5}
  .rowwrap{display:flex;flex-direction:column}
  .loading{text-align:center;padding:70px 20px;color:var(--muted)}
  .spinner{width:42px;height:42px;border:4px solid var(--line2);border-top-color:var(--brand);border-radius:50%;margin:0 auto 18px;animation:spin .8s linear infinite}
  @keyframes spin{to{transform:rotate(360deg)}}
  @media(max-width:820px){.podium{grid-template-columns:1fr}.who{min-width:120px}.row{flex-wrap:wrap}}
  @media(max-width:640px){
    .row{padding:13px 14px;gap:11px}
    .barwrap{flex-basis:100%;order:3}
    .ractions{flex-basis:100%;justify-content:flex-start;order:4}
    .who{flex:1}
    .iconbtn{flex:1;justify-content:center;text-align:center}
  }`;

  const body = `
  <header>
    <span class="eyebrow"><span class="dot"></span> Analisis Otomatis · CV</span>
    <h1>Perankingan <span class="grad">Pengalaman IT</span></h1>
    <p class="sub">Sistem membaca isi CV setiap kandidat, lalu memperkirakan total lama pengalaman kerja di bidang IT dari rentang tanggal pekerjaan & pernyataan eksplisit — mengurutkan dari yang paling berpengalaman.</p>
  </header>
  <div class="topbar">
    <button class="btn" id="reanalyze">↻ Analisis Ulang CV</button>
    <span id="meta" style="color:var(--muted2);font-size:13px"></span>
  </div>
  <div class="note">
    <b>Cara kerja & catatan:</b> Estimasi dihitung otomatis dari teks CV (rentang tanggal pekerjaan + klaim "X tahun pengalaman"). Tahun <b>pendidikan</b> & <b>organisasi</b> sengaja dikecualikan. Karena format CV beragam, angka ini bersifat <b>perkiraan bantu</b> — selalu verifikasi lewat tombol <b>Lihat CV</b>. CV berupa hasil scan/gambar tidak dapat dibaca otomatis.
  </div>
  <div class="stats" id="stats"></div>
  <div id="content"><div class="loading"><div class="spinner"></div>Menganalisis CV seluruh pelamar...</div></div>`;

  const script = `
  let DATA=null;
  function medal(r){return r===1?'\\uD83E\\uDD47':r===2?'\\uD83E\\uDD48':r===3?'\\uD83E\\uDD49':'';}
  async function load(refresh){
    const c=document.getElementById('content');
    c.innerHTML='<div class="loading"><div class="spinner"></div>'+(refresh?'Menganalisis ulang seluruh CV...':'Menganalisis CV seluruh pelamar...')+'</div>';
    const d=await (await fetch('/api/ranking'+(refresh?'?refresh=1':''))).json();DATA=d;
    renderStats(d.stats);render(d.ranking,d.stats);
    document.getElementById('meta').textContent=d.stats.analyzed+' CV dianalisis \\u00b7 rata-rata '+d.stats.avgYears+' thn';
  }
  function renderStats(s){
    const items=[{n:s.withExperience,l:'Terdeteksi Pengalaman',i:'\\u2705'},{n:s.avgYears+' thn',l:'Rata-rata Pengalaman',i:'\\uD83D\\uDCCA'},{n:Math.round(s.maxYears*10)/10+' thn',l:'Tertinggi',i:'\\uD83C\\uDFC6'},{n:s.unreadable,l:'CV Tak Terbaca',i:'\\u26A0\\uFE0F'}];
    document.getElementById('stats').innerHTML=items.map(x=>'<div class="stat"><div class="ico">'+x.i+'</div><div class="num">'+x.n+'</div><div class="lbl">'+x.l+'</div></div>').join('');
  }
  function techChips(arr,n){return (arr||[]).slice(0,n).map(t=>'<span class="tg">'+esc(t)+'</span>').join('')+((arr||[]).length>n?'<span class="tg">+'+((arr||[]).length-n)+'</span>':'');}
  function cvBtn(r){return r.cvRel?'<button class="iconbtn" onclick="openFile(\\''+r.cvRel.replace(/'/g,"\\\\'")+'\\',\\''+esc(r.name).replace(/'/g,"")+' — CV\\')">\\uD83D\\uDCC4 Lihat CV</button>':'<span class="iconbtn" style="opacity:.5">Tanpa CV</span>';}
  function ocrBtn(r){return (r.confidence==='rendah'&&r.cvRel)?'<button class="iconbtn" style="border-color:rgba(34,211,238,.5);color:#22d3ee" onclick="doOcr(\\''+r.name.replace(/'/g,"\\\\'")+'\\',this)">\\uD83D\\uDD0E Coba OCR</button>':'';}
  function doOcr(name,btn){btn.disabled=true;btn.textContent='\\u23F3 OCR...';toast('Menjalankan OCR untuk '+name+' (perlu beberapa detik)...');fetch('/api/ocr',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:name})}).then(r=>r.json()).then(res=>{if(res.ok){toast('OCR selesai \\u2014 '+name);load(false);}else{toast('OCR gagal: '+(res.error||''));btn.disabled=false;btn.textContent='\\uD83D\\uDD0E Coba OCR';}}).catch(()=>{toast('OCR gagal');btn.disabled=false;btn.textContent='\\uD83D\\uDD0E Coba OCR';});}
  function render(rank,stats){
    const max=stats.maxYears||1;
    const top=rank.filter(r=>r.estimateYears>0).slice(0,3);
    let podium='';
    if(top.length){
      podium='<div class="podium">'+top.map(r=>'<div class="pod g'+r.rank+'"><div class="medal">'+medal(r.rank)+'</div><div class="avatar" style="background:'+gradFor(r.name)+'">'+esc(r.initials)+'</div><div class="pname">'+esc(r.name)+'</div><div class="pyears">'+esc(r.estimateLabel)+'</div><div class="tech" style="justify-content:center">'+techChips(r.tech,4)+'</div></div>').join('')+'</div>';
    }
    const rows=rank.map(r=>{
      const pct=Math.max(2,Math.round(r.estimateYears/max*100));
      const ev=(r.evidence&&r.evidence.length)?('<div class="ev" id="ev'+r.rank+'"><h4>Bukti dari CV ('+r.evidence.length+')</h4>'+r.evidence.map(e=>'<div class="eitem"><span class="etag '+e.kind+'">'+e.kind+' \\u00b7 '+e.years+'th</span><span class="etxt">\\u2026'+esc(e.raw)+'\\u2026</span></div>').join('')+(r.note?'<div class="etxt" style="margin-top:8px;color:var(--accent)">\\u26A0\\uFE0F '+esc(r.note)+'</div>':'')+'</div>'):(r.note?'<div class="ev" id="ev'+r.rank+'"><div class="etxt" style="color:var(--accent)">\\u26A0\\uFE0F '+esc(r.note)+'</div></div>':'');
      const hasEv=(r.evidence&&r.evidence.length)||r.note;
      return '<div class="rowwrap"><div class="row">'+
        '<div class="rank-no">'+(medal(r.rank)||r.rank)+'</div>'+
        '<div class="avatar" style="background:'+gradFor(r.name)+'">'+esc(r.initials)+'</div>'+
        '<div class="who"><div class="nm">'+esc(r.name)+'</div><div class="ed">'+(r.education?esc(r.education):'\\u2014')+' \\u00b7 '+r.fileCount+' dok</div></div>'+
        '<div class="barwrap"><div class="bartop"><span class="yrs">'+esc(r.estimateLabel)+'</span><span class="conf '+r.confidence+'">'+r.confidence+'</span></div><div class="bar"><i style="width:'+pct+'%"></i></div><div class="tech">'+techChips(r.tech,8)+'</div></div>'+
        '<div class="ractions">'+(hasEv?'<button class="iconbtn" onclick="toggleEv('+r.rank+')">Bukti</button>':'')+ocrBtn(r)+cvBtn(r)+'</div>'+
        '</div>'+ev+'</div>';
    }).join('');
    document.getElementById('content').innerHTML=podium+'<div class="rows">'+rows+'</div>';
  }
  function toggleEv(r){document.getElementById('ev'+r).classList.toggle('open');}
  document.getElementById('reanalyze').addEventListener('click',async()=>{const b=document.getElementById('reanalyze');b.disabled=true;b.textContent='\\u23F3 Menganalisis...';await load(true);b.disabled=false;b.textContent='\\u21BB Analisis Ulang CV';});
  load(false);`;

  return layout({ active: 'ranking', title: 'Perankingan — Talent Pool', head, body, script });
}

/* ── Halaman: Undang ke Grup WhatsApp ───────────────────────────────────────── */
function pageUndang() {
  const head = `
  header{padding:46px 0 8px}
  .cfg{background:linear-gradient(180deg,var(--card),var(--card2));border:1px solid var(--line2);border-radius:18px;padding:22px 24px;margin:24px 0 6px;display:grid;grid-template-columns:1fr 1fr;gap:20px}
  .field label{display:block;font-size:13px;font-weight:600;color:var(--muted);margin-bottom:8px}
  .field input,.field textarea{width:100%;background:var(--bg2);border:1px solid var(--line2);color:var(--text);padding:12px 14px;border-radius:11px;font-size:14px;outline:none;font-family:inherit;transition:.2s;resize:vertical}
  .field input:focus,.field textarea:focus{border-color:var(--brand);box-shadow:0 0 0 4px rgba(99,102,241,.16)}
  .field textarea{min-height:118px;line-height:1.55}
  .hint{font-size:11.5px;color:var(--muted2);margin-top:7px;line-height:1.5}
  .hint code{background:var(--soft);padding:1px 6px;border-radius:5px;color:var(--brand2);font-size:11px}
  .linkbad{border-color:rgba(244,63,94,.5)!important}
  .note{background:rgba(245,158,11,.08);border:1px solid rgba(245,158,11,.3);color:#fcd9a3;border-radius:14px;padding:14px 18px;font-size:13.5px;line-height:1.6;margin:6px 0 8px}
  .note b{color:#fde7c4}
  .bulk{display:flex;gap:10px;flex-wrap:wrap;margin:20px 0 4px;align-items:center}
  .btn{background:linear-gradient(100deg,var(--brand),#4f46e5);color:#fff;border:0;padding:11px 18px;border-radius:11px;font-size:13.5px;font-weight:600;cursor:pointer;font-family:inherit;display:inline-flex;align-items:center;gap:8px;transition:.15s}
  .btn:hover{filter:brightness(1.1)}.btn:disabled{opacity:.5;cursor:not-allowed}
  .btn.wa{background:linear-gradient(100deg,#22c55e,#16a34a)}
  .btn.ghost{background:var(--card);border:1px solid var(--line2);color:var(--text)}
  .progress{flex:1;min-width:180px}
  .progress .ptop{display:flex;justify-content:space-between;font-size:12px;color:var(--muted2);margin-bottom:6px}
  .pbar{height:8px;background:var(--barbg);border-radius:99px;overflow:hidden}.pbar>i{display:block;height:100%;background:linear-gradient(90deg,#22c55e,#16a34a);border-radius:99px;transition:width .3s}
  .toolbar2{display:flex;gap:12px;align-items:center;margin:18px 0 6px;flex-wrap:wrap}
  .search{flex:1;min-width:220px;position:relative}
  .search input{width:100%;background:var(--card);border:1px solid var(--line2);color:var(--text);padding:12px 14px 12px 42px;border-radius:12px;font-size:14px;outline:none;font-family:inherit}
  .search input:focus{border-color:var(--brand)}
  .search svg{position:absolute;left:13px;top:50%;transform:translateY(-50%);opacity:.55}
  .chips{display:flex;gap:8px;flex-wrap:wrap}
  .chip{background:var(--card);border:1px solid var(--line2);color:var(--muted);padding:10px 15px;border-radius:999px;font-size:13px;cursor:pointer;font-weight:500;font-family:inherit;transition:.15s;white-space:nowrap}
  .chip:hover{color:var(--text);border-color:var(--brand)}.chip.active{background:linear-gradient(100deg,var(--brand),#4f46e5);color:#fff;border-color:transparent}
  .clist{display:flex;flex-direction:column;gap:10px;padding-bottom:30px;margin-top:8px}
  .citem{background:linear-gradient(180deg,var(--card),var(--card2));border:1px solid var(--line);border-radius:14px;padding:14px 18px;display:flex;align-items:center;gap:15px;transition:.16s}
  .citem:hover{border-color:var(--line2)}
  .citem.done{border-color:rgba(34,197,94,.4);background:linear-gradient(180deg,rgba(34,197,94,.06),var(--card2))}
  .citem .avatar{width:46px;height:46px;font-size:16px}
  .cwho{min-width:150px;flex:1}
  .cwho .nm{font-weight:700;font-size:15px;display:flex;align-items:center;gap:8px}
  .cwho .em{color:var(--muted2);font-size:12px;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:280px}
  .cnum{font-family:'Plus Jakarta Sans';font-weight:600;font-size:14px;min-width:150px}
  .cnum.miss{color:var(--muted2);font-weight:500;font-size:13px}
  .csrc{font-size:10.5px;color:var(--muted2);font-weight:400;margin-top:2px}
  .cact{display:flex;gap:8px;flex-shrink:0;flex-wrap:wrap;justify-content:flex-end}
  .iconbtn{background:var(--card);border:1px solid var(--line2);color:var(--muted);padding:9px 13px;border-radius:10px;font-size:12.5px;cursor:pointer;font-family:inherit;transition:.15s;white-space:nowrap;display:inline-flex;align-items:center;gap:6px}
  .iconbtn:hover{color:#fff;border-color:var(--brand)}
  .tick{width:22px;height:22px;border-radius:50%;background:#22c55e;color:#fff;display:grid;place-items:center;font-size:13px;flex-shrink:0}
  .loading{text-align:center;padding:70px 20px;color:var(--muted)}
  .spinner{width:42px;height:42px;border:4px solid var(--line2);border-top-color:var(--brand);border-radius:50%;margin:0 auto 18px;animation:spin .8s linear infinite}
  @keyframes spin{to{transform:rotate(360deg)}}
  @media(max-width:820px){.cfg{grid-template-columns:1fr}.citem{flex-wrap:wrap}.cwho{min-width:120px}.cnum{min-width:auto}}
  @media(max-width:640px){
    .cfg{padding:18px}
    .citem{gap:12px}
    .cwho{flex:1;min-width:0}.cwho .em{max-width:60vw}
    .cnum{flex-basis:calc(100% - 61px);margin-left:61px;margin-top:-4px}
    .cact{flex-basis:100%;justify-content:flex-start}
    .cact .iconbtn{flex:1;justify-content:center}
    .bulk .btn{flex:1;justify-content:center}
    .progress{flex-basis:100%}
  }`;

  const body = `
  <header>
    <span class="eyebrow"><span class="dot"></span> Otomasi Rekrutmen · WhatsApp</span>
    <h1>Undang ke <span class="grad">Grup WhatsApp</span></h1>
    <p class="sub">Nomor WhatsApp setiap pelamar diambil otomatis dari CV. Atur link grup & pesan, lalu undang peserta satu per satu dengan pesan personal — atau ekspor seluruh kontak.</p>
  </header>
  <div class="note">
    <b>Cara kerja:</b> WhatsApp tidak mengizinkan menambah anggota grup secara otomatis tanpa persetujuan (kebijakan anti-spam). Pendekatan yang dipakai: tombol <b>Undang via WA</b> membuka chat pribadi ke nomor pelamar berisi <b>pesan + link grup</b> yang siap dikirim. Alternatif: <b>Salin Semua Nomor</b> atau <b>Ekspor vCard</b> untuk diimpor ke kontak HP.
  </div>

  <div class="cfg">
    <div class="field">
      <label for="glink">🔗 Link Undangan Grup WhatsApp</label>
      <input id="glink" type="text" placeholder="https://chat.whatsapp.com/XXXXXXXXXXXXXXX" autocomplete="off" />
      <div class="hint">Buat grup di WhatsApp → Info Grup → <b>Undang via tautan</b> → salin & tempel di sini.</div>
    </div>
    <div class="field">
      <label for="gmsg">💬 Template Pesan Undangan</label>
      <textarea id="gmsg" placeholder="Tulis pesan..."></textarea>
      <div class="hint">Placeholder: <code>{nama}</code> = nama pelamar, <code>{link}</code> = link grup. Format WA: <code>*tebal*</code>, <code>_miring_</code>.</div>
    </div>
  </div>

  <div class="stats" id="stats"></div>

  <div class="bulk">
    <button class="btn wa" id="nextBtn">▶ Undang Berikutnya</button>
    <button class="btn ghost" id="copyAll">📋 Salin Semua Nomor</button>
    <button class="btn ghost" id="expVcf">📇 Ekspor vCard</button>
    <button class="btn ghost" id="expCsv">📄 Ekspor CSV</button>
    <button class="btn ghost" id="resetInv">↺ Reset Tanda</button>
    <div class="progress"><div class="ptop"><span id="pTxt">0 diundang</span><span id="pPct">0%</span></div><div class="pbar"><i id="pBar" style="width:0%"></i></div></div>
  </div>

  <div class="toolbar2">
    <div class="search"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg><input id="search" type="text" placeholder="Cari nama..." autocomplete="off" /></div>
    <div class="chips" id="chips"></div>
  </div>

  <div id="content"><div class="loading"><div class="spinner"></div>Mengambil nomor WhatsApp dari CV...</div></div>`;

  const DEFAULT_MSG = 'Halo {nama}! 👋\\n\\nSelamat, Anda kami undang untuk bergabung ke grup WhatsApp peserta seleksi *Fullstack Developer*.\\n\\nSilakan gabung melalui tautan berikut:\\n{link}\\n\\nMohon segera bergabung ya. Terima kasih! 🙏';

  const script = `
  let ALL=[],view=[],activeFilter='Semua',searchTerm='';
  const LS_LINK='wa_group_link',LS_MSG='wa_msg_tpl',LS_INV='wa_invited',LS_MAN='wa_manual';
  let invited=new Set(JSON.parse(localStorage.getItem(LS_INV)||'[]'));
  let manual=JSON.parse(localStorage.getItem(LS_MAN)||'{}');
  const linkEl=document.getElementById('glink'),msgEl=document.getElementById('gmsg');
  linkEl.value=localStorage.getItem(LS_LINK)||'';
  msgEl.value=localStorage.getItem(LS_MSG)||"${DEFAULT_MSG}";
  linkEl.addEventListener('input',()=>{localStorage.setItem(LS_LINK,linkEl.value.trim());validateLink();});
  msgEl.addEventListener('input',()=>localStorage.setItem(LS_MSG,msgEl.value));
  function validateLink(){const v=linkEl.value.trim();linkEl.classList.toggle('linkbad',v.length>0&&!/^https:\\/\\/chat\\.whatsapp\\.com\\//.test(v));}
  function saveInv(){localStorage.setItem(LS_INV,JSON.stringify([...invited]));}
  function saveMan(){localStorage.setItem(LS_MAN,JSON.stringify(manual));}

  function phoneOf(c){return manual[c.name]||(c.phones&&c.phones[0])||'';}
  function normNum(v){let d=(v||'').replace(/\\D/g,'');if(d.startsWith('0'))d='62'+d.slice(1);else if(d.startsWith('8'))d='62'+d;if(!d.startsWith('62')||d[2]!=='8')return'';if(d.length<11||d.length>14)return'';return d;}
  function pretty(d){if(!d||!d.startsWith('62'))return d;const r=d.slice(2);return '+62 '+[r.slice(0,3),r.slice(3,7),r.slice(7)].filter(Boolean).join('-');}
  function waUrl(num,name){const msg=msgEl.value.replace(/{nama}/g,name).replace(/{link}/g,linkEl.value.trim());return 'https://wa.me/'+num+'?text='+encodeURIComponent(msg);}

  async function load(refresh){
    const c=document.getElementById('content');
    c.innerHTML='<div class="loading"><div class="spinner"></div>'+(refresh?'Membaca ulang CV...':'Mengambil nomor WhatsApp dari CV...')+'</div>';
    const d=await (await fetch('/api/contacts'+(refresh?'?refresh=1':''))).json();
    ALL=d.contacts;renderStats();renderChips();render();
  }
  function withNum(){return ALL.filter(c=>phoneOf(c));}
  function renderStats(){
    const wn=withNum().length,inv=ALL.filter(c=>invited.has(c.name)).length;
    const items=[{n:ALL.length,l:'Total Pelamar',i:'\\uD83D\\uDC65'},{n:wn,l:'Nomor Terdeteksi',i:'\\uD83D\\uDCF1'},{n:ALL.length-wn,l:'Tanpa Nomor',i:'\\u2753'},{n:inv,l:'Sudah Diundang',i:'\\u2705'}];
    document.getElementById('stats').innerHTML=items.map(x=>'<div class="stat"><div class="ico">'+x.i+'</div><div class="num">'+x.n+'</div><div class="lbl">'+x.l+'</div></div>').join('');
    const wn2=withNum().length,p=wn2?Math.round(inv/wn2*100):0;
    document.getElementById('pTxt').textContent=inv+' dari '+wn2+' diundang';
    document.getElementById('pPct').textContent=p+'%';document.getElementById('pBar').style.width=p+'%';
  }
  function renderChips(){
    const cats=['Semua','Punya Nomor','Belum Diundang','Tanpa Nomor'];
    document.getElementById('chips').innerHTML=cats.map(c=>'<div class="chip'+(c===activeFilter?' active':'')+'" data-c="'+c+'">'+c+'</div>').join('');
    document.querySelectorAll('.chip').forEach(ch=>ch.onclick=()=>{activeFilter=ch.dataset.c;renderChips();render();});
  }
  function passFilter(c){const has=!!phoneOf(c);if(activeFilter==='Punya Nomor')return has;if(activeFilter==='Tanpa Nomor')return !has;if(activeFilter==='Belum Diundang')return has&&!invited.has(c.name);return true;}
  function render(){
    view=ALL.filter(c=>(!searchTerm||c.name.toLowerCase().includes(searchTerm))&&passFilter(c));
    const el=document.getElementById('content');
    if(!view.length){el.innerHTML='<div class="loading">Tidak ada data yang cocok.</div>';return;}
    el.innerHTML='<div class="clist">'+view.map((c,i)=>{
      const num=phoneOf(c),done=invited.has(c.name);
      const numHtml=num?('<div class="cnum">'+pretty(num)+(c.phoneSource&&!manual[c.name]?'<div class="csrc">dari '+esc(c.phoneSource)+'</div>':(manual[c.name]?'<div class="csrc">input manual</div>':''))+'</div>'):'<div class="cnum miss">Nomor tidak terdeteksi</div>';
      let act='';
      if(num){act+='<button class="iconbtn" style="border-color:rgba(34,197,94,.5);color:#4ade80" onclick="invite('+i+')">\\uD83D\\uDCAC '+(done?'Undang lagi':'Undang via WA')+'</button>';
        act+='<button class="iconbtn" onclick="copyText(\\''+num+'\\',\\'Nomor disalin\\')">Salin</button>';}
      else{act+='<button class="iconbtn" onclick="setManual('+i+')">+ Isi Nomor</button>';}
      if(c.cvRel)act+='<button class="iconbtn" onclick="openFile(\\''+c.cvRel.replace(/'/g,"\\\\'")+'\\',\\''+esc(c.name).replace(/'/g,"")+' — CV\\')">CV</button>';
      const tick=done?'<span class="tick">\\u2713</span>':'';
      return '<div class="citem'+(done?' done':'')+'"><div class="avatar" style="background:'+gradFor(c.name)+'">'+esc(c.initials)+'</div>'+
        '<div class="cwho"><div class="nm">'+esc(c.name)+tick+'</div>'+(c.emails&&c.emails[0]?'<div class="em">'+esc(c.emails[0])+'</div>':'')+'</div>'+
        numHtml+'<div class="cact">'+act+'</div></div>';
    }).join('')+'</div>';
  }
  function invite(i){
    const c=view[i],num=phoneOf(c);
    if(!num){toast('Nomor tidak tersedia');return;}
    if(!linkEl.value.trim()){toast('Isi link grup WhatsApp dulu');linkEl.focus();return;}
    if(!/^https:\\/\\/chat\\.whatsapp\\.com\\//.test(linkEl.value.trim())){toast('Link grup tidak valid');linkEl.focus();return;}
    window.open(waUrl(num,c.name),'_blank');
    invited.add(c.name);saveInv();renderStats();render();
  }
  function setManual(i){
    const c=view[i];const v=prompt('Masukkan nomor WhatsApp untuk '+c.name+'\\n(contoh: 081234567890 atau +62812...)');
    if(v===null)return;const n=normNum(v);
    if(!n){toast('Format nomor tidak valid');return;}
    manual[c.name]=n;saveMan();toast('Nomor disimpan');renderStats();render();
  }
  document.getElementById('nextBtn').addEventListener('click',()=>{
    if(!linkEl.value.trim()){toast('Isi link grup WhatsApp dulu');linkEl.focus();return;}
    const next=ALL.find(c=>phoneOf(c)&&!invited.has(c.name));
    if(!next){toast('Semua pelamar bernomor sudah diundang \\uD83C\\uDF89');return;}
    window.open(waUrl(phoneOf(next),next.name),'_blank');
    invited.add(next.name);saveInv();renderStats();render();
    toast('Membuka WA untuk '+next.name);
  });
  document.getElementById('copyAll').addEventListener('click',()=>{
    const nums=withNum().map(c=>phoneOf(c));
    if(!nums.length){toast('Tidak ada nomor');return;}
    copyText(nums.join('\\n'),nums.length+' nomor disalin');
  });
  document.getElementById('expVcf').addEventListener('click',()=>{
    const list=withNum();if(!list.length){toast('Tidak ada nomor');return;}
    const vcf=list.map(c=>'BEGIN:VCARD\\nVERSION:3.0\\nFN:'+c.name+'\\nTEL;TYPE=CELL:+'+phoneOf(c)+(c.emails&&c.emails[0]?'\\nEMAIL:'+c.emails[0]:'')+'\\nEND:VCARD').join('\\n');
    downloadFile('kontak-pelamar-fullstack.vcf',vcf,'text/vcard;charset=utf-8');toast(list.length+' kontak diekspor');
  });
  document.getElementById('expCsv').addEventListener('click',()=>{
    const rows=[['Nama','Nomor WA','Email','Sudah Diundang']].concat(ALL.map(c=>[c.name,phoneOf(c)?'+'+phoneOf(c):'',c.emails&&c.emails[0]||'',invited.has(c.name)?'Ya':'Tidak']));
    const csv='\\uFEFF'+rows.map(r=>r.map(x=>'"'+String(x).replace(/"/g,'""')+'"').join(',')).join('\\n');
    downloadFile('pelamar-fullstack-kontak.csv',csv,'text/csv;charset=utf-8');toast('CSV diekspor');
  });
  document.getElementById('resetInv').addEventListener('click',()=>{
    if(!invited.size){toast('Belum ada yang ditandai');return;}
    if(confirm('Hapus semua tanda "sudah diundang"?')){invited.clear();saveInv();renderStats();render();toast('Tanda direset');}
  });
  let t;document.getElementById('search').addEventListener('input',e=>{clearTimeout(t);t=setTimeout(()=>{searchTerm=e.target.value.trim().toLowerCase();render();},120);});
  validateLink();load(false);`;

  return layout({ active: 'undang', title: 'Undang Grup WA — Talent Pool', head, body, script });
}

/* ── Halaman: Pencocokan Lowongan (Job Match) ───────────────────────────────── */
function pageCocok() {
  const head = `
  header{padding:46px 0 8px}
  .reqcard{background:linear-gradient(180deg,var(--card),var(--card2));border:1px solid var(--line2);border-radius:18px;padding:22px 24px;margin:22px 0 8px}
  .reqgrid{display:grid;grid-template-columns:2fr 1fr 1fr;gap:18px}
  .efield label{display:block;font-size:13px;font-weight:600;color:var(--muted);margin-bottom:8px}
  .einput,select.einput{width:100%;background:var(--bg2);border:1px solid var(--line2);color:var(--text);padding:11px 13px;border-radius:10px;font-family:inherit;font-size:14px;outline:none}
  .einput:focus{border-color:var(--brand)}
  .weights{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-top:16px}
  .wbox label{display:flex;justify-content:space-between;font-size:12.5px;color:var(--muted);margin-bottom:6px}
  .wbox input[type=range]{width:100%;accent-color:var(--brand)}
  .reqfoot{display:flex;gap:10px;align-items:center;margin-top:18px;flex-wrap:wrap}
  .btn{background:linear-gradient(100deg,var(--brand),#4f46e5);color:#fff;border:0;padding:11px 18px;border-radius:11px;font-size:14px;font-weight:600;cursor:pointer;font-family:inherit;transition:.15s}
  .btn:hover{filter:brightness(1.1)}
  .mrow{background:linear-gradient(180deg,var(--card),var(--card2));border:1px solid var(--line);border-radius:14px;padding:16px 18px;display:flex;gap:16px;align-items:center;margin-bottom:10px;flex-wrap:wrap}
  .mrow .rank-no{font-family:'Plus Jakarta Sans';font-weight:800;font-size:17px;color:var(--muted2);width:30px;text-align:center}
  .mrow .avatar{width:48px;height:48px;font-size:16px}
  .mwho{min-width:150px;flex:1}.mwho .nm{font-weight:700;font-size:15px;display:flex;gap:8px;align-items:center}.mwho .sub{color:var(--muted2);font-size:12px;margin-top:3px}
  .score{text-align:center;min-width:78px}
  .score .pct{font-family:'Plus Jakarta Sans';font-weight:800;font-size:26px;line-height:1}
  .score .lbl{font-size:10.5px;color:var(--muted2);text-transform:uppercase;letter-spacing:.05em;margin-top:2px}
  .breakdown{flex:1;min-width:200px;display:flex;flex-direction:column;gap:7px}
  .bd{display:flex;align-items:center;gap:9px;font-size:11.5px;color:var(--muted)}
  .bd .bl{width:78px;flex-shrink:0}
  .bd .bar{flex:1;height:7px;background:var(--barbg);border-radius:99px;overflow:hidden}.bd .bar>i{display:block;height:100%;border-radius:99px}
  .bd .bv{width:34px;text-align:right;flex-shrink:0;font-weight:600;color:var(--text)}
  .mskills{display:flex;flex-wrap:wrap;gap:5px;flex-basis:100%;margin-top:2px}
  .msk{font-size:11px;padding:3px 9px;border-radius:7px;font-weight:600}
  .msk.has{background:rgba(34,197,94,.13);color:#4ade80;border:1px solid rgba(34,197,94,.3)}
  .msk.no{background:var(--soft);color:var(--muted2);border:1px solid var(--line2);text-decoration:line-through;opacity:.7}
  [data-theme="light"] .msk.has{color:#16a34a}
  .mact{display:flex;gap:8px;flex-shrink:0}
  .iconbtn{background:var(--card);border:1px solid var(--line2);color:var(--muted);padding:9px 13px;border-radius:10px;font-size:12.5px;cursor:pointer;font-family:inherit;transition:.15s;white-space:nowrap}
  .iconbtn:hover{color:#fff;border-color:var(--brand)}
  .loading{text-align:center;padding:60px;color:var(--muted)}.spinner{width:40px;height:40px;border:4px solid var(--line2);border-top-color:var(--brand);border-radius:50%;margin:0 auto 16px;animation:spin .8s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}
  @media(max-width:820px){.reqgrid{grid-template-columns:1fr}.weights{grid-template-columns:1fr}}`;

  const body = `
  <header>
    <span class="eyebrow"><span class="dot"></span> Otomasi Seleksi · Job Match</span>
    <h1>Pencocokan <span class="grad">Lowongan</span></h1>
    <p class="sub">Tentukan kriteria lowongan, lalu sistem menghitung <b>persentase kecocokan</b> setiap pelamar (skill, pengalaman, pendidikan) untuk membantu menyusun shortlist secara objektif.</p>
  </header>
  <div class="reqcard">
    <div class="reqgrid">
      <div class="efield"><label>Posisi / Lowongan</label><input class="einput" id="jTitle" placeholder="mis. Fullstack Developer"></div>
      <div class="efield"><label>Min. Pengalaman (tahun)</label><input class="einput" id="jYears" type="number" min="0" step="0.5" value="1"></div>
      <div class="efield"><label>Min. Pendidikan</label><select class="einput" id="jEdu"><option value="">Bebas</option><option>SMK/SMA</option><option>D3</option><option>D4</option><option>S1</option><option>S2</option><option>S3</option></select></div>
    </div>
    <div class="efield" style="margin-top:16px"><label>Skill Wajib (ketik lalu Enter)</label><div class="etags" id="jSkillTags"></div><input class="einput" id="jSkillInput" placeholder="mis. React, Laravel, Node.js..."></div>
    <div class="weights">
      <div class="wbox"><label>Bobot Skill <span id="wsV">50%</span></label><input type="range" id="wS" min="0" max="100" value="50"></div>
      <div class="wbox"><label>Bobot Pengalaman <span id="weV">35%</span></label><input type="range" id="wE" min="0" max="100" value="35"></div>
      <div class="wbox"><label>Bobot Pendidikan <span id="wedV">15%</span></label><input type="range" id="wEd" min="0" max="100" value="15"></div>
    </div>
    <div class="reqfoot"><button class="btn" id="saveReq">💾 Simpan & Hitung</button><span style="color:var(--muted2);font-size:13px" id="reqInfo"></span></div>
  </div>
  <div id="content"><div class="loading"><div class="spinner"></div>Menghitung kecocokan...</div></div>`;

  const script = `
  const EDU_RANK={'SMK/SMA':0,'D1':1,'D2':2,'D3':3,'D4':4,'S1':5,'S2':6,'S3':7};
  let CAND=[],reqSkills=[];
  const $=id=>document.getElementById(id);
  function renderTags(){$('jSkillTags').innerHTML=reqSkills.map((t,i)=>'<span class="etag-chip">'+esc(t)+'<b onclick="rmSkill('+i+')">\\u00d7</b></span>').join('');}
  function rmSkill(i){reqSkills.splice(i,1);renderTags();compute();}
  function addSkill(){const el=$('jSkillInput');const v=(el.value||'').trim();if(v){if(reqSkills.map(s=>s.toLowerCase()).indexOf(v.toLowerCase())<0)reqSkills.push(v);el.value='';renderTags();compute();}}
  $('jSkillInput').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();addSkill();}});
  function wsum(){return (+$('wS').value)+(+$('wE').value)+(+$('wEd').value)||1;}
  function updW(){$('wsV').textContent=$('wS').value+'%';$('weV').textContent=$('wE').value+'%';$('wedV').textContent=$('wEd').value+'%';}
  ['wS','wE','wEd'].forEach(id=>$(id).addEventListener('input',()=>{updW();compute();}));
  ['jYears','jEdu'].forEach(id=>$(id).addEventListener('input',compute));
  function skillMatched(req,tech){const r=req.toLowerCase();return (tech||[]).some(t=>{const x=t.toLowerCase();return x===r||x.includes(r)||r.includes(x);});}
  function compute(){
    const minY=parseFloat($('jYears').value)||0;const reqEdu=$('jEdu').value;const reqRank=reqEdu?EDU_RANK[reqEdu]:-1;
    const wS=+$('wS').value,wE=+$('wE').value,wEd=+$('wEd').value,ws=wsum();
    const rows=CAND.map(c=>{
      const matched=reqSkills.filter(s=>skillMatched(s,c.tech));
      const skillScore=reqSkills.length?Math.round(matched.length/reqSkills.length*100):100;
      let expScore=minY<=0?100:Math.min(100,Math.round((c.estimateYears||0)/minY*100));
      let eduScore;if(reqRank<0)eduScore=100;else{const cr=c.education!=null?EDU_RANK[c.education]:undefined;if(cr===undefined)eduScore=0;else eduScore=cr>=reqRank?100:Math.round(cr/reqRank*100);}
      const total=Math.round((skillScore*wS+expScore*wE+eduScore*wEd)/ws);
      return {c,total,skillScore,expScore,eduScore,matched};
    }).sort((a,b)=>b.total-a.total);
    render(rows);
  }
  function barColor(v){return v>=75?'linear-gradient(90deg,#22c55e,#16a34a)':v>=45?'linear-gradient(90deg,#f59e0b,#f97316)':'linear-gradient(90deg,#ef4444,#dc2626)';}
  function scoreColor(v){return v>=75?'#22c55e':v>=45?'#f59e0b':'#ef4444';}
  function render(rows){
    $('content').innerHTML=rows.map((r,i)=>{
      const c=r.c;
      const skills=reqSkills.map(s=>'<span class="msk '+(r.matched.map(x=>x.toLowerCase()).indexOf(s.toLowerCase())>=0?'has':'no')+'">'+esc(s)+'</span>').join('');
      const bd=(lbl,v)=>'<div class="bd"><span class="bl">'+lbl+'</span><div class="bar"><i style="width:'+v+'%;background:'+barColor(v)+'"></i></div><span class="bv">'+v+'%</span></div>';
      return '<div class="mrow"><div class="rank-no">'+(i+1)+'</div>'+
        '<div class="avatar" style="background:'+gradFor(c.name)+'">'+esc(c.initials)+'</div>'+
        '<div class="mwho"><div class="nm">'+esc(c.name)+statusBadge(c.eval)+'</div><div class="sub">'+(c.estimateLabel||'-')+' \\u00b7 '+(c.education||'-')+'</div></div>'+
        '<div class="score"><div class="pct" style="color:'+scoreColor(r.total)+'">'+r.total+'%</div><div class="lbl">cocok</div></div>'+
        '<div class="breakdown">'+bd('Skill',r.skillScore)+bd('Pengalaman',r.expScore)+bd('Pendidikan',r.eduScore)+'</div>'+
        (skills?'<div class="mskills">'+skills+'</div>':'')+
        '<div class="mact">'+(c.cvRel?'<button class="iconbtn" onclick="openFile(\\''+c.cvRel.replace(/'/g,"\\\\'")+'\\',\\''+esc(c.name).replace(/'/g,"")+' — CV\\')">CV</button>':'')+'<button class="iconbtn" onclick="nilai(\\''+c.name.replace(/'/g,"\\\\'")+'\\')">\\u2605 Nilai</button></div>'+
        '</div>';
    }).join('');
  }
  function nilai(name){const c=CAND.find(x=>x.name===name);if(!c)return;openEval(name,{cvRel:c.cvRel,ev:c.eval,onSave:(s)=>{c.eval=s;compute();}});}
  function saveReq(){
    const body={requirements:{title:$('jTitle').value,skills:reqSkills,minYears:parseFloat($('jYears').value)||0,eduLevel:$('jEdu').value,weights:{skills:+$('wS').value,experience:+$('wE').value,education:+$('wEd').value}}};
    fetch('/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}).then(r=>r.json()).then(()=>toast('Kriteria disimpan')).catch(()=>toast('Gagal menyimpan'));
  }
  $('saveReq').addEventListener('click',saveReq);
  async function load(){
    const data=await (await fetch('/api/data')).json();const req=data.settings.requirements||{};
    $('jTitle').value=req.title||'Fullstack Developer';$('jYears').value=req.minYears!=null?req.minYears:1;$('jEdu').value=req.eduLevel||'';
    reqSkills=(req.skills||[]).slice();if(req.weights){$('wS').value=req.weights.skills;$('wE').value=req.weights.experience;$('wEd').value=req.weights.education;}
    updW();renderTags();
    const ad=await (await fetch('/api/applicants')).json();CAND=ad.applicants;
    $('reqInfo').textContent=CAND.length+' kandidat dinilai';
    compute();
  }
  load();`;

  return layout({ active: 'cocok', title: 'Pencocokan Lowongan — Talent Pool', head, body, script });
}

/* ── Halaman: Seleksi (Kanban pipeline) ─────────────────────────────────────── */
function pageSeleksi() {
  const head = `
  header{padding:46px 0 4px}
  .board{display:flex;gap:14px;overflow-x:auto;padding:18px 0 30px;align-items:flex-start}
  .col{min-width:266px;width:266px;flex-shrink:0;background:var(--card);border:1px solid var(--line);border-radius:16px;display:flex;flex-direction:column;max-height:calc(100vh - 220px)}
  .col.over{border-color:var(--brand);box-shadow:0 0 0 3px rgba(99,102,241,.2)}
  .col-head{padding:14px 16px;display:flex;align-items:center;gap:9px;border-bottom:1px solid var(--line);position:sticky;top:0}
  .col-head .dot2{width:10px;height:10px;border-radius:50%;flex-shrink:0}
  .col-head .ct{font-weight:700;font-size:14px}
  .col-head .cc{margin-left:auto;background:var(--soft);color:var(--muted);font-size:12px;font-weight:700;padding:2px 9px;border-radius:99px}
  .col-body{padding:12px;display:flex;flex-direction:column;gap:10px;overflow-y:auto;flex:1;min-height:80px}
  .kcard{background:linear-gradient(180deg,var(--card2),var(--card));border:1px solid var(--line2);border-radius:12px;padding:13px;cursor:grab;transition:.12s}
  .kcard:hover{border-color:var(--brand)}
  .kcard.dragging{opacity:.45}
  .kc-top{display:flex;align-items:center;gap:10px}
  .kc-top .avatar{width:38px;height:38px;font-size:14px}
  .kc-nm{font-weight:700;font-size:13.5px;line-height:1.2}
  .kc-sub{color:var(--muted2);font-size:11px;margin-top:2px}
  .kc-skills{display:flex;flex-wrap:wrap;gap:4px;margin-top:9px}
  .kc-sk{font-size:10px;padding:2px 7px;border-radius:6px;background:rgba(99,102,241,.1);border:1px solid rgba(99,102,241,.25);color:#c7d2fe}
  [data-theme="light"] .kc-sk{color:#4338ca}
  .kc-foot{display:flex;align-items:center;gap:7px;margin-top:10px}
  .kc-rate{color:#fbbf24;font-size:12px;letter-spacing:1px;margin-right:auto}
  .kc-btn{background:var(--soft);border:1px solid var(--line2);color:var(--muted);padding:5px 9px;border-radius:8px;font-size:11px;cursor:pointer;font-family:inherit;transition:.12s}
  .kc-btn:hover{color:#fff;border-color:var(--brand)}
  .kc-fav{color:#f59e0b}
  .hint{color:var(--muted2);font-size:13px;margin:8px 0 0}
  .loading{text-align:center;padding:60px;color:var(--muted)}.spinner{width:40px;height:40px;border:4px solid var(--line2);border-top-color:var(--brand);border-radius:50%;margin:0 auto 16px;animation:spin .8s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}`;

  const body = `
  <header>
    <span class="eyebrow"><span class="dot"></span> Pipeline Rekrutmen</span>
    <h1>Papan <span class="grad">Seleksi</span></h1>
    <p class="sub">Kelola tahapan setiap kandidat ala Kanban. <b>Seret-tempel</b> kartu antar kolom untuk mengubah status, atau klik kartu untuk menilai.</p>
  </header>
  <p class="hint">💡 Tip: tarik kartu ke kolom lain untuk memindahkan tahapan. Perubahan tersimpan otomatis.</p>
  <div id="content"><div class="loading"><div class="spinner"></div>Memuat kandidat...</div></div>`;

  const script = `
  let CAND=[],dragName=null;
  async function load(){
    const ad=await (await fetch('/api/applicants')).json();CAND=ad.applicants;render();
  }
  function statusOf(c){return (c.eval&&c.eval.status)||'Baru';}
  function render(){
    const board='<div class="board">'+STATUSES.map(s=>{
      const items=CAND.filter(c=>statusOf(c)===s);
      const cards=items.map(c=>kcard(c)).join('')||'<div style="color:var(--muted2);font-size:12px;text-align:center;padding:14px 0">—</div>';
      return '<div class="col" data-s="'+s+'" ondragover="colOver(event,this)" ondragleave="this.classList.remove(\\'over\\')" ondrop="colDrop(event,this)">'+
        '<div class="col-head"><span class="dot2" style="background:'+STATUS_COLORS[s]+'"></span><span class="ct">'+s+'</span><span class="cc">'+items.length+'</span></div>'+
        '<div class="col-body">'+cards+'</div></div>';
    }).join('')+'</div>';
    document.getElementById('content').innerHTML=board;
  }
  function kcard(c){
    const sk=(c.tech||[]).slice(0,3).map(t=>'<span class="kc-sk">'+esc(t)+'</span>').join('');
    const rate=(c.eval&&c.eval.rating)?'<span class="kc-rate">'+'\\u2605'.repeat(c.eval.rating)+'</span>':'<span class="kc-rate"></span>';
    const fav=(c.eval&&c.eval.favorite)?'<span class="kc-fav">\\u2605</span>':'';
    return '<div class="kcard" draggable="true" ondragstart="dragStart(event,\\''+c.name.replace(/'/g,"\\\\'")+'\\')" ondragend="dragEnd(this)" data-name="'+esc(c.name)+'">'+
      '<div class="kc-top"><div class="avatar" style="background:'+gradFor(c.name)+'">'+esc(c.initials)+'</div><div><div class="kc-nm">'+esc(c.name)+' '+fav+'</div><div class="kc-sub">'+(c.estimateLabel||'-')+' \\u00b7 '+(c.education||'-')+'</div></div></div>'+
      (sk?'<div class="kc-skills">'+sk+'</div>':'')+
      '<div class="kc-foot">'+rate+(c.cvRel?'<button class="kc-btn" onclick="openFile(\\''+c.cvRel.replace(/'/g,"\\\\'")+'\\',\\''+esc(c.name).replace(/'/g,"")+' — CV\\')">CV</button>':'')+'<button class="kc-btn" onclick="nilai(\\''+c.name.replace(/'/g,"\\\\'")+'\\')">Nilai</button></div>'+
    '</div>';
  }
  function dragStart(e,name){dragName=name;e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('text/plain',name);e.target.classList.add('dragging');}
  function dragEnd(el){el.classList.remove('dragging');}
  function colOver(e,col){e.preventDefault();col.classList.add('over');}
  function colDrop(e,col){e.preventDefault();col.classList.remove('over');const name=dragName||e.dataTransfer.getData('text/plain');const s=col.dataset.s;const c=CAND.find(x=>x.name===name);if(!c)return;if(statusOf(c)===s)return;
    if(!c.eval)c.eval={};c.eval.status=s;render();
    fetch('/api/eval',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:name,patch:{status:s}})}).then(r=>r.json()).then(res=>{c.eval=res.eval;}).catch(()=>toast('Gagal menyimpan status'));
    toast(name+' \\u2192 '+s);
  }
  function nilai(name){const c=CAND.find(x=>x.name===name);if(!c)return;openEval(name,{cvRel:c.cvRel,ev:c.eval,onSave:(saved)=>{c.eval=saved;render();}});}
  load();`;

  return layout({ active: 'seleksi', title: 'Seleksi — Talent Pool', head, body, script });
}

/* ── Halaman: Analitik & Laporan ────────────────────────────────────────────── */
function pageAnalitik() {
  const head = `
  header{padding:46px 0 8px}
  .topbar{display:flex;gap:10px;flex-wrap:wrap;margin:20px 0 4px}
  .btn{background:linear-gradient(100deg,var(--brand),#4f46e5);color:#fff;border:0;padding:11px 18px;border-radius:11px;font-size:13.5px;font-weight:600;cursor:pointer;font-family:inherit;transition:.15s;display:inline-flex;gap:8px;align-items:center}
  .btn:hover{filter:brightness(1.1)}.btn.ghost{background:var(--card);border:1px solid var(--line2);color:var(--text)}
  .charts{display:grid;grid-template-columns:1fr 1fr;gap:18px;padding-bottom:30px}
  .chart{background:linear-gradient(180deg,var(--card),var(--card2));border:1px solid var(--line);border-radius:16px;padding:20px 22px}
  .chart h3{font-size:15px;font-weight:700;margin-bottom:16px;display:flex;align-items:center;gap:9px}
  .chart h3 .ic{font-size:18px}
  .hbar{display:flex;align-items:center;gap:11px;margin-bottom:11px;font-size:13px}
  .hbar .hl{width:118px;flex-shrink:0;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .hbar .ht{flex:1;height:22px;background:var(--barbg);border-radius:7px;overflow:hidden;position:relative}
  .hbar .ht>i{display:block;height:100%;border-radius:7px;background:linear-gradient(90deg,var(--brand),var(--brand2));min-width:2px;transition:width .4s}
  .hbar .hv{width:34px;text-align:right;flex-shrink:0;font-weight:700}
  .loading{text-align:center;padding:60px;color:var(--muted)}.spinner{width:40px;height:40px;border:4px solid var(--line2);border-top-color:var(--brand);border-radius:50%;margin:0 auto 16px;animation:spin .8s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}
  @media(max-width:820px){.charts{grid-template-columns:1fr}}
  @media print{.nav,.topbar,.theme-toggle,.no-print{display:none!important}body{background:#fff;color:#000}.chart{break-inside:avoid}}`;

  const body = `
  <header>
    <span class="eyebrow"><span class="dot"></span> Laporan Rekrutmen</span>
    <h1>Analitik <span class="grad">Kandidat</span></h1>
    <p class="sub">Ringkasan menyeluruh kumpulan pelamar: sebaran pengalaman, skill terpopuler, pendidikan, dan status pipeline. Cocok untuk laporan ke atasan/klien.</p>
  </header>
  <div class="topbar">
    <button class="btn ghost" id="expCsv">📄 Export CSV (Excel)</button>
    <button class="btn ghost" id="printBtn">🖨️ Cetak / PDF</button>
  </div>
  <div class="stats" id="stats"></div>
  <div id="content"><div class="loading"><div class="spinner"></div>Menghitung analitik...</div></div>`;

  const script = `
  let CAND=[];
  function hbars(arr,colorFn){const max=Math.max(1,...arr.map(x=>x.v));return arr.map(x=>'<div class="hbar"><span class="hl">'+esc(x.l)+'</span><div class="ht"><i style="width:'+Math.round(x.v/max*100)+'%'+(colorFn?';background:'+colorFn(x):'')+'"></i></div><span class="hv">'+x.v+'</span></div>').join('');}
  async function load(){
    const ad=await (await fetch('/api/applicants')).json();CAND=ad.applicants;
    // Stats ringkas
    const withExp=CAND.filter(c=>c.estimateYears>0);
    const avg=withExp.length?(withExp.reduce((s,c)=>s+c.estimateYears,0)/withExp.length).toFixed(1):0;
    const evald=CAND.filter(c=>c.eval&&(c.eval.status||c.eval.rating)).length;
    const items=[{n:CAND.length,l:'Total Pelamar',i:'\\uD83D\\uDC65'},{n:avg+' thn',l:'Rata-rata Pengalaman',i:'\\uD83D\\uDCCA'},{n:evald,l:'Sudah Dinilai',i:'\\u2705'},{n:CAND.filter(c=>c.eval&&c.eval.favorite).length,l:'Favorit',i:'\\u2B50'}];
    document.getElementById('stats').innerHTML=items.map(x=>'<div class="stat"><div class="ico">'+x.i+'</div><div class="num">'+x.n+'</div><div class="lbl">'+x.l+'</div></div>').join('');
    // Distribusi pengalaman
    const buckets=[['Tidak terdeteksi',c=>c.estimateYears<=0],['< 1 tahun',c=>c.estimateYears>0&&c.estimateYears<1],['1–2 tahun',c=>c.estimateYears>=1&&c.estimateYears<2],['2–4 tahun',c=>c.estimateYears>=2&&c.estimateYears<4],['4–6 tahun',c=>c.estimateYears>=4&&c.estimateYears<6],['6+ tahun',c=>c.estimateYears>=6]];
    const expData=buckets.map(b=>({l:b[0],v:CAND.filter(b[1]).length}));
    // Top skills
    const sc={};CAND.forEach(c=>(c.tech||[]).forEach(t=>sc[t]=(sc[t]||0)+1));
    const skillData=Object.keys(sc).map(k=>({l:k,v:sc[k]})).sort((a,b)=>b.v-a.v).slice(0,12);
    // Pendidikan
    const ec={};CAND.forEach(c=>{const e=c.education||'Tidak terdeteksi';ec[e]=(ec[e]||0)+1;});
    const order=['S3','S2','S1','D4','D3','D2','D1','SMK/SMA','Tidak terdeteksi'];
    const eduData=order.filter(o=>ec[o]).map(o=>({l:o,v:ec[o]}));
    // Status pipeline
    const stc={};STATUSES.forEach(s=>stc[s]=0);CAND.forEach(c=>{const s=(c.eval&&c.eval.status)||'Baru';stc[s]=(stc[s]||0)+1;});
    const statusData=STATUSES.map(s=>({l:s,v:stc[s]}));
    document.getElementById('content').innerHTML='<div class="charts">'+
      chart('\\uD83D\\uDCBC','Sebaran Pengalaman',hbars(expData))+
      chart('\\uD83D\\uDEE0\\uFE0F','Skill Terpopuler (Top 12)',hbars(skillData))+
      chart('\\uD83C\\uDF93','Sebaran Pendidikan',hbars(eduData))+
      chart('\\uD83D\\uDCCB','Status Pipeline',hbars(statusData,x=>STATUS_COLORS[x.l]||'var(--brand)'))+
    '</div>';
  }
  function chart(ic,title,inner){return '<div class="chart"><h3><span class="ic">'+ic+'</span>'+title+'</h3>'+inner+'</div>';}
  document.getElementById('printBtn').addEventListener('click',()=>window.print());
  document.getElementById('expCsv').addEventListener('click',()=>{
    const head=['Nama','Pengalaman (thn)','Estimasi','Pendidikan','Skill','GitHub','LinkedIn','Status','Rating','Favorit','Catatan'];
    const rows=CAND.map(c=>[c.name,c.estimateYears||0,c.estimateLabel||'',c.education||'',(c.tech||[]).join('; '),(c.links&&c.links.github)||'',(c.links&&c.links.linkedin)||'',(c.eval&&c.eval.status)||'Baru',(c.eval&&c.eval.rating)||'',(c.eval&&c.eval.favorite)?'Ya':'',(c.eval&&c.eval.note)||'']);
    const csv='\\uFEFF'+[head].concat(rows).map(r=>r.map(x=>'"'+String(x).replace(/"/g,'""')+'"').join(',')).join('\\n');
    downloadFile('laporan-pelamar-fullstack.csv',csv,'text/csv;charset=utf-8');toast('Laporan CSV diunduh');
  });
  load();`;

  return layout({ active: 'analitik', title: 'Analitik — Talent Pool', head, body, script });
}
