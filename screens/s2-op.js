/**
 * s2-op.js — Tela 2: Seleção de OP, operador e turno.
 * - Quem logou (AD) e quem opera podem ser pessoas diferentes — operador
 *   continua sendo selecionado aqui, na lista vinda do Protheus.
 * - Exibe OPs da máquina selecionada
 * - Destaca a OP sugerida pelo Drummer
 * - Aviso obrigatório ao escolher OP diferente do Drummer
 * - Selector de cor/variante quando OP tem múltiplos itens (c2_item)
 * - Caixa de acumulado: total produzido desde último encerramento
 * - Chama POST /api/op/iniciar ao confirmar
 */

import { getOps, iniciarOP, pausarOP, retomarOP, getOperadores, getOpsOutrasMaquinas, getMotivosParada, registrarParadaOp, encerrarOpSemApontamento } from '../api.js';
import { salvarCache, lerCache, lerTodoCache }  from '../db.js';
import { estado, irParaTela, atualizarBadgePerfil } from '../app.js';
import { escHtml, formatarDataHoraLocale, formatarDuracaoCurta } from '../utils.js';
import { confirmar } from '../modal.js';
import { criarLinhaParada } from '../shared/parada-row.js';

export async function render(container) {
  const maquina = estado.maquinaSelecionada;
  const ct      = estado.centroTrabalho;

  // Guard (A6): esta tela depende de uma maquina selecionada. Sem ela (estado
  // limpo por boot offline, sessao reiniciada, navegacao direta) volta pra Tela 1.
  if (!maquina) {
    irParaTela(1);
    return;
  }

  let opSelecionada       = null;
  let opDrummerSugerida   = null;
  let avisoConfirmado     = false;
  let varianteSelecionada = null;  // { cod, descricao }

  container.innerHTML = `
    <div class="screen-topbar">
      <div class="screen-topbar-left">
        <button class="btn-voltar-padrao" id="btn-voltar-tela">← Voltar</button>
        <h2>Selecione a OP</h2>
      </div>
    </div>
    <div style="margin-bottom:16px;">
      ${ct ? `<span class="badge badge-primary" style="margin-right:6px;">${escHtml(ct.COD)}</span>` : ''}
      <span class="badge badge-gray">${escHtml(maquina.COD)}</span>
      <strong style="margin-left:8px;">${escHtml(maquina.DESCRICAO)}</strong>
    </div>

    ${(() => {
      // Banner condicional:
      //  - LARANJA "OP PARADA": pausa_op_aberta existe E (e' da OP_ATIVA OU sem OP_ATIVA).
      //    Caso da OP_ATIVA: soft-pause via /registrar-parada (OP segue atrelada).
      //    Caso sem OP_ATIVA: hard-pause via /pausar (OP foi desvinculada da maquina).
      //  - VERDE "OP EM ANDAMENTO": OP_ATIVA existe sem pausa, OU OP_ATIVA com pausa
      //    de OUTRA OP detached (a OP rodando esta normal).
      //  - VAZIO: maquina sem OP_ATIVA e sem pausa.
      const ativa = maquina.OP_ATIVA ? String(maquina.OP_ATIVA).trim() : '';
      const pausa = maquina.pausa_op_aberta;
      const pausaOp = pausa ? String(pausa.op_numero || '').trim() : '';
      const pausaDaAtiva = !!(pausa && ativa && pausaOp === ativa);
      const pausaSemAtiva = !!(pausa && !ativa && pausaOp);
      if (pausaDaAtiva || pausaSemAtiva) {
        return `
    <div style="background:#fff7ed; border:1px solid #f97316; border-radius:8px; padding:10px 14px; margin-bottom:16px;">
      <div style="font-size:12px; color:#9a3412; font-weight:700; letter-spacing:0.5px;">⏸ OP PARADA NESTA MÁQUINA</div>
      <div style="font-size:15px; font-weight:600; color:#7c2d12; margin-top:2px;">OP ${escHtml(pausaOp)}</div>
      ${pausa.motivo ? `<div style="font-size:12px; color:#9a3412; margin-top:4px;">Motivo: ${escHtml(pausa.motivo)}</div>` : ''}
      <div style="font-size:12px; color:#9a3412; margin-top:4px;">Faça um apontamento para retomar a produção.</div>
    </div>`;
      }
      if (ativa) {
        return `
    <div style="background: #ecfdf5; border: 1px solid #10b981; border-radius: 8px; padding: 10px 14px; margin-bottom: 16px;">
      <div style="font-size:12px; color:#065f46; font-weight:700; letter-spacing:0.5px;">● OP EM ANDAMENTO NESTA MÁQUINA</div>
      <div style="font-size:15px; font-weight:600; color:#064e3b; margin-top:2px;">OP ${escHtml(ativa)}</div>
      <div style="font-size:12px; color:#065f46; margin-top:4px;">Para pausar, volte à tela anterior e use o botão "Pausar OP" no rodapé.</div>
    </div>`;
      }
      return '';
    })()}

    <!-- Seleção de turno (filtra a lista de operadores via RA_TNOTRAB) -->
    <div class="field turno-row">
      <label class="field-label">Turno</label>
      <select id="sel-turno" class="field-input">
        <option value="">Selecione...</option>
        <option value="A">Turno A</option>
        <option value="B">Turno B</option>
        <option value="C">Turno C</option>
        <option value="D">Turno D</option>
      </select>
    </div>

    <!-- Seleção de operador (responsavel pelo apontamento) -->
    <div class="field operador-row">
      <label class="field-label">Operador</label>
      <select id="sel-operador" class="field-input" disabled>
        <option value="">Selecione um turno primeiro</option>
      </select>
    </div>

    <h3 style="font-size:16px;font-weight:700;margin-bottom:12px;">Ordens de Produção disponíveis</h3>

    <div id="ops-container">
      <div class="loading-center">
        <div class="spinner"></div>
        <span>Buscando OPs...</span>
      </div>
    </div>

    <!-- Transferir OP de outra maquina (ex.: problema na maquina original) -->
    <div id="ops-outras-wrap" style="margin-top:12px;">
      <button type="button" id="btn-outras-ops" class="btn btn-secondary" style="font-size:13px; padding:8px 12px; width:100%;">
        + Adicionar OP de outra maquina
      </button>
      <div id="ops-outras-container" style="display:none; margin-top:10px;"></div>
    </div>

    <!-- Aviso de divergência do Drummer (oculto inicialmente) -->
    <div id="aviso-divergencia" style="display:none;" class="aviso-amarelo">
      <p id="aviso-texto"></p>
      <div style="display:flex;gap:8px;margin-top:10px;">
        <button id="btn-confirmar-assim" class="btn btn-secondary btn-sm">Confirmar assim mesmo</button>
        <button id="btn-usar-drummer"    class="btn btn-primary   btn-sm">Usar OP prioritaria</button>
      </div>
    </div>

    <!-- Barra de acoes fixada no rodape (mesmo padrao das Telas 1 e 3) -->
    <div id="barra-confirmar-op" style="position:fixed; bottom:0; left:0; right:0; background:var(--color-bg); padding:10px 16px; border-top:2px solid var(--color-primary); z-index:100; box-shadow:0 -2px 8px rgba(0,0,0,0.1); display:flex; gap:8px; flex-direction:column;">
      <button id="btn-confirmar-op" class="btn btn-primary btn-block" disabled>Confirmar OP</button>
      <button id="btn-so-iniciar" class="btn btn-secondary btn-block" disabled title="Sinaliza que a OP iniciou — sem apontamento ainda">▶ Só sinalizar início</button>
      <button id="btn-registrar-parada" class="btn btn-secondary btn-block" title="Pausa a OP em andamento (não a máquina). Fim opcional.">⏸ Registrar parada de OP</button>
    </div>
    <div style="height:200px;"></div>
  `;

  const opsContainer     = document.getElementById('ops-container');
  const btnOutrasOps     = document.getElementById('btn-outras-ops');
  const opsOutrasContainer = document.getElementById('ops-outras-container');
  const btnConfirmarOp   = document.getElementById('btn-confirmar-op');
  const avisoDiv         = document.getElementById('aviso-divergencia');
  const avisoTexto       = document.getElementById('aviso-texto');
  const btnConfAssim     = document.getElementById('btn-confirmar-assim');
  const btnUsarDrummer   = document.getElementById('btn-usar-drummer');
  const selOperador      = document.getElementById('sel-operador');
  const selTurno         = document.getElementById('sel-turno');

  document.getElementById('btn-voltar-tela').addEventListener('click', () => irParaTela(1));

  // Carregar operadores (com fallback para cache offline) — guardar a lista
  // completa em memoria; o select e filtrado por turno (RA_TNOTRAB) abaixo.
  const todosOperadores = await carregarOperadores();

  // Pre-carregar motivos de parada (usados no modal de Pausar OP).
  // Falha silenciosa — se nao carregar, o modal mostra que esta sem motivos.
  let motivosCache = [];
  try {
    const resMot = await getMotivosParada();
    motivosCache = (resMot?.success && Array.isArray(resMot.data)) ? resMot.data : [];
    if (!motivosCache.length) {
      const cached = await lerTodoCache('cache-motivos');
      if (cached?.length) motivosCache = cached;
    }
  } catch (_) { /* silencioso */ }

  function popularSelectOperadores(turno) {
    if (!turno) {
      selOperador.innerHTML = '<option value="">Selecione um turno primeiro</option>';
      selOperador.disabled = true;
      return;
    }
    const filtrados = todosOperadores.filter(op =>
      (op.TURNO_PADRAO || op.turno_padrao) === turno
    );
    let html = '<option value="">— Selecione o operador —</option>';
    for (const op of filtrados) {
      const mat  = op.matricula || op.MATRICULA;
      const nome = op.nome      || op.NOME;
      html += `<option value="${escHtml(mat)}">${escHtml(nome)}</option>`;
    }
    selOperador.innerHTML = html;
    selOperador.disabled = false;
  }

  // Turno: vem SEMPRE do turno GLOBAL aberto e o select fica travado. Sem turno
  // aberto, fica vazio e travado — o operador precisa abrir o turno no botao do
  // topo antes de apontar. Ninguem escolhe turno manualmente.
  const turnoAberto = estado.turnoAberto?.turno || '';
  selTurno.disabled = true;
  if (turnoAberto) {
    selTurno.value = turnoAberto;
    estado.turno   = turnoAberto;
    popularSelectOperadores(turnoAberto);
  } else {
    selTurno.value = '';
    estado.turno   = null;
    popularSelectOperadores('');
  }

  // Buscar OPs da máquina
  let ops = [];
  const resultado = await getOps(maquina.COD);

  if (resultado.offline || !resultado.success) {
    const cached = await lerCache('cache-ops', maquina.COD);
    if (cached && cached.ops) {
      ops = cached.ops;
      renderOps(true);
    } else {
      opsContainer.innerHTML = `<div class="error-box">Sem conexão e sem cache de OPs disponível.</div>`;
      return;
    }
  } else {
    ops = resultado.data;
    await salvarCache('cache-ops', { key: maquina.COD, ops }).catch(() => {});
    renderOps(false);
  }

  // Identificar OP sugerida pelo Drummer
  opDrummerSugerida = ops.find(op => op.is_drummer_sugerida) || null;
  estado.opDrummerSugerida = opDrummerSugerida;

  function renderOps(usandoCache) {
    opsContainer.innerHTML = `
      ${usandoCache ? '<p style="font-size:12px;color:#b45309;margin-bottom:10px;">⚠ Dados do cache local (offline)</p>' : ''}
      <div class="ops-lista" id="ops-lista"></div>
    `;

    const lista = document.getElementById('ops-lista');
    const opAtivaCod = maquina.OP_ATIVA ? String(maquina.OP_ATIVA).trim() : null;
    // Se a OP atual esta PAUSADA, o operador pode querer trocar pra outra OP
    // (cenario: pausou pra fazer outro produto). Nesse caso libera a lista cheia
    // + botao "Adicionar OP de outra maquina". So restringe a lista quando a OP
    // esta efetivamente PRODUZINDO (sem pausa aberta).
    const opEstaPausada = !!maquina.pausa_op_aberta;

    let opsParaMostrar = ops;
    const wrap = document.getElementById('ops-outras-wrap');
    if (opAtivaCod && !opEstaPausada) {
      // Produzindo: so a OP atual aparece, sem botao de outras
      opsParaMostrar = ops.filter(o => String(o.op_numero).trim() === opAtivaCod);
      if (wrap) wrap.style.display = 'none';
    } else {
      // Pausada ou sem OP: lista cheia + botao de outras visivel
      if (wrap) wrap.style.display = '';
    }

    if (!opsParaMostrar.length) {
      // Caso defensivo: maquina tem OP_ATIVA mas getOps nao retornou ela.
      if (opAtivaCod) {
        lista.innerHTML = `
          <div class="info-box" style="background:#fef3c7; border:1px solid #f59e0b; border-radius:8px; padding:12px;">
            <p style="margin:0; font-size:13px; color:#92400e;">
              A máquina está com a OP <strong>${escHtml(opAtivaCod)}</strong> em andamento, mas ela não veio na lista.
              Volte à tela anterior e tente de novo, ou use "Encerrar OP" na tela anterior pra liberar a máquina.
            </p>
          </div>`;
      }
      return;
    }

    for (const op of opsParaMostrar) {
      const card = criarCardOpPrincipal(op, opAtivaCod);
      lista.appendChild(card);
    }
  }

  // Cria o card de uma OP para a lista principal "Ordens de Producao disponiveis".
  // Reusado tanto no render inicial quanto quando o usuario seleciona uma OP da
  // lista "outras maquinas" que esta em andamento na maquina atual.
  function criarCardOpPrincipal(op, opAtivaCod) {
    const ehDrummer     = op.is_drummer_sugerida;
    const ehPausada     = op.is_pausada;
    const ehEmAndamento = opAtivaCod && String(op.op_numero).trim() === opAtivaCod;
    const card      = document.createElement('div');
    card.className  = `card card-op ${ehDrummer ? 'card-drummer' : ''} ${ehPausada ? 'card-pausada' : ''} ${ehEmAndamento && !ehPausada ? 'card-em-andamento' : ''}`.replace(/\s+/g, ' ').trim();
    card.id         = `op-card-${op.op_numero}`;
    const badgePausada = ehPausada
      ? `<span class="badge-pausada" title="${escHtml(op.motivo_pausa || '')}">⏸ Pausada há ${formatarDuracaoCurta(op.dt_pausa)}</span>`
      : '';
    // "EM ANDAMENTO" so quando nao esta pausada — evita os dois badges juntos.
    const badgeEmAndamento = (ehEmAndamento && !ehPausada)
      ? `<span class="badge-em-andamento">● EM ANDAMENTO</span>`
      : '';
    card.innerHTML  = `
      <div class="op-header">
        <span class="op-numero">OP ${escHtml(op.op_numero)}</span>
        ${badgeEmAndamento}
        ${badgePausada}
      </div>
      <div class="op-produto">${escHtml(op.produto)}</div>
      <div class="op-info">
        ${op.planejado_un != null
          ? `<span>Planejado: <strong>${op.planejado_un} ${op.unid_medida || 'UN'}</strong>${op.planejado_kg ? ` (${op.planejado_kg} kg)` : ''}</span>`
          : (op.planejado_kg ? `<span>Planejado: <strong>${op.planejado_kg} kg</strong></span>` : '')
        }
        ${op.restante_un != null
          ? `<span>Saldo: <strong>${op.restante_un} ${op.unid_medida || 'UN'}</strong>${op.restante_kg ? ` (${op.restante_kg} kg)` : ''}</span>`
          : ''
        }
        ${op.taxa_producao_h > 0 ? `<span>Taxa: <strong>${op.taxa_producao_h} pç/h</strong></span>` : ''}
        ${op.previsao_termino ? `<span>Previsão: <strong>${formatarDataHoraLocale(op.previsao_termino)}</strong></span>` : ''}
        ${ehPausada && op.motivo_pausa ? `<span>Motivo: <strong>${escHtml(op.motivo_pausa)}</strong></span>` : ''}
      </div>
    `;
    card.addEventListener('click', () => selecionarOp(op));
    return card;
  }


  async function selecionarOp(op) {
    // Se a OP vem da lista "outras" mas pertence a esta maquina e ja esta em
    // andamento aqui, injeta o card dela na lista principal (em destaque) pra
    // ficar visivel ao operador, em vez de tratar como transferencia.
    const opAtivaCod = maquina.OP_ATIVA ? String(maquina.OP_ATIVA).trim() : null;
    const ehEmAndamentoAqui = opAtivaCod && String(op.op_numero).trim() === opAtivaCod;
    if (ehEmAndamentoAqui) {
      const listaPrincipal = document.getElementById('ops-lista');
      const cardExistente  = document.getElementById(`op-card-${op.op_numero}`);
      if (listaPrincipal && !listaPrincipal.contains(cardExistente)) {
        if (cardExistente) cardExistente.remove();   // remove do outras-lista se estiver la
        const novoCard = criarCardOpPrincipal({ ...op, is_outra_maquina: false }, opAtivaCod);
        listaPrincipal.prepend(novoCard);            // entra primeiro (destaque)
        novoCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
      // Reseta a flag pra nao entrar no fluxo de transferencia abaixo.
      op = { ...op, is_outra_maquina: false };
    }

    // Limpar seleção anterior (inclui OPs de outras maquinas)
    document.querySelectorAll('#ops-lista .card, #ops-outras-lista .card').forEach(c => c.classList.remove('selected'));
    document.getElementById(`op-card-${op.op_numero}`)?.classList.add('selected');

    opSelecionada     = op;
    avisoConfirmado   = false;
    varianteSelecionada = null;

    // OP pausada (a pausa eh DESSA op): abrir fluxo de retomada.
    if (op.is_pausada) {
      avisoDiv.style.display = 'none';
      atualizarBotaoConfirmar();
      await abrirModalRetomar(op);
      return;
    }

    // Maquina tem OP PAUSADA da OP_ATIVA mas o operador clicou em OUTRA OP — quer
    // trocar. Pede confirmacao + encerra a OP pausada antes de seguir pro fluxo
    // normal. So vale quando a pausa eh da MESMA OP que OP_ATIVA (soft-pause via
    // /registrar-parada). Se a pausa eh de outra OP detached, OP_ATIVA segue
    // rodando — o backend /iniciar bloqueia com 409, usuario precisa encerrar
    // OP_ATIVA primeiro pelo fluxo normal.
    const pausaAtual = maquina.pausa_op_aberta;
    const pausaOp = pausaAtual ? String(pausaAtual.op_numero || '').trim() : '';
    const pausaDaAtiva = !!(pausaAtual && opAtivaCod && pausaOp === opAtivaCod);
    if (pausaDaAtiva && String(op.op_numero).trim() !== pausaOp) {
      const ok = await confirmar({
        titulo: 'Trocar de OP?',
        html: `
          <p>A máquina está com a OP <strong>${escHtml(pausaOp)}</strong> pausada (${escHtml(pausaAtual.motivo || 'sem motivo')}).</p>
          <p style="margin-top:10px;">Encerrar essa OP e iniciar a <strong>${escHtml(op.op_numero)}</strong>?</p>
          <p style="margin-top:6px;font-size:12px;color:var(--color-muted);">A OP pausada será encerrada sem apontamento de produção.</p>
        `,
        tipo: 'aviso',
        textoOk: 'Encerrar pausada e trocar',
        textoCancelar: 'Cancelar',
      });
      if (!ok) {
        document.querySelectorAll('#ops-lista .card, #ops-outras-lista .card').forEach(c => c.classList.remove('selected'));
        opSelecionada = null;
        return;
      }
      const resEnc = await encerrarOpSemApontamento({
        op_numero:    pausaOp,
        maquina_cod:  maquina.COD,
        operador_cod: selOperador.value || '',
        turno:        selTurno.value   || null,
        motivo:       'Troca de OP durante pausa',
      });
      if (!resEnc?.success) {
        await confirmar({
          titulo: 'Erro ao encerrar OP pausada',
          mensagem: resEnc?.error || 'Não foi possível encerrar a OP pausada. Tente de novo.',
          tipo: 'erro', textoOk: 'OK', textoCancelar: '',
        });
        document.querySelectorAll('#ops-lista .card, #ops-outras-lista .card').forEach(c => c.classList.remove('selected'));
        opSelecionada = null;
        return;
      }
      // Atualiza estado local: a maquina ja nao tem mais OP_ATIVA nem pausa
      maquina.OP_ATIVA = null;
      maquina.pausa_op_aberta = null;
      // Segue fluxo normal abaixo (escolha de divergencia/confirmar)
    }

    // Se a OP vem de outra maquina, considerar como divergencia (OP transferida)
    // e nao aplicar o aviso de prioridade do PCP (ja e uma decisao intencional).
    if (op.is_outra_maquina) {
      avisoDiv.style.display = 'none';
      atualizarBotaoConfirmar();
      return;
    }

    // OP ja em andamento na maquina: nao tem o que decidir — o operador esta
    // apenas continuando o que ja esta rodando. Suprime o aviso de prioridade
    // do PCP (que so faria sentido na hora de ESCOLHER qual OP iniciar).
    if (ehEmAndamentoAqui) {
      avisoDiv.style.display = 'none';
      atualizarBotaoConfirmar();
      return;
    }

    // Verificar divergência com Drummer
    const temDivergencia = opDrummerSugerida && !op.is_drummer_sugerida;
    if (temDivergencia) {
      avisoTexto.textContent = `O PCP definiu a OP ${opDrummerSugerida.op_numero} como prioridade 1 para esta máquina. Tem certeza que deseja apontar em outra OP?`;
      avisoDiv.style.display = 'block';
      btnConfirmarOp.disabled = true;
    } else {
      avisoDiv.style.display = 'none';
      atualizarBotaoConfirmar();
    }
  }

  // Modal de retomada de OP pausada. Mostra motivo + duracao, e ao confirmar
  // chama /api/op/retomar e segue pra Tela 3 (apontamento).
  async function abrirModalRetomar(op) {
    if (!selOperador.value || !selTurno.value) {
      await confirmar({
        titulo: 'Selecione operador e turno',
        mensagem: 'Antes de retomar a OP pausada, escolha o turno e o operador.',
        tipo: 'info', textoOk: 'OK', textoCancelar: '',
      });
      return;
    }
    const motivo = op.motivo_pausa || '(sem motivo registrado)';
    const tempo  = formatarDuracaoCurta(op.dt_pausa);
    const dtFmt  = op.dt_pausa ? formatarDataHoraLocale(op.dt_pausa) : '—';
    const html = `
      <p>A OP <strong>${escHtml(op.op_numero)}</strong> esta pausada ha <strong>${tempo}</strong>.</p>
      <p style="margin-top:6px;"><span style="color:var(--color-muted);font-size:13px;">Pausada em ${escHtml(dtFmt)}</span></p>
      <p style="margin-top:6px;">Motivo: <strong>${escHtml(motivo)}</strong></p>
      <p style="margin-top:10px;">Deseja retomar a producao agora?</p>
    `;
    const ok = await confirmar({ titulo: 'Retomar OP pausada', html, tipo: 'info', textoOk: 'Retomar', textoCancelar: 'Cancelar' });
    if (!ok) return;

    const res = await retomarOP({
      op_numero:    op.op_numero,
      maquina_cod:  maquina.COD,
      operador_cod: selOperador.value,
      turno:        selTurno.value,
      origem_op:    op.origem_op || 'MANUAL',
    });
    if (!res.success) {
      await confirmar({ titulo: 'Erro ao retomar OP', mensagem: res.error || 'Tente novamente.', tipo: 'danger', textoOk: 'Entendi', textoCancelar: '' });
      return;
    }

    // Retomar apenas sinaliza que a OP voltou — nao força um apontamento.
    // O operador volta pra Tela 1 e aponta depois, quando tiver os dados.
    estado.operadorCod = selOperador.value;
    estado.turno       = selTurno.value;
    atualizarBadgePerfil();
    await confirmar({
      titulo: 'OP retomada',
      html: `<p>OP <strong>${escHtml(op.op_numero)}</strong> retomada na máquina <strong>${escHtml(maquina.COD)}</strong>.</p>
             <p style="font-size:13px;color:#6b7280;margin-top:8px;">Volte a esta OP quando tiver os dados pra apontar a produção.</p>`,
      tipo: 'info',
      textoOk: 'OK',
      textoCancelar: '',
    });
    irParaTela(1);
  }

  // ---------------------------------------------------------------------------
  // OPs de outras maquinas (para transferencia)
  // ---------------------------------------------------------------------------
  let opsOutrasCarregadas = false;
  btnOutrasOps.addEventListener('click', async () => {
    if (opsOutrasContainer.style.display === 'none') {
      if (!opsOutrasCarregadas) {
        opsOutrasContainer.innerHTML = '<div class="loading-center"><div class="spinner"></div><span>Buscando OPs...</span></div>';
        opsOutrasContainer.style.display = 'block';
        const res = await getOpsOutrasMaquinas(maquina.COD);
        if (res.success && Array.isArray(res.data) && res.data.length > 0) {
          renderOpsOutras(res.data);
        } else {
          opsOutrasContainer.innerHTML = '<p style="font-size:13px; color:var(--color-muted); text-align:center; padding:10px;">Nenhuma OP disponivel em outras maquinas.</p>';
        }
        opsOutrasCarregadas = true;
      } else {
        opsOutrasContainer.style.display = 'block';
      }
      btnOutrasOps.textContent = '− Ocultar OPs de outras maquinas';
    } else {
      opsOutrasContainer.style.display = 'none';
      btnOutrasOps.textContent = '+ Adicionar OP de outra maquina';
    }
  });

  function renderOpsOutras(opsOutras) {
    const html = `
      <div style="font-size:12px; color:var(--color-muted); padding:6px 4px 8px;">
        OPs originalmente destinadas a outras maquinas — selecione se precisa transferir a producao para <strong>${escHtml(maquina.COD)}</strong>.
      </div>
      <input
        type="search"
        id="input-busca-ops-outras"
        class="field-input"
        placeholder="Buscar por numero da OP ou descricao do item..."
        style="margin-bottom:10px;"
        autocomplete="off"
      />
      <div class="ops-lista" id="ops-outras-lista"></div>
    `;
    opsOutrasContainer.innerHTML = html;

    const inputBusca = document.getElementById('input-busca-ops-outras');
    const lista      = document.getElementById('ops-outras-lista');

    function renderLista(filtro = '') {
      const f = (filtro || '').trim().toLowerCase();
      const filtradas = !f ? opsOutras : opsOutras.filter(op =>
        (op.op_numero && String(op.op_numero).toLowerCase().includes(f)) ||
        (op.produto   && String(op.produto).toLowerCase().includes(f))   ||
        (op.maquina_original && String(op.maquina_original).toLowerCase().includes(f))
      );

      lista.innerHTML = '';
      if (filtradas.length === 0) {
        lista.innerHTML = '<p style="font-size:13px; color:var(--color-muted); text-align:center; padding:10px;">Nenhuma OP encontrada.</p>';
        return;
      }

      for (const op of filtradas) {
        const card = document.createElement('div');
        card.className = 'card card-op';
        card.id = `op-card-${op.op_numero}`;
        card.style.borderLeft = '3px solid var(--color-warning)';
        card.innerHTML = `
          <div class="op-header">
            <span class="op-numero">OP ${escHtml(op.op_numero)}</span>
            <span class="badge" style="background:#fef3c7; color:#92400e;">De ${escHtml(op.maquina_original || '?')}</span>
          </div>
          <div class="op-produto">${escHtml(op.produto)}</div>
          <div class="op-info">
            ${op.planejado_un != null
              ? `<span>Planejado: <strong>${op.planejado_un} ${op.unid_medida || 'UN'}</strong>${op.planejado_kg ? ` (${op.planejado_kg} kg)` : ''}</span>`
              : (op.planejado_kg ? `<span>Planejado: <strong>${op.planejado_kg} kg</strong></span>` : '')
            }
            ${op.restante_un != null
              ? `<span>Saldo: <strong>${op.restante_un} ${op.unid_medida || 'UN'}</strong>${op.restante_kg ? ` (${op.restante_kg} kg)` : ''}</span>`
              : ''
            }
            <span>Prioridade: <strong>${op.prioridade || '—'}</strong></span>
          </div>
        `;
        card.addEventListener('click', () => selecionarOp(op));
        lista.appendChild(card);
      }
    }

    inputBusca.addEventListener('input', () => renderLista(inputBusca.value));
    renderLista('');
  }

  function atualizarBotaoConfirmar() {
    const semDadosBasicos = !opSelecionada || !selOperador.value || !selTurno.value;
    const opEhPausada     = !!(opSelecionada && opSelecionada.is_pausada);
    // Confirmar/SoIniciar: OP nao pausada com todos os campos.
    btnConfirmarOp.disabled = semDadosBasicos || opEhPausada;
    const btnSoIniciar = document.getElementById('btn-so-iniciar');
    if (btnSoIniciar) btnSoIniciar.disabled = semDadosBasicos || opEhPausada;
  }

  btnConfAssim.addEventListener('click', () => {
    avisoConfirmado = true;
    avisoDiv.style.display = 'none';
    atualizarBotaoConfirmar();
  });

  btnUsarDrummer.addEventListener('click', () => {
    avisoDiv.style.display = 'none';
    document.querySelectorAll('#ops-lista .card').forEach(c => c.classList.remove('selected'));
    opSelecionada = null;
    btnConfirmarOp.disabled = true;
    if (opDrummerSugerida) {
      document.getElementById(`op-card-${opDrummerSugerida.op_numero}`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  });

  selOperador.addEventListener('change', () => {
    selOperador.classList.remove('error');
    estado.operadorCod = selOperador.value || null;
    atualizarBotaoConfirmar();
  });
  // O select de turno fica sempre travado (turno vem do turno GLOBAL aberto),
  // entao nao ha listener de 'change' — o turno nunca muda por aqui.

  // Confirmar OP
  btnConfirmarOp.addEventListener('click', async () => {
    if (!opSelecionada) return;

    const operadorCod = selOperador.value;
    if (!operadorCod) { selOperador.classList.add('error'); return; }
    if (!selTurno.value) { selTurno.classList.add('error'); return; }

    const opDivergiu = !!(opDrummerSugerida && !opSelecionada.is_drummer_sugerida);

    // Não chamar iniciarOP aqui — a OP só será aberta quando
    // o apontamento for confirmado na tela 3 (evita abrir OP sem produção)

    // Salvar no estado global
    estado.opSelecionada  = opSelecionada;
    estado.operadorCod    = operadorCod;
    estado.turno          = selTurno.value;
    estado.opDivergiu     = opDivergiu;

    atualizarBadgePerfil();
    irParaTela(3);
  });

  // Só sinalizar início (sem apontamento) — util pra operador avisar que a OP
  // começou mesmo sem dados de produção ainda (pro Drummer saber).
  const btnSoIniciar = document.getElementById('btn-so-iniciar');
  btnSoIniciar.addEventListener('click', async () => {
    if (!opSelecionada) return;
    const operadorCod = selOperador.value;
    if (!operadorCod) { selOperador.classList.add('error'); return; }
    if (!selTurno.value) { selTurno.classList.add('error'); return; }

    const opDivergiu = !!(opDrummerSugerida && !opSelecionada.is_drummer_sugerida);
    const turno = selTurno.value;

    btnSoIniciar.disabled = true;
    btnSoIniciar.textContent = 'Enviando...';
    try {
      const res = await iniciarOP({
        op_numero:    opSelecionada.op_numero,
        maquina_cod:  maquina.COD,
        operador_cod: operadorCod,
        turno,
        origem_op:    opSelecionada.origem_op || 'MANUAL',
        op_divergiu:  opDivergiu,
      });

      if (!res.success && !res.offline) {
        throw new Error(res.error || 'Falha ao iniciar OP');
      }

      estado.operadorCod = operadorCod;
      estado.turno = turno;
      atualizarBadgePerfil();

      await confirmar({
        titulo: 'OP iniciada',
        html: `<p>OP <strong>${escHtml(opSelecionada.op_numero)}</strong> sinalizada como iniciada na máquina <strong>${escHtml(maquina.COD)}</strong>.</p>
               ${res.offline ? '<p style="color:#92400e;font-size:13px;">📡 Sem conexão — vai sincronizar quando voltar.</p>' : ''}
               <p style="font-size:13px;color:#6b7280;margin-top:8px;">Volte a esta mesma OP quando tiver os dados pra apontar a produção.</p>`,
        tipo: 'info',
        textoOk: 'OK',
        textoCancelar: '',
      });
      irParaTela(1);   // volta pra selecao de maquina
    } catch (err) {
      await confirmar({
        titulo: 'Erro ao iniciar OP',
        mensagem: err.message,
        tipo: 'danger',
        textoOk: 'Entendi',
        textoCancelar: '',
      });
      btnSoIniciar.disabled = false;
      btnSoIniciar.textContent = '▶ Só sinalizar início';
    }
  });

  // Registrar parada DE OP (nao da maquina). So tem sentido quando a maquina
  // tem OP_ATIVA — pausa essa OP especifica via OP_PAUSADA, sem mexer na
  // maquina. Fim e opcional: vazio = parada ainda em andamento (live);
  // preenchido = registro historico que ja terminou.
  document.getElementById('btn-registrar-parada')
    .addEventListener('click', () => abrirModalRegistrarParada());

  async function abrirModalRegistrarParada() {
    const opAtivaCod = maquina.OP_ATIVA ? String(maquina.OP_ATIVA).trim() : '';
    if (!opAtivaCod) {
      await confirmar({
        titulo: 'Nenhuma OP em andamento',
        mensagem: 'Esta maquina nao tem OP em andamento. Para registrar uma parada de OP, inicie a OP primeiro.',
        tipo: 'warning', textoOk: 'Entendi', textoCancelar: '',
      });
      return;
    }
    if (!motivosCache.length) {
      await confirmar({
        titulo: 'Motivos indisponiveis',
        mensagem: 'Nao foi possivel carregar a lista de motivos. Tente recarregar o app.',
        tipo: 'danger', textoOk: 'Entendi', textoCancelar: '',
      });
      return;
    }
    const motivoOptionsHtml = '<option value="">— Selecione o motivo —</option>' +
      motivosCache.map(m => {
        const cod  = m.COD || m.cod;
        const desc = m.DESCRICAO || m.descricao || '';
        return `<option value="${escHtml(cod)}" data-busca="${escHtml(desc.toLowerCase())}">${escHtml(desc)}</option>`;
      }).join('');

    const existente = document.getElementById('app-modal-backdrop');
    if (existente) existente.remove();
    const backdrop = document.createElement('div');
    backdrop.id = 'app-modal-backdrop';
    backdrop.className = 'app-modal-backdrop';
    backdrop.innerHTML = `
      <div class="app-modal" role="dialog" aria-modal="true">
        <div class="app-modal-header app-modal-info">
          <span class="app-modal-icon">⏸</span>
          <h3>Registrar parada da OP ${escHtml(opAtivaCod)} — ${escHtml(maquina.COD)}</h3>
        </div>
        <div class="app-modal-body">
          <p style="margin:0 0 10px; font-size:13px; color:var(--color-muted);">
            Pausa a OP (não a máquina). Deixe o <strong>fim em branco</strong> se a parada
            ainda está em andamento, ou preencha início e fim para registrar uma parada já terminada.
          </p>
          <div id="parada-avulsa-lista"></div>
          <div id="parada-avulsa-erro" class="error-box" style="display:none; margin-top:8px; margin-bottom:0;"></div>
        </div>
        <div class="app-modal-footer">
          <button type="button" class="btn btn-secondary" id="parada-av-cancelar">Cancelar</button>
          <button type="button" class="btn btn-primary" id="parada-av-ok">Registrar parada</button>
        </div>
      </div>`;
    document.body.appendChild(backdrop);

    const lista = backdrop.querySelector('#parada-avulsa-lista');
    const row = criarLinhaParada({ listaEl: lista, motivoOptionsHtml, comBusca: true, autoInicio: true });
    // Modal de uma parada so — o cabecalho "Parada #1" e o "x" nao fazem sentido.
    const header = row.querySelector('.parada-header');
    if (header) header.style.display = 'none';
    // Marca o "Fim" como opcional (remove o * vermelho do label gerado pela
    // linha compartilhada). A msg de erro do fim tambem deixa de aparecer.
    const fimField = row.querySelector('.parada-fim').closest('.field');
    if (fimField) {
      const lbl = fimField.querySelector('.field-label');
      if (lbl) lbl.innerHTML = 'Fim <span style="color:var(--color-muted);font-weight:400;">(opcional)</span>';
      const err = fimField.querySelector('.field-error-msg');
      if (err) err.style.display = 'none';
    }

    const erroBox     = backdrop.querySelector('#parada-avulsa-erro');
    const btnOk       = backdrop.querySelector('#parada-av-ok');
    const btnCancelar = backdrop.querySelector('#parada-av-cancelar');

    function fechar() {
      backdrop.classList.add('fechando');
      setTimeout(() => backdrop.remove(), 150);
    }
    btnCancelar.addEventListener('click', fechar);
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) fechar(); });

    btnOk.addEventListener('click', async () => {
      const codMotivo = row.querySelector('.parada-motivo').value;
      const inicio    = row.querySelector('.parada-inicio').value;
      const fim       = row.querySelector('.parada-fim').value;
      erroBox.style.display = 'none';
      if (!codMotivo) { erroBox.textContent = 'Selecione o motivo da parada.'; erroBox.style.display = 'block'; return; }
      if (!inicio)    { erroBox.textContent = 'Informe o início da parada.';    erroBox.style.display = 'block'; return; }
      if (fim && new Date(fim) <= new Date(inicio)) {
        erroBox.textContent = 'O fim deve ser depois do início.'; erroBox.style.display = 'block'; return;
      }
      const motivoObj = motivosCache.find(m => (m.COD || m.cod) === codMotivo);
      btnOk.disabled = true;
      btnOk.textContent = 'Registrando...';
      const res = await registrarParadaOp({
        op_numero:        opAtivaCod,
        maquina_cod:      maquina.COD,
        operador_cod:     selOperador.value || estado.operadorCod || null,
        turno:            estado.turno || null,
        cod_motivo_pausa: codMotivo,
        motivo_pausa:     motivoObj ? (motivoObj.DESCRICAO || motivoObj.descricao) : '',
        inicio,
        fim: fim || null,
      });
      if (!res || !res.success) {
        btnOk.disabled = false;
        btnOk.textContent = 'Registrar parada';
        erroBox.textContent = (res && res.offline)
          ? 'Sem conexão com o servidor. Tente novamente.'
          : 'Não foi possível registrar a parada: ' + ((res && res.error) || 'erro desconhecido');
        erroBox.style.display = 'block';
        return;
      }
      fechar();
      const msgFinal = fim
        ? `<p>Parada da OP <strong>${escHtml(opAtivaCod)}</strong> registrada (início e fim).</p>`
        : `<p>OP <strong>${escHtml(opAtivaCod)}</strong> pausada. Quando voltar a produzir, faça o próximo apontamento normalmente.</p>`;
      await confirmar({
        titulo: 'Parada registrada',
        html: msgFinal,
        tipo: 'info', textoOk: 'OK', textoCancelar: '',
      });
    });

    setTimeout(() => { const b = row.querySelector('.parada-busca'); if (b) b.focus(); }, 50);
  }

  // Pausar OP foi REMOVIDO desta tela. O operador pausa direto na Tela de
  // selecao de maquina (s1-maquina.js), via botao "⏸ Pausar OP X" no rodape
  // que so aparece quando a maquina selecionada tem OP_ATIVA.

  // Modal de selecao de motivo. Retorna { cod, desc } ou null.
  // Constroi um <select> com motivosCache. Se cache vazio, alerta o operador.
  async function abrirModalMotivosPausa(op) {
    if (!motivosCache.length) {
      await confirmar({
        titulo: 'Motivos indisponiveis',
        mensagem: 'Nao foi possivel carregar a lista de motivos. Tente recarregar o app.',
        tipo: 'danger', textoOk: 'Entendi', textoCancelar: '',
      });
      return null;
    }
    return new Promise((resolve) => {
      const existente = document.getElementById('app-modal-backdrop');
      if (existente) existente.remove();
      const backdrop = document.createElement('div');
      backdrop.id = 'app-modal-backdrop';
      backdrop.className = 'app-modal-backdrop';
      const opcoesHtml = motivosCache
        .map(m => `<option value="${escHtml(m.COD || m.cod)}">${escHtml(m.DESCRICAO || m.descricao)}</option>`)
        .join('');
      backdrop.innerHTML = `
        <div class="app-modal" role="dialog" aria-modal="true">
          <div class="app-modal-header app-modal-info">
            <span class="app-modal-icon">⏸</span>
            <h3>Pausar OP ${escHtml(op.op_numero)}</h3>
          </div>
          <div class="app-modal-body">
            <p style="margin-bottom:10px;">Selecione o motivo da pausa:</p>
            <select id="pausa-motivo-sel" class="field-input" style="width:100%;">
              <option value="">— Selecione —</option>
              ${opcoesHtml}
            </select>
          </div>
          <div class="app-modal-footer">
            <button type="button" class="btn btn-secondary" id="pausa-cancelar">Cancelar</button>
            <button type="button" class="btn btn-primary" id="pausa-ok" disabled>Pausar OP</button>
          </div>
        </div>`;
      document.body.appendChild(backdrop);
      const sel = document.getElementById('pausa-motivo-sel');
      const btnOk = document.getElementById('pausa-ok');
      const btnCancelar = document.getElementById('pausa-cancelar');
      sel.addEventListener('change', () => { btnOk.disabled = !sel.value; });
      setTimeout(() => sel.focus(), 50);
      function fechar(valor) {
        backdrop.classList.add('fechando');
        setTimeout(() => { backdrop.remove(); resolve(valor); }, 150);
      }
      btnOk.addEventListener('click', () => {
        if (!sel.value) return;
        const motivo = motivosCache.find(m => (m.COD || m.cod) === sel.value);
        fechar({ cod: sel.value, desc: motivo ? (motivo.DESCRICAO || motivo.descricao) : '' });
      });
      btnCancelar.addEventListener('click', () => fechar(null));
      backdrop.addEventListener('click', (e) => { if (e.target === backdrop) fechar(null); });
    });
  }
}

async function carregarOperadores() {
  const res = await getOperadores();
  let operadores = (res.success && res.data) ? res.data : [];

  if (operadores.length === 0) {
    const cached = await lerTodoCache('cache-operadores');
    if (cached?.length) operadores = cached;
  }

  return [...operadores].sort((a, b) =>
    (a.nome || a.NOME || '').localeCompare(b.nome || b.NOME || '', 'pt-BR', { numeric: true })
  );
}

