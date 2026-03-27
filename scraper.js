/**
 * TMDb Now Playing — Scraper JavaScript
 *
 * Seletores corrigidos com base na análise do HTML real do TMDb.
 *
 * Descobertas da análise:
 *  - director/screenplay: ol.people.no_image > li.profile, cargo em p.character
 *  - status/idioma: section.split_column > p > strong > bdi
 *  - cast image: hash extraído do src local → https://image.tmdb.org/t/p/w138_and_h175_face/{hash}.jpg
 *  - poster: único <img> com URL https://image.tmdb.org no HTML
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
  recordsLimit:  1200,
  // Base URL para imagens do TMDb
  imgBase:       'https://image.tmdb.org/t/p',
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
      warn(`Tentativa ${attempt} falhou: ${e.message}. Retry em ${attempt * 2}s...`);
      await sleep(attempt * 2000);
      return fetchHtml(url, attempt + 1);
    }
    err(`Falhou após ${CONFIG.retries} tentativas: ${url} — ${e.message}`);
    return null;
  }
}

// ─── PRÉ-CHECAGEM ────────────────────────────────────────────────────────────

async function getTotalRecords() {
  if (!CONFIG.sheetsApiUrl) return null;
  try {
    const url  = `${CONFIG.sheetsApiUrl}?action=count&secret=${encodeURIComponent(CONFIG.sheetsSecret || '')}`;
    const res  = await fetch(url, { redirect: 'follow', timeout: 10000 });
    const json = JSON.parse(await res.text());
    return typeof json.total === 'number' ? json.total : null;
  } catch (e) {
    warn(`Não foi possível consultar total: ${e.message}`);
    return null;
  }
}

// ─── COLETA DE LINKS ─────────────────────────────────────────────────────────

async function collectMovieLinks() {
  const links = new Set();
  let page = 1;

  log(`Iniciando coleta de links (máx ${CONFIG.maxMovies})...`);

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
        if (!links.has(clean)) { links.add(clean); newOnPage++; }
      }
    });

    log(`    → ${newOnPage} novos links (total: ${links.size})`);
    if (newOnPage === 0) { log('  Fim da paginação.'); break; }
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

/**
 * Extrai a nota. O TMDb usa div.user_score_chart com data-percent="82"
 * (onde 82 = 8.2 na escala de 10).
 */
function parseScore($) {
  const chart = $('div.user_score_chart[data-percent]').first();
  if (chart.length) {
    const pct = parseFloat(chart.attr('data-percent'));
    if (!isNaN(pct) && pct > 0) return Math.round((pct / 10) * 10) / 10;
  }
  return null;
}

/**
 * Extrai o poster — procura a única img com URL absoluta do image.tmdb.org no src.
 * Converte para tamanho w500.
 */
function parsePoster($) {
  const posterDiv = $('div.poster_wrapper').first();
  if (!posterDiv.length) return null;
  const img = posterDiv.find('img').first();
  if (!img.length) return null;
  const src = img.attr('src') || '';
  const cdnMatch = src.match(/image\.tmdb\.org\/t\/p\/[^/]+\/([A-Za-z0-9]+)\.(?:jpg|webp|png)/);
  if (cdnMatch) return CONFIG.imgBase + '/w500/' + cdnMatch[1] + '.jpg';
  const localMatch = src.match(/([A-Za-z0-9]{20,})(?:_\d+)?\.(?:webp|jpg|png)/);
  if (localMatch) return CONFIG.imgBase + '/w500/' + localMatch[1] + '.jpg';
  return null;
}

/**
 * Extrai o hash da imagem de uma URL local salva pelo browser.
 * Ex: "arquivos/lyUyVARQKhGxaxy0FbPJCQRpiaW_002.webp" → "lyUyVARQKhGxaxy0FbPJCQRpiaW"
 * Na página ao vivo o src vem direto do CDN, então também trata esse caso.
 */
function extractImgHash(src) {
  if (!src) return null;
  // Caso 1: URL completa do CDN (ao vivo)
  const cdnMatch = src.match(/\/p\/[^/]+\/([A-Za-z0-9]+)\.(?:jpg|webp|png)/);
  if (cdnMatch) return cdnMatch[1];
  // Caso 2: src local com hash no nome do arquivo
  const localMatch = src.match(/([A-Za-z0-9]{20,})(?:_\d+)?\.(?:webp|jpg|png)/);
  if (localMatch) return localMatch[1];
  return null;
}

/**
 * Extrai os dados da section.split_column (painel lateral de fatos).
 * Estrutura real: <p><strong><bdi>Label</bdi></strong> Valor</p>
 */
function parseFacts($) {
  const facts = {
    originalTitle:     null,
    status:            null,
    originalLanguage:  null,
    budget:            null,
    revenue:           null,
  };

  $('section.split_column p').each((_, el) => {
    const bdi   = $(el).find('bdi').text().trim().toLowerCase();
    const strong = $(el).find('strong').text().trim().toLowerCase();
    const label  = bdi || strong;

    // Valor = texto do <p> menos o texto do <strong>
    const value = $(el).text()
      .replace($(el).find('strong').text(), '')
      .trim();

    if (!value || !label) return;

    if (label.includes('situação') || label.includes('status'))            facts.status           = value;
    if (label.includes('idioma') || label.includes('language'))            facts.originalLanguage = value;
    if (label.includes('título original') || label.includes('original title')) facts.originalTitle = value;
  });

  return facts;
}

/**
 * Extrai diretor e roteiristas.
 *
 * Estrutura real no HTML:
 *   ol.people.no_image > li.profile > p > a  (nome)
 *                                   > p.character  (cargo: "Director", "Screenplay")
 */
function parseCrew($) {
  let director    = null;
  const screenplay = [];

  $('ol.people.no_image li.profile').each((_, el) => {
    const name = $(el).find('p:not(.character) a').first().text().trim()
               || $(el).find('p:not(.character)').first().text().trim();
    const job  = $(el).find('p.character').text().trim().toLowerCase();

    if (!name || !job) return;

    if (job.includes('director') || job.includes('diretor') || job.includes('direção')) {
      if (!director) director = name;
    } else if (job.includes('screenplay') || job.includes('roteiro') || job.includes('writer') || job.includes('story')) {
      if (!screenplay.includes(name)) screenplay.push(name);
    }
  });

  return { director, screenplay };
}

/**
 * Extrai o elenco principal.
 *
 * Estrutura real:
 *   ol.people.scroller > li.card > a > img (foto)
 *                                  > p > a  (nome)
 *                                  > p.character  (personagem)
 *
 * Para a URL da foto: extrai o hash do src e monta a URL do CDN.
 * Formato: https://image.tmdb.org/t/p/w138_and_h175_face/{hash}.jpg
 */
function parseCast($) {
  const cast = [];

  $('ol.people.scroller li.card').each((_, el) => {
    const nameEl = $(el).find('p:not(.character) a').first()
                || $(el).find('p:not(.character)').first();
    const charEl  = $(el).find('p.character');
    const imgEl   = $(el).find('img').first();

    const name      = nameEl ? $(nameEl).text().trim() : null;
    const character = charEl.length ? charEl.text().trim() : null;

    // Reconstrói URL da foto do ator a partir do hash
    let photoUrl = null;
    if (imgEl.length) {
      const src  = imgEl.attr('src') || '';
      const hash = extractImgHash(src);
      if (hash) photoUrl = `${CONFIG.imgBase}/w138_and_h175_face/${hash}.jpg`;
    }

    if (name) {
      cast.push({ name, character, photo_url: photoUrl });
    }

    if (cast.length >= 10) return false; // máx 10 atores
  });

  return cast;
}

/**
 * Scraping completo de uma página de filme.
 */
async function scrapeMovie(url) {
  const html = await fetchHtml(url);
  if (!html) return null;

  const $ = cheerio.load(html);

  // ID via URL
  const idMatch = url.match(/\/movie\/(\d+)/);
  const id = idMatch ? parseInt(idMatch[1]) : null;

  // Título
  let title = null;
  const titleEl = $('h2.title a, div.title h2 a, section.header h2 a').first();
  title = titleEl.length
    ? titleEl.text().trim()
    : ($('title').text() || '').split('—')[0].split('-')[0].trim() || null;

  // Nota (vote_average)
  const voteAverage = parseScore($);

  // Imagens
  const posterPath   = parsePoster($);

  // Sinopse
  const overview = (
    $('div.overview p').first().text() ||
    $('p.overview').first().text() || ''
  ).trim() || null;

  // Gêneros
  const genres = [];
  $('a[href*="/genre/"]').each((_, el) => {
    const g = $(el).text().trim();
    if (g && !genres.includes(g)) genres.push(g);
  });

  // Data de lançamento
  let releaseDate = null;
  const bodyText  = $('body').text();
  const dateMatch = bodyText.match(/(\d{2}\/\d{2}\/\d{4}|\d{4}-\d{2}-\d{2})/);
  if (dateMatch) releaseDate = dateMatch[1];

  // Runtime
  let runtime = null;
  const rtMatch = bodyText.match(/(\d+)h\s*(\d+)m|(\d+)h\b|(\d+)min/);
  if (rtMatch) {
    const h = parseInt(rtMatch[1] || rtMatch[3] || 0);
    const m = parseInt(rtMatch[2] || 0);
    runtime = h * 60 + m || null;
  }

  // Fatos do painel lateral (status, idioma original)
  const facts = parseFacts($);

  // Equipe (diretor, roteiro)
  const { director, screenplay } = parseCrew($);

  // Elenco com fotos
  const cast = parseCast($);

  return {
    id,
    url,
    title,
    vote_average:      voteAverage,
    poster_path:       posterPath,
    overview,
    genres,
    release_date:      releaseDate,
    runtime,
    original_language: facts.originalLanguage,
    status:            facts.status,
    cast,
    director,
    screenplay,
    scraped_at:        new Date().toISOString(),
    date:              today(),
  };
}

// ─── ENVIO PARA SHEETS ───────────────────────────────────────────────────────

async function sendToSheets(movies) {
  if (!CONFIG.sheetsApiUrl) {
    warn('APPS_SCRIPT_URL não definido — pulando envio para Sheets.');
    return false;
  }

  log(`Enviando ${movies.length} filmes para o Google Sheets...`);

  try {
    const res  = await fetch(CONFIG.sheetsApiUrl, {
      method:   'POST',
      headers:  { 'Content-Type': 'application/json' },
      body:     JSON.stringify({ secret: CONFIG.sheetsSecret || '', date: today(), movies }),
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

  // 1. Checa limite de registros
  log('\nConsultando total de registros no Google Sheets...');
  const totalRecords = await getTotalRecords();

  if (totalRecords !== null) {
    log(`Total atual: ${totalRecords} / ${CONFIG.recordsLimit}`);
    if (totalRecords >= CONFIG.recordsLimit) {
      log(`\n⚠ LIMITE ATINGIDO: ${totalRecords} >= ${CONFIG.recordsLimit}`);
      log('Encerrando. O workflow enviará notificação por e-mail.');
      process.exit(2);
    }
  } else {
    warn('Não foi possível verificar o total — prosseguindo normalmente.');
  }

  // 2. Coleta links
  const links = await collectMovieLinks();
  log(`\nTotal de links: ${links.length}\n`);

  // 3. Scraping
  const movies = [];
  const errors = [];

  for (let i = 0; i < links.length; i++) {
    const url = links[i];
    log(`[${i + 1}/${links.length}] ${url}`);

    const movie = await scrapeMovie(url);
    if (movie) {
      movies.push(movie);
      log(`  ✓ "${movie.title}" | Nota: ${movie.vote_average ?? '—'} | Status: ${movie.status ?? '—'} | Dir: ${movie.director ?? '—'}`);
    } else {
      errors.push(url);
      log('  ✗ Falha');
    }

    if ((i + 1) % 50 === 0) {
      log(`\n── Progresso: ${movies.length} OK, ${errors.length} erros ──\n`);
    }

    await sleep(CONFIG.delayMs);
  }

  // 4. Envia para Sheets
  const duration = Date.now() - startTime;
  log('\n═══════════════════════════════════════════');
  log(`Concluído em ${(duration / 1000 / 60).toFixed(1)} minutos`);
  log(`Filmes: ${movies.length} | Erros: ${errors.length}`);
  log('═══════════════════════════════════════════\n');

  const sheetsOk = await sendToSheets(movies);

  if (!sheetsOk && CONFIG.sheetsApiUrl) {
    err('Envio para Sheets falhou.');
    process.exit(1);
  }

  log('Tudo pronto! ✓');
}

main().catch(e => {
  err(`Erro fatal: ${e.message}`);
  console.error(e);
  process.exit(1);
});
