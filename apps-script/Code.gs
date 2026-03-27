/**
 * TMDb Scraper — Apps Script
 *
 * Recebe os dados do scraper via POST, valida o secret,
 * insere os filmes na aba "filmes" e registra a execução na aba "runs".
 *
 * Também expõe endpoints GET para:
 *  - ?action=count  → total de registros (usado pelo scraper para checar limite)
 *  - ?action=ranking&date=YYYY-MM-DD → top 10 por nota de um dia
 *  - ?action=top20&date=YYYY-MM-DD  → top 20 por popularidade de um dia
 *  - ?action=dates                  → lista de datas disponíveis
 *  - ?action=history&id=NNNNN       → histórico de um filme específico
 *  - ?action=trending               → filmes que aparecem há mais dias
 */

// ─── CONFIGURAÇÃO ────────────────────────────────────────────────────────────

// ⚠️ Troque pelo mesmo valor do secret APPS_SCRIPT_SECRET no GitHub
const SECRET = 'COLOQUE_SEU_SECRET_AQUI';

// Nomes das abas da planilha
const SHEET_MOVIES = 'filmes';
const SHEET_RUNS   = 'runs';
const SHEET_CAST   = 'elenco';

// Colunas da aba "elenco"
const CAST_HEADERS = [
  'date',
  'movie_id',
  'movie_title',
  'actor_name',
  'character',
  'photo_url',
];

// Colunas da aba "filmes" — ordem importa, deve bater com HEADERS abaixo
const HEADERS = [
  'date',
  'id',
  'title',
  'vote_average',
  'genres',
  'release_date',
  'runtime',
  'overview',
  'original_language',
  'status',
  'director',
  'screenplay',
  'cast',
  'poster_path',
  'url',
  'scraped_at',
];

// Colunas da aba "runs"
const RUN_HEADERS = [
  'date',
  'total_inserted',
  'total_records_after',
  'status',
  'duration_ms',
  'ran_at',
];

// ─── ENTRY POINTS ─────────────────────────────────────────────────────────────

/**
 * Recebe os dados do scraper (POST com JSON no body).
 * Chamado pelo scraper.js ao final do scraping.
 */
function doPost(e) {
  const startTime = Date.now();

  try {
    const body = JSON.parse(e.postData.contents);

    // Valida o secret
    if (body.secret !== SECRET) {
      return jsonResponse({ status: 'error', message: 'Unauthorized' });
    }

    const movies = body.movies || [];
    const date   = body.date   || today();

    if (!Array.isArray(movies) || movies.length === 0) {
      return jsonResponse({ status: 'error', message: 'Nenhum filme recebido.' });
    }

    // Garante que as abas existem com os cabeçalhos corretos
    ensureSheet(SHEET_MOVIES, HEADERS);
    ensureSheet(SHEET_RUNS,   RUN_HEADERS);
    ensureSheet(SHEET_CAST,   CAST_HEADERS);

    // Insere os filmes
    const inserted = insertMovies(movies, date);

    // Insere o elenco na aba separada
    insertCast(movies, date);

    // Conta total de registros após inserção
    const totalAfter = getTotalCount();

    // Registra a execução no log
    logRun({
      date,
      total_inserted:      inserted,
      total_records_after: totalAfter,
      status:              'success',
      duration_ms:         Date.now() - startTime,
      ran_at:              new Date().toISOString(),
    });

    return jsonResponse({
      status:   'ok',
      inserted,
      total:    totalAfter,
      date,
    });

  } catch (err) {
    // Tenta registrar a falha no log
    try {
      ensureSheet(SHEET_RUNS, RUN_HEADERS);
      logRun({
        date:                today(),
        total_inserted:      0,
        total_records_after: getTotalCount(),
        status:              `error: ${err.message}`,
        duration_ms:         Date.now() - startTime,
        ran_at:              new Date().toISOString(),
      });
    } catch (_) {}

    return jsonResponse({ status: 'error', message: err.message });
  }
}

/**
 * Responde a requisições GET da API.
 * Chamado pelo scraper (action=count) e pelo frontend no futuro.
 */
function doGet(e) {
  const params = e.parameter || {};
  const action = params.action || 'count';
  const secret = params.secret || '';

  // Valida secret em todas as rotas
  if (secret !== SECRET) {
    return jsonResponse({ status: 'error', message: 'Unauthorized' });
  }

  try {
    switch (action) {

      // Total de registros — usado pelo scraper para checar o limite
      case 'count':
        return jsonResponse({ status: 'ok', total: getTotalCount() });

      // Top 10 por nota de um dia específico (ou hoje)
      case 'ranking': {
        const date = params.date || today();
        const data = getMoviesByDate(date);
        const ranked = data
          .filter(m => m.vote_average)
          .sort((a, b) => b.vote_average - a.vote_average)
          .slice(0, 10);
        return jsonResponse({ status: 'ok', date, ranking: ranked });
      }

      // Top 20 por popularidade de um dia específico (ou hoje)
      case 'top20': {
        const date = params.date || today();
        const data = getMoviesByDate(date);
        const top = data
          .filter(m => m.vote_average)
          .sort((a, b) => b.vote_average - a.vote_average)
          .slice(0, 20);
        return jsonResponse({ status: 'ok', date, movies: top });
      }

      // Lista de datas disponíveis na planilha
      case 'dates': {
        const dates = getAvailableDates();
        return jsonResponse({ status: 'ok', dates });
      }

      // Histórico de um filme pelo ID
      case 'history': {
        const id = parseInt(params.id);
        if (!id) return jsonResponse({ status: 'error', message: 'id obrigatório' });
        const history = getMovieHistory(id);
        return jsonResponse({ status: 'ok', id, history });
      }

      // Filmes que aparecem há mais dias consecutivos
      case 'trending': {
        const trending = getTrending();
        return jsonResponse({ status: 'ok', trending });
      }

      // Log de execuções
      case 'runs': {
        const runs = getRunsLog();
        return jsonResponse({ status: 'ok', runs });
      }

      default:
        return jsonResponse({ status: 'error', message: `Ação desconhecida: ${action}` });
    }

  } catch (err) {
    return jsonResponse({ status: 'error', message: err.message });
  }
}

// ─── FUNÇÕES DE ESCRITA ───────────────────────────────────────────────────────

/**
 * Insere os filmes na aba "filmes".
 * Cada filme vira uma linha. Retorna quantos foram inseridos.
 */
function insertMovies(movies, date) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_MOVIES);
  const rows  = movies.map(m => movieToRow(m, date));

  if (rows.length === 0) return 0;

  // Insere todas as linhas de uma vez (muito mais rápido que linha a linha)
  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, HEADERS.length)
       .setValues(rows);

  return rows.length;
}

/**
 * Insere o elenco de cada filme na aba elenco.
 * Cada ator de cada filme vira uma linha separada.
 */
function insertCast(movies, date) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_CAST);
  const rows  = [];

  movies.forEach(m => {
    if (!Array.isArray(m.cast) || m.cast.length === 0) return;
    m.cast.forEach(actor => {
      if (!actor.name) return;
      rows.push([
        date,
        m.id    || '',
        m.title || '',
        actor.name,
        actor.character  || '',
        actor.photo_url  || '',
      ]);
    });
  });

  if (rows.length === 0) return;

  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, CAST_HEADERS.length)
       .setValues(rows);
}

/**
 * Converte um objeto de filme para um array de valores na ordem de HEADERS.
 */
function movieToRow(m, date) {
  return [
    date,
    m.id            || '',
    m.title         || '',
    m.vote_average  || '',
    Array.isArray(m.genres)     ? m.genres.join(', ') : (m.genres || ''),
    m.release_date  || '',
    m.runtime       || '',
    m.overview      || '',
    m.original_language || '',
    m.status        || '',
    m.director      || '',
    Array.isArray(m.screenplay) ? m.screenplay.join(', ') : (m.screenplay || ''),
    Array.isArray(m.cast) ? m.cast.map(c => c.name).join(', ') : (m.cast || ''),
    m.poster_path   || '',
    m.url           || '',
    m.scraped_at    || new Date().toISOString(),
  ];
}

/**
 * Registra uma execução na aba "runs".
 */
function logRun(run) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_RUNS);
  sheet.appendRow([
    run.date,
    run.total_inserted,
    run.total_records_after,
    run.status,
    run.duration_ms,
    run.ran_at,
  ]);
}

// ─── FUNÇÕES DE LEITURA ───────────────────────────────────────────────────────

/**
 * Retorna o total de linhas de dados na aba "filmes" (excluindo cabeçalho).
 */
function getTotalCount() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_MOVIES);
  if (!sheet) return 0;
  const last = sheet.getLastRow();
  return last <= 1 ? 0 : last - 1; // desconta o cabeçalho
}

/**
 * Retorna todos os filmes de uma data específica como array de objetos.
 */
function getMoviesByDate(date) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_MOVIES);
  if (!sheet || sheet.getLastRow() <= 1) return [];

  const data = sheet.getDataRange().getValues();
  const head = data[0];
  const dateIdx = head.indexOf('date');

  return data
    .slice(1) // pula cabeçalho
    .filter(row => row[dateIdx] === date)
    .map(row => rowToMovie(row, head));
}

/**
 * Retorna todas as datas únicas disponíveis, ordenadas do mais recente.
 */
function getAvailableDates() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_MOVIES);
  if (!sheet || sheet.getLastRow() <= 1) return [];

  const data    = sheet.getDataRange().getValues();
  const dateIdx = data[0].indexOf('date');
  const dates   = new Set(data.slice(1).map(row => row[dateIdx]));

  return [...dates].filter(Boolean).sort().reverse();
}

/**
 * Retorna o histórico de aparições de um filme pelo ID.
 */
function getMovieHistory(id) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_MOVIES);
  if (!sheet || sheet.getLastRow() <= 1) return [];

  const data    = sheet.getDataRange().getValues();
  const head    = data[0];
  const idIdx   = head.indexOf('id');

  return data
    .slice(1)
    .filter(row => String(row[idIdx]) === String(id))
    .map(row => rowToMovie(row, head));
}

/**
 * Retorna os filmes que aparecem em mais datas (mais persistentes em cartaz).
 * Retorna top 20 ordenados por número de aparições.
 */
function getTrending() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_MOVIES);
  if (!sheet || sheet.getLastRow() <= 1) return [];

  const data    = sheet.getDataRange().getValues();
  const head    = data[0];
  const idIdx   = head.indexOf('id');
  const titleIdx= head.indexOf('title');
  const postIdx = head.indexOf('poster_path');
  const scoreIdx= head.indexOf('vote_average');

  // Conta aparições por ID
  const counts = {};
  const meta   = {};

  data.slice(1).forEach(row => {
    const id = String(row[idIdx]);
    if (!id) return;
    counts[id] = (counts[id] || 0) + 1;
    // Guarda os dados mais recentes do filme
    meta[id] = {
      id,
      title:        row[titleIdx],
      poster_path:  row[postIdx],
      vote_average: row[scoreIdx],
      days_in_theaters: counts[id],
    };
  });

  return Object.values(meta)
    .sort((a, b) => b.days_in_theaters - a.days_in_theaters)
    .slice(0, 20);
}

/**
 * Retorna o log de execuções.
 */
function getRunsLog() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_RUNS);
  if (!sheet || sheet.getLastRow() <= 1) return [];

  const data = sheet.getDataRange().getValues();
  const head = data[0];

  return data.slice(1).map(row => {
    const obj = {};
    head.forEach((col, i) => { obj[col] = row[i]; });
    return obj;
  }).reverse(); // mais recente primeiro
}

// ─── UTILITÁRIOS ─────────────────────────────────────────────────────────────

/**
 * Converte uma linha da planilha em objeto JavaScript.
 */
function rowToMovie(row, headers) {
  const obj = {};
  headers.forEach((col, i) => { obj[col] = row[i]; });
  return obj;
}

/**
 * Garante que uma aba existe. Se não existir, cria e adiciona o cabeçalho.
 * Se existir mas sem cabeçalho, adiciona o cabeçalho.
 */
function ensureSheet(name, headers) {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  let sheet   = ss.getSheetByName(name);

  if (!sheet) {
    sheet = ss.insertSheet(name);
  }

  // Adiciona cabeçalho se a aba estiver vazia
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(headers);
    // Formata o cabeçalho: negrito + fundo cinza
    const headerRange = sheet.getRange(1, 1, 1, headers.length);
    headerRange.setFontWeight('bold');
    headerRange.setBackground('#efefef');
    sheet.setFrozenRows(1); // congela o cabeçalho
  }
}

/**
 * Retorna a data de hoje no formato YYYY-MM-DD (fuso de Brasília).
 */
function today() {
  return Utilities.formatDate(
    new Date(),
    'America/Sao_Paulo',
    'yyyy-MM-dd'
  );
}

/**
 * Retorna uma resposta JSON formatada para o ContentService.
 */
function jsonResponse(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}
