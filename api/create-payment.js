'use strict';
/* POST /api/create-payment
   Cria uma cobrança Pix na Magnus Pay. Preços, produtos e cidades são decididos AQUI,
   nunca pelo navegador. A MAGNUS_API_KEY só existe no servidor. */
const crypto = require('crypto');
const { guard, sendJson, clientIp, makeLimiter, readBody } = require('./_shared');

const MAGNUS_URL = 'https://api.magnuspay.com.br/transactions/create';
const EXPIRES_SECONDS = 15 * 60; // documentado: a cobrança expira em 15 minutos

/* ---------- Catálogo permitido (valores em centavos) ---------- */
const GAS_MAX_QTY = 20; // acima disso o pedido é combinado pelo WhatsApp
const GAS_PRICE = { regular: 11000, pg: 12000 }; // São Vicente/Santos e Praia Grande
const PRODUCTS = {
  gas: { label: 'Botijão P13 (troca)', maxQty: GAS_MAX_QTY, enabled: true },
  // Fogões: cobrança por Pix DESLIGADA até a regra de entrega/frete ser confirmada.
  // Para ligar, troque enabled para true (e adicione o botão no site).
  fogao4: { label: 'Fogão industrial 4 bocas', cents: 30000, maxQty: 5, enabled: false },
  fogao6: { label: 'Fogão industrial 6 bocas', cents: 80000, maxQty: 5, enabled: false },
};

const limited = makeLimiter(8, 10 * 60 * 1000); // 8 cobranças por IP a cada 10 min
const recent = new Map(); // impressão digital do pedido -> cobrança já criada (melhor esforço)
const REUSE_MS = 10 * 60 * 1000;

/* ---------- Utilidades ---------- */
const norm = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
const clean = (s, max) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

function areaOf(city, uf) {
  if (uf !== 'SP') return null;
  const c = norm(city);
  if (c === 'sao vicente' || c === 'santos') return 'regular';
  if (c === 'praia grande') return 'pg';
  return null;
}

async function lookupCep(cep) {
  const r = await fetch('https://viacep.com.br/ws/' + cep + '/json/', { signal: AbortSignal.timeout(5000) });
  if (r.status === 400) return { invalid: true };
  if (!r.ok) throw new Error('viacep ' + r.status);
  const d = await r.json();
  if (d.erro) return { invalid: true };
  return { city: String(d.localidade || ''), uf: String(d.uf || '') };
}

// Valida a entrada e devolve { ok, status, error } ou { ok:true, order }
async function buildOrder(body) {
  const id = String(body.productId || '');
  const product = Object.prototype.hasOwnProperty.call(PRODUCTS, id) ? PRODUCTS[id] : null;
  if (!product || !product.enabled) return { ok: false, status: 400, error: 'Produto indisponível para pagamento por Pix.' };

  const qty = body.qty;
  if (!Number.isInteger(qty) || qty < 1 || qty > product.maxQty) {
    return { ok: false, status: 400, error: 'Quantidade inválida. Para pedidos maiores, fale pelo WhatsApp.' };
  }

  const name = clean(body.name, 80);
  if (name.length < 2) return { ok: false, status: 400, error: 'Informe seu nome.' };

  if (id !== 'gas') return { ok: false, status: 400, error: 'Produto indisponível para pagamento por Pix.' };

  const cep = String(body.cep || '').replace(/\D/g, '');
  if (cep.length !== 8) return { ok: false, status: 400, error: 'Digite um CEP válido.' };
  const number = clean(body.number, 10);
  if (!number) return { ok: false, status: 400, error: 'Informe o número da residência.' };
  const complement = clean(body.complement, 60);
  const street = clean(body.street, 70);
  const district = clean(body.district, 50);
  if (!street || !district) return { ok: false, status: 400, error: 'Informe rua e bairro.' };

  let place;
  try { place = await lookupCep(cep); }
  catch (_) { return { ok: false, status: 503, error: 'Não foi possível validar o CEP agora. Tente novamente.' }; }
  if (place.invalid) return { ok: false, status: 400, error: 'CEP não encontrado.' };

  const area = areaOf(place.city, place.uf);
  if (!area) return { ok: false, status: 400, error: 'No momento atendemos São Vicente, Santos e Praia Grande.' };

  const unit = GAS_PRICE[area];
  return {
    ok: true,
    order: {
      productId: id, qty, name, cep, number, complement, street, district, city: place.city,
      unitCents: unit, totalCents: unit * qty,
      // Descrição curta (usada como reserva) e completa, com os dados de entrega para a loja ver no painel da Magnus Pay.
      description: 'Ultragaz Entregas Flash - ' + qty + 'x ' + product.label + ' (' + place.city + ')',
      deliveryDescription: ('Ultragaz Flash | ' + qty + 'x gás P13 troca | ' + street + ', ' + number + (complement ? ' ' + complement : '') +
        ' - ' + district + ' | ' + place.city + '/SP | CEP ' + cep.slice(0, 5) + '-' + cep.slice(5)).slice(0, 180),
    },
  };
}

function safeCharge(data, order, deliveryDataSent) {
  const out = {
    ok: true,
    deliveryDataSent: Boolean(deliveryDataSent),
    transactionId: String(data.transactionId),
    total: order.totalCents / 100,
    unit: order.unitCents / 100,
    qty: order.qty,
    copyPaste: String(data.copyPaste),
    expiresInSeconds: EXPIRES_SECONDS,
  };
  if (typeof data.qrCodeBase64 === 'string' && /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(data.qrCodeBase64)) {
    out.qrCodeBase64 = data.qrCodeBase64;
  }
  if (typeof data.paymentLink === 'string' && /^https:\/\//.test(data.paymentLink)) {
    out.paymentLink = data.paymentLink;
  }
  return out;
}

module.exports = async (req, res) => {
  if (guard(req, res)) return;

  const apiKey = process.env.MAGNUS_API_KEY;
  if (!apiKey) {
    console.error('config: MAGNUS_API_KEY ausente');
    return sendJson(res, 500, { ok: false, error: 'Pagamento indisponível no momento.' });
  }

  if (limited(clientIp(req))) {
    res.setHeader('Retry-After', '600');
    return sendJson(res, 429, { ok: false, error: 'Muitas tentativas. Aguarde alguns minutos ou chame pelo WhatsApp.' });
  }

  const body = readBody(req);
  if (!body) return sendJson(res, 400, { ok: false, error: 'Requisição inválida.' });

  let built;
  try { built = await buildOrder(body); }
  catch (_) { return sendJson(res, 500, { ok: false, error: 'Não foi possível gerar o Pix agora.' }); }
  if (!built.ok) return sendJson(res, built.status, { ok: false, error: built.error });
  const order = built.order;

  // Anti-duplicidade (melhor esforço, sem banco): mesmo pedido em até 10 min reutiliza a cobrança.
  const fp = crypto.createHash('sha256')
    .update([order.productId, order.qty, order.cep, order.street, order.district, order.number, order.complement, order.name, order.totalCents].join('|'))
    .digest('hex');
  const now = Date.now();
  for (const [k, v] of recent) if (now - v.at > REUSE_MS) recent.delete(k);
  const retry = body.retry === true; // cliente pediu um novo Pix depois de expirar/falhar
  const hit = retry ? null : recent.get(fp);
  if (hit) return sendJson(res, 200, hit.payload);

  async function createCharge(description) {
    return fetch(MAGNUS_URL, {
      method: 'POST',
      headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amount: order.totalCents / 100, // documentado: valor em reais
        description,
        payerName: order.name,
      }),
      signal: AbortSignal.timeout(9000),
    });
  }

  let data;
  let deliveryDataSent = true;
  try {
    let r = await createCharge(order.deliveryDescription);
    if (r.status === 400 || r.status === 422) { // descrição longa recusada: tenta a versão curta
      console.error('magnus create: HTTP', r.status, '(descrição completa recusada, usando a curta)');
      deliveryDataSent = false;
      r = await createCharge(order.description);
    }
    if (!r.ok) {
      console.error('magnus create: HTTP', r.status); // nunca registrar corpo, headers ou chave
      return sendJson(res, 502, { ok: false, error: 'Não foi possível gerar o Pix agora. Tente novamente ou chame pelo WhatsApp.' });
    }
    const json = await r.json();
    data = json && json.success === true ? json.data : null;
  } catch (_) {
    console.error('magnus create: falha de rede ou tempo esgotado');
    return sendJson(res, 502, { ok: false, error: 'Não foi possível gerar o Pix agora. Tente novamente ou chame pelo WhatsApp.' });
  }

  if (!data || typeof data.transactionId !== 'string' || typeof data.copyPaste !== 'string' || !data.copyPaste) {
    console.error('magnus create: resposta fora do formato documentado');
    return sendJson(res, 502, { ok: false, error: 'Não foi possível gerar o Pix agora. Tente novamente ou chame pelo WhatsApp.' });
  }

  const payload = safeCharge(data, order, deliveryDataSent);
  recent.set(fp, { at: now, payload });
  return sendJson(res, 201, payload);
};
