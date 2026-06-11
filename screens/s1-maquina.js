/**
 * s1-maquina.js — Tela 1: Seleção de máquina.
 * Exibe grid de cards com as máquinas e seus status.
 * Ao confirmar, avança para a Tela 2.
 */

import { getMaquinas, getMotivosParada, registrarParadaAberta, fecharParadaAberta, pausarOP, encerrarOpSemApontamento } from '../api.js';
import { confirmar } from '../modal.js';
import { salvarCache, lerTodoCache } from '../db.js';
import { estado, irParaTela } from '../app.js';
import { escHtml, formatarDuracaoHa } from '../utils.js';

// Chave de cache inclui o centro de trabalho para não misturar dados
function chaveCacheMaquinas() {
  return `cache-maquinas-${estado.centroTrabalho?.COD || 'todos'}`;
}

// Mapeia STATUS do banco para classe CSS e texto
const STATUS_CONFIG = {
  PRODUZINDO: { classe: 'status-produzindo', texto: 'Produzindo' },
  PARADA:     { classe: 'status-parada',     texto: 'Parada'     },
  OP_PARADA:  { classe: 'status-op-parada',  texto: 'OP parada'  },
  SETUP:      { classe: 'status-setup',      texto: 'Setup'      },
  SEM_OP:     { classe: 'status-sem-op',     texto: 'Sem OP'     },
};

export async function render(container) {
  const ct = estado.centroTrabalho;

  // Estado local da tela
  let maquinaSelecionada = null;
  let maquinas = [];

  // Montar HTML da tela — botão fixo no rodapé, grid rola independente
  container.innerHTML = `
    <div class="screen-topbar">
      <div class="screen-topbar-left">
        <button class="btn-voltar-padrao" id="btn-voltar-tela">← Voltar</button>
        <h2>Selecione a máquina</h2>
      </div>
    </div>
    ${ct ? `<div style="margin-bottom:8px;"><span class="badge badge-primary">${escHtml(ct.COD)}</span> <strong>${escHtml(ct.DESCRICAO)}</strong></div>` : ''}
    <div id="maquinas-container" style="flex:1; overflow-y:auto; padding-bottom:8px;">
      <div class="loading-center">
        <div class="spinner"></div>
        <span>Carregando máquinas...</span>
      </div>
    </div>
    <div id="barra-confirmar-maquina" style="position:fixed; bottom:0; left:0; right:0; background:var(--color-bg); padding:10px 16px; border-top:2px solid var(--color-primary); z-index:100; box-shadow: 0 -2px 8px rgba(0,0,0,0.1);">
      <div style="display:flex; gap:8px; flex-wrap:wrap;">
        <button id="btn-confirmar-maquina" class="btn btn-primary" disabled style="flex:1; font-size:16px; height:48px; min-width:140px;">
          Confirmar máquina
        </button>
        <button id="btn-pausar-op-maq" class="btn btn-pausar" disabled style="font-size:14px; height:48px; padding:0 14px; display:none;">
          ⏸ Pausar OP
        </button>
        <button id="btn-encerrar-op-maq" class="btn btn-danger" disabled style="font-size:14px; height:48px; padding:0 14px; display:none;" title="Encerrar OP sem apontamento">
          ■ Encerrar OP
        </button>
        <button id="btn-acao-parada" class="btn btn-secondary" disabled style="font-size:14px; height:48px; padding:0 14px; display:none;">
          ⏸ Registrar parada
        </button>
      </div>
    </div>
    <div style="height:70px;"></div>
  `;
  document.getElementById('btn-voltar-tela').addEventListener('click', () => irParaTela(0));

  const maquinasContainer  = document.getElementById('maquinas-container');
  const btnConfirmar       = document.getElementById('btn-confirmar-maquina');
  const btnAcaoParada      = document.getElementById('btn-acao-parada');
  const btnPausarOpMaq     = document.getElementById('btn-pausar-op-maq');
  const btnEncerrarOpMaq   = document.getElementById('btn-encerrar-op-maq');


  // Recursos que aparecem no cadastro como "maquinas" mas nao sao apontaveis
  // (administrativos / mao de obra que entrou no SG2 sem ser maquina real).
  // Manter aqui ate ter uma flag no cadastro Protheus ou flag local.
  const MAQUINAS_OCULTAR = new Set(['AD0003', 'MO0001', 'MO0002', 'MO0003']);
  const filtrarOcultas = (lista) => (lista || []).filter(m => !MAQUINAS_OCULTAR.has(String(m.COD || '').trim()));

  // Buscar máquinas do backend filtradas pelo centro de trabalho selecionado
  const centroCod = ct?.COD || null;
  const resultado = await getMaquinas(centroCod);

  if (resultado.offline || !resultado.success) {
    // Tentar cache local (filtrado pelo centro)
    const allCached = await lerTodoCache('cache-maquinas');
    const cached = centroCod
      ? (allCached || []).filter(m => m.CENTRO_TRAB_COD === centroCod)
      : (allCached || []);
    if (cached && cached.length > 0) {
      maquinas = filtrarOcultas(cached);
      renderGrid(true);
    } else {
      maquinasContainer.innerHTML = `
        <div class="error-box">
          Sem conexão com o servidor e sem cache local disponível.<br>
          Verifique a rede e tente novamente.
        </div>
      `;
      return;
    }
  } else {
    // Salva o cache COM tudo (sem aplicar filtro local) pra nao perder dados
    // caso a lista de ocultar mude no futuro.
    await salvarCache('cache-maquinas', resultado.data).catch(() => {});
    maquinas = filtrarOcultas(resultado.data);
    renderGrid(false);
  }

  function renderGrid(usandoCache) {
    maquinasContainer.innerHTML = `
      ${usandoCache ? '<p style="font-size:12px;color:#b45309;margin-bottom:10px;">⚠ Dados do cache local (offline)</p>' : ''}
      <div class="maquinas-grid" id="maquinas-grid"></div>
    `;

    const grid = document.getElementById('maquinas-grid');

    for (const maq of maquinas) {
      const cfg = STATUS_CONFIG[maq.STATUS] || STATUS_CONFIG.SEM_OP;

      const card = document.createElement('div');
      card.className = 'card card-maquina';
      card.dataset.cod = maq.COD;
      const qtdOps = Number(maq.qtd_ops || 0);
      // Ponto discreto no canto indicando que ha OPs disponiveis para apontar
      const indicadorOp = qtdOps > 0
        ? `<span title="${qtdOps} OP(s) disponivel(is) para apontamento" style="position:absolute;top:6px;right:8px;display:inline-flex;align-items:center;gap:3px;font-size:10px;color:var(--color-success);font-weight:700;">
             <span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--color-success);"></span>${qtdOps}
           </span>`
        : '';
      card.style.position = 'relative';

      // Badge de parada em aberto (maquina parou, sem apontamento ainda)
      const pa = maq.parada_aberta;
      const badgeParadaAberta = pa
        ? `<div class="badge-parada-aberta" title="${escHtml(pa.motivo || '')}">
             ⏸ Parada ${formatarDuracaoHa(pa.inicio)}
           </div>`
        : '';

      card.innerHTML = `
        ${indicadorOp}
        <div class="maq-cod">${escHtml(maq.COD)}</div>
        <div class="maq-desc">${escHtml(maq.DESCRICAO)}</div>
        ${maq.SETOR ? `<div class="maq-desc" style="font-size:11px;">${escHtml(maq.SETOR)}</div>` : ''}
        <div class="maq-status">
          <span class="badge ${cfg.classe}">${cfg.texto}</span>
          ${maq.OP_ATIVA ? `<span style="font-size:11px;color:var(--color-muted);margin-left:6px;">OP ${escHtml(maq.OP_ATIVA)}</span>` : ''}
        </div>
        ${badgeParadaAberta}
      `;
      if (pa) card.classList.add('tem-parada-aberta');

      card.addEventListener('click', () => selecionarMaquina(card, maq));
      grid.appendChild(card);
    }
  }

  function selecionarMaquina(card, maquina) {
    document.querySelectorAll('#maquinas-grid .card').forEach(c => c.classList.remove('selected'));
    card.classList.add('selected');
    maquinaSelecionada = maquina;
    btnConfirmar.disabled = false;
    btnAcaoParada.disabled = false;
    btnAcaoParada.style.display = '';

    // Botao "Pausar OP" inline: so quando a maquina tem OP ativa em producao
    // (nao pausada e nao parada).
    const opAtiva = maquina.OP_ATIVA;
    const ehSoftPausa = maquina.parada_aberta && maquina.parada_aberta.origem === 'OP_PAUSADA';
    const ehParadaMaquina = maquina.parada_aberta && !ehSoftPausa;
    if (opAtiva && !maquina.parada_aberta) {
      btnPausarOpMaq.textContent = `⏸ Pausar OP ${opAtiva}`;
      btnPausarOpMaq.classList.remove('btn-primary');
      btnPausarOpMaq.classList.add('btn-pausar');
      btnPausarOpMaq.style.display = '';
      btnPausarOpMaq.disabled = false;
    } else {
      btnPausarOpMaq.style.display = 'none';
      btnPausarOpMaq.disabled = true;
    }

    // Botão "Encerrar OP" aparece quando a máquina tem OP atrelada — inclui OP
    // pausada via "soft pause" (registrarParadaOp mantem OP_ATIVA). Excluido
    // quando a maquina esta em parada DE MAQUINA (sem OP atrelada do nada).
    if (opAtiva && !ehParadaMaquina) {
      btnEncerrarOpMaq.textContent = `■ Encerrar OP ${opAtiva}`;
      btnEncerrarOpMaq.style.display = '';
      btnEncerrarOpMaq.disabled = false;
    } else {
      btnEncerrarOpMaq.style.display = 'none';
      btnEncerrarOpMaq.disabled = true;
    }

    if (ehParadaMaquina) {
      btnConfirmar.textContent = 'Continuar com apontamento';
      btnAcaoParada.textContent = '✓ Máquina voltou';
      btnAcaoParada.className = 'btn btn-danger';
      btnAcaoParada.style.fontSize = '14px';
      btnAcaoParada.style.height = '48px';
      btnAcaoParada.style.padding = '0 14px';
      btnAcaoParada.style.display = '';
    } else if (ehSoftPausa) {
      // OP em parada via registrar-parada: usuario vai pra Tela 3 e retoma via
      // apontamento (fluxo ja existente). Esconde botoes de parada-de-maquina.
      btnConfirmar.textContent = `Continuar com OP ${opAtiva}`;
      btnAcaoParada.style.display = 'none';
    } else {
      btnConfirmar.textContent = `Confirmar ${maquina.COD}`;
      btnAcaoParada.textContent = '⏸ Registrar parada';
      btnAcaoParada.className = 'btn btn-secondary';
      btnAcaoParada.style.fontSize = '14px';
      btnAcaoParada.style.height = '48px';
      btnAcaoParada.style.padding = '0 14px';
      btnAcaoParada.style.display = '';
    }
  }

  btnConfirmar.addEventListener('click', async () => {
    if (!maquinaSelecionada) return;
    estado.maquinaSelecionada = maquinaSelecionada;
    irParaTela(2);
  });

  btnAcaoParada.addEventListener('click', async () => {
    if (!maquinaSelecionada) return;
    if (maquinaSelecionada.parada_aberta) {
      await confirmarMaquinaVoltou(maquinaSelecionada);
    } else {
      await abrirModalRegistrarParada(maquinaSelecionada);
    }
  });

  btnPausarOpMaq.addEventListener('click', async () => {
    if (!maquinaSelecionada || !maquinaSelecionada.OP_ATIVA) return;
    await abrirModalPausarOp(maquinaSelecionada);
  });

  btnEncerrarOpMaq.addEventListener('click', async () => {
    if (!maquinaSelecionada || !maquinaSelecionada.OP_ATIVA) return;
    await confirmarEncerrarOp(maquinaSelecionada);
  });

  async function confirmarEncerrarOp(maquina) {
    const ok = await confirmar({
      titulo: `Encerrar OP ${maquina.OP_ATIVA}`,
      html: `<p>Tem certeza que deseja <strong>encerrar a OP ${escHtml(maquina.OP_ATIVA)}</strong> da máquina <strong>${escHtml(maquina.COD)}</strong>?</p>
             <p style="background:#fef3c7;padding:8px 12px;border-radius:6px;font-size:13px;color:#92400e;margin-top:8px;">
               ⚠ Esta ação encerra a OP <strong>sem registrar apontamento de produção</strong>.
               A máquina fica liberada e a OP some da lista de OPs em andamento.
             </p>
             <p style="font-size:12px;color:#6b7280;margin-top:8px;">
               Use só quando a OP foi iniciada por engano ou ficou travada. Pra encerrar com
               produção, faça um apontamento normal e marque "Encerrar OP".
             </p>`,
      tipo: 'warning',
      textoOk: 'Sim, encerrar OP',
      textoCancelar: 'Cancelar',
    });
    if (!ok) return;
    const res = await encerrarOpSemApontamento({
      op_numero:    maquina.OP_ATIVA,
      maquina_cod:  maquina.COD,
      operador_cod: estado.operadorCod || estado.user?.username || '',
      turno:        estado.turno || null,
      motivo:       'Encerrada sem apontamento',
    });
    if (!res.success) {
      await confirmar({
        titulo: 'Erro ao encerrar OP',
        mensagem: res.error || 'Tente novamente.',
        tipo: 'danger', textoOk: 'Entendi', textoCancelar: '',
      });
      return;
    }
    irParaTela(1); // Recarrega com o novo estado (OP_ATIVA limpa)
  }

  async function abrirModalPausarOp(maquina) {
    const motivosRes = await getMotivosParada(estado.centroTrabalho?.TIPO || null);
    const motivos = motivosRes.success ? motivosRes.data : [];

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal-box" style="max-width:420px;">
        <h3 style="margin:0 0 8px 0;">⏸ Pausar OP ${escHtml(maquina.OP_ATIVA)} — ${escHtml(maquina.COD)}</h3>
        <p style="font-size:13px;color:var(--color-muted);margin-bottom:12px;">
          A OP fica pausada e a máquina libera para outra OP. O motivo da pausa
          fica gravado no histórico.
        </p>
        <div class="field">
          <label class="field-label">Motivo da pausa <span class="obrigatorio">*</span></label>
          <input type="text" id="busca-motivo-pausa-op" class="field-input" placeholder="Filtrar..." autocomplete="off" style="margin-bottom:4px;">
          <select id="sel-motivo-pausa-op" class="field-input">
            <option value="">— Selecione o motivo —</option>
            ${motivos.map(m => {
              const cod  = m.COD  || m.cod  || '';
              const desc = m.DESCRICAO || m.descricao || m;
              return `<option value="${escHtml(cod)}" data-desc="${escHtml(desc)}" data-busca="${escHtml((cod + ' ' + desc).toLowerCase())}">${escHtml(cod)} — ${escHtml(desc)}</option>`;
            }).join('')}
          </select>
        </div>
        <div style="display:flex; gap:8px; margin-top:12px;">
          <button id="btn-cancelar-pausa-op" class="btn btn-secondary" style="flex:1;">Cancelar</button>
          <button id="btn-confirmar-pausa-op" class="btn btn-primary" style="flex:1;">Pausar OP</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const sel   = overlay.querySelector('#sel-motivo-pausa-op');
    const busca = overlay.querySelector('#busca-motivo-pausa-op');
    const opcoesOriginais = Array.from(sel.options);
    busca.addEventListener('input', () => {
      const termo = busca.value.trim().toLowerCase();
      sel.innerHTML = '';
      const matches = opcoesOriginais.filter(opt => {
        if (!opt.value) return true;
        const b = opt.dataset.busca || opt.text.toLowerCase();
        return !termo || b.includes(termo);
      });
      matches.forEach(opt => sel.appendChild(opt.cloneNode(true)));
      const opcoesValidas = matches.filter(o => o.value);
      if (termo && opcoesValidas.length === 1) sel.value = opcoesValidas[0].value;
    });

    overlay.querySelector('#btn-cancelar-pausa-op').addEventListener('click', () => overlay.remove());
    overlay.querySelector('#btn-confirmar-pausa-op').addEventListener('click', async () => {
      if (!sel.value) { busca.focus(); return; }
      const opt = sel.options[sel.selectedIndex];
      const btnOk = overlay.querySelector('#btn-confirmar-pausa-op');
      btnOk.disabled = true;
      btnOk.textContent = 'Pausando...';
      const res = await pausarOP({
        op_numero:        maquina.OP_ATIVA,
        maquina_cod:      maquina.COD,
        // O operador da maquina nao e selecionado na Tela 1 — usa o apontador
        // logado como responsavel pela pausa.
        operador_cod:     estado.operadorCod || estado.user?.username || '',
        turno:            estado.turno || null,
        origem_op:        'MANUAL',
        cod_motivo_pausa: sel.value,
        motivo_pausa:     opt?.dataset?.desc || opt?.text || '',
      });
      if (!res.success) {
        alert('Erro ao pausar OP: ' + (res.error || 'desconhecido'));
        btnOk.disabled = false;
        btnOk.textContent = 'Pausar OP';
        return;
      }
      overlay.remove();
      // Recarrega a tela para refletir o novo status da maquina
      irParaTela(1);
    });
  }

  async function confirmarMaquinaVoltou(maquina) {
    const { confirmar } = await import('../modal.js');
    const ok = await confirmar({
      titulo: `${maquina.COD} — Máquina voltou?`,
      mensagem: `Fechar parada "${maquina.parada_aberta?.motivo || '—'}" agora?`,
      tipo: 'warning',
      textoOk: 'Sim, fechar parada',
      textoCancelar: 'Cancelar',
    });
    if (!ok) return;
    const res = await fecharParadaAberta(maquina.COD);
    if (!res.success) {
      alert('Erro ao fechar parada: ' + (res.error || 'desconhecido'));
      return;
    }
    // Recarrega a tela
    irParaTela(1);
  }

  async function abrirModalRegistrarParada(maquina) {
    const motivosRes = await getMotivosParada(estado.centroTrabalho?.TIPO || null);
    const motivos = motivosRes.success ? motivosRes.data : [];

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal-box" style="max-width:420px;">
        <h3 style="margin:0 0 8px 0;">⏸ Registrar parada — ${escHtml(maquina.COD)}</h3>
        <p style="font-size:13px;color:var(--color-muted);margin-bottom:12px;">
          A máquina vai ficar marcada como parada até alguém registrar o retorno
          ou fazer um apontamento nela.
        </p>
        <div class="field">
          <label class="field-label">Motivo <span class="obrigatorio">*</span></label>
          <input type="text" id="busca-motivo-parada-aberta" class="field-input" placeholder="Filtrar..." autocomplete="off" style="margin-bottom:4px;">
          <select id="sel-motivo-parada-aberta" class="field-input">
            <option value="">— Selecione o motivo —</option>
            ${motivos.map(m => {
              const cod  = m.COD  || m.cod  || '';
              const desc = m.DESCRICAO || m.descricao || m;
              return `<option value="${escHtml(cod)}" data-desc="${escHtml(desc)}" data-busca="${escHtml((cod + ' ' + desc).toLowerCase())}">${escHtml(cod)} — ${escHtml(desc)}</option>`;
            }).join('')}
          </select>
        </div>
        <div style="display:flex; gap:8px; margin-top:12px;">
          <button id="btn-cancelar-pa" class="btn btn-secondary" style="flex:1;">Cancelar</button>
          <button id="btn-confirmar-pa" class="btn btn-primary" style="flex:1;">Confirmar parada</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const sel   = overlay.querySelector('#sel-motivo-parada-aberta');
    const busca = overlay.querySelector('#busca-motivo-parada-aberta');
    const opcoesOriginais = Array.from(sel.options);
    busca.addEventListener('input', () => {
      const termo = busca.value.trim().toLowerCase();
      sel.innerHTML = '';
      const matches = opcoesOriginais.filter(opt => {
        if (!opt.value) return true;
        const b = opt.dataset.busca || opt.text.toLowerCase();
        return !termo || b.includes(termo);
      });
      matches.forEach(opt => sel.appendChild(opt.cloneNode(true)));
      const opcoesValidas = matches.filter(o => o.value);
      if (termo && opcoesValidas.length === 1) sel.value = opcoesValidas[0].value;
    });

    overlay.querySelector('#btn-cancelar-pa').addEventListener('click', () => overlay.remove());
    overlay.querySelector('#btn-confirmar-pa').addEventListener('click', async () => {
      if (!sel.value) { busca.focus(); return; }
      const opt = sel.options[sel.selectedIndex];
      const res = await registrarParadaAberta({
        maquina_cod:  maquina.COD,
        operador_cod: estado.operadorCod || estado.user?.username || null,
        cod_motivo:   sel.value,
        motivo:       opt?.dataset?.desc || opt?.text || '',
      });
      overlay.remove();
      if (!res.success) {
        alert('Erro ao registrar parada: ' + (res.error || 'desconhecido'));
        return;
      }
      irParaTela(1); // Recarrega com o novo estado
    });
  }
}

/** Sanitiza string para uso em innerHTML */
