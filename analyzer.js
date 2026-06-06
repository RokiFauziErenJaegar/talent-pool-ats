/*
 * analyzer.js — Mesin analisis CV
 * Membaca teks PDF CV lalu memperkirakan lama pengalaman IT/kerja kandidat
 * menggunakan beberapa sinyal heuristik (rentang tanggal pekerjaan, klaim
 * eksplisit "X tahun pengalaman"), sekaligus mengekstrak tech-stack & pendidikan.
 *
 * Semua hasil disertai BUKTI (evidence) agar transparan & bisa diverifikasi
 * manusia — perankingan ini adalah alat bantu, bukan keputusan absolut.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const pdf = require('pdf-parse');
const { APPLICANTS_DIR: BASE } = require('./config');

const CACHE_FILE = path.join(__dirname, 'cache.json');
// Naikkan versi ini bila format hasil analisis berubah agar cache diperbarui.
const CACHE_VERSION = 3;

// ── Kamus bulan (ID + EN, lengkap & singkatan) ────────────────────────────────
const MONTHS = {
  jan: 1, januari: 1, january: 1,
  feb: 2, februari: 2, february: 2,
  mar: 3, maret: 3, march: 3,
  apr: 4, april: 4,
  mei: 5, may: 5,
  jun: 6, juni: 6, june: 6,
  jul: 7, juli: 7, july: 7,
  agu: 8, agt: 8, ags: 8, agustus: 8, aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  okt: 10, oct: 10, oktober: 10, october: 10,
  nov: 11, november: 11, nopember: 11,
  des: 12, dec: 12, desember: 12, december: 12,
};
const MONTH_RE = '(?:jan(?:uari|uary)?|feb(?:ruari|ruary)?|mar(?:et|ch)?|apr(?:il)?|mei|may|jun(?:i|e)?|jul(?:i|y)?|agu(?:stus)?|agt|ags|aug(?:ust)?|sept?(?:ember)?|okt(?:ober)?|oct(?:ober)?|nov(?:ember)?|nop(?:ember)?|des(?:ember)?|dec(?:ember)?)';
const NOW_RE = '(?:sekarang|saat\\s*ini|present|now|current|kini|hingga\\s*kini)';
const YEAR_RE = '(?:19[89]\\d|20[0-3]\\d)';
const SEP_RE = '\\s*(?:-|–|—|−|s\\/?d|sampai(?:\\s*dengan)?|hingga|to|until|s\\.d\\.?)\\s*';

// Kata kunci konteks
// Pendidikan diprioritaskan: nama gelar sering memuat kata "engineering/computer"
// sehingga TIDAK boleh dianggap kerja meski ada istilah teknis.
const EDU_WORDS = /universit|institut|sekolah|\bsma\b|\bsmk\b|\bsmp\b|\bsmu\b|\bstm\b|\bman\b|\bmts\b|\bs1\b|\bs2\b|\bs3\b|\bd3\b|\bd4\b|\bd2\b|\bd1\b|fakultas|jurusan|prodi|program\s*studi|mahasiswa|kuliah|perkuliahan|semester|angkatan|pendidikan|education|\bgpa\b|\bipk\b|sarjana|diploma|gelar|lulus|graduat|bachelor|master|doctor|faculty|teknokrat|politeknik|poltek|akademi|academy|college|pondok|pesantren|vocational|high\s*school|paket\s*c|almamater|cumlaude|cum\s*laude/i;
const ORG_WORDS = /organisasi|organization|himpunan|\bhmj\b|\bbem\b|\bukm\b|osis|karang\s*taruna|kepemudaan|pemuda|relawan|volunteer|komunitas|community|kepanitiaan|\bpanitia\b|rohis|pramuka|paskibra|club\b|klub|forum|ikatan|paguyuban/i;
// Penanda pekerjaan (untuk skoring kedekatan). "engineer(?!ing)" agar gelar
// "...Engineering" tidak salah dianggap kerja.
const WORK_HINT = /developer|engineer(?!ing)|programmer|\bstaff?\b|\bstaf\b|magang|intern(?:ship)?|freelanc|kontrak|\bpt\b|\bcv\b|perusahaan|company|teknolog|software\s*house|aplikasi|web\s*develop|back\s*end|backend|front\s*end|frontend|full\s*stack|fullstack|analyst|analis|konsultan|consultant|operator|kasir|\badmin\b|manager|manajer|founder|owner|direktur|\bcto\b|\bceo\b|teknisi|technician|wirausaha|usaha|\btoko\b|jasa|client|klien|tutor|mentor|asisten|assistant/i;
const EXP_CTX = /pengalaman|experience|berkecimpung|menggeluti|selama|bekerja|berpengalaman|kurang\s*lebih|lebih\s*dari|over|more\s*than|profesional|professional/i;
const AGE_CTX = /usia|umur|berusia|lahir|years?\s*old|tahun\s*lahir|kelahiran/i;

// Klasifikasi rentang tanggal berdasarkan KATA KUNCI TERDEKAT (proximity),
// bukan sekadar keberadaan — menghindari "bleed-over" antar entri berdempetan.
function classifyRange(lower, idx, matchLen) {
  const W = 150;
  const segStart = Math.max(0, idx - W);
  const seg = lower.slice(segStart, Math.min(lower.length, idx + matchLen + W));
  const rel = idx - segStart;
  const nearest = (re) => {
    let best = Infinity, mm;
    const r = new RegExp(re.source, 'gi');
    while ((mm = r.exec(seg)) !== null) {
      const ks = mm.index, ke = mm.index + mm[0].length;
      const d = ke <= rel ? rel - ke : ks >= rel + matchLen ? ks - (rel + matchLen) : 0;
      if (d < best) best = d;
      if (mm.index === r.lastIndex) r.lastIndex++;
    }
    return best;
  };
  const de = nearest(EDU_WORDS), dorg = nearest(ORG_WORDS), dw = nearest(WORK_HINT);
  if (de === Infinity && dorg === Infinity && dw === Infinity) return 'kerja';
  if (de <= dorg && de <= dw) return 'pendidikan'; // prioritas edu saat seri
  if (dorg <= dw) return 'organisasi';
  return 'kerja';
}

// Tech stack yang dideteksi (label tampilan -> regex)
const TECH = [
  ['JavaScript', /\bjavascript\b|\bjs\b/i], ['TypeScript', /\btypescript\b|\bts\b/i],
  ['React', /\breact(?:\.?js)?\b/i], ['Next.js', /\bnext\.?js\b/i], ['Vue', /\bvue(?:\.?js)?\b/i],
  ['Angular', /\bangular\b/i], ['Node.js', /\bnode\.?js\b/i], ['Express', /\bexpress(?:\.?js)?\b/i],
  ['NestJS', /\bnest\.?js\b/i], ['Laravel', /\blaravel\b/i], ['PHP', /\bphp\b/i],
  ['CodeIgniter', /\bcode\s*igniter\b|\bci3\b|\bci4\b/i], ['Python', /\bpython\b/i],
  ['Django', /\bdjango\b/i], ['Flask', /\bflask\b/i], ['Java', /\bjava\b(?!script)/i],
  ['Spring', /\bspring\s*boot\b|\bspring\b/i], ['Kotlin', /\bkotlin\b/i], ['Go', /\bgolang\b|\bgo\b/i],
  ['C#', /\bc#\b|\b\.net\b|\bdotnet\b|\basp\.net\b/i], ['C++', /\bc\+\+\b/i], ['Ruby', /\bruby\b/i],
  ['Rails', /\brails\b|ruby\s*on\s*rails/i], ['Flutter', /\bflutter\b/i], ['Dart', /\bdart\b/i],
  ['React Native', /react\s*native/i], ['MySQL', /\bmysql\b/i], ['PostgreSQL', /\bpostgre\w*\b/i],
  ['MongoDB', /\bmongo\w*\b/i], ['Redis', /\bredis\b/i], ['SQLite', /\bsqlite\b/i],
  ['Firebase', /\bfirebase\b/i], ['Supabase', /\bsupabase\b/i], ['Docker', /\bdocker\b/i],
  ['Kubernetes', /\bkubernetes\b|\bk8s\b/i], ['AWS', /\baws\b|amazon\s*web/i], ['GCP', /\bgcp\b|google\s*cloud/i],
  ['Azure', /\bazure\b/i], ['Git', /\bgit\b|github|gitlab/i], ['REST API', /\brest\s*api\b|\brestful\b/i],
  ['GraphQL', /\bgraphql\b/i], ['Tailwind', /\btailwind\b/i], ['Bootstrap', /\bbootstrap\b/i],
  ['HTML', /\bhtml5?\b/i], ['CSS', /\bcss3?\b/i], ['Linux', /\blinux\b|ubuntu|debian/i],
  ['CI/CD', /\bci\/cd\b|jenkins|github\s*actions/i], ['Figma', /\bfigma\b/i],
  ['Vite', /\bvite\b/i], ['Prisma', /\bprisma\b/i], ['jQuery', /\bjquery\b/i],
];

const EDU_LEVELS = [
  ['S3', /\bs3\b|doktor|ph\.?d|doctoral/i, 7],
  ['S2', /\bs2\b|magister|master|m\.kom|m\.t\b|m\.sc/i, 6],
  ['S1', /\bs1\b|sarjana|bachelor|s\.kom|s\.t\b|s\.tr|strata\s*1/i, 5],
  ['D4', /\bd4\b|d-?iv|diploma\s*4|sarjana\s*terapan/i, 4],
  ['D3', /\bd3\b|d-?iii|diploma\s*3|a\.md/i, 3],
  ['D2', /\bd2\b|diploma\s*2/i, 2],
  ['D1', /\bd1\b|diploma\s*1/i, 1],
  ['SMK/SMA', /\bsmk\b|\bsma\b|\bman\b|sekolah\s*menengah/i, 0],
];

// ── Helper ────────────────────────────────────────────────────────────────────
function monthNum(token) {
  if (!token) return null;
  const t = token.toLowerCase().replace(/[^a-z]/g, '');
  for (const key of Object.keys(MONTHS)) {
    if (t.startsWith(key)) return MONTHS[key];
  }
  return null;
}

function nowDecimal() {
  const d = new Date();
  return d.getFullYear() + d.getMonth() / 12; // getMonth 0-based
}

// Ubah satu sisi rentang ("Sep 2024", "2017", "Sekarang") menjadi angka desimal-tahun
function sideToDecimal(monthTok, year, isEnd) {
  if (year == null) return null;
  const m = monthNum(monthTok);
  if (m != null) {
    // start = awal bulan; end = akhir bulan
    return year + (isEnd ? m / 12 : (m - 1) / 12);
  }
  // hanya tahun → asumsi pertengahan tahun (mengurangi over/under-estimate)
  return year + 0.5;
}

function fmtYears(y) {
  if (y <= 0) return '0';
  const years = Math.floor(y);
  const months = Math.round((y - years) * 12);
  if (years === 0) return months + ' bln';
  if (months === 0) return years + ' thn';
  return years + ' thn ' + months + ' bln';
}

// Ekstrak & normalkan nomor HP/WhatsApp Indonesia ke format internasional (62...)
function extractPhones(text) {
  const out = [];
  const seen = new Set();
  // Diawali +62 / 62 / 0, lalu '8' (nomor seluler), diikuti 7–12 digit (boleh ada spasi/.-)
  const re = /(?<!\d)(?:\(?\+?62\)?|0)[\s.\-]?8\d(?:[\s.\-]?\d){6,11}(?!\d)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    let d = m[0].replace(/\D/g, '');
    if (d.startsWith('0')) d = '62' + d.slice(1);
    else if (d.startsWith('8')) d = '62' + d;
    if (!d.startsWith('62') || d[2] !== '8') continue;
    if (d.length < 11 || d.length > 14) continue; // 62 + 9..12 digit
    if (!seen.has(d)) { seen.add(d); out.push(d); }
  }
  return out;
}

// Format nomor untuk tampilan: +62 812-3456-7890
function prettyPhone(d) {
  if (!d || !d.startsWith('62')) return d || '';
  const rest = d.slice(2);
  const a = rest.slice(0, 3), b = rest.slice(3, 7), c = rest.slice(7);
  return '+62 ' + [a, b, c].filter(Boolean).join('-');
}

function extractEmails(text) {
  const out = [];
  const seen = new Set();
  const re = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const e = m[0].toLowerCase();
    if (!seen.has(e)) { seen.add(e); out.push(e); }
  }
  return out;
}

// Ekstrak tautan profil penting (GitHub, LinkedIn, portfolio) dari teks CV
function extractLinks(text) {
  const links = { github: null, linkedin: null, website: null };
  const norm = (u) => (/^https?:\/\//i.test(u) ? u : 'https://' + u);
  let m;
  m = text.match(/(?:https?:\/\/)?(?:www\.)?github\.com\/[A-Za-z0-9_.\-]+(?:\/[A-Za-z0-9_.\-]+)?/i);
  if (m) links.github = norm(m[0].replace(/[).,;]+$/, ''));
  m = text.match(/(?:https?:\/\/)?(?:[a-z]{2,3}\.)?linkedin\.com\/(?:in|pub)\/[A-Za-z0-9_%\-]+\/?/i);
  if (m) links.linkedin = norm(m[0].replace(/[).,;]+$/, ''));
  // Website/portofolio: domain umum, hindari email/github/linkedin/sosmed lain
  const wre = /(?:https?:\/\/)?(?:www\.)?[A-Za-z0-9\-]+\.(?:dev|me|io|com|net|id|vercel\.app|netlify\.app|github\.io)(?:\/[A-Za-z0-9_#%.\-\/]*)?/gi;
  while ((m = wre.exec(text)) !== null) {
    const u = m[0].toLowerCase();
    if (/github\.com|linkedin\.com|gmail|yahoo|hotmail|outlook|@|\.png|\.jpg|wa\.me|whatsapp|instagram\.com|facebook\.com|twitter\.com|t\.me|youtube/.test(u)) continue;
    links.website = norm(m[0].replace(/[).,;]+$/, ''));
    break;
  }
  return links;
}

// Gabung interval yang tumpang tindih lalu jumlahkan total durasinya
function mergeAndSum(intervals) {
  if (intervals.length === 0) return 0;
  const sorted = intervals.slice().sort((a, b) => a.start - b.start);
  const merged = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const last = merged[merged.length - 1];
    if (sorted[i].start <= last.end + 0.01) {
      last.end = Math.max(last.end, sorted[i].end);
    } else {
      merged.push({ ...sorted[i] });
    }
  }
  return merged.reduce((s, iv) => s + Math.max(0, iv.end - iv.start), 0);
}

// ── Analisis teks CV ──────────────────────────────────────────────────────────
function analyzeText(rawText) {
  const text = rawText.replace(/ /g, ' ');
  const lower = text.toLowerCase();
  const now = nowDecimal();
  const nowYear = Math.floor(now);

  const evidence = [];

  // 1) Rentang tanggal pekerjaan
  const rangeRe = new RegExp(
    '(' + MONTH_RE + ')?\\s*(' + YEAR_RE + ')' + SEP_RE +
    '(?:(' + NOW_RE + ')|(?:(' + MONTH_RE + ')?\\s*(' + YEAR_RE + ')))',
    'gi'
  );
  const workIntervals = [];
  let m;
  while ((m = rangeRe.exec(lower)) !== null) {
    const [full, sMon, sYearStr, nowTok, eMon, eYearStr] = m;
    const sYear = parseInt(sYearStr, 10);
    let start = sideToDecimal(sMon, sYear, false);
    let end;
    if (nowTok) {
      end = now;
    } else if (eYearStr) {
      end = sideToDecimal(eMon, parseInt(eYearStr, 10), true);
    } else {
      continue;
    }
    if (start == null || end == null) continue;
    if (sYear < 1990 || sYear > nowYear + 1) continue;
    if (end < start) { const t = end; end = start; start = t; } // jaga-jaga terbalik
    const dur = Math.max(0, Math.min(end, now) - start);
    if (dur > 45) continue; // anomali

    // Klasifikasi berdasarkan kata kunci terdekat (pendidikan/organisasi/kerja)
    const idx = m.index;
    const kind = classifyRange(lower, idx, full.length);

    const item = {
      raw: text.slice(Math.max(0, idx - 45), Math.min(text.length, idx + full.length + 45)).replace(/\s+/g, ' ').trim(),
      years: +dur.toFixed(2),
      kind,
    };
    if (kind === 'kerja') workIntervals.push({ start, end: Math.min(end, now) });
    evidence.push(item);
  }

  const rangeWorkYears = mergeAndSum(workIntervals);

  // 2) Klaim eksplisit "X tahun pengalaman"
  let explicitYears = 0;
  const expRe = /(\d{1,2})(?:[.,](\d))?\s*\+?\s*(?:tahun|thn|years?|yrs?)/gi;
  while ((m = expRe.exec(lower)) !== null) {
    const val = parseInt(m[1], 10) + (m[2] ? parseInt(m[2], 10) / 10 : 0);
    if (val <= 0 || val > 45) continue;
    const idx = m.index;
    const before = lower.slice(Math.max(0, idx - 45), idx);
    const after = lower.slice(idx, Math.min(lower.length, idx + 20));
    const ctx = before + after;
    if (AGE_CTX.test(before)) continue;        // buang "usia 26 tahun"
    if (!EXP_CTX.test(ctx)) continue;          // hanya jika konteks pengalaman
    if (val > explicitYears) explicitYears = val;
    evidence.push({
      raw: text.slice(Math.max(0, idx - 40), Math.min(text.length, idx + 20)).replace(/\s+/g, ' ').trim(),
      years: val,
      kind: 'klaim',
    });
  }

  // 3) Estimasi final
  const candidates = [];
  if (rangeWorkYears > 0) candidates.push(rangeWorkYears);
  if (explicitYears > 0) candidates.push(explicitYears);
  const estimate = candidates.length ? Math.max(...candidates) : 0;

  // 4) Tech stack
  const tech = TECH.filter(([, re]) => re.test(text)).map(([name]) => name);

  // 4b) Kontak: nomor WhatsApp, email & tautan profil
  const phones = extractPhones(text);
  const emails = extractEmails(text);
  const links = extractLinks(text);

  // 5) Pendidikan tertinggi
  let edu = null, eduRank = -1;
  for (const [label, re, rank] of EDU_LEVELS) {
    if (re.test(text) && rank > eduRank) { edu = label; eduRank = rank; }
  }

  // 6) Confidence
  let confidence;
  if (text.replace(/\s/g, '').length < 120) confidence = 'rendah';
  else if (rangeWorkYears > 0 || explicitYears > 0) confidence = 'tinggi';
  else confidence = 'sedang';

  return {
    estimateYears: +estimate.toFixed(2),
    estimateLabel: estimate > 0 ? fmtYears(estimate) : 'Tidak terdeteksi',
    rangeWorkYears: +rangeWorkYears.toFixed(2),
    explicitYears,
    tech,
    education: edu,
    phones,
    phonesPretty: phones.map(prettyPhone),
    emails: emails.slice(0, 3),
    links,
    confidence,
    evidence: evidence.slice(0, 12),
    textChars: text.replace(/\s/g, '').length,
  };
}

// ── Pemilihan & pembacaan berkas CV ───────────────────────────────────────────
function pickCvFile(files) {
  const pdfs = files.filter((f) => f.ext === '.pdf');
  // utamakan yang kategori CV / Surat Lamaran, hindari Portofolio (besar & sering scan)
  return (
    pdfs.find((f) => f.category === 'CV') ||
    pdfs.find((f) => /cv|resume|curriculum|riwayat/i.test(f.name.replace(/[_\-.]/g, ' '))) ||
    pdfs.find((f) => f.category === 'Surat Lamaran') ||
    pdfs.find((f) => f.category !== 'Portofolio') ||
    pdfs[0] ||
    null
  );
}

async function readPdfText(absPath) {
  const buf = fs.readFileSync(absPath);
  const data = await pdf(buf, { max: 6 }); // batasi 6 halaman pertama (cukup utk CV)
  return data.text || '';
}

// ── Cache ─────────────────────────────────────────────────────────────────────
function loadCache() {
  try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch { return {}; }
}
function saveCache(c) {
  try { fs.writeFileSync(CACHE_FILE, JSON.stringify(c)); } catch {}
}

/**
 * Analisis satu applicant (objek dari getApplicants()).
 * Menggunakan cache berbasis path+mtime+size berkas CV.
 */
async function analyzeApplicant(applicant, cache) {
  const cv = pickCvFile(applicant.files);
  const base = {
    name: applicant.name,
    initials: applicant.initials,
    cvFile: cv ? cv.name : null,
    cvRel: cv ? cv.rel : null,
    fileCount: applicant.fileCount,
  };

  if (!cv) {
    return { ...base, estimateYears: 0, estimateLabel: 'Tanpa CV', confidence: 'rendah',
      tech: [], education: null, evidence: [], phones: [], phonesPretty: [], emails: [], links: { github: null, linkedin: null, website: null },
      note: 'Tidak ada berkas CV yang dapat dianalisis.' };
  }

  const abs = path.resolve(BASE, cv.rel);
  let stat;
  try { stat = fs.statSync(abs); } catch { stat = { mtimeMs: 0, size: 0 }; }
  const key = cv.rel;
  const cached = cache[key];
  if (cached && cached.v === CACHE_VERSION && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return { ...base, ...cached.result };
  }

  let result;
  try {
    const text = await readPdfText(abs);
    result = analyzeText(text);
    if (result.textChars < 120) {
      result.note = 'CV kemungkinan berupa hasil scan/gambar — teks tidak dapat diekstrak otomatis.';
    }
    // Fallback nomor/email: bila CV tak memuat kontak, coba dokumen lain (mis. Surat Lamaran)
    if (!result.phones.length || !result.emails.length) {
      const others = applicant.files.filter((f) => f.ext === '.pdf' && f.rel !== cv.rel && f.category !== 'Portofolio');
      for (const o of others) {
        try {
          const t = await readPdfText(path.resolve(BASE, o.rel));
          if (!result.phones.length) {
            const ph = extractPhones(t);
            if (ph.length) { result.phones = ph; result.phonesPretty = ph.map(prettyPhone); result.phoneSource = o.name; }
          }
          if (!result.emails.length) {
            const em = extractEmails(t);
            if (em.length) result.emails = em.slice(0, 3);
          }
          if (result.phones.length && result.emails.length) break;
        } catch {}
      }
    }
  } catch (e) {
    result = { estimateYears: 0, estimateLabel: 'Gagal dibaca', confidence: 'rendah',
      tech: [], education: null, evidence: [], phones: [], phonesPretty: [], emails: [], links: { github: null, linkedin: null, website: null },
      note: 'Gagal membaca PDF: ' + e.message };
  }

  cache[key] = { v: CACHE_VERSION, mtimeMs: stat.mtimeMs, size: stat.size, result };
  return { ...base, ...result };
}

// ── OCR (on-demand) untuk CV hasil scan ───────────────────────────────────────
let _ocrWorker = null;
let _ocrWorkerPromise = null;
async function getOcrWorker() {
  if (_ocrWorker) return _ocrWorker;
  if (_ocrWorkerPromise) return _ocrWorkerPromise;
  _ocrWorkerPromise = (async () => {
    const { createWorker } = require('tesseract.js');
    _ocrWorker = await createWorker('ind+eng');
    return _ocrWorker;
  })();
  return _ocrWorkerPromise;
}

/**
 * Jalankan OCR pada CV (untuk berkas hasil scan), analisis hasilnya,
 * lalu simpan ke cache agar permanen. Dipanggil on-demand dari UI.
 */
async function ocrApplicant(applicant) {
  const cv = pickCvFile(applicant.files);
  if (!cv) return { ok: false, error: 'Tidak ada berkas CV.' };
  const abs = path.resolve(BASE, cv.rel);
  let text = '';
  try {
    const { pdf } = await import('pdf-to-img');
    const doc = await pdf(abs, { scale: 2 });
    const worker = await getOcrWorker();
    let pg = 0;
    for await (const img of doc) {
      pg++;
      if (pg > 4) break; // batasi 4 halaman demi waktu
      const { data: { text: t } } = await worker.recognize(img);
      text += t + '\n';
    }
  } catch (e) {
    return { ok: false, error: 'OCR gagal: ' + e.message };
  }
  if (text.replace(/\s/g, '').length < 40) {
    return { ok: false, error: 'OCR tidak menghasilkan teks yang memadai.' };
  }
  const result = analyzeText(text);
  result.ocr = true;
  result.note = 'Diekstrak via OCR (CV hasil scan) — akurasi terbatas, mohon verifikasi melalui CV asli.';

  const cache = loadCache();
  let stat;
  try { stat = fs.statSync(abs); } catch { stat = { mtimeMs: 0, size: 0 }; }
  cache[cv.rel] = { v: CACHE_VERSION, mtimeMs: stat.mtimeMs, size: stat.size, result };
  saveCache(cache);

  return {
    ok: true,
    result: { name: applicant.name, initials: applicant.initials, cvFile: cv.name, cvRel: cv.rel, fileCount: applicant.fileCount, ...result },
  };
}

/**
 * Analisis seluruh applicant (urutan nama) — dipakai untuk daftar kontak/undangan.
 */
async function analyzeAll(applicants, { refresh = false } = {}) {
  const cache = refresh ? {} : loadCache();
  const results = [];
  for (const a of applicants) {
    results.push(await analyzeApplicant(a, cache));
  }
  saveCache(cache);
  results.sort((x, y) => x.name.localeCompare(y.name, 'id'));
  return results;
}

/**
 * Analisis seluruh applicant & kembalikan terurut (ranking) menurun by estimateYears.
 */
async function rankAll(applicants, { refresh = false } = {}) {
  const cache = refresh ? {} : loadCache();
  const results = [];
  for (const a of applicants) {
    results.push(await analyzeApplicant(a, cache));
  }
  saveCache(cache);

  results.sort((x, y) => {
    if (y.estimateYears !== x.estimateYears) return y.estimateYears - x.estimateYears;
    const conf = { tinggi: 3, sedang: 2, rendah: 1 };
    const c = (conf[y.confidence] || 0) - (conf[x.confidence] || 0);
    if (c !== 0) return c;
    return x.name.localeCompare(y.name, 'id');
  });
  results.forEach((r, i) => { r.rank = i + 1; });
  return results;
}

module.exports = { rankAll, analyzeAll, analyzeText, fmtYears, extractPhones, prettyPhone, extractLinks, ocrApplicant };
