/**
 * TMDb Scraper API — Production Ready
 *
 * Recebe dados via POST do scraper, valida o secret,
 * insere filmes/elenco e registra logs de execução.
 *
 * ─────────────────────────────────────────────
 * ENDPOINTS GET
 * ─────────────────────────────────────────────
 *
 * Públicos:
 *
 *  ?action=ranking&date=YYYY-MM-DD
 *    → Top 10 filmes por nota em uma data
 *
 *  ?action=top20&date=YYYY-MM-DD
 *    → Top 20 filmes por nota
 *
 *  ?action=dates
 *    → Lista de datas disponíveis
 *
 *  ?action=history&id=NNNNN
 *    → Histórico completo de um filme
 *
 *  ?action=trending
 *    → Filmes com maior número de dias únicos em cartaz
 *
 *  ?action=runs
 *    → Log de execuções do scraper
 *
 *  ?action=cast&id=NNNNN
 *    → Elenco de um filme
 *
 *  ?action=search&q=texto
 *    → Busca por nome (retorna versões mais recentes)
 *
 * ─────────────────────────────────────────────
 * Privados:
 *
 *  ?action=count&secret=SEU_SECRET
 *    → Total de registros (usado pelo scraper)
 *
 * ─────────────────────────────────────────────
 * OBSERVAÇÕES:
 *
 * - Cache aplicado em: ranking, top20, dates, trending
 * - Deduplicação por (movie_id + date)
 * - Trending considera dias únicos (não duplicatas)
 * - Search retorna sempre o registro mais recente
 *
 */

// ───────────────── CONFIG ─────────────────

const SECRET = PropertiesService.getScriptProperties().getProperty('SECRET');

const SHEET_MOVIES = 'filmes';
const SHEET_RUNS   = 'runs';
const SHEET_CAST   = 'elenco';

const CACHE_TTL = 300; // 5 min

const HEADERS = [
  'date','id','title','vote_average','genres','release_date','runtime',
  'overview','original_language','status','director','screenplay',
  'cast','poster_path','url','scraped_at'
];

const RUN_HEADERS = [
  'date','total_inserted','total_records_after','status','duration_ms','ran_at'
];

const CAST_HEADERS = [
  'date','movie_id','movie_title','actor_name','character','photo_url'
];

// ───────────────── ENTRY ─────────────────

function doPost(e) {
  const start = Date.now();
  const lock = LockService.getScriptLock();

  try {
    lock.waitLock(30000);

    const body = JSON.parse(e.postData.contents);

    if (body.secret !== SECRET) {
      return json({ status: 'error', message: 'Unauthorized' });
    }

    const movies = body.movies || [];
    const date   = normalizeDate(body.date || today());

    if (!movies.length) {
      return json({ status: 'error', message: 'No movies' });
    }

    ensureSheet(SHEET_MOVIES, HEADERS);
    ensureSheet(SHEET_RUNS, RUN_HEADERS);
    ensureSheet(SHEET_CAST, CAST_HEADERS);

    const inserted = insertMoviesSafe(movies, date);
    insertCastBatch(movies, date);

    const total = getTotalCount();

    logRunBatch([[
      date, inserted, total, 'success',
      Date.now() - start,
      new Date().toISOString()
    ]]);

    clearCache();

    return json({ status: 'ok', inserted, total });

  } catch (err) {
    return json({ status: 'error', message: err.message });
  } finally {
    lock.releaseLock();
  }
}

function doGet(e) {
  const p = e.parameter || {};
  const action = p.action || '';

  if (action === 'count') {
    if (p.secret !== SECRET) return json({ status: 'error' });
    return json({ status: 'ok', total: getTotalCount() });
  }

  try {
    switch (action) {

      case 'ranking':
        return cached(`ranking_${p.date}`, () => {
          const data = getMoviesByDate(p.date);
          return {
            status: 'ok',
            ranking: data
              .filter(m => m.vote_average)
              .sort((a,b)=>b.vote_average-a.vote_average)
              .slice(0,10)
          };
        });

      case 'top20':
        return cached(`top20_${p.date}`, () => {
          const data = getMoviesByDate(p.date);
          return {
            status: 'ok',
            movies: data
              .filter(m => m.vote_average)
              .sort((a,b)=>b.vote_average-a.vote_average)
              .slice(0,20)
          };
        });

      case 'dates':
        return cached('dates', () => ({
          status:'ok',
          dates:getAvailableDates()
        }));

      case 'history':
        return json({
          status:'ok',
          history:getMovieHistory(p.id)
        });

      case 'trending':
        return cached('trending', () => ({
          status:'ok',
          trending:getTrending()
        }));

      case 'runs':
        return json({ status:'ok', runs:getRunsLog() });

      case 'cast':
        return json({ status:'ok', cast:getMovieCast(p.id) });

      case 'search':
        return json({ status:'ok', results:searchMovies(p.q) });

      default:
        return json({ status:'error', message:'invalid action' });
    }

  } catch (err) {
    return json({ status:'error', message:err.message });
  }
}

// ───────────────── WRITE ─────────────────

function insertMoviesSafe(movies, date) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_MOVIES);

  const existing = buildExistingSet(sheet);
  const rows = [];

  movies.forEach(m => {
    const key = `${m.id}_${date}`;
    if (existing.has(key)) return;

    rows.push(movieToRow(m, date));
    existing.add(key);
  });

  if (!rows.length) return 0;

  sheet.getRange(sheet.getLastRow()+1,1,rows.length,HEADERS.length)
       .setValues(rows);

  return rows.length;
}

function insertCastBatch(movies, date) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_CAST);
  const rows = [];

  movies.forEach(m=>{
    (m.cast||[]).forEach(a=>{
      if (!a.name) return;
      rows.push([date,m.id,m.title,a.name,a.character||'',a.photo_url||'']);
    });
  });

  if (!rows.length) return;

  sheet.getRange(sheet.getLastRow()+1,1,rows.length,CAST_HEADERS.length)
       .setValues(rows);
}

function logRunBatch(rows) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_RUNS);
  sheet.getRange(sheet.getLastRow()+1,1,rows.length,RUN_HEADERS.length)
       .setValues(rows);
}

// ───────────────── READ ─────────────────

function getMoviesByDate(date) {
  const data = getSheetData(SHEET_MOVIES);
  const idx = data.head.indexOf('date');
  const target = normalizeDate(date);

  return data.rows
    .filter(r => normalizeDate(r[idx]) === target)
    .map(r => rowToObj(r, data.head));
}

function getAvailableDates() {
  const data = getSheetData(SHEET_MOVIES);
  const idx = data.head.indexOf('date');

  return [...new Set(
    data.rows.map(r => normalizeDate(r[idx]))
  )].sort().reverse();
}

function getMovieHistory(id) {
  const data = getSheetData(SHEET_MOVIES);
  const idx = data.head.indexOf('id');

  return data.rows
    .filter(r => String(r[idx]) === String(id))
    .map(r => rowToObj(r, data.head));
}

function getTrending() {
  const data = getSheetData(SHEET_MOVIES);

  const idIdx    = data.head.indexOf('id');
  const dateIdx  = data.head.indexOf('date');
  const titleIdx = data.head.indexOf('title');
  const postIdx  = data.head.indexOf('poster_path');
  const scoreIdx = data.head.indexOf('vote_average');

  const map = {};

  data.rows.forEach(r => {
    const id = r[idIdx];
    const d  = normalizeDate(r[dateIdx]);

    if (!map[id]) {
      map[id] = {
        id,
        title: r[titleIdx],
        poster_path: r[postIdx],
        vote_average: r[scoreIdx],
        days: new Set()
      };
    }

    map[id].days.add(d);

    // Se ainda não tem poster, tenta atualizar com um válido
    if (!map[id].poster_path && r[postIdx]) {
      map[id].poster_path = r[postIdx];
    }

    // Atualiza score mais recente
    if (r[scoreIdx]) {
      map[id].vote_average = r[scoreIdx];
    }
  });

  return Object.values(map)
    .map(m => ({
      id: m.id,
      title: m.title,
      poster_path: m.poster_path,
      vote_average: m.vote_average,
      days_in_theaters: m.days.size
    }))
    .sort((a,b)=>b.days_in_theaters-a.days_in_theaters)
    .slice(0,20);
}

function getRunsLog() {
  const data = getSheetData(SHEET_RUNS);
  return data.rows.map(r=>rowToObj(r,data.head)).reverse();
}

function getMovieCast(id) {
  const data = getSheetData(SHEET_CAST);
  const idxId    = data.head.indexOf('movie_id');
  const idxName  = data.head.indexOf('actor_name');
  const idxChar  = data.head.indexOf('character');
  const idxPhoto = data.head.indexOf('photo_url');

  const map = new Map();

  data.rows.forEach(r => {
    if (String(r[idxId]) !== String(id)) return;

    const name  = r[idxName];
    const photo = r[idxPhoto];

    // Se ainda não existe OU encontramos versão com foto melhor
    if (!map.has(name) || (photo && !map.get(name).photo_url)) {
      map.set(name, {
        name,
        character: r[idxChar] || '',
        photo_url: photo || ''
      });
    }
  });

  return Array.from(map.values());
}

function searchMovies(q) {
  if (!q) return [];
  q = q.toLowerCase();

  const data = getSheetData(SHEET_MOVIES);
  const titleIdx = data.head.indexOf('title');
  const idIdx = data.head.indexOf('id');

  const seen = new Set();
  const res = [];

  for (let i = data.rows.length-1; i>=0; i--) {
    const r = data.rows[i];
    const title = String(r[titleIdx]).toLowerCase();

    if (!title.includes(q)) continue;

    const id = r[idIdx];
    if (seen.has(id)) continue;

    seen.add(id);
    res.push(rowToObj(r,data.head));

    if (res.length >= 10) break;
  }

  return res;
}

// ───────────────── CORE ─────────────────

function getSheetData(name) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sheet || sheet.getLastRow() <= 1) return { head: [], rows: [] };

  const values = sheet.getDataRange().getValues();
  return {
    head: values[0],
    rows: values.slice(1)
  };
}

function buildExistingSet(sheet) {
  const data = sheet.getDataRange().getValues();
  const idIdx = data[0].indexOf('id');
  const dateIdx = data[0].indexOf('date');

  const set = new Set();

  data.slice(1).forEach(r=>{
    set.add(`${r[idIdx]}_${normalizeDate(r[dateIdx])}`);
  });

  return set;
}

// ───────────────── UTILS ─────────────────

function normalizeDate(v) {
  if (!v) return '';
  if (v instanceof Date) {
    return Utilities.formatDate(v,'America/Sao_Paulo','yyyy-MM-dd');
  }
  const s = String(v);
  if (s.includes('T')) return s.slice(0,10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (d) return `${d[3]}-${d[2]}-${d[1]}`;
  return s;
}

function today() {
  return Utilities.formatDate(new Date(),'America/Sao_Paulo','yyyy-MM-dd');
}

function rowToObj(row, head) {
  const o = {};
  head.forEach((h,i)=>o[h]=row[i]);
  return o;
}

function ensureSheet(name, headers) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(name);

  if (!sheet) sheet = ss.insertSheet(name);

  if (sheet.getLastRow() === 0) {
    sheet.appendRow(headers);
    sheet.setFrozenRows(1);
  }
}

// ───────────────── CACHE ─────────────────

function cached(key, fn) {
  const cache = CacheService.getScriptCache();
  const c = cache.get(key);
  if (c) return json(JSON.parse(c));

  const result = fn();
  cache.put(key, JSON.stringify(result), CACHE_TTL);
  return json(result);
}

function clearCache() {
  CacheService.getScriptCache().removeAll([]);
}

function json(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}