/**
 * s0-centro.js — Tela 0: Seleção de Centro de Trabalho.
 * Exibe os centros de trabalho disponíveis (ex: Transformação, Montagem, Embaladoras).
 * Cache em IndexedDB para uso offline.
 */

import { getCentrosTrabalho } from '../api.js';
import { salvarCache, lerTodoCache } from '../db.js';
import { estado, irParaTela, atualizarBadgePerfil } from '../app.js';
import { atualizarCampo } from '../perfil.js';
import { escHtml } from '../utils.js';

// Ícones por tipo de centro
const ICONE_CT = {
  TRANSFORMACAO: '⚙',
  MONTAGEM:      '🔧',
  EMBALAGEM:     '📦',
};

export async function render(container) {
  let centroSelecionado = null;
  let centros = [];

  container.innerHTML = `
    <h2 style="font-size:18px;font-weight:700;margin-bottom:8px;">Centro de Trabalho</h2>
    <p style="font-size:13px;color:var(--color-muted);margin-bottom:16px;">
      Selecione o setor onde irá realizar o apontamento.
    </p>
    <div id="centros-container">
      <div class="loading-center">
        <div class="spinner"></div>
        <span>Carregando centros de trabalho...</span>
      </div>
    </div>
    <div class="actions-bar">
      <button id="btn-confirmar-ct" class="btn btn-primary btn-block" disabled>
        Confirmar centro de trabalho
      </button>
    </div>
  `;

  const centrosContainer = document.getElementById('centros-container');
  const btnConfirmar     = document.getElementById('btn-confirmar-ct');

  // Buscar centros (API ou cache)
  const resultado = await getCentrosTrabalho();

  if (resultado.offline || !resultado.success) {
    const cached = await lerTodoCache('cache-centros');
    if (cached && cached.length > 0) {
      centros = cached;
      renderCards(true);
    } else {
      centrosContainer.innerHTML = `
        <div class="error-box">
          Sem conexão com o servidor e sem cache local disponível.<br>
          Verifique a rede e tente novamente.
        </div>
      `;
      return;
    }
  } else {
    centros = resultado.data;
    await salvarCache('cache-centros', centros).catch(() => {});
    renderCards(false);
  }

  function renderCards(usandoCache) {
    centrosContainer.innerHTML = `
      ${usandoCache ? '<p style="font-size:12px;color:#b45309;margin-bottom:10px;">⚠ Dados do cache local (offline)</p>' : ''}
      <div class="centros-grid" id="centros-grid"></div>
    `;

    const grid = document.getElementById('centros-grid');

    for (const ct of centros) {
      const icone = ICONE_CT[ct.TIPO] || '🏭';
      const card  = document.createElement('div');
      card.className = 'card card-centro';
      card.dataset.cod = ct.COD;
      card.innerHTML = `
        <div class="ct-icone">${icone}</div>
        <div class="ct-cod">${escHtml(ct.COD)}</div>
        <div class="ct-desc">${escHtml(ct.DESCRICAO)}</div>
        ${ct.TIPO ? `<div class="ct-tipo">${escHtml(ct.TIPO.charAt(0) + ct.TIPO.slice(1).toLowerCase())}</div>` : ''}
      `;
      card.addEventListener('click', () => selecionarCentro(card, ct));
      grid.appendChild(card);
    }
  }

  function selecionarCentro(card, ct) {
    document.querySelectorAll('#centros-grid .card').forEach(c => c.classList.remove('selected'));
    card.classList.add('selected');
    centroSelecionado = ct;
    btnConfirmar.disabled = false;
  }

  btnConfirmar.addEventListener('click', () => {
    if (!centroSelecionado) return;
    estado.centroTrabalho = centroSelecionado;
    atualizarCampo('centroTrabalho', centroSelecionado);
    atualizarBadgePerfil();
    irParaTela(1);
  });
}

