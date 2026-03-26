/**
 * TMDb Now Playing — Scraper JavaScript
 *
 * Coleta até 1000 filmes em cartaz do themoviedb.org via scraping (sem usar a API oficial),
 * depois salva os dados no Google Sheets via Apps Script Web App.
 *
 * Dependências: cheerio, node-fetch
 * Node.js >= 18 (fetch nativo disponível, mas foi usado o node-fetch considerando compatibilidade)
 */

import fetch from 'node-fetch';
import * as cheerio from 'cheerio';

// ─── CONFIGURAÇÃO ────────────────────────────────────────────────────────────

const CONFIG = {
  baseUrl:      'https://www.themoviedb.org',
  nowPlayingUrl:'https://www.themoviedb.org/movie/now-playing',
  maxMovies:    1000,
  delayMs:      900,       // delay entre requisições (ms) — respeita o servidor
  retries:      3,          // tentativas por página em caso de falha
  // URL da Web App do Apps Script — vem da variável de ambiente
  sheetsApiUrl: process.env.APPS_SCRIPT_URL,
  sheetsSecret: process.env.APPS_SCRIPT_SECRET,
};

// Headers que simulam um browser real
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
  return new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
}

/**
 * Faz uma requisição HTTP com retry automático em caso de falha.
 * Retorna o HTML como string ou null se todas as tentativas falharem.
 */
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

// ─── FASE 1: COLETA DE LINKS ─────────────────────────────────────────────────

/**
 * Percorre as páginas de /movie/now-playing coletando URLs únicas de filmes.
 * O TMDb usa ?page=N para paginação — cada página tem ~20 filmes.
 */
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

    // Links de filmes seguem o padrão /movie/NNNNN-nome-do-filme
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href') || '';
      if (/^\/movie\/\d+/.test(href) && !href.includes('now-playing')) {
        // Normaliza: remove query string, anchors e trailing slash
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

// ─── FASE 2: EXTRAÇÃO DE DADOS DE CADA FILME ─────────────────────────────────

/**
 * Extrai o número de minutos de uma string como "2h 15m" ou "1h" ou "45m".
 */
function parseRuntime(text) {
  if (!text) return null;
  const h = text.match(/(\d+)h/);
  const m = text.match(/(\d+)m/);
  const total = (h ? parseInt(h[1]) * 60 : 0) + (m ? parseInt(m[1]) : 0);
  return total > 0 ? total : null;
}

/**
 * Extrai a nota de avaliação de um elemento com data-percent.
 * O TMDb armazena como porcentagem (ex: 82 = nota 8.2).
 */
function parseScore($) {
  // Tenta elemento com data-percent (gráfico circular)
  const chart = $('[data-percent]').first();
  if (chart.length) {
    const pct = parseFloat(chart.attr('data-percent'));
    if (!isNaN(pct) && pct > 0) return Math.round((pct / 10) * 10) / 10;
  }

  // Fallback: texto de porcentagem em spans
  let score = null;
  $('span.percent, div.percent').each((_, el) => {
    const txt = $(el).text().replace('%', '').trim();
    const val = parseFloat(txt);
    if (!isNaN(val) && val > 0 && val <= 100) {
      score = Math.round((val / 10) * 10) / 10;
      return false; // break
    }
  });
  return score;
}

/**
 * Extrai a URL completa do poster a partir da div.poster_wrapper ou similar.
 */
function parsePoster($, baseUrl) {
  // Tenta dentro da div de poster
  const posterDiv = $('div.poster_wrapper, div.poster, section.poster').first();
  let src = null;

  if (posterDiv.length) {
    const img = posterDiv.find('img').first();
    src = img.attr('src') || img.attr('data-src') || img.attr('srcset')?.split(' ')[0];
  }

  // Fallback: primeira imagem com "poster" na URL ou classe
  if (!src) {
    $('img').each((_, el) => {
      const s = $(el).attr('src') || '';
      if (s.includes('poster') || s.includes('/p/')) {
        src = s;
        return false;
      }
    });
  }

  if (!src) return null;
  return src.startsWith('http') ? src : `${baseUrl}${src}`;
}

/**
 * Extrai a imagem de backdrop do estilo inline da div de cabeçalho.
 */
function parseBackdrop($) {
  let backdrop = null;

  // O TMDb coloca o backdrop como background-image inline
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

/**
 * Scraping completo de uma página de filme individual.
 * Retorna um objeto com todos os campos necessários.
 */
async function scrapeMovie(url) {
  const html = await fetchHtml(url);
  if (!html) return null;

  const $ = cheerio.load(html);

  // ID via URL
  const idMatch = url.match(/\/movie\/(\d+)/);
  const id = idMatch ? parseInt(idMatch[1]) : null;

  // Título — h2.title > a ou h2 dentro de .title
  let title = null;
  const titleEl = $('h2.title a, div.title h2 a, section.header h2 a').first();
  if (titleEl.length) {
    title = titleEl.text().trim();
  } else {
    // Fallback: <title> da página
    const pageTitle = $('title').text() || '';
    title = pageTitle.split('—')[0].split('-')[0].trim() || null;
  }

  // Nota
  const voteAverage = parseScore($);

  // Contagem de votos — geralmente aparece como "1,234 ratings" ou similar
  let voteCount = null;
  $('span, div').each((_, el) => {
    const txt = $(el).text().trim();
    const match = txt.match(/^([\d,\.]+)\s*(ratings?|avalia)/i);
    if (match) {
      voteCount = parseInt(match[1].replace(/[,\.]/g, ''));
      return false;
    }
  });

  // Popularidade — aparece no painel lateral como número
  let popularity = null;
  $('p strong.alt, bdi').each((_, el) => {
    const parent = $(el).parent();
    const label = $(el).text().toLowerCase();
    if (label.includes('popularidade') || label.includes('popularity')) {
      const val = parseFloat(parent.text().replace(label, '').trim().replace(',', '.'));
      if (!isNaN(val)) popularity = val;
    }
  });

  // Poster e backdrop
  const posterPath   = parsePoster($, CONFIG.baseUrl);
  const backdropPath = parseBackdrop($);

  // Sinopse
  const overview = (
    $('div.overview p').first().text() ||
    $('p.overview').first().text() ||
    ''
  ).trim() || null;

  // Gêneros — links com /genre/ na URL
  const genres = [];
  $('a[href*="/genre/"]').each((_, el) => {
    const g = $(el).text().trim();
    if (g && !genres.includes(g)) genres.push(g);
  });

  // Data de lançamento — busca padrão DD/MM/YYYY ou YYYY-MM-DD
  let releaseDate = null;
  const bodyText = $('body').text();
  const dateMatch = bodyText.match(/(\d{2}\/\d{2}\/\d{4}|\d{4}-\d{2}-\d{2})/);
  if (dateMatch) releaseDate = dateMatch[1];

  // Runtime — busca "Xh Ym" no texto da página
  let runtime = null;
  const rtMatch = bodyText.match(/(\d+h\s*\d*m?|\d+h|\d+m\b)/);
  if (rtMatch) runtime = parseRuntime(rtMatch[1]);

  // Idioma original e status — painel lateral de fatos
  let originalLanguage = null;
  let status = null;

  $('section.facts p, div.facts p').each((_, el) => {
    const strong = $(el).find('strong.alt').text().toLowerCase();
    const value  = $(el).text().replace($(el).find('strong').text(), '').trim();
    if (strong.includes('idioma') || strong.includes('language')) originalLanguage = value;
    if (strong.includes('status'))  status = value;
  });

  // Elenco — seção de cast cards
  const cast = [];
  $('ol.people.scroller li.card, section.cast ol li.card').each((_, el) => {
    const name      = $(el).find('p:not(.character)').first().text().trim();
    const character = $(el).find('p.character').text().trim();
    if (name) cast.push({ name, character: character || null });
    if (cast.length >= 10) return false; // máx 10 atores
  });

  // Equipe — diretor e roteirista
  let director    = null;
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
    id,
    url,
    title,
    vote_average:      voteAverage,
    vote_count:        voteCount,
    popularity,
    poster_path:       posterPath,
    backdrop_path:     backdropPath,
    overview,
    genres,
    release_date:      releaseDate,
    runtime,
    original_language: originalLanguage,
    status,
    cast,
    director,
    screenplay,
    scraped_at:        new Date().toISOString(),
    date:              today(),
  };
}

// ─── FASE 3: ENVIO PARA O GOOGLE SHEETS ─────────────────────────────────────

/**
 * Envia o array de filmes para a Web App do Apps Script via POST.
 * O Apps Script recebe, valida o secret e insere na planilha.
 */
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
    const res = await fetch(CONFIG.sheetsApiUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
      // Apps Script redireciona POST — precisamos seguir o redirect
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

  // 1. Coleta links
  const links = await collectMovieLinks();
  log(`\nTotal de links coletados: ${links.length}\n`);

  // 2. Scraping de cada filme
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
      log(`  ✗ Falha`);
    }

    // Log de progresso a cada 50 filmes
    if ((i + 1) % 50 === 0) {
      log(`\n── Progresso: ${movies.length} filmes OK, ${errors.length} erros ──\n`);
    }

    await sleep(CONFIG.delayMs);
  }

  // 3. Envia para Google Sheets
  const duration = Date.now() - startTime;
  log('\n═══════════════════════════════════════════');
  log(`Scraping concluído em ${(duration / 1000 / 60).toFixed(1)} minutos`);
  log(`Filmes coletados: ${movies.length}`);
  log(`Erros: ${errors.length}`);
  log('═══════════════════════════════════════════\n');

  const sheetsOk = await sendToSheets(movies);

  // Exit code 1 se o envio para Sheets falhar (GitHub Actions vai marcar como falha)
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
