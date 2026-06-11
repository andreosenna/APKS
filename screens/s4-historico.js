/**
 * s4-historico.js — Tela de histórico e correção de apontamentos.
 * Permite visualizar apontamentos recentes, corrigir valores e reabrir OPs.
 */

import { irParaTela, registrarGuardaNavegacao } from '../app.js';
import { getHistoricoGeral, corrigirApontamento, reabrirOP, getMotivosParada, getLogsEdicao, getOperadores, excluirEvento, atualizarDtEvento, criarApontamentoRetroativo, getOpsAbertas } from '../api.js';
import { lerTodoCache } from '../db.js';
import { confirmar }    from '../modal.js';
import { opcoesHtmlTipoPerda } from '../shared/tipos-perda.js';
import { criarLinhaParada }   from '../shared/parada-row.js';
import { formatarDataDiaMesHora, formatarNumFixo, escHtml, hojeISO } from '../utils.js';
import * as admin        from '../admin.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function badgeStatus(st) {
  if (st === 'ENVIADO')  return '<span class="badge badge-success">Enviado</span>';
  if (st === 'PENDENTE') return '<span class="badge badge-warning">Pendente</span>';
  if (st === 'ERRO')     return '<span class="badge badge-danger">Erro</span>';
  return `<span class="badge badge-gray">${st || '—'}</span>`;
}

// ---------------------------------------------------------------------------
// Renderizar lista de apontamentos
// ---------------------------------------------------------------------------

async function renderLista(container, sel = null) {
  // A lista nao tem dados a perder — limpa qualquer guarda de navegacao deixada
  // pela tela de edicao (ALTO 4).
  registrarGuardaNavegacao(null);
  // Seletor de periodo. sel: null (hoje) | '__todos__' | 'YYYY-MM-DD' | {inicio,fim}
  let inicio = null, fim = null, todos = false;
  if (sel === '__todos__') {
    todos = true;
  } else if (sel && typeof sel === 'object') {
    inicio = sel.inicio || hojeISO();
    fim    = sel.fim || null;
  } else if (typeof sel === 'string' && sel) {
    inicio = sel;
  } else {
    inicio = hojeISO();
  }
  // So vira "periodo" se "fim" for posterior ao "inicio".
  const ehPeriodo = !todos && !!fim && fim > inicio;
  if (!ehPeriodo) fim = null;
  // Usado nas re-renderizacoes (apos excluir/editar).
  const selAtual = todos ? '__todos__' : (ehPeriodo ? { inicio, fim } : inicio);

  container.innerHTML = `
    <div class="screen-topbar">
      <div class="screen-topbar-left">
        <button class="btn-voltar-padrao" id="btn-voltar-hist">← Voltar</button>
        <h2>Historico</h2>
      </div>
    </div>

    <!-- Filtro de data / periodo -->
    <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 14px; flex-wrap: wrap;">
      <button class="btn btn-secondary btn-sm" id="btn-dia-anterior" title="Dia anterior" style="min-width:36px; padding:0 8px;">←</button>
      <label style="font-size:13px; color:var(--color-muted);">De</label>
      <input type="date" id="filtro-data" class="field-input" value="${todos ? '' : inicio}" style="max-width: 155px; font-size: 14px;">
      <label style="font-size:13px; color:var(--color-muted);">até</label>
      <input type="date" id="filtro-data-fim" class="field-input" value="${fim || ''}" title="Opcional — preencha para ver um período" style="max-width: 155px; font-size: 14px;">
      <button class="btn btn-secondary btn-sm" id="btn-dia-seguinte" title="Dia seguinte" style="min-width:36px; padding:0 8px;">→</button>
      <button class="btn btn-secondary btn-sm" id="btn-hoje" style="font-size: 13px;">Hoje</button>
      <button class="btn btn-secondary btn-sm" id="btn-todos" style="font-size: 13px;">Todos</button>
      <span id="historico-contagem" style="font-size: 13px; color: var(--color-muted); margin-left: auto;"></span>
      ${admin.isEditor() ? `<button class="btn btn-primary btn-sm" id="btn-retroativo" style="font-size:13px;" title="Registrar producao de um turno passado">+ Retroativo</button>` : ''}
    </div>

    <div id="historico-loading" class="loading-center">
      <div class="spinner"></div>
      <span>Carregando...</span>
    </div>
    <div id="historico-erro" class="error-box" style="display:none;"></div>
    <div id="historico-lista"></div>
  `;

  document.getElementById('btn-voltar-hist').addEventListener('click', () => irParaTela(0));

  // Navegacao de data / periodo
  const inputData    = document.getElementById('filtro-data');
  const inputDataFim = document.getElementById('filtro-data-fim');

  // Le os dois campos: se "até" estiver preenchido e for posterior, vira periodo.
  const recarregar = () => {
    const di = inputData.value;
    const df = inputDataFim.value;
    if (!di) return;
    renderLista(container, (df && df > di) ? { inicio: di, fim: df } : di);
  };
  inputData.addEventListener('change', recarregar);
  inputDataFim.addEventListener('change', recarregar);

  document.getElementById('btn-hoje').addEventListener('click', () => renderLista(container, hojeISO()));
  document.getElementById('btn-todos').addEventListener('click', () => renderLista(container, '__todos__'));
  const btnRetro = document.getElementById('btn-retroativo');
  if (btnRetro) btnRetro.addEventListener('click', () => abrirModalRetroativo(() => recarregar()));

  // Setas deslocam o periodo inteiro (ou o dia unico) em 1 dia.
  const deslocar = (delta) => {
    if (todos || !inicio) return;
    const shift = (iso) => {
      const d = new Date(iso + 'T12:00:00');
      d.setDate(d.getDate() + delta);
      return d.toISOString().slice(0, 10);
    };
    renderLista(container, ehPeriodo ? { inicio: shift(inicio), fim: shift(fim) } : shift(inicio));
  };
  document.getElementById('btn-dia-anterior').addEventListener('click', () => deslocar(-1));
  document.getElementById('btn-dia-seguinte').addEventListener('click', () => deslocar(1));

  // Buscar dados
  const filtros = {};
  if (ehPeriodo) {
    filtros.data_inicio = inicio;
    filtros.data_fim    = fim;
  } else if (!todos) {
    filtros.data = inicio;
  }
  const res = await getHistoricoGeral(filtros);
  document.getElementById('historico-loading').style.display = 'none';

  if (!res.success) {
    document.getElementById('historico-erro').style.display = 'block';
    document.getElementById('historico-erro').textContent = res.error || 'Erro ao carregar historico';
    return;
  }

  const lista = res.data || [];
  // Eventos AP4010 (OP_INICIADA, OP_PAUSADA, OP_RETOMADA, OP_ENCERRADA, PARADA_AVULSA).
  // Renderizamos como cards distintos no historico para que inicio/termino aparecam
  // mesmo quando nao houve apontamento (ex: "so sinalizar inicio").
  // O backend ja filtra eventos pela data (CAST AS DATE). Nao refiltrar aqui:
  // .slice(0,10) numa string de data UTC erraria o dia por causa do fuso.
  let eventos = (res.eventos || []).slice();

  const contagem = document.getElementById('historico-contagem');
  const fmtBR = (d) => d.split('-').reverse().join('/');
  const sufixoPeriodo = todos
    ? '(todos)'
    : ehPeriodo ? `de ${fmtBR(inicio)} a ${fmtBR(fim)}` : `em ${fmtBR(inicio)}`;
  contagem.textContent = `${lista.length} apontamento${lista.length !== 1 ? 's' : ''} + ${eventos.length} evento${eventos.length !== 1 ? 's' : ''} ${sufixoPeriodo}`;

  if (!lista.length && !eventos.length) {
    document.getElementById('historico-lista').innerHTML = `
      <div style="text-align: center; padding: 40px; color: var(--color-muted);">
        Nenhum apontamento ${todos ? 'registrado ainda' : ehPeriodo ? 'neste período' : 'nesta data'}.
      </div>`;
    return;
  }

  // Constroi a timeline unificada (apontamentos + eventos), ordenada por data desc.
  const tipoLabel = {
    OP_INICIADA:    { rotulo: '▶ OP iniciada',    cor: '#16a34a' },
    OP_ENCERRADA:   { rotulo: '■ OP encerrada',   cor: '#6b7280' },
    OP_PAUSADA:     { rotulo: '⏸ OP pausada',     cor: '#eab308' },
    OP_RETOMADA:    { rotulo: '⏵ OP retomada',    cor: '#0891b2' },
    PARADA_AVULSA:  { rotulo: '⏸ Parada avulsa',  cor: '#dc2626' },
  };
  function eventoCard(ev) {
    const t   = tipoLabel[ev.tipo_evento] || { rotulo: ev.tipo_evento, cor: '#6b7280' };
    // Valores dinamicos (produto/maquina/motivo do Protheus, etc.) escapados na
    // origem — o card e montado por interpolacao de string (XSS C4).
    const op  = escHtml(ev.op_numero || '');
    const maq = escHtml(ev.maquina_desc || ev.maquina_cod || '');
    const maqCod = escHtml(ev.maquina_cod || '');
    const produto = escHtml(ev.produto || '');
    const motivo = escHtml(ev.motivo_pausa || '');
    const oper = escHtml(ev.operador_cod || '');
    const turno = escHtml(ev.turno || '');
    const planejado = ev.planejado_un ? escHtml(`${ev.planejado_un} ${ev.unid_medida || 'un'}`) : '';
    const dur = ev.duracao_min != null
      ? (ev.duracao_min < 60 ? `${ev.duracao_min} min` : `${Math.floor(ev.duracao_min / 60)}h${String(ev.duracao_min % 60).padStart(2, '0')}`)
      : null;
    const btnExcluir = admin.isEditor()
      ? `<button class="btn-excluir-evento" data-evento-id="${ev.id}" data-tipo="${t.rotulo}" title="Excluir evento (admin)" style="background:transparent; border:none; color:#dc2626; font-size:16px; cursor:pointer; padding:4px 8px;">🗑</button>`
      : '';
    // Edicao de DT_EVENTO permitida pra OP_INICIADA, OP_PAUSADA e PARADA_AVULSA
    // — corrige quando o encarregado registrou o evento atrasado/adiantado.
    // RETOMADA/ENCERRAMENTO nao sao editaveis (fecham ciclo do evento anterior).
    const TIPOS_EDITAVEIS = ['OP_INICIADA', 'OP_PAUSADA', 'PARADA_AVULSA'];
    const btnEditar = (admin.isEditor() && TIPOS_EDITAVEIS.includes(ev.tipo_evento))
      ? `<button class="btn-editar-evento" data-evento-id="${ev.id}" data-dt-atual="${escHtml(ev.dt_evento || '')}" title="Editar data/hora (admin)" style="background:transparent; border:none; color:#2563eb; font-size:16px; cursor:pointer; padding:4px 8px;">✏</button>`
      : '';
    return `
      <div class="card card-historico card-evento" data-evento-id="${ev.id}" style="margin-bottom: 10px; border-left: 4px solid ${t.cor};">
        <div style="display: flex; justify-content: space-between; align-items: flex-start;">
          <div style="min-width:0; flex:1;">
            <div style="font-size: 14px; font-weight: 700; color: ${t.cor};">${t.rotulo}</div>
            ${produto ? `<div style="font-size: 14px; font-weight: 600; margin-top: 2px;">${produto}</div>` : ''}
            <div style="font-size: 13px; color: var(--color-muted); margin-top: 2px;">
              ${op ? `<strong>OP ${op}</strong> · ` : ''}${maq}${maqCod && maq !== maqCod ? ` (${maqCod})` : ''}${motivo ? ` — ${motivo}` : ''}
            </div>
          </div>
          <div style="text-align: right;">
            <div style="font-size: 12px; color: var(--color-muted);">${formatarDataDiaMesHora(ev.dt_evento)}</div>
            ${dur ? `<div style="font-size: 12px; margin-top: 4px;"><strong>Duração:</strong> ${dur}</div>` : ''}
            ${(btnEditar || btnExcluir) ? `<div style="margin-top:4px;">${btnEditar}${btnExcluir}</div>` : ''}
          </div>
        </div>
        ${(oper || turno || planejado) ? `
        <div style="margin-top: 6px; display: flex; gap: 12px; flex-wrap: wrap; font-size: 12px; color: var(--color-muted);">
          ${oper ? `<span>Operador: <strong>${oper}</strong></span>` : ''}
          ${turno ? `<span>Turno: <strong>${turno}</strong></span>` : ''}
          ${planejado ? `<span>Planejado: <strong>${planejado}</strong></span>` : ''}
          ${ev.prioridade ? `<span>Prioridade: <strong>${escHtml(String(ev.prioridade))}</strong></span>` : ''}
        </div>` : ''}
      </div>`;
  }

  // Apontamentos primeiro, com renderizacao detalhada; eventos intercalados por data.
  const itens = [
    ...lista.map(a => ({ tipo: 'apt', dt: a.dt_apontamento, dados: a })),
    ...eventos.map(e => ({ tipo: 'evt', dt: e.dt_evento, dados: e })),
  ].sort((a, b) => new Date(b.dt) - new Date(a.dt));

  document.getElementById('historico-lista').innerHTML = itens.map(it => {
    if (it.tipo === 'evt') return eventoCard(it.dados);
    const apt = it.dados;
    {
    const id       = apt.id;
    // Valores dinamicos escapados na origem (XSS C4) — cards montados por
    // interpolacao de string com dados do Protheus/AD.
    const op       = escHtml(apt.op_numero || '');
    const maquina  = escHtml(apt.maquina_cod || '');
    const maqDesc  = escHtml(apt.maquina_desc || apt.maquina_cod || '');
    const qtdKg    = apt.qtd_produzida;
    const qtdUn    = apt.qtd_produzida_un;
    const unid     = apt.unid_medida;
    const encerrou = apt.encerrou_op;
    const stPro    = apt.st_protheus || 'PENDENTE';
    const dt       = apt.dt_apontamento;
    const refugo    = apt.qtd_refugo_kg || 0;
    const perdaMp   = apt.qtd_perda_mp_kg || 0;
    const foiEditado = apt.foi_editado || false;

    const qtdDisplay = unid === 'UN' && qtdUn
      ? `${qtdUn} un (${formatarNumFixo(qtdKg, 1)} kg)`
      : `${formatarNumFixo(qtdKg, 1)} kg`;

    const produto    = escHtml(apt.produto || '');
    const operador   = escHtml(apt.operador_cod || '');
    const turno      = escHtml(apt.turno || '');
    const cor        = escHtml(apt.cor_variante_desc || '');
    const houveParada = apt.houve_parada;
    const motivoPar   = escHtml(apt.motivo_parada || apt.cod_motivo_parada || '');
    const ctCod      = escHtml(apt.centro_trab_cod || '');
    const opInfo     = apt.op_info || null;
    const btnExcluirHtml = admin.isAdmin()
      ? `<button class="btn-excluir-apt" data-excluir-id="${id}" title="Excluir apontamento (admin)" style="background:transparent; border:none; color:#dc2626; font-size:16px; cursor:pointer; padding:4px 8px;">🗑</button>`
      : '';
    return `
      <div class="card card-historico ${foiEditado ? 'card-editado' : ''}" data-apt-id="${id}" style="margin-bottom: 10px; cursor: pointer;">
        <div style="display: flex; justify-content: space-between; align-items: flex-start;">
          <div style="min-width:0; flex:1;">
            ${produto ? `<div style="font-size: 15px; font-weight: 700;">${produto}</div>` : ''}
            <div style="font-size: 13px; color: var(--color-muted);">
              <strong>OP ${op}</strong> · ${maqDesc} (${maquina})${ctCod ? ` · CT ${ctCod}` : ''}
            </div>
            ${cor ? `<div style="font-size: 12px; color: var(--color-muted); margin-top: 2px;">Cor/Variante: <strong>${cor}</strong></div>` : ''}
          </div>
          <div style="text-align: right;">
            <div style="font-size: 12px; color: var(--color-muted);">${formatarDataDiaMesHora(dt)}</div>
            <div style="display: flex; gap: 4px; justify-content: flex-end; flex-wrap: wrap; margin-top: 4px; align-items:center;">
              ${foiEditado ? '<span class="badge badge-info">✏ Editado</span>' : ''}
              ${encerrou ? '<span class="badge badge-warning">OP Encerrada</span>' : ''}
              ${btnExcluirHtml}
            </div>
          </div>
        </div>
        <div style="margin-top: 8px; display: flex; gap: 12px; flex-wrap: wrap; font-size: 13px;">
          <span><strong>Produzido:</strong> ${qtdDisplay}</span>
          <span><strong>Perda Peça:</strong> ${formatarNumFixo(refugo, 1)} kg</span>
          <span><strong>Perda BCV:</strong> ${formatarNumFixo(perdaMp, 1)} kg</span>
          ${apt.horas_trabalhadas ? `<span><strong>Tempo:</strong> ${formatarNumFixo(apt.horas_trabalhadas, 1)}h</span>` : ''}
          ${apt.horas_trabalhadas && apt.qtd_produzida_un ? `<span><strong>PH:</strong> ${Math.round(apt.qtd_produzida_un / apt.horas_trabalhadas)} un/h</span>` : ''}
        </div>
        <div style="margin-top: 6px; display: flex; gap: 12px; flex-wrap: wrap; font-size: 12px; color: var(--color-muted);">
          ${operador ? `<span>Operador: <strong>${operador}</strong></span>` : ''}
          ${turno ? `<span>Turno: <strong>${turno}</strong></span>` : ''}
          ${unid ? `<span>Unidade: <strong>${unid}</strong></span>` : ''}
          ${apt.origem_op ? `<span>Origem: <strong>${apt.origem_op}</strong></span>` : ''}
        </div>
        ${opInfo ? `
        <div style="margin-top: 6px; padding: 6px 10px; background: #f1f5f9; border-radius: 6px; font-size: 12px; display: flex; gap: 14px; flex-wrap: wrap;">
          <span><strong>OP — Planejado:</strong> ${opInfo.planejado_un ? `${opInfo.planejado_un} ${opInfo.unid_medida || 'un'}` : '—'}${opInfo.planejado_kg ? ` (${formatarNumFixo(opInfo.planejado_kg, 1)} kg)` : ''}</span>
          ${opInfo.restante_un != null ? `<span><strong>Saldo:</strong> ${opInfo.restante_un} ${opInfo.unid_medida || 'un'}</span>` : ''}
          ${opInfo.prioridade ? `<span><strong>Prioridade:</strong> ${opInfo.prioridade}</span>` : ''}
          ${opInfo.previsao_termino ? `<span><strong>Previsão:</strong> ${formatarDataDiaMesHora(opInfo.previsao_termino)}</span>` : ''}
        </div>` : ''}
        ${houveParada && motivoPar ? `
        <div style="margin-top: 6px; padding: 4px 8px; background: #fef3c7; border-left: 3px solid #f59e0b; font-size: 12px;">
          ⏸ <strong>Parada:</strong> ${motivoPar}
          ${apt.dt_inicio_parada && apt.dt_fim_parada ? ` (${formatarDataDiaMesHora(apt.dt_inicio_parada)} → ${formatarDataDiaMesHora(apt.dt_fim_parada)})` : ''}
        </div>` : ''}
        ${stPro !== 'PENDENTE' ? `
        <div style="margin-top: 6px; display: flex; gap: 6px;">
          ${badgeStatus(stPro)}
        </div>` : ''}
      </div>`;
    }
  }).join('');

  // Eventos de clique nos cards de APONTAMENTO (abre edicao). Cards de EVENTO
  // (data-evento-id) nao abrem edicao -- so suportam o botao de excluir.
  document.querySelectorAll('.card-historico[data-apt-id]').forEach(card => {
    card.addEventListener('click', (e) => {
      if (e.target.closest('.btn-excluir-apt')) return;
      const aptId = card.dataset.aptId;
      const apt   = lista.find(a => String(a.ID ?? a.id) === String(aptId));
      if (apt) renderEdicao(container, apt);
    });
  });

  // Modal pra editar a DT_EVENTO de um OP_INICIADA ou OP_PAUSADA. Retorna ISO
  // string ou null (cancelado). Usa datetime-local — converte hora LOCAL.
  async function abrirModalEditarDtInicio({ opNumero, maquinaCod, dtInicial, tipoEvento }) {
    const ePausa  = tipoEvento === 'OP_PAUSADA';
    const eParada = tipoEvento === 'PARADA_AVULSA';
    const icone   = (ePausa || eParada) ? '⏸' : '▶';
    let titulo, descricao, labelCampo;
    if (eParada) {
      titulo     = `Editar parada avulsa`;
      descricao  = `Corrige o horário do início da <strong>parada avulsa</strong> em <strong>${escHtml(maquinaCod || '')}</strong>. Útil quando a parada foi registrada com atraso. Recalcula as horas efetivas do PH.`;
      labelCampo = 'Início da parada (data + hora)';
    } else if (ePausa) {
      titulo     = `Editar pausa da OP ${escHtml(opNumero || '')}`;
      descricao  = `Corrige o horário do <strong>OP_PAUSADA</strong> de <strong>${escHtml(maquinaCod || '')}</strong>. Útil quando a parada foi registrada com atraso. Recalcula as horas efetivas do PH.`;
      labelCampo = 'Início da pausa (data + hora)';
    } else {
      titulo     = `Editar início da OP ${escHtml(opNumero || '')}`;
      descricao  = `Corrige o horário do <strong>OP_INICIADA</strong> de <strong>${escHtml(maquinaCod || '')}</strong>. Útil quando o encarregado confirmou a OP atrasado ou adiantado. Recalcula as horas efetivas do PH.`;
      labelCampo = 'Início da OP (data + hora)';
    }
    return new Promise((resolve) => {
      const existente = document.getElementById('app-modal-backdrop');
      if (existente) existente.remove();
      const backdrop = document.createElement('div');
      backdrop.id = 'app-modal-backdrop';
      backdrop.className = 'app-modal-backdrop';
      backdrop.innerHTML = `
        <div class="app-modal" role="dialog" aria-modal="true" style="max-width:420px;">
          <div class="app-modal-header app-modal-info">
            <span class="app-modal-icon">${icone}</span>
            <h3>${titulo}</h3>
          </div>
          <div class="app-modal-body">
            <p style="margin:0 0 10px; font-size:13px; color:var(--color-muted);">
              ${descricao}
            </p>
            <div class="field">
              <label class="field-label">${labelCampo} <span class="obrigatorio">*</span></label>
              <input type="datetime-local" id="edit-dt-evento" class="field-input" value="${escHtml(dtInicial || '')}">
            </div>
            <div id="edit-dt-erro" class="error-box" style="display:none; margin-top:8px;"></div>
          </div>
          <div class="app-modal-footer">
            <button type="button" class="btn btn-secondary" id="edit-dt-cancelar">Cancelar</button>
            <button type="button" class="btn btn-primary" id="edit-dt-ok">Salvar</button>
          </div>
        </div>`;
      document.body.appendChild(backdrop);
      const inp     = backdrop.querySelector('#edit-dt-evento');
      const erroBox = backdrop.querySelector('#edit-dt-erro');
      function fechar(valor) {
        backdrop.classList.add('fechando');
        setTimeout(() => { backdrop.remove(); resolve(valor); }, 150);
      }
      backdrop.querySelector('#edit-dt-cancelar').addEventListener('click', () => fechar(null));
      backdrop.addEventListener('click', (e) => { if (e.target === backdrop) fechar(null); });
      backdrop.querySelector('#edit-dt-ok').addEventListener('click', () => {
        const v = inp.value;
        const m = String(v || '').match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
        if (!m) {
          erroBox.textContent = 'Informe data e hora válidas.';
          erroBox.style.display = 'block'; return;
        }
        const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], 0);
        if (isNaN(d.getTime())) {
          erroBox.textContent = 'Data inválida.'; erroBox.style.display = 'block'; return;
        }
        if (d.getTime() > Date.now() + 5 * 60000) {
          erroBox.textContent = 'O horário não pode ser no futuro.'; erroBox.style.display = 'block'; return;
        }
        fechar(d.toISOString());
      });
      setTimeout(() => inp.focus(), 50);
    });
  }

  // Botoes de editar data de OP_INICIADA (admin/editor)
  document.querySelectorAll('.btn-editar-evento').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const eventoId = btn.dataset.eventoId;
      const ev = eventos.find(x => String(x.id) === String(eventoId));
      if (!ev) return;
      const dtAtual = ev.dt_evento ? new Date(ev.dt_evento) : new Date();
      const p = n => String(n).padStart(2, '0');
      const dtLocal = `${dtAtual.getFullYear()}-${p(dtAtual.getMonth()+1)}-${p(dtAtual.getDate())}T${p(dtAtual.getHours())}:${p(dtAtual.getMinutes())}`;

      const novoDt = await abrirModalEditarDtInicio({
        opNumero:   ev.op_numero,
        maquinaCod: ev.maquina_cod,
        dtInicial:  dtLocal,
        tipoEvento: ev.tipo_evento,
      });
      if (!novoDt) return;
      const res = await atualizarDtEvento(eventoId, novoDt);
      if (!res.success) {
        await confirmar({
          titulo: 'Falha ao atualizar',
          mensagem: res.error || 'Erro desconhecido',
          tipo: 'danger', textoOk: 'Entendi', textoCancelar: '',
        });
        return;
      }
      await renderLista(container, selAtual);
    });
  });

  // Botoes de excluir evento (admin/editor only -- filtrado no render)
  document.querySelectorAll('.btn-excluir-evento').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const eventoId = btn.dataset.eventoId;
      const tipo     = btn.dataset.tipo || 'evento';
      const ev = eventos.find(x => String(x.id) === String(eventoId));
      if (!ev) return;
      const ok = await confirmar({
        titulo: 'Excluir evento',
        html: `<p>Apagar permanentemente este evento do historico?</p>
               <p style="background:#fee2e2;padding:8px 12px;border-radius:6px;font-size:13px;">
                 <strong>${escHtml(tipo)}</strong>${ev.op_numero ? ` · OP ${escHtml(ev.op_numero)}` : ''} · ${escHtml(ev.maquina_cod || '')}
                 ${ev.motivo_pausa ? `<br>Motivo: ${escHtml(ev.motivo_pausa)}` : ''}
               </p>
               <p style="font-size:12px;color:#6b7280;margin-top:8px;">
                 Eventos antigos NAO sao re-criados automaticamente. Use so se foi erro real.
               </p>`,
        tipo: 'danger',
        textoOk: 'Excluir',
        textoCancelar: 'Cancelar',
      });
      if (!ok) return;
      const res = await excluirEvento(eventoId);
      if (!res.success) {
        await confirmar({ titulo: 'Falha ao excluir', mensagem: res.error || 'Erro desconhecido', tipo: 'danger', textoOk: 'Entendi', textoCancelar: '' });
        return;
      }
      // Recarregar a lista
      await renderLista(container, selAtual);
    });
  });

  // Botoes de excluir (admin only — ja filtrado no render)
  document.querySelectorAll('.btn-excluir-apt').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const aptId = btn.dataset.excluirId;
      const apt = lista.find(a => String(a.ID ?? a.id) === String(aptId));
      if (!apt) return;

      const qtdDisplayConfirm = apt.unid_medida === 'UN' && apt.qtd_produzida_un
        ? `${apt.qtd_produzida_un} un`
        : `${formatarNumFixo(apt.qtd_produzida, 1)} kg`;
      const ok = await confirmar({
        titulo: 'Excluir apontamento',
        html: `<p>Esta acao apaga permanentemente este apontamento:</p>
               <p style="background:#fee2e2;padding:8px 12px;border-radius:6px;font-size:13px;">
                 <strong>OP ${escHtml(apt.op_numero)}</strong> · ${escHtml(apt.maquina_cod || '')} · ${qtdDisplayConfirm}
               </p>
               <p style="font-size:12px;color:#6b7280;margin-top:8px;">
                 Se apagar por engano, restaure via backup (/api/backup/import).
               </p>`,
        tipo: 'danger',
        textoOk: 'Excluir',
        textoCancelar: 'Cancelar',
      });
      if (!ok) return;

      try {
        const url = (window.APP_CONFIG?.backendUrl || '') + `/api/apontamento/${aptId}`;
        const res = await admin.fetchAdmin(url, { method: 'DELETE' });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || 'HTTP ' + res.status);
        }
        // Re-renderizar a lista inteira (mais simples que remover o item)
        await renderLista(container, selAtual);
      } catch (err) {
        if (err.message !== 'Autenticacao cancelada' && err.message !== 'Token revogado') {
          await confirmar({
            titulo: 'Falha ao excluir',
            mensagem: err.message,
            tipo: 'danger',
            textoOk: 'Entendi',
            textoCancelar: '',
          });
        }
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Renderizar tela de edicao/correcao
// ---------------------------------------------------------------------------

async function renderEdicao(container, apt) {
  const somenteLeitura = !admin.isEditor();
  const id       = apt.id;
  // Valores dinamicos escapados na origem (XSS C4) — esta tela monta HTML por
  // interpolacao de string com dados do Protheus/AD.
  const op       = escHtml(apt.op_numero || '');
  const maquina  = escHtml(apt.maquina_cod || '');
  const maqDesc  = escHtml(apt.maquina_desc || apt.maquina_cod || '');
  const unid     = apt.unid_medida || 'KG';
  let encerrou   = apt.encerrou_op;
  const qtdKg    = apt.qtd_produzida || 0;
  const qtdUn    = apt.qtd_produzida_un || '';
  const pesoUn   = apt.peso_padrao_un || '';
  const refugo   = apt.qtd_refugo_kg || 0;
  const perdaMp  = apt.qtd_perda_mp_kg || 0;
  const hParada  = apt.houve_parada || false;
  const codMotivo= apt.cod_motivo_parada || '';
  const motivo   = apt.motivo_parada || '';
  const dtInicioProd   = apt.dt_inicio_producao || '';
  const dtFimProd      = apt.dt_fim_producao || '';
  const dtInicioParada = apt.dt_inicio_parada || '';
  const dtFimParada    = apt.dt_fim_parada || '';
  const perdas   = apt.outras_perdas     || [];
  const dt       = apt.dt_apontamento;

  // Converter ISO UTC para valor "YYYY-MM-DDTHH:MM" para input type=datetime-local
  function isoToDatetimeLocal(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  const hInicioProd   = isoToDatetimeLocal(dtInicioProd);
  const hFimProd      = isoToDatetimeLocal(dtFimProd);
  // Edicao abre a secao de horario automaticamente quando ja ha horario gravado.
  const horarioPreenchido = !!(hInicioProd || hFimProd);
  const hInicioParada = isoToDatetimeLocal(dtInicioParada);
  const hFimParada    = isoToDatetimeLocal(dtFimParada);

  // Buscar motivos de parada (mesma lógica da tela de apontamento)
  const motivosParada = await carregarMotivosParada();

  // Options do <select> de tipos de perda (fonte unica em shared/tipos-perda.js)
  const tiposPerdaOptions = opcoesHtmlTipoPerda();

  container.innerHTML = `
    <div class="screen-topbar">
      <div class="screen-topbar-left">
        <button class="btn-voltar-padrao" id="btn-voltar-edicao">← Voltar</button>
        <h2>${somenteLeitura ? 'Apontamento' : 'Corrigir apontamento'} #${id}</h2>
      </div>
    </div>

    <div class="resumo-op" style="margin-bottom: 16px;">
      ${apt.produto ? `<div class="op-produto" style="font-size: 16px; font-weight: 700;">${escHtml(apt.produto)}</div>` : `<div class="op-produto" style="font-size: 16px; font-weight: 700;">Corrigir Apontamento #${id}</div>`}
      <div class="op-detalhe">OP ${op} — ${maqDesc} (${maquina})</div>
      <div class="op-detalhe">Data: ${formatarDataDiaMesHora(dt)}</div>
      ${encerrou ? '<div class="op-badges" style="margin-top:6px;"><span class="badge badge-warning">OP foi encerrada neste apontamento</span></div>' : ''}
    </div>

    ${encerrou ? `
    <div class="encerrar-op-box" style="margin-bottom: 16px; border-color: #ef4444; background: #fef2f2;">
      <div style="display: flex; align-items: center; gap: 10px;">
        <span style="font-size: 20px;">⚠</span>
        <div>
          <div style="font-size: 14px; font-weight: 600; color: #991b1b;">Esta OP foi encerrada neste apontamento</div>
          <div style="font-size: 12px; color: #b91c1c; margin-top: 2px;">Se foi por engano, clique abaixo para reabrir.</div>
        </div>
      </div>
      <button class="btn btn-danger btn-sm" id="btn-reabrir-op" style="margin-top: 10px; width: 100%;">
        Reabrir OP ${op}
      </button>
    </div>` : ''}

    <div id="msg-sucesso" class="aviso-amarelo" style="display:none; border-color: #86efac; background: #f0fdf4;">
      <p style="color: #166534;"></p>
    </div>
    <div id="msg-erro" class="error-box" style="display:none;"></div>

    <!-- Cor / Variante (paridade com tela de apontamento) -->
    <div class="field">
      <label class="field-label">Cor / Variante</label>
      <select class="field-input" id="sel-variante-edit">
        <option value="">— Sem variante / cor única —</option>
        <option value="Azul" ${(apt.cor_variante_desc === 'Azul') ? 'selected' : ''}>Azul</option>
        <option value="Vermelho" ${(apt.cor_variante_desc === 'Vermelho') ? 'selected' : ''}>Vermelho</option>
        <option value="OUTROS" ${(apt.cor_variante_desc && !['Azul','Vermelho',''].includes(apt.cor_variante_desc)) ? 'selected' : ''}>Outros</option>
      </select>
    </div>
    <div id="campo-cor-outros-edit" style="display: ${(apt.cor_variante_desc && !['Azul','Vermelho',''].includes(apt.cor_variante_desc)) ? 'block' : 'none'};">
      <div class="field">
        <label class="field-label">Qual a cor?</label>
        <input type="text" id="inp-cor-outros-edit" class="field-input" placeholder="Ex: Verde, Preto..." value="${escHtml((apt.cor_variante_desc && !['Azul','Vermelho',''].includes(apt.cor_variante_desc)) ? apt.cor_variante_desc : '')}">
      </div>
    </div>

    <div class="section-divider"></div>

    <!-- Período de produção — OPCIONAL, atras de toggle (igual a tela de apontamento).
         Abre automaticamente quando o apontamento ja tem horarios gravados. -->
    <button type="button" class="expansivel-toggle" id="toggle-ajustar-horario-edit">${horarioPreenchido ? '▼' : '▶'} Ajustar horário de produção (avançado)</button>
    <div class="expansivel-conteudo ${horarioPreenchido ? 'aberto' : ''}" id="secao-horario-edit">
      <div class="field-row">
        <div class="field">
          <label class="field-label">Início da produção</label>
          <input type="datetime-local" class="field-input" id="inicio-prod-edit" value="${hInicioProd}">
        </div>
        <div class="field">
          <label class="field-label">Fim da produção</label>
          <input type="datetime-local" class="field-input" id="fim-prod-edit" value="${hFimProd}">
        </div>
      </div>
    </div>

    <!-- Peso padrao (so quando UN) — exibido em gramas, storage em kg -->
    <div class="field" id="campo-peso-edit" style="display: ${unid === 'UN' ? 'block' : 'none'};">
      <label class="field-label">Peso padrao (g/un)</label>
      <input type="number" class="field-input" id="peso-padrao-edit" step="0.01" min="0" value="${pesoUn ? (pesoUn * 1000).toFixed(2) : ''}">
    </div>

    <!-- Quantidade produzida -->
    <div class="field" id="campo-qtd-un-edit" style="display: ${unid === 'UN' ? 'block' : 'none'};">
      <label class="field-label">Quantidade produzida (unidades)</label>
      <input type="number" class="field-input" id="qtd-un-edit" step="1" min="0" value="${qtdUn}">
      <div class="calc-pill" id="calc-pill-edit" style="display: ${unid === 'UN' && qtdUn && pesoUn ? 'inline-flex' : 'none'};">
        ${qtdUn && pesoUn ? `${qtdUn} un x ${(pesoUn * 1000).toFixed(2)} g/un = ${formatarNumFixo(qtdUn * pesoUn, 3)} kg` : ''}
      </div>
    </div>

    <div class="field" id="campo-qtd-kg-edit">
      <label class="field-label" id="label-qtd-kg-edit">
        ${unid === 'UN' ? 'Total em kg (calculado)' : 'Quantidade produzida (kg)'}
      </label>
      <input type="number" class="field-input" id="qtd-kg-edit" step="0.1" min="0" value="${formatarNumFixo(qtdKg, 3)}"
        ${unid === 'UN' ? 'readonly style="background: #f3f4f6;"' : ''}>
    </div>

    <!-- Refugo e Perda MP -->
    <div class="field-row">
      <div class="field">
        <label class="field-label">Perda Peça (kg) <span class="obrigatorio">*</span></label>
        <input type="number" class="field-input" id="refugo-edit" step="0.1" min="0" value="${refugo}">
      </div>
      <div class="field">
        <label class="field-label">Perda BCV (kg) <span class="obrigatorio">*</span></label>
        <input type="number" class="field-input" id="perda-mp-edit" step="0.1" min="0" value="${perdaMp}">
      </div>
    </div>

    <!-- Outras perdas (vem antes de Parada para casar com a tela de apontamento) -->
    <div class="field">
      <div class="toggle-row" id="toggle-perdas-edit">
        <span class="toggle-label">Outras perdas</span>
        <div class="toggle-track ${perdas.length ? 'on-orange ativo' : ''}">
          <div class="toggle-thumb"></div>
        </div>
      </div>
      <div id="perdas-campos-edit" style="display: ${perdas.length ? 'block' : 'none'};">
        <div id="perdas-lista-edit">
          ${perdas.map((p, i) => `
            <div class="perda-row" data-idx="${i}">
              <select class="field-input perda-tipo-edit">
                ${opcoesHtmlTipoPerda(p.TIPO_PERDA || p.tipo_perda || '')}
              </select>
              <input type="number" class="field-input perda-kg-edit" step="0.1" min="0" value="${p.QTD_KG || p.qtd_kg || ''}">
              <button class="btn-remover-perda" data-idx="${i}">×</button>
            </div>
          `).join('')}
        </div>
        <button class="btn btn-secondary btn-sm" id="btn-add-perda-edit" style="margin-top: 8px;">+ Adicionar perda</button>
      </div>
    </div>

    <!-- Paradas (multiplas) -->
    <div class="field">
      <div class="toggle-row" id="toggle-parada-edit">
        <span class="toggle-label">Houve parada de maquina?</span>
        <div class="toggle-track ${hParada ? 'on-red ativo' : ''}">
          <div class="toggle-thumb"></div>
        </div>
      </div>
      <div id="parada-campos-edit" style="display: ${hParada ? 'block' : 'none'};">
        <div id="lista-paradas-edit"></div>
        <button type="button" id="btn-add-parada-edit" class="btn btn-secondary btn-sm" style="margin-top:4px;">+ Adicionar parada</button>
      </div>
    </div>

    <!-- Encerrar OP (so aparece se ainda nao foi encerrada neste apontamento) -->
    ${!encerrou ? `
    <div class="encerrar-op-box" id="box-encerrar-edit">
      <label>
        <input type="checkbox" id="chk-encerrar-edit">
        <div>
          <div class="encerrar-texto">Encerrar esta OP</div>
          <div class="encerrar-sub">A OP ${op} sera marcada como encerrada. A maquina volta para SEM_OP.</div>
        </div>
      </label>
    </div>` : ''}

    <div class="section-divider"></div>

    <!-- Log de edicoes -->
    <div id="secao-log-edicoes" style="display: none;">
      <h3 style="font-size: 14px; font-weight: 700; margin-bottom: 10px; color: var(--color-muted);">
        Historico de alteracoes
      </h3>
      <div id="log-edicoes-lista"></div>
      <div class="section-divider"></div>
    </div>

    <!-- Botoes -->
    <div class="actions-bar" style="flex-direction: column; gap: 8px;">
      <button class="btn btn-primary btn-block" id="btn-salvar-correcao">Salvar correcao</button>
    </div>
  `;

  // Modo somente-leitura (visualizador): desativa inputs, esconde botoes de acao,
  // e esconde o campo "Quem esta corrigindo".
  if (somenteLeitura) {
    requestAnimationFrame(() => {
      // Desativa todos os inputs, selects, textareas e buttons SEG do form
      container.querySelectorAll('input, select, textarea').forEach(el => {
        el.disabled = true;
      });
      container.querySelectorAll('.seg-btn').forEach(el => {
        el.disabled = true;
        el.style.pointerEvents = 'none';
        el.style.opacity = '0.7';
      });
      // Esconde Salvar / Reabrir OP
      const btnSalvar = document.getElementById('btn-salvar-correcao');
      if (btnSalvar) btnSalvar.style.display = 'none';
      const boxReabrir = document.querySelector('.encerrar-op-box');
      if (boxReabrir) boxReabrir.style.display = 'none';
      // Esconde botoes de adicionar/remover linhas de perdas/paradas
      container.querySelectorAll('[id^="btn-add"], .btn-remover-perda, .btn-remover-parada, .btn-remover-linha').forEach(b => {
        b.style.display = 'none';
      });
    });
  }

  // --- Carregar log de edições ---
  carregarLogs(id);

  async function carregarLogs(aptId) {
    const res = await getLogsEdicao(aptId);
    const logs = res.data || [];
    if (!logs.length) return;

    // Buscar nomes dos operadores para exibir no log
    let mapaOperadores = {};
    try {
      let ops = await lerTodoCache('cache-operadores');
      if (!ops || !ops.length) {
        const resOp = await getOperadores();
        if (resOp.success && resOp.data) ops = resOp.data;
      }
      if (ops) {
        for (const op of ops) {
          const cod = op.MATRICULA || op.matricula || op.cod || '';
          const nome = op.NOME || op.nome || '';
          if (cod) mapaOperadores[cod] = nome;
        }
      }
    } catch (_) { /* sem operadores */ }

    const secao = document.getElementById('secao-log-edicoes');
    const lista = document.getElementById('log-edicoes-lista');
    secao.style.display = 'block';

    lista.innerHTML = logs.map(log => {
      const dt    = formatarDataDiaMesHora(log.DT_EDICAO || log.dt_edicao);
      const tipo  = log.TIPO_EDICAO  || log.tipo_edicao;
      const campo = escHtml(log.CAMPO_ALTERADO || log.campo_alterado || '');
      const de    = escHtml(log.VALOR_ANTERIOR || log.valor_anterior || '');
      const para  = escHtml(log.VALOR_NOVO    || log.valor_novo || '');
      const codOp = log.OPERADOR_COD  || log.operador_cod || '';
      const quem  = codOp ? (mapaOperadores[codOp] ? `${escHtml(codOp)} — ${escHtml(mapaOperadores[codOp])}` : escHtml(codOp)) : '—';
      const isTipoReabertura = tipo === 'REABERTURA_OP';

      return `
        <div class="log-edicao-item" style="
          background: ${isTipoReabertura ? '#fef2f2' : '#f8fafc'};
          border: 1px solid ${isTipoReabertura ? '#fca5a5' : 'var(--color-border)'};
          border-radius: var(--radius-sm);
          padding: 10px 12px;
          margin-bottom: 8px;
          font-size: 13px;
        ">
          <div style="display: flex; justify-content: space-between; margin-bottom: 4px;">
            <strong>${campo}</strong>
            <span style="color: var(--color-muted); font-size: 11px;">${dt}</span>
          </div>
          <div style="color: var(--color-muted);">
            <span style="color: #991b1b; text-decoration: line-through;">${de}</span>
            →
            <span style="color: #166534; font-weight: 600;">${para}</span>
          </div>
          ${quem !== '—' ? `<div style="font-size: 11px; color: var(--color-muted); margin-top: 4px;">Por: ${quem}</div>` : ''}
        </div>`;
    }).join('');
  }

  // --- Event listeners ---

  // Voltar — pede confirmação se algum campo foi alterado (formDirty).
  let formDirty = false;
  // Os listeners de "form sujo" vao no container, que persiste entre telas
  // (innerHTML so troca os filhos). Sem remover o par anterior, cada abertura
  // da edicao acumularia listeners orfaos sobre closures mortas (MEDIO 10).
  if (container._formDirtyHandler) {
    container.removeEventListener('input',  container._formDirtyHandler);
    container.removeEventListener('change', container._formDirtyHandler);
  }
  const marcarFormDirty = () => { formDirty = true; };
  container._formDirtyHandler = marcarFormDirty;
  container.addEventListener('input',  marcarFormDirty);
  container.addEventListener('change', marcarFormDirty);

  // Guarda de navegacao (A9): os botoes do header (Historico/Painel/Home/Sair)
  // consultam isto antes de trocar de tela. Sem a guarda, sair pelo header no
  // meio de uma correcao descartaria as alteracoes sem aviso (ALTO 4).
  registrarGuardaNavegacao(() => formDirty);

  document.getElementById('btn-voltar-edicao').addEventListener('click', async () => {
    if (formDirty) {
      const ok = await confirmar({
        titulo: 'Sair sem salvar?',
        mensagem: 'Você fez alterações neste apontamento que ainda não foram salvas.',
        tipo: 'warning',
        textoOk: 'Descartar alterações',
        textoCancelar: 'Continuar editando',
      });
      if (!ok) return;
    }
    renderLista(container);
  });

  // Toggle "Ajustar horário": expande/recolhe a seção de início/fim — mesmo
  // padrão da tela de apontamento. Na edição não limpa os inputs ao recolher,
  // pois podem conter horários já gravados.
  const toggleHorarioEdit = document.getElementById('toggle-ajustar-horario-edit');
  const secaoHorarioEdit  = document.getElementById('secao-horario-edit');
  toggleHorarioEdit.addEventListener('click', () => {
    const aberto = secaoHorarioEdit.classList.toggle('aberto');
    toggleHorarioEdit.textContent =
      (aberto ? '▼' : '▶') + ' Ajustar horário de produção (avançado)';
  });

  // Reabrir OP
  const btnReabrir = document.getElementById('btn-reabrir-op');
  if (btnReabrir) {
    btnReabrir.addEventListener('click', async () => {
      const okReabrir = await confirmar({
        titulo: 'Reabrir OP encerrada',
        html: `
          <p>Você vai reabrir a OP <strong>${op}</strong>.</p>
          <div class="modal-resumo">
            <dl>
              <dt>Máquina</dt>  <dd>${maquina}</dd>
            </dl>
          </div>
          <p>A máquina voltará a ficar como <strong>PRODUZINDO</strong> e o apontamento será reenviado ao Drummer.</p>
        `,
        tipo: 'danger',
        textoOk: 'Reabrir OP',
        textoCancelar: 'Cancelar',
      });
      if (!okReabrir) return;
      btnReabrir.disabled = true;
      btnReabrir.textContent = 'Reabrindo...';
      const res = await reabrirOP(id);
      if (res.success && (res.offline || res.queued)) {
        // Offline: a reabertura so foi enfileirada — nao confirmada (A8).
        mostrarMsg('aviso', `Sem conexão — reabertura da OP ${op} enfileirada. Será enviada quando a conexão voltar.`);
        btnReabrir.closest('.encerrar-op-box').style.display = 'none';
        encerrou = false;
      } else if (res.success) {
        mostrarMsg('sucesso', `OP ${op} reaberta com sucesso! A maquina ${maquina} voltou para PRODUZINDO.`);
        btnReabrir.closest('.encerrar-op-box').style.display = 'none';
        encerrou = false;
      } else {
        mostrarMsg('erro', res.error || 'Erro ao reabrir OP');
        btnReabrir.disabled = false;
        btnReabrir.textContent = `Reabrir OP ${op}`;
      }
    });
  }

  // Unidade de medida -- vem fixa do apontamento original (apt.unid_medida).
  // O toggle KG/UN foi removido para paridade com a tela de apontamento, que
  // assume a unidade da OP sem permitir troca manual.
  const unidAtual = unid;

  // Recalculo automatico quando UN.
  // Peso padrao no input esta em GRAMAS; convertemos para KG aqui.
  function recalcularKg() {
    const qtd       = parseFloat(document.getElementById('qtd-un-edit').value) || 0;
    const pesoGrama = parseFloat(document.getElementById('peso-padrao-edit').value) || 0;
    const pesoKg    = pesoGrama / 1000;
    const pill      = document.getElementById('calc-pill-edit');
    if (qtd > 0 && pesoKg > 0) {
      const total = qtd * pesoKg;
      document.getElementById('qtd-kg-edit').value = total.toFixed(3);
      pill.style.display = 'inline-flex';
      pill.textContent = `${qtd} un × ${pesoGrama.toFixed(2)} g/un = ${total.toFixed(3)} kg`;
    } else {
      pill.style.display = 'none';
    }
  }
  document.getElementById('qtd-un-edit').addEventListener('input', recalcularKg);
  document.getElementById('peso-padrao-edit').addEventListener('input', recalcularKg);

  // Render das paradas existentes (array + fallback legado single parada)
  const listaParadasEdit = document.getElementById('lista-paradas-edit');
  const motivoOptionsEdit = `
    <option value="">— Selecione o motivo —</option>
    ${motivosParada.map(m => {
      const cod  = escHtml(m.COD  || m.cod  || '');
      const desc = escHtml(m.DESCRICAO || m.descricao || m);
      return `<option value="${cod}" data-desc="${desc}">${cod} — ${desc}</option>`;
    }).join('')}
  `;

  function adicionarLinhaParadaEdit({ cod = '', inicio = '', fim = '' } = {}) {
    criarLinhaParada({
      listaEl:           listaParadasEdit,
      motivoOptionsHtml: motivoOptionsEdit,
      dados:             { cod_motivo: cod, inicio, fim },
      // Sem busca por motivo na tela de edicao (motivos estaticos cabem no scroll)
      comBusca:          false,
    });
  }

  // Popular com paradas existentes (prefere array; senao usa campos legados)
  if (Array.isArray(apt.paradas) && apt.paradas.length > 0) {
    // Passa o datetime completo — criarLinhaParada converte ISO -> datetime-local
    // e preserva a data real de cada parada, inclusive as multiplas (A4).
    apt.paradas.forEach(p => adicionarLinhaParadaEdit({
      cod: p.cod_motivo || '', inicio: p.inicio || '', fim: p.fim || '',
    }));
  } else if (hParada) {
    adicionarLinhaParadaEdit({ cod: codMotivo, inicio: hInicioParada, fim: hFimParada });
  }

  document.getElementById('btn-add-parada-edit').addEventListener('click', () => adicionarLinhaParadaEdit());

  // Cor/Variante: exibir campo "Qual a cor?" quando "Outros" estiver selecionado
  const selVarianteEdit = document.getElementById('sel-variante-edit');
  if (selVarianteEdit) {
    selVarianteEdit.addEventListener('change', () => {
      const mostrar = selVarianteEdit.value === 'OUTROS';
      const div = document.getElementById('campo-cor-outros-edit');
      if (div) div.style.display = mostrar ? 'block' : 'none';
    });
  }

  // Toggle parada
  document.getElementById('toggle-parada-edit').addEventListener('click', () => {
    const track = document.querySelector('#toggle-parada-edit .toggle-track');
    track.classList.toggle('ativo');
    track.classList.toggle('on-red');
    const ativo = track.classList.contains('ativo');
    document.getElementById('parada-campos-edit').style.display = ativo ? 'block' : 'none';
    if (ativo && listaParadasEdit.children.length === 0) {
      adicionarLinhaParadaEdit();
    }
  });

  // Toggle perdas
  document.getElementById('toggle-perdas-edit').addEventListener('click', () => {
    const track = document.querySelector('#toggle-perdas-edit .toggle-track');
    track.classList.toggle('ativo');
    track.classList.toggle('on-orange');
    document.getElementById('perdas-campos-edit').style.display =
      track.classList.contains('ativo') ? 'block' : 'none';
  });

  // Adicionar perda
  document.getElementById('btn-add-perda-edit').addEventListener('click', () => {
    const lista = document.getElementById('perdas-lista-edit');
    const idx   = lista.children.length;
    const row   = document.createElement('div');
    row.className = 'perda-row';
    row.dataset.idx = idx;
    row.innerHTML = `
      <select class="field-input perda-tipo-edit">
        ${opcoesHtmlTipoPerda()}
      </select>
      <input type="number" class="field-input perda-kg-edit" step="0.1" min="0" value="">
      <button class="btn-remover-perda" data-idx="${idx}">×</button>
    `;
    lista.appendChild(row);
    row.querySelector('.btn-remover-perda').addEventListener('click', () => row.remove());
  });

  // Remover perdas existentes
  document.querySelectorAll('.btn-remover-perda').forEach(btn => {
    btn.addEventListener('click', () => btn.closest('.perda-row').remove());
  });

  // Checkbox Encerrar OP — muda visual do botao salvar
  const chkEncerrarEdit = document.getElementById('chk-encerrar-edit');
  if (chkEncerrarEdit) {
    chkEncerrarEdit.addEventListener('change', () => {
      const btnSalvar = document.getElementById('btn-salvar-correcao');
      if (chkEncerrarEdit.checked) {
        btnSalvar.classList.replace('btn-primary', 'btn-amber');
        btnSalvar.textContent = 'Salvar correcao e encerrar OP';
      } else {
        btnSalvar.classList.replace('btn-amber', 'btn-primary');
        btnSalvar.textContent = 'Salvar correcao';
      }
    });
  }

  // Salvar correcao
  document.getElementById('btn-salvar-correcao').addEventListener('click', async () => {
    const btnSalvar = document.getElementById('btn-salvar-correcao');
    limparMsgs();

    // Coletar dados
    const chkEncerrar = document.getElementById('chk-encerrar-edit');
    const selVariante = document.getElementById('sel-variante-edit');
    const inpCorOutros = document.getElementById('inp-cor-outros-edit');
    let corVarianteDesc = '';
    if (selVariante && selVariante.value === 'OUTROS' && inpCorOutros) {
      corVarianteDesc = (inpCorOutros.value || '').trim();
    } else if (selVariante && selVariante.value && selVariante.value !== 'OUTROS') {
      corVarianteDesc = selVariante.value;
    }
    const novosDados = {
      unid_medida:    unidAtual,
      qtd_produzida:  parseFloat(document.getElementById('qtd-kg-edit').value) || 0,
      qtd_refugo_kg:  parseFloat(document.getElementById('refugo-edit').value) || 0,
      qtd_perda_mp_kg:parseFloat(document.getElementById('perda-mp-edit').value) || 0,
      houve_parada:   document.querySelector('#toggle-parada-edit .toggle-track').classList.contains('ativo'),
      cor_variante_desc: corVarianteDesc || null,
      cor_variante_cod:  corVarianteDesc ? (apt.cor_variante_cod || null) : null,
      // Se OP ja estava encerrada, mantem. Se tem checkbox e foi marcado, encerra agora.
      encerrou_op:    encerrou || (chkEncerrar && chkEncerrar.checked),
    };

    if (unidAtual === 'UN') {
      novosDados.qtd_produzida_un = parseInt(document.getElementById('qtd-un-edit').value) || 0;
      // Input em GRAMAS, storage em KG — converter antes de enviar.
      const pesoGrama = parseFloat(document.getElementById('peso-padrao-edit').value) || 0;
      novosDados.peso_padrao_un = pesoGrama > 0 ? pesoGrama / 1000 : 0;
      if (!novosDados.peso_padrao_un) {
        mostrarMsg('erro', 'Peso padrao e obrigatorio quando a unidade e UN');
        return;
      }
    }

    // Coletar paradas (podem ser multiplas). Campos legados (motivo_parada/
    // dt_*_parada) sao espelhados da primeira parada para compatibilidade.
    novosDados.paradas = [];
    if (novosDados.houve_parada) {
      const linhas = document.querySelectorAll('#lista-paradas-edit .parada-row');
      if (linhas.length === 0) {
        mostrarMsg('erro', 'Adicione ao menos uma parada ou desative o toggle');
        return;
      }
      // Paradas agora usam datetime-local — data explicita, sem +24h adhoc
      for (let i = 0; i < linhas.length; i++) {
        const row = linhas[i];
        const sel = row.querySelector('.parada-motivo');
        const iP  = row.querySelector('.parada-inicio').value;
        const fP  = row.querySelector('.parada-fim').value;
        if (!sel.value) { mostrarMsg('erro', `Selecione o motivo da parada #${i + 1}`); return; }
        if (!iP || !fP) { mostrarMsg('erro', `Informe data/hora de início e fim da parada #${i + 1}`); return; }
        const dI = new Date(iP);
        const dF = new Date(fP);
        if (isNaN(dI.getTime()) || isNaN(dF.getTime())) {
          mostrarMsg('erro', `Data inválida na parada #${i + 1}`); return;
        }
        if (dF.getTime() < dI.getTime()) {
          mostrarMsg('erro', `Fim anterior ao início na parada #${i + 1}`); return;
        }
        novosDados.paradas.push({
          cod_motivo: sel.value,
          motivo:     sel.options[sel.selectedIndex]?.dataset?.desc || sel.options[sel.selectedIndex]?.text || '',
          inicio:     dI.toISOString(),
          fim:        dF.toISOString(),
        });
      }
      const primeira = novosDados.paradas[0];
      novosDados.cod_motivo_parada = primeira.cod_motivo;
      novosDados.motivo_parada     = primeira.motivo;
      novosDados.dt_inicio_parada  = primeira.inicio;
      novosDados.dt_fim_parada     = primeira.fim;
    } else {
      novosDados.dt_inicio_parada = null;
      novosDados.dt_fim_parada    = null;
    }

    // Horários de produção e cálculo de horas trabalhadas.
    // Inputs agora sao datetime-local ("YYYY-MM-DDTHH:MM") — Date() interpreta
    // como hora local. OP atravessando dias funciona naturalmente.
    const inicioProdEdit = document.getElementById('inicio-prod-edit').value;
    const fimProdEdit    = document.getElementById('fim-prod-edit').value;
    if (inicioProdEdit && fimProdEdit) {
      const dIP = new Date(inicioProdEdit);
      const dFP = new Date(fimProdEdit);
      if (!isNaN(dIP.getTime()) && !isNaN(dFP.getTime())) {
        novosDados.dt_inicio_producao = dIP.toISOString();
        novosDados.dt_fim_producao    = dFP.toISOString();

        const minProd = Math.max(0, Math.round((dFP - dIP) / 60000));
        let minParada = 0;
        if (novosDados.houve_parada) {
          document.querySelectorAll('#lista-paradas-edit .parada-row').forEach(row => {
            const iPar = row.querySelector('.parada-inicio').value;
            const fPar = row.querySelector('.parada-fim').value;
            if (iPar && fPar) {
              const dA = new Date(iPar);
              const dB = new Date(fPar);
              if (!isNaN(dA.getTime()) && !isNaN(dB.getTime())) {
                minParada += Math.max(0, Math.round((dB - dA) / 60000));
              }
            }
          });
        }
        novosDados.horas_trabalhadas = parseFloat((Math.max(0, minProd - minParada) / 60).toFixed(2));
      }
    }

    // Coletar perdas
    const perdasAtivas = document.querySelector('#toggle-perdas-edit .toggle-track').classList.contains('ativo');
    const novasPerdas = [];
    if (perdasAtivas) {
      const rows = document.querySelectorAll('#perdas-lista-edit .perda-row');
      for (const row of rows) {
        const tipo = row.querySelector('.perda-tipo-edit').value;
        const kg   = parseFloat(row.querySelector('.perda-kg-edit').value);
        if (!tipo) { mostrarMsg('erro', 'Selecione o tipo de todas as perdas'); return; }
        if (!kg || kg <= 0) { mostrarMsg('erro', 'Informe a quantidade (kg) de todas as perdas'); return; }
        novasPerdas.push({ tipo_perda: tipo, qtd_kg: kg });
      }
    }
    novosDados.outras_perdas = novasPerdas;

    // Validacao
    if (!novosDados.qtd_produzida && novosDados.qtd_produzida !== 0) {
      mostrarMsg('erro', 'Quantidade produzida e obrigatoria');
      return;
    }

    // Segunda confirmacao — correcoes afetam dados ja enviados ao Drummer/Protheus
    const vaiEncerrar = novosDados.encerrou_op && !encerrou;
    const htmlResumo = `
      <p>Revise os novos valores antes de salvar:</p>
      <div class="modal-resumo">
        <dl>
          <dt>OP</dt>                    <dd>${op}</dd>
          <dt>Unidade</dt>               <dd>${escHtml(novosDados.unid_medida || '')}</dd>
          <dt>Quantidade</dt>            <dd>${novosDados.qtd_produzida} kg${novosDados.qtd_produzida_un ? ' (' + novosDados.qtd_produzida_un + ' un)' : ''}</dd>
          <dt>Perda Peça</dt>                <dd>${novosDados.qtd_refugo_kg} kg</dd>
          <dt>Perda BCV</dt>              <dd>${novosDados.qtd_perda_mp_kg} kg</dd>
          ${novosDados.houve_parada && (novosDados.paradas || []).length > 1
              ? `<dt>Paradas</dt><dd>${novosDados.paradas.length}: ${escHtml(novosDados.paradas.map(p => p.motivo || '—').join('; '))}</dd>`
              : (novosDados.houve_parada ? `<dt>Parada</dt><dd>${escHtml(novosDados.motivo_parada || '—')}</dd>` : '')}
        </dl>
      </div>
      ${vaiEncerrar ? '<div class="modal-alerta">⚠ Esta OP será ENCERRADA após salvar. A máquina voltará para SEM_OP.</div>' : ''}
      <p style="font-size:12px;color:var(--color-muted);">
        Os dados corrigidos serão reenviados automaticamente ao Drummer e ao Protheus.
      </p>
    `;

    const ok = await confirmar({
      titulo: vaiEncerrar ? 'Confirmar correção e encerramento' : 'Confirmar correção',
      html: htmlResumo,
      tipo: vaiEncerrar ? 'danger' : 'warning',
      textoOk: vaiEncerrar ? 'Salvar e encerrar OP' : 'Salvar correção',
      textoCancelar: 'Revisar',
    });
    if (!ok) return;

    btnSalvar.disabled = true;
    btnSalvar.textContent = 'Salvando...';

    const res = await corrigirApontamento(id, novosDados);
    if (res.success && (res.offline || res.queued)) {
      // Offline: a correcao so foi enfileirada — NAO foi confirmada pelo
      // servidor. Nao mostrar "sucesso" verde (A8).
      formDirty = false;  // dados ja capturados na fila — guarda nao deve avisar
      mostrarMsg('aviso', 'Sem conexão — correção enfileirada. Será enviada automaticamente quando a conexão voltar.');
      btnSalvar.textContent = 'Na fila';
      setTimeout(() => renderLista(container), 2200);
    } else if (res.success) {
      formDirty = false;  // correcao salva — guarda nao deve avisar
      mostrarMsg('sucesso', 'Apontamento corrigido com sucesso! Os dados serao reenviados ao Drummer e Protheus.');
      btnSalvar.textContent = 'Salvo!';
      setTimeout(() => renderLista(container), 2000);
    } else {
      mostrarMsg('erro', res.error || 'Erro ao salvar correcao');
      btnSalvar.disabled = false;
      btnSalvar.textContent = 'Salvar correcao';
    }
  });

  function mostrarMsg(tipo, texto) {
    limparMsgs();
    if (tipo === 'sucesso' || tipo === 'aviso') {
      const el = document.getElementById('msg-sucesso');
      const p  = el.querySelector('p');
      el.style.display = 'block';
      // 'aviso' (ex.: correcao apenas enfileirada offline) usa o amarelo base
      // da classe aviso-amarelo; 'sucesso' mantem o verde.
      if (tipo === 'aviso') {
        el.style.borderColor = '';
        el.style.background  = '';
        p.style.color        = '';
      } else {
        el.style.borderColor = '#86efac';
        el.style.background  = '#f0fdf4';
        p.style.color        = '#166534';
      }
      p.textContent = texto;
    } else {
      const el = document.getElementById('msg-erro');
      el.style.display = 'block';
      el.textContent = texto;
    }
    // Scroll to top to show message
    document.getElementById('screens').scrollTop = 0;
  }

  function limparMsgs() {
    document.getElementById('msg-sucesso').style.display = 'none';
    document.getElementById('msg-erro').style.display = 'none';
  }
}

// ---------------------------------------------------------------------------
// Carregar motivos de parada (mesma lógica de s3-apontamento.js)
// ---------------------------------------------------------------------------

async function carregarMotivosParada() {
  const res = await getMotivosParada();
  if (res.success && res.data?.length) return res.data;

  const cached = await lerTodoCache('cache-motivos');
  if (cached?.length) return cached;

  // Fallback hardcoded
  return [
    { COD: '1',  DESCRICAO: 'Regulagem' },
    { COD: '2',  DESCRICAO: 'Ajuste Refrigeração / Ajuste na Extração' },
    { COD: '3',  DESCRICAO: 'Aquecimento (Início de Produção)' },
    { COD: '4',  DESCRICAO: 'Reaquecimento (Reinício de Produção)' },
    { COD: '5',  DESCRICAO: 'Falta de Matéria Prima' },
    { COD: '6',  DESCRICAO: 'Falta de Operador' },
    { COD: '7',  DESCRICAO: 'Operador Faltou (Absenteísmo)' },
    { COD: '8',  DESCRICAO: 'Base do Funil Obstruída (Bola)' },
    { COD: '9',  DESCRICAO: 'Troca de Bico / Bico Frio / Bico Entupido' },
    { COD: '10', DESCRICAO: 'Organização e Limpeza' },
    { COD: '15', DESCRICAO: 'Galhos no Material' },
    { COD: '16', DESCRICAO: 'Troca de Matéria Prima / Repassar Material' },
    { COD: '17', DESCRICAO: 'Falta de Material Preparado' },
    { COD: '25', DESCRICAO: 'Manutenção Mecânica' },
    { COD: '26', DESCRICAO: 'Manutenção Elétrica' },
    { COD: '27', DESCRICAO: 'Falta de Ar Comprimido / Nitrogênio' },
    { COD: '28', DESCRICAO: 'Falta de Água (Motivo Interno)' },
    { COD: '29', DESCRICAO: 'Falta de Energia (Motivo Interno)' },
    { COD: '35', DESCRICAO: 'Intervenção para Melhoria do Processo' },
    { COD: '45', DESCRICAO: 'Manutenção de Molde' },
    { COD: '55', DESCRICAO: 'Aguardando Liberação do Produto' },
    { COD: '65', DESCRICAO: 'Reunião' },
    { COD: '66', DESCRICAO: 'Refeição / Revesamento' },
    { COD: '67', DESCRICAO: 'Falta de Água (Motivo Externo)' },
    { COD: '68', DESCRICAO: 'Falta de Energia (Motivo Externo)' },
    { COD: '69', DESCRICAO: 'Chuva Forte (Risco de Descarga Elétrica)' },
    { COD: '75', DESCRICAO: 'PPL - Parada para Polir e Limpar' },
    { COD: '76', DESCRICAO: 'Racionamento' },
    { COD: '77', DESCRICAO: 'Falta Programada' },
    { COD: '78', DESCRICAO: 'Manutenção Preventiva' },
    { COD: '79', DESCRICAO: 'Tryout' },
    { COD: '85', DESCRICAO: 'Regulagem Inicial' },
    { COD: '95', DESCRICAO: 'Troca Molde' },
    { COD: '96', DESCRICAO: 'Troca de Cor' },
  ];
}

// ---------------------------------------------------------------------------
// Modal: Apontamento retroativo (admin/editor)
// ---------------------------------------------------------------------------
// Registra producao de um turno passado. Diferente do POST /apontamento
// normal: DT_APONTAMENTO = data informada, ORIGEM='RETROATIVO', exige
// justificativa. Backend cria OP_INICIADA retroativo se nao existir.

function abrirModalRetroativo(aoSalvar) {
  const existente = document.getElementById('modal-retroativo');
  if (existente) existente.remove();

  // Defaults: data = ontem; hora derivada do turno na hora do submit.
  const ontem = new Date(); ontem.setDate(ontem.getDate() - 1);
  const isoDate = (d) => {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  };

  const modal = document.createElement('div');
  modal.id = 'modal-retroativo';
  modal.className = 'app-modal-backdrop';
  modal.innerHTML = `
    <div class="app-modal" role="dialog" aria-modal="true" style="max-width:520px;">
      <div class="app-modal-header">
        <h3>+ Apontamento retroativo</h3>
      </div>
      <div class="app-modal-body">
        <p style="margin-top:0; font-size:13px; color:var(--color-muted);">
          Registra produção de um turno passado. Use só quando o operador não
          conseguiu apontar na hora. <strong>Sem reversão automática</strong> — confira
          os dados antes de gravar.
        </p>
        <div class="field"><label class="field-label">OP <span class="obrigatorio">*</span></label>
          <div id="ret-op-wrap" style="position:relative;">
            <input type="text" id="ret-op" class="field-input" placeholder="Digite ou escolha — ex: 067824" autocomplete="off">
            <div id="ret-ops-pop" class="ret-ops-pop" style="display:none;"></div>
          </div>
          <div style="font-size:12px; color:var(--color-muted); margin-top:4px;">
            Aceita <strong>qualquer OP</strong> — se não aparecer na lista, digite o número.
            A máquina é preenchida automaticamente quando a OP estiver na lista (editável).
          </div></div>
        <div class="field"><label class="field-label">Máquina <span class="obrigatorio">*</span></label>
          <input type="text" id="ret-maq" class="field-input" placeholder="Ex: INJ010"></div>
        <div style="display:flex; gap:8px;">
          <div class="field" style="flex:1;"><label class="field-label">Operador</label>
            <input type="text" id="ret-op-cod" class="field-input" placeholder="(opcional)"></div>
          <div class="field" style="width:90px;"><label class="field-label">Turno <span class="obrigatorio">*</span></label>
            <select id="ret-turno" class="field-input">
              <option value="A">A</option><option value="B">B</option>
              <option value="C">C</option><option value="D">D</option></select></div>
        </div>
        <div class="field"><label class="field-label">Data <span class="obrigatorio">*</span></label>
          <input type="date" id="ret-dt" class="field-input" value="${isoDate(ontem)}" max="${isoDate(new Date())}">
          <div style="font-size:12px; color:var(--color-muted); margin-top:4px;">
            Dia em que a produção realmente aconteceu. O horário é derivado do turno (A/C → meio do diurno; B/D → meio do noturno).
          </div></div>
        <div style="display:flex; gap:8px;">
          <div class="field" style="flex:1;"><label class="field-label">Qtd produzida (un) <span class="obrigatorio">*</span></label>
            <input type="number" min="0" step="1" id="ret-qtd-un" class="field-input"></div>
          <div class="field" style="flex:1;"><label class="field-label">Peso padrão (kg/un)</label>
            <input type="number" min="0" step="0.001" id="ret-peso" class="field-input" placeholder="0"></div>
        </div>
        <div style="display:flex; gap:8px;">
          <div class="field" style="flex:1;"><label class="field-label">Refugo (kg)</label>
            <input type="number" min="0" step="0.01" id="ret-refugo" class="field-input" value="0"></div>
          <div class="field" style="flex:1;"><label class="field-label">Perda BCV (kg)</label>
            <input type="number" min="0" step="0.01" id="ret-perda" class="field-input" value="0"></div>
        </div>
        <div class="field"><label class="field-label">Justificativa <span class="obrigatorio">*</span></label>
          <textarea id="ret-just" class="field-input" rows="3" placeholder="Mínimo 10 caracteres — explique por que está apontando retroativamente"></textarea>
          <div style="font-size:12px; color:var(--color-muted); margin-top:4px;">
            Ficará registrado em AP3010 como <code>TIPO_EDICAO=RETROATIVO</code>.
          </div></div>
        <label style="display:flex; align-items:center; gap:8px; font-size:14px; margin-top:8px;">
          <input type="checkbox" id="ret-iniciar"> Marcar início da OP retroativamente
        </label>
        <div class="field" id="ret-dtini-wrap" style="display:none; margin-top:8px;">
          <label class="field-label">Início da OP (data + hora) <span class="obrigatorio">*</span></label>
          <input type="datetime-local" id="ret-dt-inicio" class="field-input">
          <div style="font-size:12px; color:var(--color-muted); margin-top:4px;">
            Momento em que a OP realmente começou a rodar — usado pra calcular as
            horas efetivas. Útil quando o encarregado iniciou a OP
            <strong>atrasado ou adiantado</strong> e precisa corrigir o horário,
            ou pra <strong>iniciar uma OP nova</strong> que ainda não tinha sido
            apontada. Deve ser anterior ao apontamento.
          </div>
        </div>
        <label style="display:flex; align-items:center; gap:8px; font-size:14px; margin-top:8px;">
          <input type="checkbox" id="ret-encerrar"> Encerrar a OP
        </label>
        <div class="field" id="ret-dtenc-wrap" style="display:none; margin-top:8px;">
          <label class="field-label">Horário do encerramento <span class="obrigatorio">*</span></label>
          <input type="datetime-local" id="ret-dt-encerramento" class="field-input">
          <div style="font-size:12px; color:var(--color-muted); margin-top:4px;">
            Momento em que a OP foi encerrada — esse horário substitui a "Data" + turno
            como referência do apontamento e do evento OP_ENCERRADA.
          </div>
        </div>
        <div id="ret-erro" class="error-box" style="display:none; margin-top:12px;"></div>
      </div>
      <div class="app-modal-footer">
        <button class="btn btn-secondary" id="ret-cancelar">Cancelar</button>
        <button class="btn btn-primary"   id="ret-gravar">Gravar retroativo</button>
      </div>
    </div>`;
  document.body.appendChild(modal);

  // Carrega OPs abertas em background e monta o dropdown customizado.
  const opsMap   = new Map();
  let   opsLista = [];
  const inpOp  = document.getElementById('ret-op');
  const inpMaq = document.getElementById('ret-maq');
  const popOp  = document.getElementById('ret-ops-pop');

  function renderPop(filtro) {
    const termo = String(filtro || '').trim().toLowerCase();
    const itens = !termo
      ? opsLista.slice(0, 30)
      : opsLista.filter(o =>
          String(o.op_numero).toLowerCase().includes(termo) ||
          String(o.maquina_cod || '').toLowerCase().includes(termo) ||
          String(o.produto || '').toLowerCase().includes(termo)
        ).slice(0, 30);
    if (!itens.length) {
      popOp.innerHTML = `<div class="ret-ops-empty">Nenhuma OP encontrada</div>`;
      popOp.style.display = 'block';
      return;
    }
    popOp.innerHTML = itens.map(op => `
      <button type="button" class="ret-ops-item" data-op="${escHtml(op.op_numero)}">
        <span class="ret-ops-num">${escHtml(op.op_numero)}</span>
        <span class="ret-ops-meta">${escHtml(op.maquina_cod || '?')} — ${escHtml(op.produto || '')}</span>
      </button>
    `).join('');
    popOp.style.display = 'block';
  }

  popOp.addEventListener('click', (e) => {
    const btn = e.target.closest('.ret-ops-item');
    if (!btn) return;
    inpOp.value = btn.dataset.op;
    popOp.style.display = 'none';
    const op = opsMap.get(String(inpOp.value).trim());
    if (op && op.maquina_cod && !inpMaq.value.trim()) inpMaq.value = op.maquina_cod;
  });

  inpOp.addEventListener('focus', () => renderPop(inpOp.value));
  inpOp.addEventListener('input', () => renderPop(inpOp.value));
  inpOp.addEventListener('blur', () => {
    // delay pra clique no item conseguir disparar antes de fechar
    setTimeout(() => { popOp.style.display = 'none'; }, 150);
  });

  (async () => {
    try {
      const res = await getOpsAbertas();
      if (!res.success) return;
      opsLista = res.data || [];
      for (const op of opsLista) opsMap.set(String(op.op_numero).trim(), op);
      if (document.activeElement === inpOp) renderPop(inpOp.value);
    } catch (_) { /* sem autocomplete, segue digitando */ }
  })();

  const fechar = () => modal.remove();
  document.getElementById('ret-cancelar').addEventListener('click', fechar);
  modal.addEventListener('click', (e) => { if (e.target === modal) fechar(); });

  // Mostra/esconde campo de inicio quando "encerrar" e marcado.
  const chkEnc  = document.getElementById('ret-encerrar');
  const chkIni  = document.getElementById('ret-iniciar');
  const wrapIni = document.getElementById('ret-dtini-wrap');
  const wrapEnc = document.getElementById('ret-dtenc-wrap');
  chkIni.addEventListener('change', () => {
    wrapIni.style.display = chkIni.checked ? 'block' : 'none';
  });
  chkEnc.addEventListener('change', () => {
    wrapEnc.style.display = chkEnc.checked ? 'block' : 'none';
  });

  const erroBox = document.getElementById('ret-erro');
  const mostrarErro = (msg) => {
    erroBox.textContent = msg;
    erroBox.style.display = msg ? 'block' : 'none';
  };

  document.getElementById('ret-gravar').addEventListener('click', async () => {
    mostrarErro('');
    const op   = document.getElementById('ret-op').value.trim();
    const maq  = document.getElementById('ret-maq').value.trim();
    const opCod = document.getElementById('ret-op-cod').value.trim();
    const turno = document.getElementById('ret-turno').value;
    const dtDiaApt = document.getElementById('ret-dt').value;  // YYYY-MM-DD
    const qtdUn = parseFloat(document.getElementById('ret-qtd-un').value);
    const peso  = parseFloat(document.getElementById('ret-peso').value) || 0;
    const refugo = parseFloat(document.getElementById('ret-refugo').value) || 0;
    const perdaMp = parseFloat(document.getElementById('ret-perda').value) || 0;
    const just = document.getElementById('ret-just').value.trim();
    const enc  = document.getElementById('ret-encerrar').checked;

    if (!op)     return mostrarErro('Informe a OP.');
    if (!maq)    return mostrarErro('Informe a maquina.');
    if (!enc && !dtDiaApt) return mostrarErro('Informe a data.');
    if (!(qtdUn > 0)) return mostrarErro('Quantidade produzida deve ser maior que zero.');
    if (just.length < 10) return mostrarErro('Justificativa minima 10 caracteres.');

    // Quando encerra OP, o usuario informa o horario exato do encerramento —
    // dt_evento_real = esse momento. Senao, deriva do turno (meio da janela
    // nominal): A/C diurno 07-19 -> 13h; B/D noturno 19-07 -> 01h do dia seguinte.
    function parseDtLocal(v) {
      const m = String(v || '').match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
      if (!m) return null;
      const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], 0);
      return isNaN(d.getTime()) ? null : d;
    }

    let dtApt;
    if (enc) {
      const dtEncInput = document.getElementById('ret-dt-encerramento').value;
      if (!dtEncInput) return mostrarErro('Informe o horario do encerramento da OP.');
      dtApt = parseDtLocal(dtEncInput);
      if (!dtApt) return mostrarErro('Horario de encerramento invalido.');
    } else {
      const diurno = (turno === 'A' || turno === 'C');
      const partes = dtDiaApt.split('-').map(Number);
      dtApt = new Date(partes[0], partes[1] - 1, partes[2], diurno ? 13 : 1, 0, 0);
      if (!diurno) dtApt.setDate(dtApt.getDate() + 1);  // noturno -> 01h do dia seguinte
    }
    if (dtApt.getTime() > Date.now()) return mostrarErro('A data/hora informada cai no futuro.');
    const dtIso = dtApt.toISOString();

    const marcarIni = document.getElementById('ret-iniciar').checked;
    let dtInicioIso = null;
    if (marcarIni) {
      const dtIniInput = document.getElementById('ret-dt-inicio').value;
      if (!dtIniInput) return mostrarErro('Informe o inicio retroativo da OP.');
      const dtIni = parseDtLocal(dtIniInput);
      if (!dtIni) return mostrarErro('Inicio da OP invalido.');
      if (dtIni.getTime() >= dtApt.getTime()) {
        return mostrarErro('Inicio da OP deve ser anterior ao apontamento/encerramento.');
      }
      dtInicioIso = dtIni.toISOString();
    }

    const qtdKg = peso > 0 ? Math.round(qtdUn * peso * 1000) / 1000 : 0;
    const btnGravar = document.getElementById('ret-gravar');
    btnGravar.disabled = true; btnGravar.textContent = 'Gravando...';

    const res = await criarApontamentoRetroativo({
      op_numero: op, maquina_cod: maq, operador_cod: opCod, turno,
      unid_medida: 'UN', qtd_produzida: qtdKg, qtd_produzida_un: qtdUn,
      peso_padrao_un: peso, qtd_refugo_kg: refugo, qtd_perda_mp_kg: perdaMp,
      encerrou_op: enc, dt_evento_real: dtIso,
      dt_inicio_op: dtInicioIso, justificativa: just,
    });

    btnGravar.disabled = false; btnGravar.textContent = 'Gravar retroativo';
    if (!res.success) return mostrarErro(res.error || 'Erro ao gravar.');
    fechar();
    if (typeof aoSalvar === 'function') aoSalvar();
  });
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export async function render(container) {
  await renderLista(container);
}
