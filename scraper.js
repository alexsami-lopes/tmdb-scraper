/**
 * TMDb Now Playing — Scraper JavaScript
 *
 * Coleta filmes em cartaz do themoviedb.org via scraping (sem API oficial),
 * depois salva os dados no Google Sheets via Apps Script Web App.
 *
 * Lógica de encerramento:
 *  - Antes de scraping, consulta o Apps Script para saber o total de registros
 *  - Se total >= RECORDS_LIMIT, encerra com exit code 2 (sinaliza ao workflow)
 *  - O workflow detecta o exit code 2 e envia e-mail pedindo desativação manual
 *
 * Dependências: cheerio, node-fetch
 * Node.js >= 18
 */

import fetch from 'node-fetch';
import * as cheerio from 'cheerio';

// ─── CONFIGURAÇÃO ────────────────────────────────────────────────────────────

const CONFIG = {
  baseUrl:       'https://www.themoviedb.org',
  nowPlayingUrl: 'https://www.themoviedb.org/movie/now-playing',
  maxMovies:     1000,
  delayMs:       900,
  retries:       3,
  sheetsApiUrl:  process.env.APPS_SCRIPT_URL,
  sheetsSecret:  process.env.APPS_SCRIPT_SECRET,
  // Limite de registros históricos — ao atingir, encerra a rotina diária
  recordsLimit:  1200,
};

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
    'AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'Chrome/120.0.0.0 Safari/537.36',
  'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

// ─── UTILITÁRIOS ─────────────────────────────────────────────────────────────

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function log(msg)  { console.log(`[${new Date().toISOString()}] ${msg}`); }
function warn(msg) { console.warn(`[${new Date().toISOString()}] ⚠ ${msg}`); }
function err(msg)  { console.error(`[${new Date().toISOString()}] ✗ ${msg}`); }

function today() {
  return new Date().toISOString().slice(0, 10);
}

async function fetchHtml(url, attempt = 1) {
  try {
    const res = await fetch(url, { headers: HEADERS, redirect: 'follow', timeout: 20000 });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } catch (e) {
    if (attempt < CONFIG.retries) {
      warn(`Tentativa ${attempt} falhou para ${url}: ${e.message}. Retrying em ${attempt * 2}s...`);
      await sleep(attempt * 2000);
      return fetchHtml(url, attempt + 1);
    }
    err(`Falhou após ${CONFIG.retries} tentativas: ${url} — ${e.message}`);
    return null;
  }
}

// ─── PRÉ-CHECAGEM: TOTAL DE REGISTROS NO SHEETS ──────────────────────────────

/**
 * Consulta o Apps Script para saber quantos registros existem no total.
 * O Apps Script responde a ?action=count com { total: N }.
 * Retorna o número total ou null em caso de falha.
 */
async function getTotalRecords() {
  if (!CONFIG.sheetsApiUrl) return null;

  try {
    const url = `${CONFIG.sheetsApiUrl}?action=count&secret=${encodeURIComponent(CONFIG.sheetsSecret || '')}`;
    const res  = await fetch(url, { redirect: 'follow', timeout: 10000 });
    const text = await res.text();
    const json = JSON.parse(text);
    return typeof json.total === 'number' ? json.total : null;
  } catch (e) {
    warn(`Não foi possível consultar total de registros: ${e.message}`);
    return null;
  }
}

// ─── COLETA DE LINKS ─────────────────────────────────────────────────────────

async function collectMovieLinks() {
  const links = new Set();
  let page = 1;

  log(`Iniciando coleta de links (máx ${CONFIG.maxMovies} filmes)...`);

  while (links.size < CONFIG.maxMovies) {
    const url = `${CONFIG.nowPlayingUrl}?page=${page}`;
    log(`  Página ${page}: ${url}`);

    const html = await fetchHtml(url);
    if (!html) break;

    const $ = cheerio.load(html);
    let newOnPage = 0;

    $('a[href]').each((_, el) => {
      const href = $(el).attr('href') || '';
      if (/^\/movie\/\d+/.test(href) && !href.includes('now-playing')) {
        const clean = `${CONFIG.baseUrl}${href.split('?')[0].split('#')[0].replace(/\/$/, '')}`;
        if (!links.has(clean)) {
          links.add(clean);
          newOnPage++;
        }
      }
    });

    log(`    → ${newOnPage} novos links (total: ${links.size})`);

    if (newOnPage === 0) {
      log('  Sem novos filmes nesta página — fim da paginação.');
      break;
    }

    page++;
    await sleep(CONFIG.delayMs);
  }

  return [...links].slice(0, CONFIG.maxMovies);
}

// ─── EXTRAÇÃO DE DADOS ───────────────────────────────────────────────────────

function parseRuntime(text) {
  if (!text) return null;
  const h = text.match(/(\d+)h/);
  const m = text.match(/(\d+)m/);
  const total = (h ? parseInt(h[1]) * 60 : 0) + (m ? parseInt(m[1]) : 0);
  return total > 0 ? total : null;
}

function parseScore($) {
  const chart = $('[data-percent]').first();
  if (chart.length) {
    const pct = parseFloat(chart.attr('data-percent'));
    if (!isNaN(pct) && pct > 0) return Math.round((pct / 10) * 10) / 10;
  }
  let score = null;
  $('span.percent, div.percent').each((_, el) => {
    const txt = $(el).text().replace('%', '').trim();
    const val = parseFloat(txt);
    if (!isNaN(val) && val > 0 && val <= 100) {
      score = Math.round((val / 10) * 10) / 10;
      return false;
    }
  });
  return score;
}

function parsePoster($, baseUrl) {
  const posterDiv = $('div.poster_wrapper, div.poster, section.poster').first();
  let src = null;
  if (posterDiv.length) {
    const img = posterDiv.find('img').first();
    src = img.attr('src') || img.attr('data-src') || img.attr('srcset')?.split(' ')[0];
  }
  if (!src) {
    $('img').each((_, el) => {
      const s = $(el).attr('src') || '';
      if (s.includes('poster') || s.includes('/p/')) { src = s; return false; }
    });
  }
  if (!src) return null;
  return src.startsWith('http') ? src : `${baseUrl}${src}`;
}

function parseBackdrop($) {
  let backdrop = null;
  $('[style*="background-image"]').each((_, el) => {
    const style = $(el).attr('style') || '';
    const match = style.match(/url\(['"]?([^'")\s]+)['"]?\)/);
    if (match && match[1] && !match[1].includes('data:')) {
      backdrop = match[1];
      return false;
    }
  });
  return backdrop;
}

async function scrapeMovie(url) {
  const html = await fetchHtml(url);
  if (!html) return null;

  const $ = cheerio.load(html);
  const idMatch = url.match(/\/movie\/(\d+)/);
  const id = idMatch ? parseInt(idMatch[1]) : null;

  let title = null;
  const titleEl = $('h2.title a, div.title h2 a, section.header h2 a').first();
  if (titleEl.length) {
    title = titleEl.text().trim();
  } else {
    const pageTitle = $('title').text() || '';
    title = pageTitle.split('—')[0].split('-')[0].trim() || null;
  }

  const voteAverage = parseScore($);

  let voteCount = null;
  $('span, div').each((_, el) => {
    const txt = $(el).text().trim();
    const match = txt.match(/^([\d,\.]+)\s*(ratings?|avalia)/i);
    if (match) { voteCount = parseInt(match[1].replace(/[,\.]/g, '')); return false; }
  });

  let popularity = null;
  $('p strong.alt, bdi').each((_, el) => {
    const parent = $(el).parent();
    const label = $(el).text().toLowerCase();
    if (label.includes('popularidade') || label.includes('popularity')) {
      const val = parseFloat(parent.text().replace(label, '').trim().replace(',', '.'));
      if (!isNaN(val)) popularity = val;
    }
  });

  const posterPath   = parsePoster($, CONFIG.baseUrl);
  const backdropPath = parseBackdrop($);

  const overview = (
    $('div.overview p').first().text() ||
    $('p.overview').first().text() || ''
  ).trim() || null;

  const genres = [];
  $('a[href*="/genre/"]').each((_, el) => {
    const g = $(el).text().trim();
    if (g && !genres.includes(g)) genres.push(g);
  });

  let releaseDate = null;
  const bodyText = $('body').text();
  const dateMatch = bodyText.match(/(\d{2}\/\d{2}\/\d{4}|\d{4}-\d{2}-\d{2})/);
  if (dateMatch) releaseDate = dateMatch[1];

  let runtime = null;
  const rtMatch = bodyText.match(/(\d+h\s*\d*m?|\d+h|\d+m\b)/);
  if (rtMatch) runtime = parseRuntime(rtMatch[1]);

  let originalLanguage = null;
  let status = null;
  $('section.facts p, div.facts p').each((_, el) => {
    const strong = $(el).find('strong.alt').text().toLowerCase();
    const value  = $(el).text().replace($(el).find('strong').text(), '').trim();
    if (strong.includes('idioma') || strong.includes('language')) originalLanguage = value;
    if (strong.includes('status')) status = value;
  });

  const cast = [];
  $('ol.people.scroller li.card, section.cast ol li.card').each((_, el) => {
    const name      = $(el).find('p:not(.character)').first().text().trim();
    const character = $(el).find('p.character').text().trim();
    if (name) cast.push({ name, character: character || null });
    if (cast.length >= 10) return false;
  });

  let director = null;
  const screenplay = [];
  $('ol.people li.card, section.crew ol li.card').each((_, el) => {
    const name = $(el).find('p:not(.job)').first().text().trim();
    const job  = $(el).find('p.job').text().trim().toLowerCase();
    if (!name) return;
    if (job.includes('direct') || job.includes('direç') || job.includes('diretor')) {
      if (!director) director = name;
    } else if (job.includes('screenplay') || job.includes('roteiro') || job.includes('writer')) {
      if (!screenplay.includes(name)) screenplay.push(name);
    }
  });

  return {
    id, url, title,
    vote_average:      voteAverage,
    vote_count:        voteCount,
    popularity,
    poster_path:       posterPath,
    backdrop_path:     backdropPath,
    overview, genres,
    release_date:      releaseDate,
    runtime,
    original_language: originalLanguage,
    status, cast, director, screenplay,
    scraped_at:        new Date().toISOString(),
    date:              today(),
  };
}

// ─── ENVIO PARA O GOOGLE SHEETS ──────────────────────────────────────────────

async function sendToSheets(movies) {
  if (!CONFIG.sheetsApiUrl) {
    warn('APPS_SCRIPT_URL não definido — pulando envio para Sheets.');
    return false;
  }

  log(`Enviando ${movies.length} filmes para o Google Sheets...`);

  const payload = {
    secret:  CONFIG.sheetsSecret || '',
    date:    today(),
    movies,
  };

  try {
    const res  = await fetch(CONFIG.sheetsApiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
      redirect: 'follow',
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = { raw: text }; }

    if (!res.ok || json.status === 'error') {
      err(`Sheets retornou erro: ${JSON.stringify(json)}`);
      return false;
    }

    log(`✓ Sheets respondeu: ${JSON.stringify(json)}`);
    return true;
  } catch (e) {
    err(`Falha ao enviar para Sheets: ${e.message}`);
    return false;
  }
}

// ─── MAIN ────────────────────────────────────────────────────────────────────

async function main() {
  const startTime = Date.now();
  log('═══════════════════════════════════════════');
  log('TMDb Scraper JS — Iniciando');
  log(`Data: ${today()}`);
  log('═══════════════════════════════════════════');

  // ── 1. Verifica total de registros antes de qualquer scraping ──────────────
  log('\nConsultando total de registros no Google Sheets...');
  const totalRecords = await getTotalRecords();

  if (totalRecords !== null) {
    log(`Total atual de registros: ${totalRecords} / ${CONFIG.recordsLimit}`);

    if (totalRecords >= CONFIG.recordsLimit) {
      // Exit code 2 = limite atingido (não é erro, é conclusão)
      // O workflow captura esse código e envia e-mail
      log(`\n⚠ LIMITE ATINGIDO: ${totalRecords} registros >= ${CONFIG.recordsLimit}`);
      log('Encerrando scraper. O workflow enviará notificação por e-mail.');
      process.exit(2);
    }
  } else {
    warn('Não foi possível verificar o total — prosseguindo com scraping normalmente.');
  }

  // ── 2. Coleta links ────────────────────────────────────────────────────────
  const links = await collectMovieLinks();
  log(`\nTotal de links coletados: ${links.length}\n`);

  // ── 3. Scraping de cada filme ──────────────────────────────────────────────
  const movies = [];
  const errors = [];

  for (let i = 0; i < links.length; i++) {
    const url = links[i];
    log(`[${i + 1}/${links.length}] ${url}`);

    const movie = await scrapeMovie(url);
    if (movie) {
      movies.push(movie);
      log(`  ✓ "${movie.title}" | Nota: ${movie.vote_average ?? '—'} | Gêneros: ${movie.genres.join(', ')}`);
    } else {
      errors.push(url);
      log('  ✗ Falha');
    }

    if ((i + 1) % 50 === 0) {
      log(`\n── Progresso: ${movies.length} filmes OK, ${errors.length} erros ──\n`);
    }

    await sleep(CONFIG.delayMs);
  }

  // ── 4. Envia para Sheets ───────────────────────────────────────────────────
  const duration = Date.now() - startTime;
  log('\n═══════════════════════════════════════════');
  log(`Scraping concluído em ${(duration / 1000 / 60).toFixed(1)} minutos`);
  log(`Filmes coletados: ${movies.length}`);
  log(`Erros: ${errors.length}`);
  log('═══════════════════════════════════════════\n');

  const sheetsOk = await sendToSheets(movies);

  if (!sheetsOk && CONFIG.sheetsApiUrl) {
    err('Envio para Sheets falhou.');
    process.exit(1);
  }

  log('Tudo pronto! ✓');
  // exit code 0 = sucesso normal
}

main().catch(e => {
  err(`Erro fatal: ${e.message}`);
  console.error(e);
  process.exit(1);
});
