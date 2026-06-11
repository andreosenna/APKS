/**
 * sync.js — Gerenciador de sincronização offline/online com retry e dedupe.
 *
 *  - Cada item enviado inclui client_uuid (idempotencia no backend).
 *  - Em falha de rede: para o loop e tenta depois.
 *  - Em 5xx: backoff exponencial (30s, 1, 5, 15, 60 min).
 *  - Em 4xx: marca como erro definitivo (nao reenvia, nao trava a fila).
 *  - Em 2xx ou duplicate: remove da fila.
 */

import { adicionarNaFila, listarFila, removerDaFila } from './db.js';

const BACKEND_URL    = window.APP_CONFIG?.backendUrl || 'http://localhost:3001';
// 4xx (erro do cliente) tem teto — apontamento "rejeitado" nao deve ficar tentando pra sempre.
const MAX_TENTATIVAS = 5;
// 5xx (servidor fora, blob indisponivel etc) nao tem teto: enquanto o problema nao resolver,
// a fila continua tentando com backoff max de 60 min. Evita perder dados se o Vercel engasgar.

function agora() { return Date.now(); }

function gerarUUID() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, ch => {
    const r = Math.random() * 16 | 0;
    return (ch === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

function proximoBackoff(errorCount) {
  const minutos = [0.5, 1, 5, 15, 60];
  const idx = Math.min(errorCount, minutos.length - 1);
  return agora() + minutos[idx] * 60 * 1000;
}

// Reescreve um item da fila (preservando o id) via IndexedDB direto.
function atualizarItemFila(store, item) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('apontamento-db');
    req.onsuccess = (e) => {
      const db = e.target.result;
      const tx = db.transaction(store, 'readwrite');
      const putReq = tx.objectStore(store).put(item);
      putReq.onsuccess = () => resolve();
      putReq.onerror   = () => reject(putReq.error);
    };
    req.onerror = () => reject(req.error);
  });
}

// ---------------------------------------------------------------------------
// Badge de status
// ---------------------------------------------------------------------------

export function atualizarBadgeSync() {
  const el = document.getElementById('sync-status');
  if (!el) return;

  Promise.all([
    listarFila('fila-apontamentos'),
    listarFila('fila-eventos'),
    listarFila('fila-operacoes').catch(() => []),
  ]).then(([filaApt, filaEvt, filaOp]) => {
      const todas   = [...filaApt, ...filaEvt, ...filaOp];
      const total   = todas.length;
      const comErro = todas.filter(i => (i.error_count || 0) >= MAX_TENTATIVAS).length;

      if (!navigator.onLine) {
        el.className   = 'sync-badge sync-offline';
        el.textContent = total > 0 ? `⚠ Offline · ${total}` : '⚠ Offline';
        el.title       = total > 0 ? `${total} apontamento(s) aguardando conexao` : 'Sem conexao';
      } else if (comErro > 0) {
        el.className   = 'sync-badge sync-offline';
        el.textContent = `⚠ Erro · ${comErro}`;
        el.title       = `${comErro} item(s) rejeitados pelo servidor. Veja o historico.`;
      } else if (total > 0) {
        el.className   = 'sync-badge sync-pending';
        el.textContent = `⏳ ${total} na fila`;
        el.title       = 'Enviando para o servidor...';
      } else {
        el.className   = 'sync-badge sync-online';
        el.textContent = '✓ Online';
        el.title       = 'Todos os apontamentos foram sincronizados';
      }
  }).catch(() => {
    el.className   = 'sync-badge sync-online';
    el.textContent = '● Online';
  });
}

// ---------------------------------------------------------------------------
// Sincronização
// ---------------------------------------------------------------------------

async function sincronizarStore(store, endpoint) {
  const itens = await listarFila(store);
  for (const item of itens) {
    try {
      // 4xx permanente: respeita o teto. 5xx: segue tentando (nao tem bloqueio)
      if (item.last_status_class === '4xx' && (item.error_count || 0) >= MAX_TENTATIVAS) continue;
      if (item.next_retry_at && item.next_retry_at > agora()) continue;

      // Item corrompido (sem payload): marca como erro permanente para nao
      // travar a fila e segue para o proximo (MEDIO 11).
      if (!item.dados || typeof item.dados !== 'object') {
        item.last_status_class = '4xx';
        item.error_count = MAX_TENTATIVAS;
        item.last_error  = 'item_corrompido';
        await atualizarItemFila(store, item);
        console.warn(`[SYNC] ${store} #${item.id} corrompido (sem dados) — ignorado`);
        continue;
      }

      if (!item.dados.client_uuid) {
        item.dados.client_uuid = gerarUUID();
        await atualizarItemFila(store, item);
      }

      let resp;
      try {
        resp = await fetch(`${BACKEND_URL}${endpoint}`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify(item.dados),
        });
      } catch (_err) {
        break; // sem rede, tentar depois
      }

      if (resp.ok) {
        await removerDaFila(store, item.id);
        continue;
      }

      let body = null;
      try { body = await resp.json(); } catch (_) {}

      if (body && (body.duplicate === true || body.error === 'DUPLICATE_UUID')) {
        await removerDaFila(store, item.id);
        continue;
      }

      if (resp.status >= 400 && resp.status < 500) {
        // 4xx = cliente mandou algo invalido. Marca como permanente e para.
        item.last_status_class = '4xx';
        item.error_count = MAX_TENTATIVAS;
        item.last_error  = (body && body.error) || `HTTP ${resp.status}`;
        await atualizarItemFila(store, item);
        console.warn(`[SYNC] ${store} #${item.id} rejeitado (4xx, nao vai reenviar): ${item.last_error}`);
        continue;
      }

      // 5xx ou erro inesperado: backoff, mas nao cria teto de tentativas
      item.last_status_class = '5xx';
      item.error_count   = (item.error_count || 0) + 1;
      item.last_error    = (body && body.error) || `HTTP ${resp.status}`;
      item.next_retry_at = proximoBackoff(item.error_count);
      await atualizarItemFila(store, item);
      console.warn(`[SYNC] ${store} #${item.id} falhou (${item.last_error}). Tentativa ${item.error_count} — vai tentar de novo`);
    } catch (err) {
      // Erro inesperado ao processar este item (ex.: IndexedDB indisponivel).
      // Sem este catch, um unico item ruim abortaria o loop e travaria a fila
      // inteira para sempre (MEDIO 11). Pula para o proximo.
      console.error(`[SYNC] ${store} #${item && item.id} erro inesperado — pulando:`, err);
    }
  }
}

// Processa fila-operacoes (reabrir OP, corrigir apontamento).
async function sincronizarOperacoes() {
  const itens = await listarFila('fila-operacoes');
  for (const item of itens) {
    try {
      if (item.last_status_class === '4xx' && (item.error_count || 0) >= MAX_TENTATIVAS) continue;
      if (item.next_retry_at && item.next_retry_at > agora()) continue;

      // Item corrompido (sem payload): marca permanente e segue (MEDIO 11).
      if (!item.dados || typeof item.dados !== 'object') {
        item.last_status_class = '4xx';
        item.error_count = MAX_TENTATIVAS;
        item.last_error  = 'item_corrompido';
        await atualizarItemFila('fila-operacoes', item);
        console.warn(`[SYNC] operacao #${item.id} corrompida (sem dados) — ignorada`);
        continue;
      }

      const { endpoint, method, body } = item.dados;
      let resp;
      try {
        resp = await fetch(`${BACKEND_URL}${endpoint}`, {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      } catch (_err) { break; }

      if (resp.ok) {
        await removerDaFila('fila-operacoes', item.id);
        continue;
      }

      let respBody = null;
      try { respBody = await resp.json(); } catch (_) {}

      if (respBody && (respBody.duplicate === true || respBody.error === 'DUPLICATE_UUID')) {
        await removerDaFila('fila-operacoes', item.id);
        continue;
      }

      if (resp.status >= 400 && resp.status < 500) {
        item.last_status_class = '4xx';
        item.error_count = MAX_TENTATIVAS;
        item.last_error  = (respBody && respBody.error) || `HTTP ${resp.status}`;
        await atualizarItemFila('fila-operacoes', item);
        console.warn(`[SYNC] operacao ${item.dados.tipo} #${item.id} rejeitada (4xx): ${item.last_error}`);
        continue;
      }

      item.last_status_class = '5xx';
      item.error_count   = (item.error_count || 0) + 1;
      item.last_error    = (respBody && respBody.error) || `HTTP ${resp.status}`;
      item.next_retry_at = proximoBackoff(item.error_count);
      await atualizarItemFila('fila-operacoes', item);
    } catch (err) {
      // Um item ruim nao pode abortar o loop e travar a fila inteira (MEDIO 11).
      console.error(`[SYNC] operacao #${item && item.id} erro inesperado — pulando:`, err);
    }
  }
}

export async function sincronizar() {
  if (!navigator.onLine) return;
  try {
    await sincronizarStore('fila-eventos',      '/api/op/iniciar');
    await sincronizarStore('fila-apontamentos', '/api/apontamento');
    await sincronizarOperacoes();
  } finally {
    atualizarBadgeSync();
  }
}

// ---------------------------------------------------------------------------
// Adicionar na fila
// ---------------------------------------------------------------------------

function envelopeItem(dados) {
  const clone = { ...dados };
  if (!clone.client_uuid) clone.client_uuid = gerarUUID();
  return { dados: clone, error_count: 0, last_error: null, next_retry_at: 0 };
}

export async function adicionarApontamentoNaFila(dados) {
  await adicionarNaFila('fila-apontamentos', envelopeItem(dados));
  atualizarBadgeSync();
}

export async function adicionarEventoNaFila(dados) {
  await adicionarNaFila('fila-eventos', envelopeItem(dados));
  atualizarBadgeSync();
}

// ---------------------------------------------------------------------------
// Listeners
// ---------------------------------------------------------------------------

window.addEventListener('online', () => {
  console.log('[SYNC] Conexão restaurada — sincronizando fila...');
  atualizarBadgeSync();
  sincronizar();
});

window.addEventListener('offline', () => {
  console.log('[SYNC] Conexão perdida');
  atualizarBadgeSync();
});

// Retry periodico para itens com next_retry_at vencido
setInterval(() => { if (navigator.onLine) sincronizar().catch(() => {}); }, 60 * 1000);

atualizarBadgeSync();
