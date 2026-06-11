/**
 * s6-consolidado.js — Tela 6: Consolidado por turno.
 *
 * Agregado descritivo apontador x turno x dia operacional. NAO mostra PH — o PH
 * e por produto/OP (ver painel e a aba Resumo_por_OP do Excel). Colunas:
 * total produzido (un/kg), nº de apontamentos/maquinas e minutos de parada.
 */

import { getConsolidadoTurno, getHistoricoGeral } from '../api.js';
import { irParaTela } from '../app.js';
import { escHtml, formatarNumBR } from '../utils.js';

function isoDiaLocal(d) {
  return d.getFullYear() + '-'
    + String(d.getMonth() + 1).padStart(2, '0') + '-'
    + String(d.getDate()).padStart(2, '0');
}

export async function render(container) {
  const hoje = new Date();
  const seteAtras = new Date(hoje);
  seteAtras.setDate(hoje.getDate() - 6);

  container.innerHTML = `
    <div class="screen-topbar">
      <div class="screen-topbar-left">
        <button class="btn-voltar-padrao" id="btn-voltar-cons">← Voltar</button>
        <h2>Consolidado por turno</h2>
      </div>
    </div>
    <p class="painel-subtitulo" style="margin-top:-8px;margin-bottom:16px;">
      Produção e paradas por apontador, turno e dia operacional.
      O PH é por produto/OP — consulte o painel.
    </p>

    <div class="field-row" style="align-items:flex-end;">
      <div class="field">
        <label class="field-label">De</label>
        <input type="date" id="cons-inicio" class="field-input" value="${isoDiaLocal(seteAtras)}">
      </div>
      <div class="field">
        <label class="field-label">Até</label>
        <input type="date" id="cons-fim" class="field-input" value="${isoDiaLocal(hoje)}">
      </div>
      <div class="field" style="flex:0 0 auto;">
        <button class="btn btn-primary" id="cons-filtrar">Filtrar</button>
      </div>
    </div>

    <div id="cons-loading" class="loading-center"><div class="spinner"></div><span>Carregando...</span></div>
    <div id="cons-erro" class="error-box" style="display:none;"></div>
    <div id="cons-resultado"></div>
  `;

  document.getElementById('btn-voltar-cons').addEventListener('click', () => irParaTela(5));
  document.getElementById('cons-filtrar').addEventListener('click', carregar);

  const elLoading = document.getElementById('cons-loading');
  const elErro    = document.getElementById('cons-erro');
  const elResult  = document.getElementById('cons-resultado');

  async function carregar() {
    const inicio = document.getElementById('cons-inicio').value;
    const fim    = document.getElementById('cons-fim').value;
    elLoading.style.display = 'flex';
    elErro.style.display = 'none';
    elResult.innerHTML = '';

    const r = await getConsolidadoTurno({ inicio, fim });
    elLoading.style.display = 'none';

    if (!r || !r.success) {
      elErro.textContent = (r && r.offline)
        ? 'Sem conexão com o servidor.'
        : ('Erro ao carregar: ' + ((r && r.error) || 'desconhecido'));
      elErro.style.display = 'block';
      return;
    }

    const linhas = r.data || [];
    if (!linhas.length) {
      elResult.innerHTML = '<p style="text-align:center;color:var(--color-muted);padding:24px;">Nenhum apontamento no período selecionado.</p>';
      return;
    }
    elResult.innerHTML = montarTabela(linhas);
    // Linhas clicaveis: abre modal com os apontamentos daquele apontador|turno|dia.
    elResult.querySelectorAll('tr[data-cons-row]').forEach((tr, i) => {
      tr.addEventListener('click', () => abrirDetalhes(linhas[i]));
    });
  }

  function montarTabela(linhas) {
    const fmt = (n) => Number(n || 0).toLocaleString('pt-BR', { maximumFractionDigits: 1 });
    const fmtDia = (d) => {
      const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d));
      return m ? `${m[3]}/${m[2]}/${m[1]}` : String(d);
    };
    const fmtHora = (v) => {
      if (!v) return '—';
      const d = new Date(v);
      if (isNaN(d.getTime())) return '—';
      return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    };
    let body = '';
    for (const l of linhas) {
      body += `
        <tr data-cons-row="1" style="cursor:pointer;" title="Clique para ver os apontamentos">
          <td>${escHtml(fmtDia(l.dia_operacional))}</td>
          <td><span class="cons-turno-badge">${escHtml(l.turno || '?')}</span></td>
          <td>${escHtml(l.apontador_usu || '—')}</td>
          <td>${fmtHora(l.dt_abertura)}</td>
          <td>${escHtml(l.usu_abertura || '—')}</td>
          <td>${fmtHora(l.dt_fechamento)}</td>
          <td>${escHtml(l.usu_fechamento || '—')}</td>
          <td>${fmt(l.total_un)}</td>
          <td>${fmt(l.total_kg)}</td>
          <td>${l.qtd_apontamentos || 0}</td>
          <td>${l.qtd_maquinas || 0}</td>
          <td>${l.paradas_apontamento_min || 0} min</td>
          <td>${l.paradas_maquina_min || 0} min</td>
        </tr>`;
    }
    return `
      <div style="overflow-x:auto;">
        <table class="cons-tabela">
          <thead>
            <tr>
              <th>Dia</th><th>Turno</th><th>Apontador</th>
              <th>Abertura</th><th>Abriu</th>
              <th>Fechamento</th><th>Fechou</th>
              <th>Produzido (un)</th><th>Produzido (kg)</th>
              <th>Apont.</th><th>Máq.</th>
              <th>Parada apont.</th><th>Parada máq.</th>
            </tr>
          </thead>
          <tbody>${body}</tbody>
        </table>
      </div>`;
  }

  carregar();

  // Modal: lista os apontamentos daquela linha (apontador|turno|dia_operacional).
  async function abrirDetalhes(linha) {
    const existente = document.getElementById('modal-cons-detalhes');
    if (existente) existente.remove();

    const fmtDia = (d) => {
      const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d));
      return m ? `${m[3]}/${m[2]}/${m[1]}` : String(d);
    };
    const fmtHora = (v) => {
      if (!v) return '—';
      const d = new Date(v);
      if (isNaN(d.getTime())) return '—';
      return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    };

    const modal = document.createElement('div');
    modal.id = 'modal-cons-detalhes';
    modal.className = 'app-modal-backdrop';
    modal.innerHTML = `
      <div class="app-modal" role="dialog" aria-modal="true" style="max-width:880px;">
        <div class="app-modal-header">
          <h3>Apontamentos de ${escHtml(linha.apontador_usu || '—')} — Turno ${escHtml(linha.turno || '?')} · ${escHtml(fmtDia(linha.dia_operacional))}</h3>
        </div>
        <div class="app-modal-body">
          <div id="cons-det-loading" class="loading-center"><div class="spinner"></div><span>Carregando...</span></div>
          <div id="cons-det-erro" class="error-box" style="display:none;"></div>
          <div id="cons-det-conteudo"></div>
        </div>
        <div class="app-modal-footer">
          <button class="btn btn-secondary" id="cons-det-fechar">Fechar</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    function fechar() { modal.remove(); }
    modal.querySelector('#cons-det-fechar').addEventListener('click', fechar);
    modal.addEventListener('click', (e) => { if (e.target === modal) fechar(); });

    const r = await getHistoricoGeral({
      apontador:       linha.apontador_usu,
      turno:           linha.turno,
      dia_operacional: linha.dia_operacional,
      limite:          500,
    });
    const elL = document.getElementById('cons-det-loading');
    const elE = document.getElementById('cons-det-erro');
    const elC = document.getElementById('cons-det-conteudo');
    elL.style.display = 'none';

    if (!r || !r.success) {
      elE.textContent = (r && r.offline) ? 'Sem conexão.' : ('Erro: ' + ((r && r.error) || 'desconhecido'));
      elE.style.display = 'block';
      return;
    }

    const aps = r.data || [];
    if (!aps.length) {
      elC.innerHTML = '<p style="text-align:center;color:var(--color-muted);padding:24px;">Nenhum apontamento encontrado.</p>';
      return;
    }

    let rows = '';
    for (const a of aps) {
      const dt = a.dt_apontamento ? new Date(a.dt_apontamento) : null;
      const horaApt = dt ? dt.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '—';
      const isUn = a.unid_medida === 'UN';
      const qtdLabel = isUn
        ? `${formatarNumBR(a.qtd_produzida_un, 0)} un (${formatarNumBR(a.qtd_produzida, 1)} kg)`
        : `${formatarNumBR(a.qtd_produzida, 1)} kg`;
      rows += `
        <tr>
          <td>${horaApt}</td>
          <td>${escHtml(a.maquina_desc || a.maquina_cod || '—')}</td>
          <td>${escHtml(a.op_numero || '—')}</td>
          <td title="${escHtml(a.produto || '')}">${escHtml(a.produto || '—')}</td>
          <td>${qtdLabel}</td>
          <td>${a.encerrou_op ? '✓' : ''}</td>
        </tr>`;
    }
    elC.innerHTML = `
      <div style="overflow-x:auto;">
        <table class="cons-tabela">
          <thead>
            <tr><th>Hora</th><th>Máquina</th><th>OP</th><th>Produto</th><th>Produzido</th><th>Encerrou?</th></tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <p style="font-size:12px;color:var(--color-muted);margin-top:10px;">
        ${aps.length} apontamento${aps.length > 1 ? 's' : ''} no turno.
      </p>
    `;
  }
}
