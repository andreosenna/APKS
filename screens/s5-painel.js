/**
 * s5-painel.js — Painel de Producao
 * Mostra OPs em execucao com progresso de producao e graficos comparativos.
 */

import { estado, irParaTela } from '../app.js';
import { getPainelProducao } from '../api.js';
import { formatarNumBR, formatarDataDiaMes, escHtml } from '../utils.js';
import * as admin from '../admin.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function corProgresso(pct) {
  if (pct >= 90) return '#16a34a';  // verde — color-success
  if (pct >= 60) return '#0ea5e9';  // azul  — color-primary
  if (pct >= 30) return '#d97706';  // laranja — color-warning
  return '#e03e3e';                  // vermelho — color-danger
}

// Evita arredondar 99,76% para 100% — só mostra 100 quando realmente fechou.
function fmtPct(pct) {
  const v = Number(pct) || 0;
  if (v >= 100) return '100';
  return String(Math.floor(v));
}

// ---------------------------------------------------------------------------
// TODO (quando tiver integracao com Protheus):
//   1) Calcular o ritmo comparando com o PH cadastrado do produto (tabela SB1
//      customizada ou SG2). Hoje nao temos esse dado — entao o status de
//      "NO RITMO / ATRASADO" esta desabilitado. Voltar a calcular quando
//      tivermos { produto, ph_cadastro } vindo do Protheus.
//   2) OPs podem durar varios dias (3-4). A meta linear dia-a-dia usando
//      c2_datprf esta removida porque sem PH nao da pra projetar corretamente
//      o quanto deveria ter sido feito ate agora.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Renderizar
// ---------------------------------------------------------------------------

export async function render(container) {
  // Mata timers de uma sessao de modo TV anterior que nao tenha sido encerrada
  // pelo botao ✕ (ex.: voltar pra ca apos a sessao expirar) — evita vazamento (A7).
  limparTvTimers();
  container.innerHTML = `
    <div class="screen-topbar">
      <div class="screen-topbar-left">
        <button class="btn-voltar-padrao" id="btn-voltar-painel">← Voltar</button>
        <h2>Painel de Produção</h2>
      </div>
      <div class="screen-topbar-right">
        <button class="btn btn-secondary btn-sm" id="btn-modo-tv" title="Modo TV rotativo (para monitor da fabrica)">📺 TV</button>
        <button class="btn btn-secondary btn-sm" id="btn-exportar-excel" title="Exportar apontamentos em Excel">📥 Excel</button>
        <button class="btn btn-secondary btn-sm" id="btn-consolidado-turno" title="Consolidado por turno">🕒 Turnos</button>
        <button class="btn btn-secondary btn-sm" id="btn-recarregar-dados" title="Recarregar dados dos arquivos Excel" style="display:none;">🔄 Recarregar</button>
        <button class="btn btn-secondary btn-sm" id="btn-refresh-painel">Atualizar</button>
        <button class="btn btn-secondary btn-sm" id="btn-admin-toggle" title="Entrar / sair do modo admin">🔑 Admin</button>
        <span class="badge badge-primary" id="badge-admin" style="display:none;">⚙ Admin</span>
      </div>
    </div>
    <p class="painel-subtitulo" style="margin-top:-8px;margin-bottom:16px;">OPs em execução nas máquinas</p>
    <!-- Banner removido: o status do modo fica implícito pela presença do botão Recarregar -->
    <div id="painel-modo-banner" style="display:none;"></div>

    <!-- Banner mostrando modo de integracao -->
    <div id="painel-modo-banner" style="display:none;"></div>

    <div id="painel-loading" class="loading-center">
      <div class="spinner"></div>
      <span>Carregando painel...</span>
    </div>
    <div id="painel-erro" class="error-box" style="display:none;"></div>

    <!-- Resumo geral -->
    <div id="painel-resumo" style="display:none;"></div>

    <!-- Grafico comparativo geral -->
    <div id="painel-grafico" style="display:none;"></div>

    <!-- Cards individuais -->
    <div id="painel-cards"></div>
  `;

  document.getElementById('btn-voltar-painel').addEventListener('click', () => irParaTela(0));
  document.getElementById('btn-refresh-painel').addEventListener('click', () => render(container));

  document.getElementById('btn-exportar-excel').addEventListener('click', abrirExportPrompt);
  document.getElementById('btn-consolidado-turno').addEventListener('click', () => irParaTela('consolidado'));
  document.getElementById('btn-modo-tv').addEventListener('click', () => ativarModoTV(container));

  // Modo admin: botao toggle so faz sentido como fallback (digitar ADMIN_TOKEN).
  // Se ja somos editor por role, esconde o botao e deixa badge/backup sempre visiveis.
  const btnAdminToggle = document.getElementById('btn-admin-toggle');
  const ehEditorPorRole = admin.getRole() === 'editor';
  if (ehEditorPorRole && btnAdminToggle) {
    btnAdminToggle.style.display = 'none';
  } else if (btnAdminToggle) {
    btnAdminToggle.addEventListener('click', async () => {
      if (admin.isEditor()) {
        admin.sairFallback();
        atualizarUiAdmin();
      } else {
        const ok = await admin.entrarFallback();
        if (ok) atualizarUiAdmin();
      }
    });
  }
  atualizarUiAdmin();

  function atualizarUiAdmin() {
    const ativo = admin.isEditor();
    if (btnAdminToggle && !ehEditorPorRole) {
      btnAdminToggle.textContent = ativo ? '🚪 Sair' : '🔑 Admin';
      btnAdminToggle.title = ativo ? 'Sair do modo admin' : 'Entrar no modo admin';
    }
    document.getElementById('badge-admin').style.display = ativo ? 'inline-flex' : 'none';
  }

  // Mostrar botão "Recarregar" apenas no modo EXCEL (remove se for outro modo)
  await configurarBotaoRecarregar();

  await carregarDados();

  async function configurarBotaoRecarregar() {
    const btnReload = document.getElementById('btn-recarregar-dados');
    if (!btnReload) return;
    try {
      const url = (window.APP_CONFIG?.backendUrl || 'http://localhost:3001') + '/api/integracao/status';
      const res = await fetch(url).then(r => r.json());
      const modo = res?.data?.modo;

      if (modo === 'EXCEL') {
        btnReload.style.display = 'inline-flex';
        btnReload.addEventListener('click', async () => {
          btnReload.disabled = true;
          btnReload.textContent = 'Recarregando...';
          try {
            const urlReload = (window.APP_CONFIG?.backendUrl || 'http://localhost:3001') + '/api/integracao/recarregar';
            await fetch(urlReload, { method: 'POST' });
            render(container);
          } catch (e) {
            alert('Erro ao recarregar: ' + e.message);
            btnReload.disabled = false;
            btnReload.textContent = '🔄 Recarregar';
          }
        });
      } else {
        btnReload.remove();   // se não for EXCEL, tira do DOM
      }
    } catch (_) { /* silencioso */ }
  }

  async function carregarDados() {
    const loading = document.getElementById('painel-loading');
    const erro    = document.getElementById('painel-erro');
    loading.style.display = 'flex';
    erro.style.display    = 'none';

    const res = await getPainelProducao();
    loading.style.display = 'none';

    if (!res.success) {
      erro.style.display = 'block';
      erro.textContent = res.error || 'Erro ao carregar painel';
      return;
    }

    const dados = res.data || [];

    if (!dados.length) {
      document.getElementById('painel-cards').innerHTML = `
        <div style="text-align: center; padding: 60px 20px; color: var(--color-muted);">
          <div style="font-size: 48px; margin-bottom: 16px;">⚙</div>
          <div style="font-size: 16px; font-weight: 600;">Nenhuma OP em execucao</div>
          <div style="font-size: 13px; margin-top: 8px;">Inicie uma OP em alguma maquina para ver o progresso aqui.</div>
        </div>`;
      return;
    }

    // Se so temos paradas (sem OP ativa), esconde resumo/grafico e mostra so os cards.
    const temOp = dados.some(d => !d.is_parada_aberta);
    if (!temOp) {
      document.getElementById('painel-resumo').style.display = 'none';
      document.getElementById('painel-grafico').style.display = 'none';
      renderCards(dados);
      return;
    }

    renderResumo(dados);
    renderGraficoGeral(dados);
    renderCards(dados);
  }
}

// ---------------------------------------------------------------------------
// Resumo geral (totais)
// ---------------------------------------------------------------------------

function renderResumo(dados) {
  // Separa maquinas: producao ativa, pausadas, paradas (sem OP). Metricas de
  // producao so consideram as PRODUZINDO (nem pausada nem parada).
  const dadosAtivos  = dados.filter(d => !d.is_parada_aberta && !d.is_op_pausada);
  const qtdPausadas  = dados.filter(d =>  d.is_op_pausada).length;
  const qtdParadas   = dados.filter(d =>  d.is_parada_aberta).length;
  // "Em producao" = ativa e ainda nao encerrada. OP encerrada nao conta como ativa.
  const dadosEmProducao = dadosAtivos.filter(d => !d.encerrada_hoje);
  const qtdEncerradas   = dadosAtivos.length - dadosEmProducao.length;

  const totalPlanejado = dadosAtivos.reduce((s, d) => s + d.planejado_kg, 0);
  const totalProduzido = dadosAtivos.reduce((s, d) => s + d.produzido_kg, 0);
  const pctGeral       = dadosAtivos.length > 0 ? dadosAtivos.reduce((s, d) => s + d.percentual, 0) / dadosAtivos.length : 0;
  const dadosOp = dadosAtivos; // alias preserva linha abaixo

  const el = document.getElementById('painel-resumo');
  el.style.display = 'block';
  el.innerHTML = `
    <div class="painel-resumo-grid">
      <div class="resumo-card">
        <div class="resumo-valor">${dadosEmProducao.length}${qtdEncerradas > 0 ? ` <span style="font-size:16px;color:#16a34a;">+ ${qtdEncerradas} ✓</span>` : ''}${qtdPausadas > 0 ? ` <span style="font-size:16px;color:#1e40af;">+ ${qtdPausadas} ⏸</span>` : ''}${qtdParadas > 0 ? ` <span style="font-size:16px;color:#92400e;">+ ${qtdParadas} ⛔</span>` : ''}</div>
        <div class="resumo-label">Maquinas ativas${qtdEncerradas > 0 ? ' / encerradas' : ''}${qtdPausadas > 0 ? ' / pausadas' : ''}${qtdParadas > 0 ? ' / paradas' : ''}</div>
      </div>
      <div class="resumo-card">
        <div class="resumo-valor" style="color: var(--color-primary);">${formatarNumBR(totalProduzido, 0)} kg</div>
        <div class="resumo-label">Total produzido</div>
      </div>
      <div class="resumo-card">
        <div class="resumo-valor" style="color: var(--color-muted);">${formatarNumBR(totalPlanejado, 0)} kg</div>
        <div class="resumo-label">Total planejado</div>
      </div>
      <div class="resumo-card">
        <div class="resumo-valor" style="color: ${corProgresso(pctGeral)};">${pctGeral.toFixed(1)}%</div>
        <div class="resumo-label">Progresso geral</div>
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Grafico de barras comparativo (SVG puro, sem dependencias)
// ---------------------------------------------------------------------------

function renderGraficoGeral(dadosTodos) {
  const el = document.getElementById('painel-grafico');
  // OP encerrada nao ocupa mais a maquina -- fica fora do grafico de progresso.
  const base = (dadosTodos || []).filter(d => !d.encerrada_hoje);
  if (base.length === 0) { el.style.display = 'none'; return; }
  el.style.display = 'block';

  // Ordenacao: producao ativa primeiro, paradas no meio, OPs pausadas por
  // ultimo. Pausadas devem ficar visualmente no fim pra nao competirem com as
  // que estao realmente produzindo.
  const ativas   = base.filter(d => !d.is_parada_aberta && !d.is_op_pausada);
  const paradas  = base.filter(d =>  d.is_parada_aberta);
  const pausadas = base.filter(d =>  d.is_op_pausada);
  const dados = [...ativas, ...paradas, ...pausadas];

  const barHeight   = 36;
  const labelWidth  = 90;
  const valueWidth  = 80;
  const gap         = 8;
  const chartWidth  = 600;
  const totalHeight = dados.length * (barHeight + gap) + 20;
  const larguraBarra = chartWidth - labelWidth - valueWidth;

  const bars = dados.map((d, i) => {
    const y = i * (barHeight + gap) + 10;
    const labelMaq = d.maquina_desc || d.maquina_cod;

    // Maquina parada (com motivo ou sem OP) — barra cinza com selo vermelho "PARADA"
    if (d.is_parada_aberta) {
      const motivo = d.parada_aberta?.motivo || (d.is_sem_op ? 'Sem OP ativa' : 'Parada');
      return `
        <text x="${labelWidth - 8}" y="${y + barHeight / 2 + 1}" text-anchor="end"
              font-size="12" font-weight="600" fill="#374151">${truncar(labelMaq, 14)}</text>

        <rect x="${labelWidth}" y="${y}" width="${larguraBarra}" height="${barHeight / 2 - 1}"
              rx="3" fill="#fee2e2"/>
        <rect x="${labelWidth}" y="${y}" width="72" height="${barHeight / 2 - 1}"
              rx="3" fill="#dc2626"/>
        <text x="${labelWidth + 36}" y="${y + barHeight / 2 - 4}"
              text-anchor="middle" font-size="10" font-weight="800" fill="#fff">⏸ PARADA</text>

        <text x="${labelWidth}" y="${y + barHeight - 4}"
              font-size="10" fill="#991b1b" font-weight="600">${truncar(motivo, 45)}</text>

        <text x="${labelWidth + larguraBarra + 6}" y="${y + barHeight / 2 - 4}"
              font-size="11" font-weight="700" fill="#dc2626">—</text>
      `;
    }

    // OP pausada — barra ambar com selo "⏸ PAUSADA" pra destacar visualmente
    // (diferente da parada vermelha: aqui a maquina tem OP, so esta aguardando
    // retomada).
    if (d.is_op_pausada) {
      const motivo = d.motivo_pausa || 'OP pausada';
      return `
        <text x="${labelWidth - 8}" y="${y + barHeight / 2 + 1}" text-anchor="end"
              font-size="12" font-weight="600" fill="#92400e">${truncar(labelMaq, 14)}</text>

        <rect x="${labelWidth}" y="${y}" width="${larguraBarra}" height="${barHeight / 2 - 1}"
              rx="3" fill="#fef3c7"/>
        <rect x="${labelWidth}" y="${y}" width="78" height="${barHeight / 2 - 1}"
              rx="3" fill="#d97706"/>
        <text x="${labelWidth + 39}" y="${y + barHeight / 2 - 4}"
              text-anchor="middle" font-size="10" font-weight="800" fill="#fff">⏸ PAUSADA</text>

        <text x="${labelWidth}" y="${y + barHeight - 4}"
              font-size="10" fill="#92400e" font-weight="600">OP ${escHtml(String(d.op_numero || ''))} — ${truncar(motivo, 35)}</text>

        <text x="${labelWidth + larguraBarra + 6}" y="${y + barHeight / 2 - 4}"
              font-size="11" font-weight="700" fill="#d97706">—</text>
      `;
    }

    const isUn = d.unid_medida === 'UN';
    const valPlan = isUn ? d.planejado_un : d.planejado_kg;
    const valProd = isUn ? d.produzido_un : d.produzido_kg;
    const wProduzido = larguraBarra * Math.min(1, (d.percentual || 0) / 100);
    const pct = d.percentual;

    return `
      <text x="${labelWidth - 8}" y="${y + barHeight / 2 + 1}" text-anchor="end"
            font-size="12" font-weight="600" fill="#374151">${truncar(labelMaq, 14)}</text>

      <rect x="${labelWidth}" y="${y}" width="${larguraBarra}" height="${barHeight / 2 - 1}"
            rx="3" fill="#e5e7eb"/>

      <rect x="${labelWidth}" y="${y}" width="${Math.max(wProduzido, 0)}" height="${barHeight / 2 - 1}"
            rx="3" fill="${corProgresso(pct)}"/>

      <text x="${labelWidth}" y="${y + barHeight - 4}"
            font-size="10" fill="#6b7280">${truncar(d.produto, 25)} — OP ${escHtml(String(d.op_numero))} (${isUn ? formatarNumBR(valProd, 0) + '/' + formatarNumBR(valPlan, 0) + ' un' : formatarNumBR(valProd, 0) + '/' + formatarNumBR(valPlan, 0) + ' kg'})</text>

      <text x="${labelWidth + larguraBarra + 6}" y="${y + barHeight / 2 - 4}"
            font-size="11" font-weight="700" fill="${corProgresso(pct)}">${fmtPct(pct)}%</text>
    `;
  }).join('');

  el.innerHTML = `
    <div class="painel-grafico-box">
      <div class="painel-grafico-titulo">Progresso por maquina</div>
      <div class="painel-grafico-legenda">
        <span><span class="legenda-dot" style="background: #e5e7eb;"></span> Planejado</span>
        <span><span class="legenda-dot" style="background: var(--color-primary);"></span> Produzido</span>
      </div>
      <div style="overflow-x: auto;">
        <svg viewBox="0 0 ${chartWidth} ${totalHeight}" width="100%" style="min-width: 400px; max-width: ${chartWidth}px;">
          ${bars}
        </svg>
      </div>
    </div>
  `;
}

// Trunca e escapa — texto dinamico (produto/maquina/motivo) usado em SVG (XSS C4).
function truncar(str, max) {
  if (!str) return '';
  const s = str.length > max ? str.substring(0, max) + '...' : str;
  return escHtml(s);
}

// ---------------------------------------------------------------------------
// Cards individuais por maquina
// ---------------------------------------------------------------------------

function renderCards(dados) {
  const el = document.getElementById('painel-cards');

  // OPs pausadas (com OP_PAUSADA em aberto em AP4010): renderizam num bloco
  // separado no FIM da lista, com cor azul pra destacar (nao competem com as
  // ativas que estao em producao).
  const dadosPausadas = dados.filter(d =>  d.is_op_pausada);
  const dadosOp       = dados.filter(d => !d.is_parada_aberta && !d.is_op_pausada);
  const dadosParadas  = dados.filter(d =>  d.is_parada_aberta);

  const cardsPausadas = dadosPausadas.map(d => {
    const mins = d.dt_pausa ? Math.floor((Date.now() - new Date(d.dt_pausa).getTime()) / 60000) : 0;
    const dur  = mins < 60 ? `${mins} min` : `${Math.floor(mins/60)}h${String(mins%60).padStart(2,'0')}`;
    const isUn      = d.unid_medida === 'UN';
    const prodLabel = isUn
      ? `${formatarNumBR(d.produzido_un, 0)} un (${formatarNumBR(d.produzido_kg, 1)} kg)`
      : `${formatarNumBR(d.produzido_kg, 1)} kg`;
    const planLabel = isUn
      ? `${formatarNumBR(d.planejado_un, 0)} un (${formatarNumBR(d.planejado_kg, 1)} kg)`
      : `${formatarNumBR(d.planejado_kg, 1)} kg`;
    return `
      <div class="card painel-card-op painel-card-pausada">
        <div class="painel-card-top">
          <div class="painel-card-info">
            <div class="painel-card-maquina">${escHtml(d.maquina_desc || d.maquina_cod || '')} <span style="font-weight:400; color: var(--color-muted); font-size:12px;">(${escHtml(d.maquina_cod || '')})</span>${d.setor ? ` · ${escHtml(d.setor)}` : ''}</div>
            <div class="painel-card-produto" style="color:#1e40af;">⏸ OP PAUSADA</div>
            <div class="painel-card-op-num">
              <strong>OP ${escHtml(String(d.op_numero))}</strong>
              <span class="badge badge-pausada">⏸ ${dur}</span>
            </div>
            <div style="font-size:13px;color:#1e3a8a;margin-top:4px;"><strong>Produto:</strong> ${escHtml(d.produto || '—')}</div>
            <div style="font-size:13px;color:#1e3a8a;margin-top:2px;"><strong>Motivo:</strong> ${escHtml(d.motivo_pausa || '—')}</div>
          </div>
          <div class="painel-card-donut" style="display:flex;align-items:center;justify-content:center;font-size:32px;color:#3b82f6;">⏸</div>
        </div>
        <div class="painel-card-stats">
          <div class="painel-stat">
            <span class="painel-stat-label">Produzido até pausa</span>
            <span class="painel-stat-value" style="color:#1e40af;">${prodLabel}</span>
          </div>
          <div class="painel-stat">
            <span class="painel-stat-label">Planejado</span>
            <span class="painel-stat-value">${planLabel}</span>
          </div>
          <div class="painel-stat">
            <span class="painel-stat-label">Pausada desde</span>
            <span class="painel-stat-value">${d.dt_pausa ? new Date(d.dt_pausa).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '—'}</span>
          </div>
        </div>
      </div>`;
  }).join('');

  const cardsParadas = dadosParadas.map(d => {
    const pa = d.parada_aberta || {};
    const mins = pa.inicio ? Math.floor((Date.now() - new Date(pa.inicio).getTime()) / 60000) : 0;
    const dur  = mins < 60 ? `${mins} min` : `${Math.floor(mins/60)}h${String(mins%60).padStart(2,'0')}`;
    const subTitulo = escHtml(d.is_sem_op ? 'Sem OP ativa' : (pa.motivo || '—'));
    const statsExtra = d.is_sem_op
      ? `<div class="painel-stat">
           <span class="painel-stat-label">Status</span>
           <span class="painel-stat-value" style="color:#b45309;">Nenhum apontamento</span>
         </div>`
      : `<div class="painel-stat">
           <span class="painel-stat-label">Tempo parada</span>
           <span class="painel-stat-value" style="color:#b45309;">${dur}</span>
         </div>
         <div class="painel-stat">
           <span class="painel-stat-label">Desde</span>
           <span class="painel-stat-value">${pa.inicio ? new Date(pa.inicio).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '—'}</span>
         </div>`;
    return `
      <div class="card painel-card-parada">
        <div class="painel-card-top">
          <div class="painel-card-info">
            <div class="painel-card-maquina">${escHtml(d.maquina_desc || d.maquina_cod || '')} <span style="font-weight:400; color: var(--color-muted); font-size:12px;">(${escHtml(d.maquina_cod || '')})</span>${d.setor ? ` · ${escHtml(d.setor)}` : ''}</div>
            <div class="painel-card-produto" style="color:#92400e;">⏸ MÁQUINA PARADA</div>
            <div class="painel-card-op-num">
              ${d.is_sem_op ? 'Sem OP ativa' : `<strong>Motivo:</strong> ${subTitulo}`}
            </div>
          </div>
          <div class="painel-card-donut" style="display:flex;align-items:center;justify-content:center;font-size:24px;">⏸</div>
        </div>
        <div class="painel-card-stats">
          ${statsExtra}
        </div>
      </div>`;
  }).join('');

  // Ordem: paradas (urgentes — exigem acao) -> em producao -> pausadas no fim
  // (aguardando retomada, nao competem visualmente com as ativas).
  el.innerHTML = `
    <h3 style="font-size: 15px; font-weight: 700; margin: 20px 0 12px; color: var(--color-text);">
      Detalhes por maquina
    </h3>
  ` + cardsParadas + dadosOp.map(d => {
    const pct       = d.percentual;
    const cor       = corProgresso(pct);
    const isUn      = d.unid_medida === 'UN';
    const prodLabel = isUn
      ? `${formatarNumBR(d.produzido_un, 0)} un (${formatarNumBR(d.produzido_kg, 1)} kg)`
      : `${formatarNumBR(d.produzido_kg, 1)} kg`;
    const planLabel = isUn
      ? `${formatarNumBR(d.planejado_un, 0)} un (${formatarNumBR(d.planejado_kg, 1)} kg)`
      : `${formatarNumBR(d.planejado_kg, 1)} kg`;
    const restLabel = isUn && d.restante_un !== undefined
      ? `${formatarNumBR(d.restante_un, 0)} un (${formatarNumBR(d.restante_kg, 1)} kg)`
      : `${formatarNumBR(d.restante_kg, 1)} kg`;

    // Grafico circular (donut) SVG
    const radius    = 30;
    const circunf   = 2 * Math.PI * radius;
    const dashProd  = (pct / 100) * circunf;
    const dashRest  = circunf - dashProd;

    const cardClasses = 'card painel-card-op' + (d.alerta_perda ? ' painel-card-alerta-perda' : '');
    return `
      <div class="${cardClasses}">
        ${d.alerta_perda ? `
          <div class="alerta-perda-banner" title="Perda ${formatarNumBR(d.perda_pct, 1)}% do produzido (${formatarNumBR(d.perdas_kg, 1)} kg)">
            ⚠ Perda alta: <strong>${formatarNumBR(d.perda_pct, 1)}%</strong> (${formatarNumBR(d.perdas_kg, 1)} kg)
          </div>` : ''}
        <div class="painel-card-top">
          <div class="painel-card-info">
            <div class="painel-card-maquina">${escHtml(d.maquina_desc || d.maquina_cod || '')} <span style="font-weight:400; color: var(--color-muted); font-size:12px;">(${escHtml(d.maquina_cod || '')})</span>${d.setor ? ` · ${escHtml(d.setor)}` : ''}</div>
            ${!d.encerrada_hoje ? `<div class="painel-card-produto" style="color:#15803d; font-size:13px; font-weight:700; letter-spacing:0.3px; margin-bottom:2px;">▶ EM PRODUÇÃO</div>` : ''}
            <div class="painel-card-produto">${escHtml(d.produto || '—')}</div>
            <div class="painel-card-op-num">
              <strong>OP ${escHtml(String(d.op_numero))}</strong>
              ${d.encerrada_hoje ? `<span class="badge" style="background:#16a34a;color:#fff;">✓ Encerrada hoje</span>` : ''}
              ${d.previsao_termino ? `<span class="badge badge-info">Prev: ${formatarDataDiaMes(d.previsao_termino)}</span>` : ''}
            </div>
          </div>
          <div class="painel-card-donut">
            <svg viewBox="0 0 80 80" width="80" height="80">
              <circle cx="40" cy="40" r="${radius}" fill="none" stroke="#e5e7eb" stroke-width="8"/>
              <circle cx="40" cy="40" r="${radius}" fill="none" stroke="${cor}" stroke-width="8"
                      stroke-dasharray="${dashProd} ${dashRest}"
                      stroke-dashoffset="${circunf / 4}"
                      stroke-linecap="round"
                      style="transition: stroke-dasharray .5s;"/>
              <text x="40" y="42" text-anchor="middle" font-size="14" font-weight="700" fill="${cor}">
                ${fmtPct(pct)}%
              </text>
            </svg>
          </div>
        </div>

        <!-- Barra de progresso linear -->
        <div class="painel-progress-bar">
          <div class="painel-progress-fill" style="width: ${Math.min(pct, 100)}%; background: ${cor};"></div>
        </div>

        <div class="painel-card-stats">
          <div class="painel-stat">
            <span class="painel-stat-label">Produzido</span>
            <span class="painel-stat-value" style="color: ${cor};">${prodLabel}</span>
          </div>
          <div class="painel-stat">
            <span class="painel-stat-label">Planejado</span>
            <span class="painel-stat-value">${planLabel}</span>
          </div>
          <div class="painel-stat">
            <span class="painel-stat-label">Restante</span>
            <span class="painel-stat-value" style="color: var(--color-muted);">${restLabel}</span>
          </div>
          <div class="painel-stat">
            <span class="painel-stat-label">Apontamentos</span>
            <span class="painel-stat-value">${d.qtd_apontamentos}</span>
          </div>
          <div class="painel-stat">
            <span class="painel-stat-label">Horas trab.</span>
            <span class="painel-stat-value">${d.horas_trabalhadas ? formatarNumBR(d.horas_trabalhadas, 1) + 'h' : '—'}</span>
          </div>
          <div class="painel-stat">
            <span class="painel-stat-label">PH (un/h)</span>
            <span class="painel-stat-value" style="color: var(--color-info); font-weight:700;">${d.ph ? formatarNumBR(d.ph, 0) : '—'}</span>
          </div>
          <div class="painel-stat">
            <span class="painel-stat-label">Perda</span>
            <span class="painel-stat-value" style="color: ${d.alerta_perda ? '#b91c1c' : 'var(--color-muted)'}; font-weight:${d.alerta_perda ? '700' : '500'};">
              ${d.perda_pct ? formatarNumBR(d.perda_pct, 1) + '%' : '—'}
            </span>
          </div>
        </div>
      </div>`;
  }).join('') + cardsPausadas;
}

// ---------------------------------------------------------------------------
// Modal de exportacao: escolher periodo antes de baixar o Excel
// ---------------------------------------------------------------------------

function abrirExportPrompt() {
  // Fecha modal anterior se existir
  const existente = document.getElementById('modal-export-periodo');
  if (existente) existente.remove();

  const hoje = new Date();
  // Usa data LOCAL (nao UTC). Evita virada de dia entre Brasil (UTC-3) e UTC.
  const iso = (d) => {
    const y  = d.getFullYear();
    const m  = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${dd}`;
  };
  const menos = (n) => { const d = new Date(hoje); d.setDate(d.getDate() - n); return iso(d); };

  const modal = document.createElement('div');
  modal.id = 'modal-export-periodo';
  modal.className = 'app-modal-backdrop';
  modal.innerHTML = `
    <div class="app-modal" role="dialog" aria-modal="true" style="max-width:440px;">
      <div class="app-modal-header">
        <h3>Exportar apontamentos</h3>
      </div>
      <div class="app-modal-body">
        <p style="margin-top:0;font-size:13px;color:var(--color-muted);">
          Escolha o periodo. O Excel vem com 5 abas: <strong>Resumo_por_OP</strong>,
          Apontamentos, Paradas, Perdas e Log_Edicoes.
        </p>
        <div class="export-preset-grid">
          <button class="btn-preset" data-inicio="${iso(hoje)}"   data-fim="${iso(hoje)}">Hoje</button>
          <button class="btn-preset" data-inicio="${menos(1)}"    data-fim="${menos(1)}">Ontem</button>
          <button class="btn-preset" data-inicio="${menos(6)}"    data-fim="${iso(hoje)}">Ultimos 7 dias</button>
          <button class="btn-preset" data-inicio=""               data-fim="">Tudo</button>
        </div>
        <hr style="margin:16px 0;border:none;border-top:1px solid var(--color-border);">
        <div style="font-size:12px;font-weight:600;margin-bottom:6px;">Ou escolha um periodo personalizado:</div>
        <div class="export-range">
          <label>De: <input type="date" id="exp-inicio"></label>
          <label>Ate: <input type="date" id="exp-fim" value="${iso(hoje)}"></label>
          <button class="btn btn-primary btn-sm" id="exp-custom">Baixar</button>
        </div>
      </div>
      <div class="app-modal-footer">
        <button class="btn btn-secondary" id="exp-cancelar">Cancelar</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  function fechar() { modal.remove(); }

  async function baixar(inicio, fim) {
    const base = (window.APP_CONFIG?.backendUrl || '') + '/api/export/apontamentos.xlsx';
    const qs = new URLSearchParams();
    if (inicio) qs.set('inicio', inicio);
    if (fim)    qs.set('fim', fim);
    const url = qs.toString() ? `${base}?${qs}` : base;

    // window.location.href NAO envia o header Authorization, e o backend tem
    // requireAuth global em /api/*. Usamos fetch com o JWT do localStorage e
    // baixamos como blob para preservar a autenticacao.
    const token = (() => { try { return localStorage.getItem('apontamento-auth-v1') || ''; } catch (_) { return ''; } })();
    try {
      const resp = await fetch(url, { headers: token ? { 'Authorization': `Bearer ${token}` } : {} });
      if (!resp.ok) {
        const txt = await resp.text().catch(() => `HTTP ${resp.status}`);
        throw new Error(`Servidor retornou ${resp.status}: ${txt.slice(0, 200)}`);
      }
      const blob = await resp.blob();
      // Nome do arquivo: tenta extrair do header, senao usa fallback
      const cd = resp.headers.get('Content-Disposition') || '';
      const m = /filename="?([^"\s]+)"?/i.exec(cd);
      const nome = m ? m[1] : `apontamentos_${new Date().toISOString().slice(0,10)}.xlsx`;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = nome;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
    } catch (e) {
      alert('Erro ao baixar Excel: ' + e.message);
    }
    fechar();
  }

  modal.querySelectorAll('.btn-preset').forEach(btn => {
    btn.addEventListener('click', () => baixar(btn.dataset.inicio, btn.dataset.fim));
  });
  modal.querySelector('#exp-custom').addEventListener('click', () => {
    const ini = modal.querySelector('#exp-inicio').value;
    const fim = modal.querySelector('#exp-fim').value;
    if (!ini && !fim) { alert('Informe ao menos a data inicial'); return; }
    baixar(ini, fim);
  });
  modal.querySelector('#exp-cancelar').addEventListener('click', fechar);
  modal.addEventListener('click', (e) => { if (e.target === modal) fechar(); });
}

// ---------------------------------------------------------------------------
// Modo TV: versao read-only, fullscreen, rotacionando cards a cada N segundos
// ---------------------------------------------------------------------------

let _tvTimers = [];
// Geracao da sessao de modo TV: incrementada a cada limparTvTimers() e a cada
// ativarModoTV(). Permite a uma ativacao em andamento detectar que foi
// desmontada (sessao expirou / usuario saiu) durante o await de carga (A7).
let _tvGeracao = 0;
function limparTvTimers() {
  _tvGeracao++;
  for (const t of _tvTimers) {
    if (t && typeof t === 'object' && t._resize) t.clear();
    else clearInterval(t);
  }
  _tvTimers = [];
}

async function ativarModoTV(container) {
  const minhaGeracao = ++_tvGeracao;
  // Esconde header/steps/aviso do app para tela cheia
  const header = document.getElementById('header');
  const steps  = document.getElementById('steps');
  const aviso  = document.getElementById('aviso-global');
  const estiloOriginalHeader = header?.style.display;
  const estiloOriginalSteps  = steps?.style.display;
  const estiloOriginalAviso  = aviso?.style.display;
  if (header) header.style.display = 'none';
  if (steps)  steps.style.display  = 'none';
  if (aviso)  aviso.style.display  = 'none';

  document.body.classList.add('tv-mode');
  try { await document.documentElement.requestFullscreen?.(); } catch (_) {}

  // Estrutura da tela TV: flex column ocupando 100vh, nada rola.
  container.innerHTML = `
    <div class="tv-root">
      <div class="tv-header">
        <div class="tv-brand">
          <div class="tv-brand-logo">⚙</div>
          <div>
            <div class="tv-brand-titulo">Produção ao vivo</div>
            <div class="tv-brand-sub" id="tv-sub">Carregando...</div>
          </div>
        </div>
        <div class="tv-hora-box">
          <div class="tv-hora" id="tv-hora">--:--</div>
          <div class="tv-data" id="tv-data"></div>
        </div>
        <button class="tv-btn-sair" id="btn-sair-tv" title="Sair do modo TV">✕</button>
      </div>

      <div class="tv-resumo" id="tv-resumo"></div>

      <div class="tv-cards-wrap">
        <div id="tv-cards-container" class="tv-cards-grid"></div>
      </div>

      <div class="tv-footer" id="tv-footer">Carregando...</div>
    </div>
  `;

  document.getElementById('btn-sair-tv').addEventListener('click',
    () => sairModoTV(container, estiloOriginalHeader, estiloOriginalSteps, estiloOriginalAviso));

  // Se a sessao expirar com o modo TV ativo, o usuario nunca clica em ✕ e os 3
  // setInterval + o listener de resize vazariam, batendo no /api/painel-producao
  // pra sempre. Desmonta o modo TV no auth:expired (A7).
  const onAuthExpired = () =>
    limparEstadoTV(estiloOriginalHeader, estiloOriginalSteps, estiloOriginalAviso);
  window.addEventListener('auth:expired', onAuthExpired, { once: true });
  _tvTimers.push({ _resize: true, clear: () => window.removeEventListener('auth:expired', onAuthExpired) });

  // Relogio + data
  const atualizarHora = () => {
    const agora = new Date();
    const elHora = document.getElementById('tv-hora');
    const elData = document.getElementById('tv-data');
    if (elHora) elHora.textContent = agora.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    if (elData) elData.textContent = agora.toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'short' });
  };
  atualizarHora();
  _tvTimers.push(setInterval(atualizarHora, 20_000));

  let dadosAtuais = [];
  let paginaAtual = 0;
  let ultimaAtualizacao = null;

  // Calcula cards por pagina dinamicamente conforme tamanho do viewport.
  // Alvo: nenhum card "cortado", nada precisa rolar.
  function cardsPorPagina() {
    const h = window.innerHeight;
    const w = window.innerWidth;
    // Heuristica: desktop 1080p = 6 cards (3x2). 4K = 9 (3x3). Tablet = 4 (2x2).
    if (w >= 1800 && h >= 1000) return 9;
    if (w >= 1400 && h >= 900)  return 6;
    if (w >= 900)               return 4;
    return 2;
  }

  function columnsGrid() {
    const w = window.innerWidth;
    if (w >= 1800) return 3;
    if (w >= 900)  return 2;
    return 1;
  }

  // Total de paginas = N paginas de cards + 1 pagina de grafico (se houver >= 2 maquinas)
  function totalPaginasTv() {
    if (!dadosAtuais.length) return 1;
    const pagCards = Math.max(1, Math.ceil(dadosAtuais.length / cardsPorPagina()));
    const temGrafico = dadosAtuais.length >= 2;
    return pagCards + (temGrafico ? 1 : 0);
  }

  async function recarregar() {
    const res = await getPainelProducao();
    // Modo TV pode ter sido desmontado durante o fetch (sessao expirou): sem
    // este guard, renderTvResumo/renderTvPagina escreveriam em DOM destruido.
    if (minhaGeracao !== _tvGeracao) return;
    if (res.success && res.data) {
      dadosAtuais = ordenarParaTv(res.data);
      ultimaAtualizacao = new Date();
      if (paginaAtual >= totalPaginasTv()) paginaAtual = 0;
      renderTvResumo(dadosAtuais);
      renderTvPagina();
    }
  }

  // Mesma ordem do painel desktop: producao ativa primeiro, paradas no meio,
  // pausadas por ultimo (aguardando retomada nao competem com as ativas).
  function ordenarParaTv(dados) {
    const ativas   = dados.filter(d => !d.is_parada_aberta && !d.is_op_pausada);
    const paradas  = dados.filter(d =>  d.is_parada_aberta);
    const pausadas = dados.filter(d =>  d.is_op_pausada);
    return [...ativas, ...paradas, ...pausadas];
  }

  function renderTvPagina() {
    const wrap = document.getElementById('tv-cards-container');
    const subInfo = document.getElementById('tv-sub');
    if (!dadosAtuais.length) {
      wrap.className = 'tv-cards-grid';
      wrap.style.gridTemplateColumns = '1fr';
      wrap.innerHTML = `
        <div class="tv-vazio">
          <div class="tv-vazio-icone">⚙</div>
          <div>Nenhuma OP em execução</div>
        </div>`;
      if (subInfo) subInfo.textContent = 'Nenhuma máquina ativa';
      document.getElementById('tv-footer').textContent = 'Aguardando início de OPs';
      return;
    }

    const porPag = cardsPorPagina();
    const pagCards = Math.max(1, Math.ceil(dadosAtuais.length / porPag));
    const total   = totalPaginasTv();
    const ehGrafico = paginaAtual === pagCards && dadosAtuais.length >= 2;

    if (ehGrafico) {
      renderTvChart(wrap);
    } else {
      const cols = columnsGrid();
      wrap.className = 'tv-cards-grid';
      wrap.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
      const ini = paginaAtual * porPag;
      const pagina = dadosAtuais.slice(ini, ini + porPag);
      wrap.innerHTML = pagina.map(d => tvCardHtml(d)).join('');
    }

    if (subInfo) subInfo.textContent = `${dadosAtuais.length} máquina${dadosAtuais.length > 1 ? 's' : ''} em produção`;

    const hora = ultimaAtualizacao ? ultimaAtualizacao.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
    const paginacao = total > 1 ? `Página ${paginaAtual + 1}/${total}${ehGrafico ? ' · Visão geral' : ''} · ` : '';
    document.getElementById('tv-footer').textContent = `${paginacao}Atualizado às ${hora}`;
  }

  // Pagina "Visao geral" — grafico de barras com todas as maquinas na TV
  function renderTvChart(wrap) {
    wrap.className = 'tv-chart-wrap';
    wrap.style.gridTemplateColumns = '';
    // OP encerrada nao ocupa a maquina -- fora do grafico de progresso.
    const dadosChart = dadosAtuais.filter(d => !d.encerrada_hoje);
    const n = dadosChart.length;
    // Altura disponivel pra cada barra, preenchendo o container sem overflow
    // (o container ja tem altura limitada pelo flex:1 do tv-cards-wrap).
    const bars = dadosChart.map(d => {
      const maqLabel = escHtml(d.maquina_desc || d.maquina_cod || '');

      // Maquina parada (com motivo ou sem OP) — linha vermelha destacada
      if (d.is_parada_aberta) {
        const motivo = escHtml(d.parada_aberta?.motivo || (d.is_sem_op ? 'Sem OP ativa' : 'Parada'));
        return `
          <div class="tv-chart-row tv-chart-row-parada">
            <div class="tv-chart-maq">${maqLabel}</div>
            <div class="tv-chart-info">
              <div class="tv-chart-produto" style="color:#fecaca;">⏸ PARADA</div>
              <div class="tv-chart-barra-bg">
                <div class="tv-chart-barra-fill" style="width:100%; background:rgba(220,38,38,0.35);"></div>
                <div class="tv-chart-barra-motivo">${motivo}</div>
              </div>
            </div>
            <div class="tv-chart-valores">
              <div class="tv-chart-pct" style="color:#fca5a5;">—</div>
              <div class="tv-chart-qtd">parada</div>
            </div>
          </div>`;
      }

      // OP pausada (mantida na maquina, aguardando retomada) — linha amarela
      if (d.is_op_pausada) {
        const motivo = escHtml(d.motivo_pausa || 'OP pausada');
        const pctPaus = Math.min(100, d.percentual || 0);
        return `
          <div class="tv-chart-row tv-chart-row-pausada">
            <div class="tv-chart-maq">${maqLabel}</div>
            <div class="tv-chart-info">
              <div class="tv-chart-produto" style="color:#fde68a;">⏸ OP PAUSADA — ${escHtml(d.produto || '—')}</div>
              <div class="tv-chart-barra-bg">
                <div class="tv-chart-barra-fill" style="width:${pctPaus}%; background:rgba(234,179,8,0.45);"></div>
                <div class="tv-chart-barra-motivo">${motivo}</div>
              </div>
            </div>
            <div class="tv-chart-valores">
              <div class="tv-chart-pct" style="color:#fde68a;">${fmtPct(pctPaus)}%</div>
              <div class="tv-chart-qtd">pausada</div>
            </div>
          </div>`;
      }

      const pct = Math.min(100, d.percentual || 0);
      const cor = corProgresso(pct);
      const isUn = d.unid_medida === 'UN';
      const prodPlan = isUn
        ? `${formatarNumBR(d.produzido_un, 0)} / ${formatarNumBR(d.planejado_un, 0)} un`
        : `${formatarNumBR(d.produzido_kg, 0)} / ${formatarNumBR(d.planejado_kg, 0)} kg`;
      return `
        <div class="tv-chart-row" style="--cor-progresso:${cor};">
          <div class="tv-chart-maq">${maqLabel}</div>
          <div class="tv-chart-info">
            <div class="tv-chart-produto">${escHtml(d.produto || '—')}</div>
            <div class="tv-chart-barra-bg">
              <div class="tv-chart-barra-fill" style="width:${pct}%; background:${cor};"></div>
            </div>
          </div>
          <div class="tv-chart-valores">
            <div class="tv-chart-pct" style="color:${cor};">${fmtPct(pct)}%</div>
            <div class="tv-chart-qtd">${prodPlan}</div>
          </div>
        </div>`;
    }).join('');

    wrap.innerHTML = `
      <div class="tv-chart-titulo">Progresso por máquina — visão geral</div>
      <div class="tv-chart-rows" style="--n-bars:${n};">${bars}</div>
    `;
  }

  function tvCardHtml(d) {
    if (d.is_parada_aberta) {
      const pa = d.parada_aberta || {};
      const mins = pa.inicio ? Math.floor((Date.now() - new Date(pa.inicio).getTime()) / 60000) : 0;
      const dur  = mins < 60 ? `${mins} min` : `${Math.floor(mins/60)}h${String(mins%60).padStart(2,'0')}`;
      const subtitulo = escHtml(d.is_sem_op ? 'Sem OP ativa' : (pa.motivo || '—'));
      const valBloco = d.is_sem_op
        ? `<div class="tv-card-val-block">
             <div class="tv-card-val" style="font-size:22px;">—</div>
             <div class="tv-card-val-label">Sem apontamento</div>
           </div>`
        : `<div class="tv-card-val-block">
             <div class="tv-card-val">${dur}</div>
             <div class="tv-card-val-label">Parada há</div>
           </div>`;
      return `
        <div class="tv-card tv-card-parada">
          <div class="tv-card-header">
            <div class="tv-card-maquina">${escHtml(d.maquina_desc || d.maquina_cod || '')}</div>
          </div>
          <div class="tv-card-produto" style="color:#fbbf24;">⏸ PARADA</div>
          <div class="tv-card-op" style="color:#fde68a;">${subtitulo}</div>
          <div class="tv-card-valores">
            ${valBloco}
          </div>
        </div>`;
    }
    if (d.is_op_pausada) {
      const minsPaus = d.dt_pausa ? Math.floor((Date.now() - new Date(d.dt_pausa).getTime()) / 60000) : 0;
      const durPaus  = minsPaus < 60 ? `${minsPaus} min` : `${Math.floor(minsPaus/60)}h${String(minsPaus%60).padStart(2,'0')}`;
      const motivoPaus = escHtml(d.motivo_pausa || 'Aguardando retomada');
      return `
        <div class="tv-card tv-card-pausada">
          <div class="tv-card-header">
            <div class="tv-card-maquina">${escHtml(d.maquina_desc || d.maquina_cod || '')}</div>
          </div>
          <div class="tv-card-produto" style="color:#fde68a;">⏸ OP PAUSADA</div>
          <div class="tv-card-op" style="color:#fef9c3;">OP ${escHtml(String(d.op_numero || ''))} · ${escHtml(d.produto || '')}</div>
          <div class="tv-card-op" style="color:#fef9c3; font-size:13px;">${motivoPaus}</div>
          <div class="tv-card-valores">
            <div class="tv-card-val-block">
              <div class="tv-card-val">${durPaus}</div>
              <div class="tv-card-val-label">Pausada há</div>
            </div>
          </div>
        </div>`;
    }
    const isUn = d.unid_medida === 'UN';
    const pct  = Math.min(100, d.percentual || 0);
    const cor  = corProgresso(pct);
    const produzidoTxt = isUn
      ? `${formatarNumBR(d.produzido_un, 0)} <span class="tv-card-val-sub">un</span>`
      : `${formatarNumBR(d.produzido_kg, 0)} <span class="tv-card-val-sub">kg</span>`;
    const planejadoTxt = isUn
      ? `${formatarNumBR(d.planejado_un, 0)} un`
      : `${formatarNumBR(d.planejado_kg, 0)} kg`;
    const classeAlerta = d.alerta_perda ? ' tv-card-alerta-perda' : '';
    const badgeStatus = d.encerrada_hoje
      ? `<span class="tv-card-status-badge tv-card-status-encerrada">✓ ENCERRADA</span>`
      : `<span class="tv-card-status-badge tv-card-status-producao">▶ EM PRODUÇÃO</span>`;
    return `
      <div class="tv-card${classeAlerta}" style="--cor-progresso:${cor};">
        ${d.alerta_perda ? `<div class="tv-card-alerta-corner">⚠ PERDA ${formatarNumBR(d.perda_pct, 0)}%</div>` : ''}
        <div class="tv-card-header">
          <div class="tv-card-maquina">${d.maquina_desc || d.maquina_cod}</div>
          ${badgeStatus}
        </div>
        <div class="tv-card-produto" title="${escHtml(d.produto || '')}">${escHtml(d.produto || '—')}</div>
        <div class="tv-card-op">OP <strong>${escHtml(String(d.op_numero))}</strong></div>

        <div class="tv-card-valores">
          <div class="tv-card-val-block">
            <div class="tv-card-val">${produzidoTxt}</div>
            <div class="tv-card-val-label">Produzido</div>
          </div>
          <div class="tv-card-val-sep"></div>
          <div class="tv-card-val-block">
            <div class="tv-card-val tv-card-val-secundario">${planejadoTxt}</div>
            <div class="tv-card-val-label">Planejado</div>
          </div>
        </div>

        <div class="tv-card-barra-wrap">
          <div class="tv-card-barra-bg">
            <div class="tv-card-barra-fill" style="width:${pct}%; background:${cor};"></div>
          </div>
          <div class="tv-card-pct" style="color:${cor};">${fmtPct(pct)}%</div>
        </div>
      </div>`;
  }

  function renderTvResumo(dados) {
    // Maquinas em producao ativa: ignoram paradas e OPs pausadas para nao distorcer a media
    const dadosOp = dados.filter(d => !d.is_parada_aberta && !d.is_op_pausada);
    // "Ativas" = em producao de verdade -- OP encerrada nao conta.
    const emProducao = dadosOp.filter(d => !d.encerrada_hoje);
    const totalProduzido = dadosOp.reduce((s, d) => s + d.produzido_kg, 0);
    const totalPlanejado = dadosOp.reduce((s, d) => s + d.planejado_kg, 0);
    const pctGeral = dadosOp.length ? dadosOp.reduce((s, d) => s + d.percentual, 0) / dadosOp.length : 0;
    const corPct = corProgresso(pctGeral);
    document.getElementById('tv-resumo').innerHTML = `
      <div class="tv-resumo-card">
        <div class="tv-resumo-valor">${emProducao.length}</div>
        <div class="tv-resumo-label">Máquinas ativas</div>
      </div>
      <div class="tv-resumo-card">
        <div class="tv-resumo-valor tv-resumo-verde">${formatarNumBR(totalProduzido, 0)}<span class="tv-resumo-unidade">kg</span></div>
        <div class="tv-resumo-label">Produzido</div>
      </div>
      <div class="tv-resumo-card">
        <div class="tv-resumo-valor tv-resumo-cinza">${formatarNumBR(totalPlanejado, 0)}<span class="tv-resumo-unidade">kg</span></div>
        <div class="tv-resumo-label">Planejado</div>
      </div>
      <div class="tv-resumo-card">
        <div class="tv-resumo-valor" style="color:${corPct};">${pctGeral.toFixed(0)}<span class="tv-resumo-unidade">%</span></div>
        <div class="tv-resumo-label">Progresso médio</div>
      </div>`;
  }

  // Primeira carga
  await recarregar();

  // Se o modo TV foi desmontado durante a primeira carga (sessao expirou, ✕ ou
  // troca de tela), aborta antes de instalar os timers — eles vazariam (A7).
  if (minhaGeracao !== _tvGeracao) return;

  // Rotaciona pagina a cada 10s
  _tvTimers.push(setInterval(() => {
    if (!dadosAtuais.length) return;
    const total = totalPaginasTv();
    if (total <= 1) return;
    paginaAtual = (paginaAtual + 1) % total;
    renderTvPagina();
  }, 10000));

  // Recarrega dados do servidor a cada 30s
  _tvTimers.push(setInterval(() => recarregar().catch(() => {}), 30_000));

  // Re-render ao redimensionar (ex.: cliente troca de monitor)
  const onResize = () => renderTvPagina();
  window.addEventListener('resize', onResize);
  _tvTimers.push({ _resize: true, clear: () => window.removeEventListener('resize', onResize) });
}

// Desmonta o modo TV (timers, classe do body, header/steps) SEM re-renderizar.
// Usado tanto pela saida normal quanto pelo auth:expired (A7).
function limparEstadoTV(estHeader, estSteps, estAviso) {
  limparTvTimers();
  document.body.classList.remove('tv-mode');
  const header = document.getElementById('header');
  const steps  = document.getElementById('steps');
  const aviso  = document.getElementById('aviso-global');
  if (header) header.style.display = estHeader ?? '';
  if (steps)  steps.style.display  = estSteps  ?? '';
  if (aviso)  aviso.style.display  = estAviso  ?? '';
  try { if (document.fullscreenElement) document.exitFullscreen?.(); } catch (_) {}
}

function sairModoTV(container, estHeader, estSteps, estAviso) {
  limparEstadoTV(estHeader, estSteps, estAviso);
  // Re-renderiza painel normal
  render(container);
}
