'use strict';
/* POST /api/payment-status  { transactionId }
   Consulta POST /transactions/check na Magnus Pay e devolve SOMENTE o status.
   O "pago" vem exclusivamente da Magnus Pay (COMPLETED), nunca do navegador. */
const { guard, sendJson, clientIp, makeLimiter, readBody } = require('./_shared');

const CHECK_URL = 'https://api.magnuspay.com.br/transactions/check';
const KNOWN = new Set(['PENDING', 'COMPLETED', 'EXPIRED', 'FAILED']); // status documentados
const limited = makeLimiter(300, 10 * 60 * 1000); // ~1 consulta a cada 2 s por IP

module.exports = async (req, res) => {
  if (guard(req, res)) return;

  const apiKey = process.env.MAGNUS_API_KEY;
  if (!apiKey) {
    console.error('config: MAGNUS_API_KEY ausente');
    return sendJson(res, 500, { ok: false, error: 'Consulta indisponível no momento.' });
  }
  if (limited(clientIp(req))) {
    res.setHeader('Retry-After', '60');
    return sendJson(res, 429, { ok: false, error: 'Muitas consultas. Aguarde um instante.' });
  }

  const body = readBody(req);
  const id = body && typeof body.transactionId === 'string' ? body.transactionId : '';
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) return sendJson(res, 400, { ok: false, error: 'Requisição inválida.' });

  try {
    const r = await fetch(CHECK_URL, {
      method: 'POST',
      headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ transactionId: id }),
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) {
      console.error('magnus check: HTTP', r.status);
      return sendJson(res, 502, { ok: false, error: 'Não foi possível consultar agora.' });
    }
    const json = await r.json();
    const status = json && json.success === true && json.data ? String(json.data.status || '') : '';
    return sendJson(res, 200, { ok: true, status: KNOWN.has(status) ? status : 'UNKNOWN' });
  } catch (_) {
    console.error('magnus check: falha de rede ou tempo esgotado');
    return sendJson(res, 502, { ok: false, error: 'Não foi possível consultar agora.' });
  }
};
