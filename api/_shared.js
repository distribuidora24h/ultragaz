'use strict';
/* Helpers compartilhados das funções da Vercel.
   Arquivos que começam com "_" dentro de /api NÃO viram rotas públicas. */

// SITE_ORIGIN: uma ou mais origens separadas por vírgula, SEM caminho e SEM barra final.
// Produção: https://distribuidora24h.github.io (o caminho /ultragaz/ NÃO entra na origem)
const DEFAULT_ORIGIN = 'https://distribuidora24h.github.io'; // usado se SITE_ORIGIN não estiver definida
function allowedOrigins() {
  return String(process.env.SITE_ORIGIN || DEFAULT_ORIGIN)
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}

function sendJson(res, status, body) {
  res.status(status);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.send(JSON.stringify(body));
}

// Retorna true se a requisição já foi respondida (OPTIONS, origem inválida ou método inválido).
function guard(req, res) {
  const allowed = allowedOrigins();
  if (!allowed.length) {
    console.error('config: SITE_ORIGIN ausente');
    sendJson(res, 500, { ok: false, error: 'Pagamento indisponível no momento.' });
    return true;
  }

  const origin = req.headers.origin;
  const originOk = Boolean(origin) && allowed.includes(origin);

  if (originOk) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '86400');
  }

  if (req.method === 'OPTIONS') {
    if (!originOk) { sendJson(res, 403, { ok: false, error: 'Origem não permitida.' }); return true; }
    res.status(204).end();
    return true;
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    sendJson(res, 405, { ok: false, error: 'Método não permitido.' });
    return true;
  }
  if (!originOk) {
    sendJson(res, 403, { ok: false, error: 'Origem não permitida.' });
    return true;
  }
  const type = String(req.headers['content-type'] || '').toLowerCase();
  if (!type.startsWith('application/json')) {
    sendJson(res, 415, { ok: false, error: 'Requisição inválida.' });
    return true;
  }
  const len = Number(req.headers['content-length'] || 0);
  if (len > 2048) {
    sendJson(res, 413, { ok: false, error: 'Requisição muito grande.' });
    return true;
  }
  return false;
}

function clientIp(req) {
  const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xff || (req.socket && req.socket.remoteAddress) || 'unknown';
}

// Limite por IP em memória. Vale por instância "quente" da função (melhor esforço, sem banco).
function makeLimiter(max, windowMs) {
  const hits = new Map();
  return function limited(key) {
    const now = Date.now();
    if (hits.size > 2000) {
      for (const [k, v] of hits) if (now - v.start > windowMs) hits.delete(k);
    }
    const h = hits.get(key);
    if (!h || now - h.start > windowMs) { hits.set(key, { start: now, n: 1 }); return false; }
    h.n += 1;
    return h.n > max;
  };
}

function readBody(req) {
  try {
    const b = req.body;
    if (b && typeof b === 'object' && !Array.isArray(b)) return b;
  } catch (_) { /* JSON inválido */ }
  return null;
}

module.exports = { guard, sendJson, clientIp, makeLimiter, readBody };
