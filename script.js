/* Ultragaz Entregas Flash — pedido e pagamento por Pix
   JavaScript puro, sem dependências. Não armazena dados no navegador; o pagamento é feito pela API na Vercel. */
(() => {
  'use strict';

  const WHATSAPP = '5513976033642';
  const PRICE = { regular: 110, pg: 120 };
  // Pagamento Pix (Magnus Pay): URL REAL da pasta /api do projeto na Vercel, sem barra no final.
  // Vazio = volta ao pedido antigo pelo WhatsApp.
  const PIX_API_BASE = 'https://ultragaz-virid.vercel.app/api';
  const PIX_MAX_GAS = 20; // mesmo limite aplicado pelo servidor
  const MAX_QTY = PIX_API_BASE ? PIX_MAX_GAS : 99; // limite do seletor


  const $ = (id) => document.getElementById(id);
  const form = $('order-form');
  if (!form) return;

  const f = {
    cep: $('cep'), cepMsg: $('cep-msg'), retry: $('cep-retry'), block: $('address-block'),
    street: $('street'), district: $('district'), city: $('city'), uf: $('uf'),
    number: $('number'), complement: $('complement'), name: $('name'),
  };
  const ui = {
    qty: $('qty'), minus: $('qty-minus'), plus: $('qty-plus'), hint: $('qty-hint'),
    sName: $('s-name'), sUnit: $('s-unit'), sAddress: $('s-address'), sOrder: $('s-order'), sTotal: $('s-total'),
    sNote: $('s-note'), badge: $('summary-badge'), barTotal: $('bar-total'), formError: $('form-error'),
  };
  const state = { qty: 1, area: null, cep: '' }; // area: 'regular' | 'pg' | 'other' | null
  let controller = null;

  /* ---------- Utilidades ---------- */
  const digits = (s) => s.replace(/\D/g, '');
  const norm = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
  const money = (n) => n.toLocaleString('pt-BR', {
    style: 'currency', currency: 'BRL', minimumFractionDigits: 0, maximumFractionDigits: 0,
  }).replace(/\u00a0/g, ' ');
  const qtyLabel = (n) => (n === 1 ? '1 gás' : n + ' gases');
  const cepFormatted = () => { const d = digits(f.cep.value); return d.slice(0, 5) + '-' + d.slice(5); };

  function setText(node, text) {
    if (node.textContent === text) return;
    node.textContent = text;
    node.classList.remove('bump');
    void node.offsetWidth; // reinicia a animação sutil
    node.classList.add('bump');
  }

  /* ---------- Regras comerciais ---------- */
  function areaOf(city, uf) {
    if (uf !== 'SP') return 'other';
    const c = norm(city);
    if (c === 'sao vicente' || c === 'santos') return 'regular';
    if (c === 'praia grande') return 'pg';
    return 'other';
  }

  // Retorna null (sem CEP) ou { unit, total }
  function quote() {
    if (state.area === 'regular') return { unit: PRICE.regular, total: PRICE.regular * state.qty };
    if (state.area === 'pg') return { unit: PRICE.pg, total: PRICE.pg * state.qty };
    return null;
  }

  /* ---------- Mensagens e erros ---------- */
  function setCepMsg(text, kind) {
    f.cepMsg.textContent = text || '';
    f.cepMsg.className = 'field-msg' + (kind ? ' is-' + kind : '');
    f.cep.setAttribute('aria-invalid', kind === 'error' ? 'true' : 'false');
  }

  function setErr(input, msg) {
    if (input === f.cep) { setCepMsg(msg, msg ? 'error' : ''); return; }
    const node = $(input.id + '-error');
    if (node) { node.textContent = msg || ''; node.className = 'field-msg' + (msg ? ' is-error' : ''); }
    input.setAttribute('aria-invalid', msg ? 'true' : 'false');
  }

  /* ---------- Resumo ---------- */
  function addressText() {
    if (!state.area || state.area === 'other') return '—';
    const num = f.number.value.trim();
    const comp = f.complement.value.trim();
    return [
      f.street.value.trim() + (num ? ', ' + num : ''),
      comp,
      f.district.value.trim(),
      f.city.value + ' - ' + f.uf.value,
      'CEP ' + cepFormatted(),
    ].filter(Boolean).join('\n');
  }

  function isReady() {
    return (state.area === 'regular' || state.area === 'pg') &&
      f.street.value.trim() && f.district.value.trim() &&
      f.number.value.trim() && f.name.value.trim().length >= 2;
  }

  function render() {
    const q = quote();
    ui.qty.textContent = state.qty;
    ui.minus.disabled = state.qty <= 1;
    ui.plus.disabled = state.qty >= MAX_QTY;

    let total = 'Informe o CEP';
    let note = '';
    let hint = 'Informe o CEP para ver o valor. São Vicente e Santos: R$ 110 · Praia Grande: R$ 120, com entrega.';

    if (q) {
      total = money(q.total);
      note = state.qty + ' × ' + money(q.unit);
      hint = (state.area === 'pg' ? 'Praia Grande: R$ 120' : 'R$ 110') + ' por gás, com entrega.';
    }

    setText(ui.sName, f.name.value.trim() || '—');
    setText(ui.sAddress, addressText());
    setText(ui.sOrder, qtyLabel(state.qty));
    setText(ui.sUnit, q ? money(q.unit) : '—');
    setText(ui.sTotal, total);
    setText(ui.barTotal, total);
    ui.sNote.textContent = note;
    ui.sNote.hidden = !note;
    if (PIX_API_BASE && state.qty >= MAX_QTY) hint += ' Limite de ' + MAX_QTY + ' por pedido no site; para mais, fale com o suporte.';
    ui.hint.textContent = hint;
    ui.badge.hidden = !isReady();
  }

  /* ---------- ViaCEP ---------- */
  function clearAddress() {
    state.area = null;
    state.cep = '';
    f.block.hidden = true;
    [f.street, f.district, f.city, f.uf].forEach((i) => { i.value = ''; setErr(i, ''); });
  }

  async function lookup(d) {
    if (d === state.cep) return; // já resolvido: evita requisição repetida
    if (controller) controller.abort();
    controller = new AbortController();
    setCepMsg('Buscando endereço…', 'info');
    try {
      const res = await fetch('https://viacep.com.br/ws/' + d + '/json/', { signal: controller.signal });
      if (res.status === 400) { clearAddress(); setCepMsg('Digite um CEP válido.', 'error'); return; }
      if (!res.ok) throw new Error('http ' + res.status);
      const data = await res.json();
      if (data.erro) {
        clearAddress();
        setCepMsg('Não encontramos esse CEP. Confira os números e tente novamente.', 'error');
        return;
      }
      state.cep = d;
      f.street.value = data.logradouro || '';
      f.district.value = data.bairro || '';
      f.city.value = data.localidade || '';
      f.uf.value = data.uf || '';
      state.area = areaOf(f.city.value, f.uf.value);
      if (state.area === 'other') {
        f.block.hidden = true;
        setCepMsg('No momento atendemos São Vicente, Santos e Praia Grande.', 'error');
        return;
      }
      setCepMsg('CEP encontrado.', 'ok');
      f.block.hidden = false;
      f.block.classList.remove('reveal');
      void f.block.offsetWidth;
      f.block.classList.add('reveal');
      if (document.activeElement === f.cep) (f.street.value ? f.number : f.street).focus();
    } catch (err) {
      if (err.name === 'AbortError') return;
      clearAddress();
      setCepMsg('Não foi possível consultar o CEP agora. Verifique sua conexão e tente novamente.', 'error');
      f.retry.hidden = false;
    } finally {
      render();
    }
  }

  f.cep.addEventListener('input', () => {
    const d = digits(f.cep.value).slice(0, 8);
    f.cep.value = d.length > 5 ? d.slice(0, 5) + '-' + d.slice(5) : d;
    f.retry.hidden = true;
    if (d.length < 8) {
      if (controller) controller.abort();
      clearAddress();
      setCepMsg('');
      render();
    } else {
      lookup(d);
    }
  });

  f.retry.addEventListener('click', () => {
    f.retry.hidden = true;
    const d = digits(f.cep.value);
    if (d.length === 8) lookup(d);
  });

  /* ---------- Campos e quantidade ---------- */
  [f.street, f.district, f.number, f.complement, f.name].forEach((input) => {
    input.addEventListener('input', () => { setErr(input, ''); ui.formError.hidden = true; render(); });
  });

  function changeQty(delta) {
    state.qty = Math.min(MAX_QTY, Math.max(1, state.qty + delta));
    render();
  }
  ui.minus.addEventListener('click', () => changeQty(-1));
  ui.plus.addEventListener('click', () => changeQty(1));

  /* ---------- Validação e envio ---------- */
  function validate() {
    let first = null;
    const bad = (input, msg) => { setErr(input, msg); if (!first) first = input; };

    if (digits(f.cep.value).length !== 8) bad(f.cep, 'Digite um CEP válido.');
    else if (!state.area) bad(f.cep, 'Aguarde a consulta do CEP ou tente novamente.');
    else if (state.area === 'other') bad(f.cep, 'No momento atendemos São Vicente, Santos e Praia Grande.');

    if (state.area === 'regular' || state.area === 'pg') {
      if (!f.street.value.trim()) bad(f.street, 'Informe a rua.');
      if (!f.district.value.trim()) bad(f.district, 'Informe o bairro.');
      if (!f.number.value.trim()) bad(f.number, 'Informe o número da residência.');
    }
    if (f.name.value.trim().length < 2) bad(f.name, 'Informe seu nome.');
    return first;
  }

  function buildMessage() {
    const q = quote();
    const total = money(q.total);
    const comp = f.complement.value.trim();
    return [
      'Olá! Quero fazer um pedido de gás.',
      '',
      'Nome: ' + f.name.value.trim(),
      '',
      'Pedido: ' + qtyLabel(state.qty),
      '',
      'Endereço:',
      f.street.value.trim() + ', ' + f.number.value.trim(),
      ...(comp ? [comp] : []),
      f.district.value.trim(),
      f.city.value + ' - ' + f.uf.value,
      'CEP: ' + cepFormatted(),
      '',
      'Total: ' + total,
      '',
      'Quero confirmar meu pedido.',
    ].join('\n');
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (PIX_API_BASE) return; // com o Pix configurado, o envio é tratado no bloco de pagamento
    const invalid = validate();
    if (invalid) {
      ui.formError.textContent = 'Confira os campos destacados para continuar.';
      ui.formError.hidden = false;
      invalid.focus();
      return;
    }
    ui.formError.hidden = true;
    const url = 'https://wa.me/' + WHATSAPP + '?text=' + encodeURIComponent(buildMessage());
    const win = window.open(url, '_blank');
    if (win) win.opener = null; else window.location.href = url;
  });

  /* ---------- Esconde o WhatsApp flutuante enquanto o formulário está na tela ---------- */
  const section = $('pedido');
  if (section && 'IntersectionObserver' in window) {
    new IntersectionObserver(([entry]) => {
      document.body.classList.toggle('in-order', entry.isIntersecting);
    }, { threshold: 0.05 }).observe(section);
  }


  /* ---------- Pagamento por Pix (Magnus Pay) ----------
     O navegador só envia produto, quantidade e dados de entrega. Preço e cidade são decididos
     no servidor. "Pago" só aparece quando o servidor confirma COMPLETED na Magnus Pay.
     O site não guarda pedidos: os dados de entrega seguem na descrição da cobrança Pix. */
  const pix = {
    btn: $('pix-btn'), panel: $('pix-panel'), title: $('pay-title'), total: $('pix-total'), status: $('pix-status'),
    timer: $('pix-timer'), countdown: $('pix-countdown'), body: $('pay-body'), qr: $('pix-qr'), code: $('pix-code'),
    copy: $('pix-copy'), copyMsg: $('pix-copy-msg'), link: $('pix-link'), done: $('pay-done'),
    dTotal: $('pd-total'), dOrder: $('pd-order'), dAddress: $('pd-address'), dId: $('pd-id'), dNext: $('pd-next'),
    newBtn: $('pix-new'), check: $('pix-check'), retry: $('pix-retry'), edit: $('pix-edit'),
    support: $('pix-support'), formSupport: $('support-link'),
  };

  function supportUrl(charge) {
    const lines = ['Olá! Preciso de ajuda com meu pedido feito no site.'];
    if (charge) lines.push('ID da cobrança Pix: ' + charge.id);
    const q = quote();
    if (q) lines.push('Pedido: ' + qtyLabel(state.qty) + ' - Total ' + money(q.total));
    return 'https://wa.me/' + WHATSAPP + '?text=' + encodeURIComponent(lines.join('\n'));
  }

  if (PIX_API_BASE && pix.btn && pix.panel) {
    const MAX_POLLS = 150;
    let busy = false;
    let pollTimer = null;
    let clockTimer = null;
    let charge = null; // { id, sig, expiresAt, total, qty, delivery, paid, over }

    const orderSig = () => [state.qty, digits(f.cep.value), f.street.value.trim(), f.district.value.trim(), f.number.value.trim(), f.complement.value.trim(), f.name.value.trim()].join('|');
    const showError = (msg) => { ui.formError.textContent = msg; ui.formError.hidden = false; };
    const stopPolling = () => { if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; } };
    const stopClock = () => { if (clockTimer) { clearTimeout(clockTimer); clockTimer = null; } };
    const api = (path, body) => fetch(PIX_API_BASE + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const refreshSupport = () => { pix.support.href = supportUrl(charge); pix.formSupport.href = supportUrl(charge); };

    const TEXT = {
      waiting: ['Aguardando o pagamento. Assim que você pagar, a confirmação aparece aqui automaticamente.', 'info'],
      stalled: ['Não conseguimos confirmar agora. Se você já pagou, toque em "Verificar pagamento agora".', 'error'],
      expired: ['Este Pix expirou e não foi pago. Gere um novo Pix para continuar.', 'error'],
      failed: ['O pagamento não foi concluído. Você pode gerar um novo Pix.', 'error'],
      paid: ['Pagamento confirmado!', 'ok'],
    };

    function setMode(mode) {
      const live = mode === 'waiting' || mode === 'stalled';
      pix.status.textContent = TEXT[mode][0];
      pix.status.className = 'pay-status is-' + TEXT[mode][1];
      pix.body.hidden = !live;
      pix.timer.hidden = !live;
      pix.check.hidden = mode !== 'stalled';
      pix.retry.hidden = !(mode === 'expired' || mode === 'failed');
      pix.edit.hidden = mode === 'paid';
      pix.done.hidden = mode !== 'paid';
      pix.title.textContent = mode === 'paid' ? 'Pagamento confirmado' : 'Pague com Pix';
    }

    function finish(mode) {
      stopPolling(); stopClock();
      if (charge) charge.over = mode;
      setMode(mode);
    }

    function lockForm() {
      [f.cep, f.street, f.district, f.number, f.complement, f.name, ui.minus, ui.plus].forEach((i) => { i.disabled = true; });
    }

    function markPaid() {
      stopPolling(); stopClock();
      charge.paid = true;
      pix.dTotal.textContent = money(charge.total);
      pix.dOrder.textContent = qtyLabel(charge.qty);
      pix.dAddress.textContent = addressText();
      pix.dId.textContent = charge.id;
      pix.dNext.textContent = charge.delivery
        ? 'Os dados de entrega acompanham o pagamento. Deixe o botijão vazio em mãos para a troca. Para acompanhar a entrega ou tirar dúvidas, fale com o suporte.'
        : 'Atenção: os dados de entrega não acompanharam a cobrança. Fale agora com o suporte pelo WhatsApp informando o ID abaixo para confirmar a entrega.';
      setMode('paid');
      lockForm();
      pix.title.focus();
    }

    async function checkStatus(id) {
      try {
        const res = await api('/payment-status', { transactionId: id });
        const data = res.ok ? await res.json() : null;
        return data && data.ok ? data.status : null;
      } catch (_) { return null; }
    }

    function applyStatus(status) {
      if (status === 'COMPLETED') { markPaid(); return true; }
      if (status === 'EXPIRED') { finish('expired'); return true; }
      if (status === 'FAILED') { finish('failed'); return true; }
      return false;
    }

    function poll(id) {
      stopPolling();
      const started = Date.now();
      let polls = 0;
      let fails = 0;
      const loop = async () => {
        if (!charge || charge.id !== id || charge.over || charge.paid) return;
        if (++polls > MAX_POLLS) { stopClock(); setMode('stalled'); return; } // limite de tentativas
        const status = await checkStatus(id);
        if (!charge || charge.id !== id || charge.over || charge.paid) return;
        if (status === null) { if (++fails >= 5) { setMode('stalled'); return; } } else { fails = 0; if (applyStatus(status)) return; }
        pollTimer = setTimeout(loop, Date.now() - started > 120000 ? 10000 : 6000);
      };
      pollTimer = setTimeout(loop, 6000);
    }

    function runClock() {
      stopClock();
      const step = () => {
        if (!charge || charge.paid || charge.over) return;
        const msLeft = charge.expiresAt - Date.now();
        const left = Math.max(0, Math.round(msLeft / 1000));
        pix.countdown.textContent = String(Math.floor(left / 60)).padStart(2, '0') + ':' + String(left % 60).padStart(2, '0');
        if (msLeft < -45000) { finish('expired'); return; } // margem para a confirmação final do gateway
        clockTimer = setTimeout(step, 1000);
      };
      step();
    }

    function resetPix() {
      stopPolling(); stopClock();
      charge = null;
      pix.panel.hidden = true;
      form.classList.remove('is-paying');
      pix.btn.disabled = false;
      pix.btn.textContent = 'GERAR PIX PARA PAGAR';
    }

    function showCharge(data) {
      pix.total.textContent = money(data.total);
      pix.code.value = data.copyPaste;
      pix.copyMsg.textContent = '';
      if (data.qrCodeBase64) { pix.qr.src = data.qrCodeBase64; pix.qr.hidden = false; } else { pix.qr.hidden = true; pix.qr.removeAttribute('src'); }
      if (data.paymentLink) { pix.link.href = data.paymentLink; pix.link.hidden = false; } else { pix.link.hidden = true; }
      refreshSupport();
      setMode('waiting');
      form.classList.add('is-paying');
      pix.panel.hidden = false;
      pix.panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    async function startPix(retry) {
      if (busy) return;
      const invalid = validate();
      if (invalid) { showError('Confira os campos destacados para continuar.'); invalid.focus(); return; }
      if (state.qty > PIX_MAX_GAS) { showError('Pedidos acima de ' + PIX_MAX_GAS + ' gases são combinados pelo suporte no WhatsApp.'); return; }
      ui.formError.hidden = true;

      const sig = orderSig();
      if (!retry && charge && !charge.over && !charge.paid && charge.sig === sig && Date.now() < charge.expiresAt) {
        pix.panel.hidden = false; form.classList.add('is-paying'); return; // reaproveita a cobrança: sem duplicar
      }

      busy = true;
      pix.btn.disabled = true;
      pix.btn.textContent = 'GERANDO PIX…';
      pix.btn.setAttribute('aria-busy', 'true');
      try {
        const res = await api('/create-payment', {
          productId: 'gas', qty: state.qty, cep: digits(f.cep.value),
          name: f.name.value.trim(), street: f.street.value.trim(), district: f.district.value.trim(),
          number: f.number.value.trim(), complement: f.complement.value.trim(), retry: Boolean(retry),
        });
        const data = await res.json().catch(() => null);
        if (!res.ok || !data || !data.ok) { const e = new Error('api'); e.userMessage = data && data.error; throw e; }
        stopPolling(); stopClock();
        charge = {
          id: data.transactionId, sig, total: data.total, qty: data.qty, delivery: Boolean(data.deliveryDataSent),
          expiresAt: Date.now() + (data.expiresInSeconds || 900) * 1000, paid: false, over: null,
        };
        showCharge(data);
        runClock();
        poll(charge.id);
      } catch (err) {
        showError((err && err.userMessage) || 'Não foi possível gerar o Pix agora. Verifique sua conexão e tente novamente.');
        refreshSupport();
      } finally {
        busy = false;
        pix.btn.removeAttribute('aria-busy');
        pix.btn.disabled = Boolean(charge && charge.paid);
        pix.btn.textContent = 'GERAR PIX PARA PAGAR';
      }
    }

    pix.btn.textContent = 'GERAR PIX PARA PAGAR';
    refreshSupport();
    form.addEventListener('submit', (e) => { e.preventDefault(); startPix(false); });
    pix.retry.addEventListener('click', () => startPix(true));
    pix.check.addEventListener('click', async () => {
      if (!charge || charge.paid || charge.over) return;
      pix.check.disabled = true;
      const status = await checkStatus(charge.id);
      pix.check.disabled = false;
      if (status && applyStatus(status)) return;
      setMode(status ? 'waiting' : 'stalled');
      if (status) { runClock(); poll(charge.id); }
    });
    pix.edit.addEventListener('click', () => { resetPix(); f.name.focus(); });
    pix.newBtn.addEventListener('click', () => window.location.reload());
    pix.copy.addEventListener('click', async () => {
      let ok = true;
      try { await navigator.clipboard.writeText(pix.code.value); }
      catch (_) { try { pix.code.select(); ok = document.execCommand('copy'); } catch (__) { ok = false; } }
      pix.copyMsg.className = 'pay-feedback ' + (ok ? 'is-ok' : 'is-error');
      pix.copyMsg.textContent = ok ? 'Código copiado! Cole no app do seu banco.' : 'Não foi possível copiar sozinho. Toque no código, selecione e copie.';
    });

    // Se o pedido mudar depois de gerar o Pix, a tela antiga some (evita pagar um valor desatualizado).
    const onOrderChange = () => { if (charge && !charge.paid && charge.sig !== orderSig()) resetPix(); };
    form.addEventListener('input', onOrderChange);
    ui.minus.addEventListener('click', onOrderChange);
    ui.plus.addEventListener('click', onOrderChange);
    window.addEventListener('pagehide', () => { stopPolling(); stopClock(); });
  } else if (pix.btn) {
    pix.btn.textContent = 'CONFIRMAR PEDIDO PELO WHATSAPP'; // sem API de pagamento configurada, volta ao fluxo antigo
  }

  render();
})();

/* Carrossel de fotos dos produtos — rolagem nativa com scroll-snap (swipe no celular)
   + setas, pontos e teclado. Independente do sistema de pedido de gás. */
(() => {
  'use strict';
  document.querySelectorAll('[data-carousel]').forEach((root) => {
    const track = root.querySelector('.carousel-track');
    const count = root.querySelectorAll('.carousel-slide').length;
    const dots = root.querySelectorAll('.carousel-dot');
    const prev = root.querySelector('.carousel-prev');
    const next = root.querySelector('.carousel-next');
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
    let index = 0;
    let ticking = false;

    const go = (i) => {
      const n = Math.max(0, Math.min(count - 1, i));
      track.scrollTo({ left: n * track.clientWidth, behavior: reduce.matches ? 'auto' : 'smooth' });
    };
    const update = () => {
      index = Math.round(track.scrollLeft / track.clientWidth) || 0;
      dots.forEach((d, i) => d.setAttribute('aria-current', i === index ? 'true' : 'false'));
      prev.disabled = index <= 0;
      next.disabled = index >= count - 1;
    };

    track.addEventListener('scroll', () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => { ticking = false; update(); });
    }, { passive: true });
    prev.addEventListener('click', () => go(index - 1));
    next.addEventListener('click', () => go(index + 1));
    dots.forEach((d, i) => d.addEventListener('click', () => go(i)));
    track.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft') { e.preventDefault(); go(index - 1); }
      if (e.key === 'ArrowRight') { e.preventDefault(); go(index + 1); }
    });
    window.addEventListener('resize', () => track.scrollTo({ left: index * track.clientWidth, behavior: 'auto' }));
    update();
  });
})();
