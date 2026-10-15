/* Ultragaz Entregas Flash — pedido pelo WhatsApp
   JavaScript puro, sem dependências, sem backend e sem armazenar dados. */
(() => {
  'use strict';

  const WHATSAPP = '5513976033642';
  const PRICE = { regular: 110, pg: 120 };
  const MAX_QTY = 99;    // limite técnico do seletor

  // Pix (Magnus Pay): cole aqui a URL REAL da pasta /api do projeto na Vercel, sem barra no final.
  // Ex.: 'https://nome-do-projeto.vercel.app/api'. Vazio = botão Pix escondido (site funciona como antes).
  const PIX_API_BASE = 'https://ultragaz-virid.vercel.app/api';
  const PIX_MAX_GAS = 20; // acima disso o pedido é combinado pelo WhatsApp (o servidor aplica o mesmo limite)

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
    sName: $('s-name'), sAddress: $('s-address'), sOrder: $('s-order'), sTotal: $('s-total'),
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
    setText(ui.sTotal, total);
    setText(ui.barTotal, total);
    ui.sNote.textContent = note;
    ui.sNote.hidden = !note;
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
     no servidor. "Pago" só aparece quando o servidor confirma COMPLETED na Magnus Pay. */
  const pix = {
    btn: $('pix-btn'), panel: $('pix-panel'), status: $('pix-status'), total: $('pix-total'),
    qr: $('pix-qr'), code: $('pix-code'), copy: $('pix-copy'), link: $('pix-link'), wa: $('pix-wa'),
  };
  if (PIX_API_BASE && pix.btn && pix.panel) {
    let busy = false;
    let timer = null;
    let charge = null; // { id, sig, expiresAt, paid }

    pix.btn.hidden = false;

    const orderSig = () => [state.qty, digits(f.cep.value), f.number.value.trim(), f.complement.value.trim(), f.name.value.trim()].join('|');
    const setStatus = (text, kind) => { pix.status.textContent = text; pix.status.className = 'pix-status' + (kind ? ' is-' + kind : ''); };
    const stopPolling = () => { if (timer) { clearTimeout(timer); timer = null; } };
    const showError = (msg) => { ui.formError.textContent = msg; ui.formError.hidden = false; };
    const api = (path, body) => fetch(PIX_API_BASE + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });

    function whatsappLink() {
      const lines = buildMessage().split('\n');
      lines.pop(); // troca "Quero confirmar meu pedido." pelos dados do Pix
      lines.push('Pagamento: Pix ' + (charge.paid ? 'confirmado' : 'gerado (aguardando confirmação)'), 'ID da cobrança: ' + charge.id);
      return 'https://wa.me/' + WHATSAPP + '?text=' + encodeURIComponent(lines.join('\n'));
    }

    function resetPix() {
      stopPolling();
      charge = null;
      pix.panel.hidden = true;
      pix.btn.textContent = 'PAGAR COM PIX';
    }

    function poll(id) {
      stopPolling();
      const started = Date.now();
      let polls = 0;
      const tick = async () => {
        if (!charge || charge.id !== id) return;
        if (++polls > 150) { // limite de tentativas (~15 min); não presume pagamento
          setStatus('Não conseguimos confirmar o pagamento automaticamente. Se você já pagou, envie o pedido pelo WhatsApp com o ID da cobrança.', 'info');
          return;
        }
        if (Date.now() > charge.expiresAt + 30000) {
          setStatus('Este Pix expirou. Toque em "Gerar novo Pix" para pagar.', 'error');
          pix.btn.textContent = 'GERAR NOVO PIX';
          charge = null;
          return;
        }
        let next = Date.now() - started > 120000 ? 10000 : 6000;
        try {
          const res = await api('/payment-status', { transactionId: id });
          const data = res.ok ? await res.json() : null;
          if (!charge || charge.id !== id) return;
          if (data && data.status === 'COMPLETED') {
            charge.paid = true;
            setStatus('Pagamento confirmado! Envie o pedido pelo WhatsApp para agendarmos a entrega.', 'ok');
            pix.wa.href = whatsappLink();
            pix.btn.textContent = 'PIX PAGO';
            pix.btn.disabled = true;
            return;
          }
          if (data && (data.status === 'EXPIRED' || data.status === 'FAILED')) {
            setStatus(data.status === 'EXPIRED' ? 'Este Pix expirou. Toque em "Gerar novo Pix".' : 'O pagamento não foi concluído. Toque em "Gerar novo Pix".', 'error');
            pix.btn.textContent = 'GERAR NOVO PIX';
            charge = null;
            return;
          }
        } catch (_) { next = 10000; }
        timer = setTimeout(tick, next);
      };
      timer = setTimeout(tick, 6000);
    }

    function showCharge(data) {
      pix.total.textContent = money(data.total);
      pix.code.value = data.copyPaste;
      if (data.qrCodeBase64) { pix.qr.src = data.qrCodeBase64; pix.qr.hidden = false; } else { pix.qr.hidden = true; pix.qr.removeAttribute('src'); }
      if (data.paymentLink) { pix.link.href = data.paymentLink; pix.link.hidden = false; } else { pix.link.hidden = true; }
      pix.wa.href = whatsappLink();
      pix.wa.hidden = false;
      setStatus('Aguardando pagamento. Pague no app do seu banco; a confirmação aparece aqui automaticamente.', 'info');
      pix.panel.hidden = false;
      pix.panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    async function startPix() {
      if (busy) return;
      const invalid = validate();
      if (invalid) { showError('Confira os campos destacados para continuar.'); invalid.focus(); return; }
      if (state.qty > PIX_MAX_GAS) { showError('Para mais de ' + PIX_MAX_GAS + ' gases, peça pelo WhatsApp.'); return; }
      ui.formError.hidden = true;

      const sig = orderSig();
      if (charge && charge.sig === sig && Date.now() < charge.expiresAt) { pix.panel.hidden = false; pix.panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); return; }

      busy = true;
      pix.btn.disabled = true;
      pix.btn.textContent = 'GERANDO PIX…';
      try {
        const res = await api('/create-payment', {
          productId: 'gas', qty: state.qty, cep: digits(f.cep.value),
          name: f.name.value.trim(), number: f.number.value.trim(), complement: f.complement.value.trim(),
        });
        const data = await res.json().catch(() => null);
        if (!res.ok || !data || !data.ok) {
          const e = new Error('api'); e.userMessage = data && data.error; throw e;
        }
        stopPolling();
        charge = { id: data.transactionId, sig, expiresAt: Date.now() + (data.expiresInSeconds || 900) * 1000, paid: false };
        showCharge(data);
        poll(charge.id);
        pix.btn.textContent = 'VER PIX GERADO';
      } catch (err) {
        showError((err && err.userMessage) || 'Não foi possível gerar o Pix agora. Tente novamente ou confirme pelo WhatsApp.');
        pix.btn.textContent = charge ? 'VER PIX GERADO' : 'PAGAR COM PIX';
      } finally {
        busy = false;
        if (!(charge && charge.paid)) pix.btn.disabled = false;
      }
    }

    window.addEventListener('pagehide', stopPolling);
    pix.btn.addEventListener('click', startPix);
    pix.copy.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(pix.code.value); }
      catch (_) { pix.code.select(); document.execCommand('copy'); }
      pix.copy.textContent = 'CÓDIGO COPIADO ✓';
      setTimeout(() => { pix.copy.textContent = 'COPIAR CÓDIGO PIX'; }, 2000);
    });

    // Se o pedido mudar depois de gerar o Pix, o painel antigo some (evita pagar um valor desatualizado).
    const onOrderChange = () => { if (charge && !charge.paid && charge.sig !== orderSig()) { resetPix(); pix.btn.disabled = false; } };
    form.addEventListener('input', onOrderChange);
    ui.minus.addEventListener('click', onOrderChange);
    ui.plus.addEventListener('click', onOrderChange);
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
