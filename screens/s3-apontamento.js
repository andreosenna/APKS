/**
 * s3-apontamento.js — Tela 3: Formulário de apontamento de produção.
 * Implementa todos os campos conforme spec do CLAUDE.md.
 * - Motivos de parada: carregados do backend (tabela AP8010)
 * - Parada: inclui horário de início e fim
 * - Variante de cor: vem do estado (selecionada na Tela 2)
 */

import { enviarApontamento, getMotivosParada } from '../api.js';
import { lerTodoCache } from '../db.js';
import { estado, irParaTela, atualizarBadgeTurno, registrarGuardaNavegacao } from '../app.js';
import { carregarPerfil }                      from '../perfil.js';
import { confirmar }                           from '../modal.js';
import { validar as validarPayload }           from '../shared/validar-apontamento.mjs';
import { opcoesHtmlTipoPerda }                 from '../shared/tipos-perda.js';
import { criarLinhaParada }                    from '../shared/parada-row.js';
import { escHtml } from '../utils.js';

// Mapa em memória: OP → peso padrão da sessão
const pesoPadraoSessao = new Map();

// Normaliza input decimal PT-BR (virgula) -> numero. "2,5" -> 2.5
function parseNum(v) {
  if (v == null || v === '') return NaN;
  return parseFloat(String(v).replace(',', '.'));
}

export async function render(container) {
  const op      = estado.opSelecionada;
  const maquina = estado.maquinaSelecionada;
  const ct      = estado.centroTrabalho;

  // Guard (A6): esta tela depende de OP + maquina selecionadas. Se o estado foi
  // limpo (boot offline, sessao reiniciada, navegacao direta) volta pra tela
  // anterior em vez de quebrar com tela branca.
  if (!op || !maquina) {
    irParaTela(maquina ? 2 : 1);
    return;
  }

  // Buscar motivos de parada (API → cache → fallback hardcoded)
  const motivosParada = await carregarMotivosParada(ct?.TIPO || null);

  container.innerHTML = `
    <div class="screen-topbar">
      <div class="screen-topbar-left">
        <button class="btn-voltar-padrao" id="btn-voltar-tela">← Voltar</button>
        <h2>Apontamento</h2>
      </div>
    </div>
    <!-- Resumo da OP (read-only) -->
    <div class="resumo-op">
      <div class="op-produto">${escHtml(op.produto)}</div>
      <div class="op-detalhe">OP: <strong>${escHtml(op.op_numero)}</strong> | Máquina: <strong>${escHtml(maquina.COD)}</strong></div>
      <div class="op-detalhe">Planejado: <strong>${formatarPlanejado(op)}</strong> | Saldo: <strong id="saldo-op">${formatarSaldo(op)}</strong></div>
      ${op.taxa_producao_h > 0 ? `<div class="op-detalhe">Taxa esperada: <strong>${op.taxa_producao_h} pç/h</strong>${op.tempo_setup_h > 0 ? ` | Setup: <strong>${op.tempo_setup_h}h</strong>` : ''}</div>` : ''}
      ${estado.opDivergiu
        ? '<div class="op-badges"><span class="badge badge-warning">Fora da prioridade do PCP</span></div>'
        : ''}
    </div>

    <!-- Cor / Variante (opcional) -->
    <div class="field">
      <label class="field-label">Cor / Variante</label>
      <select id="sel-variante" class="field-input">
        <option value="">— Sem variante / cor única —</option>
        <option value="Azul">Azul</option>
        <option value="Vermelho">Vermelho</option>
        <option value="OUTROS">Outros</option>
      </select>
    </div>
    <div id="campo-cor-outros" style="display:none;">
      <div class="field">
        <label class="field-label">Qual a cor? <span class="obrigatorio">*</span></label>
        <input type="text" id="inp-cor-outros" class="field-input" placeholder="Ex: Verde, Preto...">
        <div class="field-error-msg">Informe a cor</div>
      </div>
    </div>

    <!-- Peso padrão (apontamento sempre em unidades) -->
    <div id="secao-peso-padrao" style="display:block;">
      <div class="field">
        <label class="field-label">Peso padrão desta OP (g/un) <span class="obrigatorio">*</span></label>
        <input type="text" id="inp-peso-padrao" class="field-input"
               placeholder="0,00" inputmode="decimal" autocomplete="off">
        <div class="field-error-msg">Informe o peso padrão</div>
        <div id="aviso-peso-divergente" style="display:none;" class="aviso-amarelo aviso-peso">
          ⚠ Peso <span id="aviso-peso-diff"></span>% diferente do cadastro (<span id="aviso-peso-cadastro"></span> g/un)
        </div>
      </div>

      <button class="expansivel-toggle" id="btn-calc-media">▶ Calcular pela média de 3 pesagens</button>
      <div class="expansivel-conteudo" id="calc-pesagens">
        <div class="pesagem-grid">
          <input type="number" id="p1" class="field-input" placeholder="Pesagem 1 (g)" step="0.01" min="0">
          <input type="number" id="p2" class="field-input" placeholder="Pesagem 2 (g)" step="0.01" min="0">
          <input type="number" id="p3" class="field-input" placeholder="Pesagem 3 (g)" step="0.01" min="0">
        </div>
        <div id="media-resultado" class="media-resultado" style="display:none;"></div>
        <button id="btn-usar-media" class="btn btn-secondary btn-sm" style="display:none;">Usar esta média</button>
      </div>

      <div class="section-divider"></div>
    </div>

    <!-- Período de produção — OPCIONAL. Por padrão o apontamento usa a hora do
         envio; o operador só abre esta seção se quiser ajustar início/fim. -->
    <button type="button" class="expansivel-toggle" id="toggle-ajustar-horario">▶ Ajustar horário de produção (avançado)</button>
    <div class="expansivel-conteudo" id="secao-horario">
      <div class="field-row">
        <div class="field">
          <label class="field-label">Início da produção</label>
          <input type="datetime-local" id="inp-inicio-prod" class="field-input">
          <div class="field-error-msg">Informe início e fim, ou deixe ambos vazios</div>
        </div>
        <div class="field">
          <label class="field-label">Fim da produção</label>
          <input type="datetime-local" id="inp-fim-prod" class="field-input">
          <div class="field-error-msg">Informe início e fim, ou deixe ambos vazios</div>
        </div>
      </div>
      <div id="pill-horas" style="display:none; margin-bottom:12px;"></div>
    </div>
    <div class="section-divider"></div>

    <!-- Quantidade produzida -->
    <div class="field">
      <label class="field-label" id="lbl-qtd">Quantidade produzida (unidades) <span class="obrigatorio">*</span></label>
      <input type="number" id="inp-qtd" class="field-input" placeholder="0" step="1" min="0" inputmode="numeric">
      <div class="field-error-msg">Informe a quantidade produzida</div>
      <div id="pill-calc" style="display:none;"></div>
    </div>

    <!-- Refugo e Perda MP (lado a lado, sempre KG) -->
    <div class="field-row">
      <div class="field">
        <label class="field-label">Perda Peça (kg) <span class="obrigatorio">*</span></label>
        <input type="number" id="inp-refugo" class="field-input" placeholder="0" step="0.001" min="0">
        <div class="field-error-msg">Informe o refugo (0 se não houver)</div>
      </div>
      <div class="field">
        <label class="field-label">Perda BCV (kg) <span class="obrigatorio">*</span></label>
        <input type="number" id="inp-perda-mp" class="field-input" placeholder="0" step="0.001" min="0">
        <div class="field-error-msg">Informe a perda MP (0 se não houver)</div>
      </div>
    </div>

    <!-- Outras perdas (toggle laranja) -->
    <div class="section-divider"></div>
    <div class="toggle-row" id="toggle-outras-perdas-row">
      <span class="toggle-label">Outras perdas</span>
      <div class="toggle-track" id="track-outras-perdas">
        <div class="toggle-thumb"></div>
      </div>
    </div>
    <div id="secao-outras-perdas" style="display:none;">
      <div id="lista-outras-perdas"></div>
      <button id="btn-add-perda" class="btn btn-secondary btn-sm" style="margin-top:4px;">+ Adicionar outra perda</button>
      <div class="section-divider"></div>
    </div>

    <!-- Parada de máquina (toggle vermelho) — agora aceita múltiplas paradas -->
    <div class="toggle-row" id="toggle-parada-row">
      <span class="toggle-label">Houve parada de máquina?</span>
      <div class="toggle-track" id="track-parada">
        <div class="toggle-thumb"></div>
      </div>
    </div>
    <div id="secao-parada" style="display:none;">
      <div id="lista-paradas"></div>
      <button id="btn-add-parada" class="btn btn-secondary btn-sm" style="margin-top:4px;">+ Adicionar parada</button>
      <div class="section-divider"></div>
    </div>

    <!-- Encerrar OP -->
    <div class="encerrar-op-box" id="box-encerrar">
      <label>
        <input type="checkbox" id="chk-encerrar">
        <div>
          <div class="encerrar-texto">Encerrar esta OP após o apontamento</div>
          <div class="encerrar-sub">A OP será sinalizada ao Drummer para fechamento</div>
        </div>
      </label>
    </div>

    <div id="barra-confirmar-apt" style="position:fixed; bottom:0; left:0; right:0; background:var(--color-bg); padding:10px 16px; border-top:2px solid var(--color-primary); z-index:100; box-shadow: 0 -2px 8px rgba(0,0,0,0.1);">
      <button id="btn-confirmar-apt" class="btn btn-primary btn-block" style="font-size:16px; height:48px;">Confirmar apontamento</button>
    </div>
    <div style="height:70px;"></div>
  `;

  // ----- Referências aos elementos -----
  const secaoPesoPadrao = document.getElementById('secao-peso-padrao');
  const inpPesoPadrao   = document.getElementById('inp-peso-padrao');
  const calcPesagens    = document.getElementById('calc-pesagens');
  const btnCalcMedia    = document.getElementById('btn-calc-media');
  const mediaResultado  = document.getElementById('media-resultado');
  const btnUsarMedia    = document.getElementById('btn-usar-media');
  const lblQtd          = document.getElementById('lbl-qtd');
  const inpQtd          = document.getElementById('inp-qtd');
  const pillCalc        = document.getElementById('pill-calc');
  const inpRefugo       = document.getElementById('inp-refugo');
  const inpPerdaMp      = document.getElementById('inp-perda-mp');
  const trackOutrasPerdas = document.getElementById('track-outras-perdas');
  const secaoOutrasPerdas = document.getElementById('secao-outras-perdas');
  const listaOutrasPerdas = document.getElementById('lista-outras-perdas');
  const btnAddPerda     = document.getElementById('btn-add-perda');
  const trackParada     = document.getElementById('track-parada');
  const secaoParada     = document.getElementById('secao-parada');
  const listaParadas    = document.getElementById('lista-paradas');
  const btnAddParada    = document.getElementById('btn-add-parada');

  // HTML das options de motivo — reusado em cada linha de parada
  const motivoOptionsHtml = `
    <option value="">— Selecione o motivo —</option>
    ${motivosParada.map(m => {
      const cod  = m.COD  || m.cod  || '';
      const desc = m.DESCRICAO || m.descricao || m;
      return `<option value="${escHtml(cod)}" data-desc="${escHtml(desc)}" data-busca="${escHtml((cod + ' ' + desc).toLowerCase())}">${escHtml(cod)} — ${escHtml(desc)}</option>`;
    }).join('')}
  `;

  function adicionarLinhaParada({ cod = '', inicio = '', fim = '', autoInicio = false } = {}) {
    criarLinhaParada({
      listaEl:           listaParadas,
      motivoOptionsHtml,
      dados:             { cod_motivo: cod, inicio, fim },
      comBusca:          true,
      autoInicio,
      onChange:          atualizarPillHoras,
      onRemove:          atualizarPillHoras,
    });
  }

  btnAddParada.addEventListener('click', () => adicionarLinhaParada());

  const chkEncerrar     = document.getElementById('chk-encerrar');
  const btnConfirmar    = document.getElementById('btn-confirmar-apt');

  const inpInicioProd  = document.getElementById('inp-inicio-prod');
  const inpFimProd     = document.getElementById('inp-fim-prod');
  const pillHoras      = document.getElementById('pill-horas');
  const secaoHorario        = document.getElementById('secao-horario');
  const toggleAjustarHorario = document.getElementById('toggle-ajustar-horario');

  // O saldo de op.restante_un ja vem ajustado pelo backend (Fase 8 — desconta a
  // foto AP4_QTDINI + AP1010 local). Nao subtrair de novo no front: causaria
  // dupla deducao e saldo zerado quando ainda ha producao a fazer.

  // Esconder botão fixo quando time picker ou select abre (mobile)
  const barraConfirmar = document.getElementById('barra-confirmar-apt');
  document.querySelectorAll('input[type=time], select').forEach(el => {
    el.addEventListener('focus', () => { if (barraConfirmar) barraConfirmar.style.display = 'none'; });
    el.addEventListener('blur',  () => { if (barraConfirmar) barraConfirmar.style.display = ''; });
  });

  // Estado local
  const unidMedida   = 'UN';
  let outrasPerdas   = [];
  let houveParada    = false;
  let outrasPerdasOn = false;
  let ajustarHorarioOn = false;  // secao de horario de producao (opcional)

  const selVariante     = document.getElementById('sel-variante');
  const campoCorOutros  = document.getElementById('campo-cor-outros');
  const inpCorOutros    = document.getElementById('inp-cor-outros');

  selVariante.addEventListener('change', () => {
    campoCorOutros.style.display = selVariante.value === 'OUTROS' ? 'block' : 'none';
    if (selVariante.value !== 'OUTROS') inpCorOutros.value = '';
  });

  // Peso padrao inicia zerado a cada apontamento (operador pesa 3 unidades ou digita).

  // ----- Segmented control de unidade -----
  // Unidade de medida fixa em UN — listener removido

  // ----- Cálculo ao vivo (modo UN) -----
  // Peso padrao e pesagens sao digitados em GRAMAS pelo operador;
  // convertemos para KG apenas no momento de montar o payload.
  function atualizarPillCalc() {
    // Mudar quantidade/peso invalida um erro de validacao ja exibido — limpa.
    exibirErroGeral('');
    if (unidMedida !== 'UN') { pillCalc.style.display = 'none'; return; }
    const qtdUn     = Math.round(parseFloat(inpQtd.value) || 0);
    const pesoGrama = parseNum(inpPesoPadrao.value) || 0;
    if (qtdUn > 0 && pesoGrama > 0) {
      const totalKg = (qtdUn * pesoGrama) / 1000;
      pillCalc.innerHTML = `<span class="calc-pill">${qtdUn} un × ${pesoGrama.toFixed(2).replace('.', ',')} g/un = <strong>${totalKg.toFixed(3).replace('.', ',')} kg</strong></span>`;
      pillCalc.style.display = 'block';
    } else {
      pillCalc.style.display = 'none';
    }
  }

  inpQtd.addEventListener('input', () => { atualizarPillCalc(); atualizarPillHoras(); });

  // ----- Cálculo de horas trabalhadas e PH -----
  // Inputs agora sao datetime-local (ISO: "YYYY-MM-DDTHH:MM"), parseaveis
  // por Date(). Como a data e explicita, OPs que atravessam o dia funcionam
  // naturalmente (nao precisa mais do +24h).
  function calcularMinutos(inicio, fim) {
    if (!inicio || !fim) return 0;
    const ms = new Date(fim).getTime() - new Date(inicio).getTime();
    if (!Number.isFinite(ms) || ms < 0) return 0;
    return Math.round(ms / 60000);
  }

  function somarMinutosParadas() {
    if (!houveParada) return 0;
    let total = 0;
    document.querySelectorAll('#lista-paradas .parada-row').forEach(row => {
      const ini = row.querySelector('.parada-inicio').value;
      const fim = row.querySelector('.parada-fim').value;
      if (ini && fim) total += calcularMinutos(ini, fim);
    });
    return total;
  }

  function atualizarPillHoras() {
    const inicioProd = inpInicioProd.value;
    const fimProd    = inpFimProd.value;
    if (!inicioProd || !fimProd) { pillHoras.style.display = 'none'; return; }

    const minProd   = calcularMinutos(inicioProd, fimProd);
    const minParada = somarMinutosParadas();
    const minTrabalhados = Math.max(0, minProd - minParada);
    const horasTrab = minTrabalhados / 60;
    // PH so vale com >=10 min de producao (abaixo disso distorce demais)
    const MIN_MIN_PARA_PH = 10;

    const qtdUn = Math.round(parseFloat(inpQtd.value) || 0);
    const ph = (minTrabalhados >= MIN_MIN_PARA_PH && qtdUn > 0) ? (qtdUn / horasTrab) : 0;

    const hStr = Math.floor(horasTrab) + 'h' + String(minTrabalhados % 60).padStart(2, '0');
    let html = `<span class="calc-pill">Tempo: <strong>${hStr}</strong>`;
    if (minParada > 0) html += ` (${Math.floor(minParada/60)}h${String(minParada%60).padStart(2,'0')} parada descontada)`;
    if (ph > 0) html += ` | PH: <strong>${Math.round(ph)} un/h</strong>`;
    else if (minTrabalhados > 0 && minTrabalhados < MIN_MIN_PARA_PH && qtdUn > 0) html += ` | PH: — (curto demais)`;

    // Produção esperada pela taxa do roteiro (recursos-validos CSV).
    // Mostra comparação real vs esperado quando ambos disponíveis.
    const taxaH = parseFloat(op.taxa_producao_h) || 0;
    if (taxaH > 0 && horasTrab > 0) {
      const esperado  = Math.round(taxaH * horasTrab);
      html += ` | Esperado: <strong>${esperado} un</strong>`;
      if (qtdUn > 0) {
        const efic = Math.round((qtdUn / esperado) * 100);
        const cor = efic >= 85 ? '#16a34a' : (efic >= 60 ? '#d97706' : '#dc2626');
        html += ` (<span style="color:${cor};font-weight:600;">${efic}%</span>)`;
      }
    }

    html += '</span>';

    pillHoras.innerHTML = html;
    pillHoras.style.display = 'block';
  }

  inpInicioProd.addEventListener('change', atualizarPillHoras);
  inpFimProd.addEventListener('change', atualizarPillHoras);

  // Toggle "Ajustar horário": expande/recolhe a seção de início/fim. Recolhido
  // (padrão), o apontamento omite os horários e o backend usa a hora do envio.
  toggleAjustarHorario.addEventListener('click', () => {
    ajustarHorarioOn = secaoHorario.classList.toggle('aberto');
    toggleAjustarHorario.textContent =
      (ajustarHorarioOn ? '▼' : '▶') + ' Ajustar horário de produção (avançado)';
    if (!ajustarHorarioOn) {
      inpInicioProd.value = '';
      inpFimProd.value = '';
      pillHoras.style.display = 'none';
    }
  });
  const avisoPesoDivergente = document.getElementById('aviso-peso-divergente');
  const avisoPesoDiff       = document.getElementById('aviso-peso-diff');
  const avisoPesoCadastro   = document.getElementById('aviso-peso-cadastro');

  inpPesoPadrao.addEventListener('input', () => {
    // Operador digita em GRAMAS. Storage e op.peso_padrao_un sao em KG.
    const vGrama = parseNum(inpPesoPadrao.value);
    if (vGrama > 0) pesoPadraoSessao.set(op.op_numero, vGrama);

    // Verificar divergência em relação ao peso do cadastro do item (b1_peso do Protheus, em kg).
    // Converte cadastro para gramas para comparar na mesma unidade.
    const pesoCadastroKg    = parseFloat(op.peso_padrao_un);
    const pesoCadastroGrama = pesoCadastroKg > 0 ? pesoCadastroKg * 1000 : 0;
    if (vGrama > 0 && pesoCadastroGrama > 0) {
      const diffPct = Math.abs((vGrama - pesoCadastroGrama) / pesoCadastroGrama) * 100;
      if (diffPct >= 15) {
        avisoPesoDiff.textContent     = diffPct.toFixed(1).replace('.', ',');
        avisoPesoCadastro.textContent = pesoCadastroGrama.toFixed(2).replace('.', ',');
        avisoPesoDivergente.style.display = 'block';
      } else {
        avisoPesoDivergente.style.display = 'none';
      }
    } else {
      avisoPesoDivergente.style.display = 'none';
    }

    atualizarPillCalc();
  });

  // ----- Cálculo de média de pesagens -----
  btnCalcMedia.addEventListener('click', () => {
    const aberto = calcPesagens.classList.toggle('aberto');
    btnCalcMedia.textContent = (aberto ? '▼' : '▶') + ' Calcular pela média de 3 pesagens';
  });

  // Pesagens tambem sao digitadas em GRAMAS (consistente com o peso padrao).
  ['p1','p2','p3'].forEach(id => {
    document.getElementById(id).addEventListener('input', () => {
      const v1 = parseFloat(document.getElementById('p1').value);
      const v2 = parseFloat(document.getElementById('p2').value);
      const v3 = parseFloat(document.getElementById('p3').value);
      if (!isNaN(v1) && !isNaN(v2) && !isNaN(v3)) {
        const media = (v1 + v2 + v3) / 3;
        mediaResultado.textContent  = `Média: ${media.toFixed(2)} g/un`;
        mediaResultado.style.display = 'block';
        btnUsarMedia.style.display   = 'inline-flex';
        btnUsarMedia.dataset.media   = media.toFixed(2);
      } else {
        mediaResultado.style.display = 'none';
        btnUsarMedia.style.display   = 'none';
      }
    });
  });

  btnUsarMedia.addEventListener('click', () => {
    const media = parseFloat(btnUsarMedia.dataset.media);
    inpPesoPadrao.value = media.toFixed(2);
    pesoPadraoSessao.set(op.op_numero, media);
    calcPesagens.classList.remove('aberto');
    btnCalcMedia.textContent = '▶ Calcular pela média de 3 pesagens';
    // Dispara o evento input para recalcular divergencia de peso (15%) e pill
    inpPesoPadrao.dispatchEvent(new Event('input', { bubbles: true }));
  });

  // ----- Toggle outras perdas -----
  document.getElementById('toggle-outras-perdas-row').addEventListener('click', () => {
    outrasPerdasOn = !outrasPerdasOn;
    trackOutrasPerdas.classList.toggle('ativo', outrasPerdasOn);
    trackOutrasPerdas.classList.toggle('on-orange', outrasPerdasOn);
    secaoOutrasPerdas.style.display = outrasPerdasOn ? 'block' : 'none';
  });

  btnAddPerda.addEventListener('click', () => adicionarLinhaPerda());

  function adicionarLinhaPerda(tipo = '', qtd = '') {
    const id  = Date.now();
    const row = document.createElement('div');
    row.className = 'perda-row';
    row.id = `perda-row-${id}`;
    row.innerHTML = `
      <select class="field-input perda-tipo" data-id="${id}">
        ${opcoesHtmlTipoPerda(tipo)}
      </select>
      <input type="number" class="field-input perda-qtd" data-id="${id}"
             placeholder="kg" step="0.001" min="0.001" value="${escHtml(String(qtd))}">
      <button class="btn-remover-perda" data-id="${id}">×</button>
    `;
    listaOutrasPerdas.appendChild(row);
    row.querySelector('.btn-remover-perda').addEventListener('click', () => row.remove());
  }

  // ----- Toggle parada -----
  document.getElementById('toggle-parada-row').addEventListener('click', () => {
    houveParada = !houveParada;
    trackParada.classList.toggle('ativo',  houveParada);
    trackParada.classList.toggle('on-red', houveParada);
    secaoParada.style.display = houveParada ? 'block' : 'none';

    // Ao ativar, adiciona a primeira parada ja com inicio = agora.
    if (houveParada && listaParadas.children.length === 0) {
      adicionarLinhaParada({ autoInicio: true });
    }
    atualizarPillHoras();
  });

  // ----- Encerrar OP -----
  chkEncerrar.addEventListener('change', () => {
    if (chkEncerrar.checked) {
      btnConfirmar.classList.replace('btn-primary', 'btn-amber');
      btnConfirmar.textContent = 'Confirmar e encerrar OP';
    } else {
      btnConfirmar.classList.replace('btn-amber', 'btn-primary');
      btnConfirmar.textContent = 'Confirmar apontamento';
    }
  });

  // ----- Voltar (com confirmação se houver dados digitados) -----
  document.getElementById('btn-voltar-tela').addEventListener('click', async () => {
    if (temDadosDigitados()) {
      const ok = await confirmar({
        titulo: 'Sair sem apontar?',
        mensagem: 'Você tem dados preenchidos neste apontamento que ainda não foram enviados.',
        tipo: 'warning',
        textoOk: 'Descartar e voltar',
        textoCancelar: 'Continuar apontamento',
      });
      if (!ok) return;
    }
    irParaTela(2);
  });

  function temDadosDigitados() {
    const campos = [inpPesoPadrao, inpQtd, inpRefugo, inpPerdaMp, document.getElementById('p1'), document.getElementById('p2'), document.getElementById('p3'), inpCorOutros];
    for (const el of campos) {
      if (el && el.value !== '' && el.value !== null && el.value !== '0') return true;
    }
    if (houveParada || outrasPerdasOn || chkEncerrar.checked) return true;
    return false;
  }

  // Guarda de navegacao (A9): se o operador tocar Historico/Painel/Home/Sair no
  // meio do apontamento, o header pede confirmacao antes de descartar os dados.
  registrarGuardaNavegacao(temDadosDigitados);

  // ----- Submit -----
  btnConfirmar.addEventListener('click', async () => {
    if (!estado.turnoAberto) {
      await confirmar({
        titulo: 'Turno fechado',
        mensagem: 'Você precisa abrir um turno antes de registrar o apontamento.',
        tipo: 'warning', textoOk: 'Abrir turno', textoCancelar: '',
      });
      irParaTela('turno');
      return;
    }
    exibirErroGeral('');   // cada envio reavalia do zero — sem erro antigo na tela
    if (!validarFormulario()) return;

    const payload = montarPayload();

    // Validacao final (mesmas regras do backend)
    const val = validarPayload(payload);
    if (!val.ok) {
      exibirErroGeral(val.erros[0]);
      return;
    }

    // Modal de revisao: mostra resumo antes de enviar. Reduz erros de digitacao.
    const okRevisao = await confirmar({
      titulo: chkEncerrar.checked ? 'Confirmar e encerrar OP?' : 'Confirmar apontamento?',
      tipo:   chkEncerrar.checked ? 'warning' : 'info',
      textoOk: chkEncerrar.checked ? 'Sim, encerrar OP' : 'Sim, enviar',
      textoCancelar: 'Revisar',
      html: montarHtmlResumo(payload),
    });
    if (!okRevisao) return;

    btnConfirmar.disabled    = true;
    btnConfirmar.textContent = 'Enviando...';

    const resultado = await enviarApontamento(payload);

    if (!resultado.success && resultado.error === 'turno_nao_aberto') {
      estado.turnoAberto = null;
      atualizarBadgeTurno();
      await confirmar({
        titulo: 'Turno fechado',
        mensagem: 'Seu turno não está mais aberto. Abra um turno para registrar o apontamento.',
        tipo: 'warning', textoOk: 'Abrir turno', textoCancelar: '',
      });
      irParaTela('turno');
      return;
    }

    if (!resultado.success && !resultado.offline) {
      btnConfirmar.disabled    = false;
      btnConfirmar.textContent = chkEncerrar.checked ? 'Confirmar e encerrar OP' : 'Confirmar apontamento';
      exibirErroGeral(`Erro ao enviar apontamento: ${resultado.error}`);
      return;
    }

    exibirConfirmacao(resultado.offline, chkEncerrar.checked);
  });

  // Monta o HTML do modal de revisao pre-envio
  function montarHtmlResumo(p) {
    const fmt = (n, d = 2) => Number(n).toLocaleString('pt-BR', { maximumFractionDigits: d });
    const linhas = [
      `<strong>${escHtml(op.produto)}</strong>`,
      `OP <strong>${escHtml(p.op_numero)}</strong> · ${escHtml(p.maquina_cod)} · ${escHtml(p.operador_cod)}`,
    ];

    const prodUn   = p.qtd_produzida_un || 0;
    const pesoKg   = p.peso_padrao_un   || 0;
    const pesoGr   = pesoKg * 1000;
    const prodKg   = p.qtd_produzida    || 0;
    linhas.push(`<hr style="margin:8px 0;border:none;border-top:1px solid #e5e7eb;">`);
    linhas.push(`<div style="font-size:15px;">Produzido: <strong>${fmt(prodUn, 0)} un</strong> × ${fmt(pesoGr, 2)} g/un = <strong style="color:var(--color-primary);">${fmt(prodKg, 2)} kg</strong></div>`);

    if (p.qtd_refugo_kg > 0)   linhas.push(`Perda Peça: <strong>${fmt(p.qtd_refugo_kg, 2)} kg</strong>`);
    if (p.qtd_perda_mp_kg > 0) linhas.push(`Perda BCV: <strong>${fmt(p.qtd_perda_mp_kg, 2)} kg</strong>`);

    if ((p.outras_perdas || []).length) {
      const itens = p.outras_perdas.map(x => `${escHtml(x.tipo_perda)}: ${fmt(x.qtd_kg, 2)} kg`).join('; ');
      linhas.push(`Outras perdas: ${itens}`);
    }

    // Tempo e PH — so quando o operador informou inicio/fim de producao.
    if (inpInicioProd.value && inpFimProd.value) {
      const minProd   = calcularMinutos(inpInicioProd.value, inpFimProd.value);
      const minParada = somarMinutosParadas();
      const minTrab   = Math.max(0, minProd - minParada);
      const horasTrab = minTrab / 60;
      const tempoStr  = `${Math.floor(horasTrab)}h${String(minTrab % 60).padStart(2,'0')}`;
      linhas.push(`Tempo trabalhado: <strong>${tempoStr}</strong>${minParada > 0 ? ` (${Math.floor(minParada/60)}h${String(minParada%60).padStart(2,'0')} de parada descontada)` : ''}`);
      if (minTrab >= 10 && prodUn > 0) {
        linhas.push(`Ritmo (PH): <strong>${Math.round(prodUn / horasTrab)} un/h</strong>`);
      }
    }

    const paradasLista = p.paradas || [];
    if (paradasLista.length === 1) {
      linhas.push(`Parada: <strong>${escHtml(paradasLista[0].motivo || '—')}</strong>`);
    } else if (paradasLista.length > 1) {
      const resumo = paradasLista.map(x => escHtml(x.motivo || '—')).join('; ');
      linhas.push(`Paradas (${paradasLista.length}): ${resumo}`);
    }

    if (p.encerrou_op) {
      linhas.push(`<div style="margin-top:8px;padding:8px;background:#fef3c7;border-radius:6px;color:#92400e;"><strong>⚠ Esta OP será encerrada</strong></div>`);
    }

    return `<div style="font-size:14px;line-height:1.5;">${linhas.map(l => `<div>${l}</div>`).join('')}</div>`;
  }

  // ----- Helpers -----

  function validarFormulario() {
    limparErros();
    let primeiroErro = null;

    function marcarErro(el) {
      el.classList.add('error');
      if (!primeiroErro) primeiroErro = el;
    }

    if (unidMedida === 'UN') {
      const v = parseNum(inpPesoPadrao.value);
      if (!Number.isFinite(v) || v <= 0) marcarErro(inpPesoPadrao);
    }

    const qtdVal = parseNum(inpQtd.value);
    if (!Number.isFinite(qtdVal) || qtdVal <= 0) marcarErro(inpQtd);

    // Refugo e Perda BCV: aceitar 0, mas exigir numero valido (nao aceitar "abc", vazio, NaN)
    const refugoVal  = parseNum(inpRefugo.value);
    const perdaMpVal = parseNum(inpPerdaMp.value);
    if (inpRefugo.value === '' || !Number.isFinite(refugoVal) || refugoVal < 0)   marcarErro(inpRefugo);
    if (inpPerdaMp.value === '' || !Number.isFinite(perdaMpVal) || perdaMpVal < 0) marcarErro(inpPerdaMp);

    // Cor: se escolheu "Outros", exigir o campo de texto
    if (selVariante.value === 'OUTROS' && !inpCorOutros.value.trim()) {
      marcarErro(inpCorOutros);
    }

    // Horario de producao e OPCIONAL. Se o operador abriu a secao, exigir
    // ambos preenchidos ou ambos vazios (nunca so um).
    if (ajustarHorarioOn) {
      const temIni = !!inpInicioProd.value;
      const temFim = !!inpFimProd.value;
      if (temIni !== temFim) {
        if (!temIni) marcarErro(inpInicioProd);
        if (!temFim) marcarErro(inpFimProd);
      }
    }

    if (houveParada) {
      const linhas = document.querySelectorAll('#lista-paradas .parada-row');
      if (linhas.length === 0) {
        // Toggle ligado mas sem linhas — forcar desligar ou exigir ao menos uma
        houveParada = false;
        trackParada.classList.remove('ativo', 'on-red');
        secaoParada.style.display = 'none';
      }
      linhas.forEach(row => {
        const sel = row.querySelector('.parada-motivo');
        const ini = row.querySelector('.parada-inicio');
        const fim = row.querySelector('.parada-fim');
        if (!sel.value) marcarErro(sel);
        if (!ini.value) marcarErro(ini);
        if (!fim.value) marcarErro(fim);
      });
    }

    if (outrasPerdasOn) {
      document.querySelectorAll('.perda-tipo').forEach(el => {
        if (!el.value) marcarErro(el);
      });
      document.querySelectorAll('.perda-qtd').forEach(el => {
        const v = parseFloat(el.value);
        if (!v || v <= 0) marcarErro(el);
      });
    }

    if (primeiroErro) {
      primeiroErro.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return false;
    }
    return true;
  }

  function limparErros() {
    document.querySelectorAll('.field-input.error').forEach(el => el.classList.remove('error'));
  }

  function montarPayload() {
    const qtdUn      = Math.round(parseNum(inpQtd.value) || 0);
    // Operador digita peso padrao e pesagens em GRAMAS. Storage fica em KG.
    const pesoGrama  = parseNum(inpPesoPadrao.value);
    const pesoPad    = pesoGrama > 0 ? pesoGrama / 1000 : null;
    const qtdKg      = unidMedida === 'UN'
      ? Math.round(qtdUn * (pesoPad || 0) * 1000) / 1000
      : parseNum(inpQtd.value) || 0;
    const pesagemKg  = (id) => {
      const g = parseFloat(document.getElementById(id)?.value);
      return g > 0 ? g / 1000 : null;
    };

    // datetime-local retorna "YYYY-MM-DDTHH:MM" (hora local).
    // Data e explicita — OP atravessando dias funciona naturalmente.
    // Se Date() nao parsear, intervalo vira { null, null }.
    function toIsoPar(inicioStr, fimStr) {
      if (!inicioStr || !fimStr) return { inicio: null, fim: null };
      const dIni = new Date(inicioStr);
      const dFim = new Date(fimStr);
      if (isNaN(dIni.getTime()) || isNaN(dFim.getTime())) return { inicio: null, fim: null };
      return { inicio: dIni.toISOString(), fim: dFim.toISOString() };
    }

    const intervaloProd = toIsoPar(inpInicioProd.value, inpFimProd.value);

    // Coleta de paradas: pode ser mais de uma. Monta array e, para manter
    // compatibilidade com integracoes legadas, preenche motivo_parada/dt_*_parada
    // com a primeira parada (indice 0).
    const paradasArr = [];
    if (houveParada) {
      document.querySelectorAll('#lista-paradas .parada-row').forEach(row => {
        const sel = row.querySelector('.parada-motivo');
        const ini = row.querySelector('.parada-inicio').value;
        const fim = row.querySelector('.parada-fim').value;
        const cod = sel.value;
        const opt = sel.options[sel.selectedIndex];
        const desc = opt?.dataset?.desc || opt?.text || '';
        if (!cod || !ini || !fim) return;
        const intervalo = toIsoPar(ini, fim);
        paradasArr.push({
          cod_motivo: cod,
          motivo:     desc,
          inicio:     intervalo.inicio,
          fim:        intervalo.fim,
        });
      });
    }
    const primeiraParada = paradasArr[0] || null;
    const motivoCod  = primeiraParada?.cod_motivo || null;
    const motivoDesc = primeiraParada?.motivo     || null;
    const intervaloParada = primeiraParada
      ? { inicio: primeiraParada.inicio, fim: primeiraParada.fim }
      : { inicio: null, fim: null };

    const perdasLista = [];
    if (outrasPerdasOn) {
      document.querySelectorAll('.perda-row').forEach(row => {
        const tipo = row.querySelector('.perda-tipo').value;
        const qtd  = parseFloat(row.querySelector('.perda-qtd').value) || 0;
        if (tipo && qtd > 0) perdasLista.push({ tipo_perda: tipo, qtd_kg: qtd });
      });
    }

    return {
      op_numero:          op.op_numero,
      maquina_cod:        maquina.COD,
      centro_trab_cod:    estado.centroTrabalho?.COD || null,
      operador_cod:       estado.operadorCod,
      unid_medida:        unidMedida,
      qtd_produzida:      qtdKg,
      qtd_produzida_un:   unidMedida === 'UN' ? qtdUn : null,
      peso_padrao_un:     unidMedida === 'UN' ? pesoPad : null,
      pesagem_1:          pesagemKg('p1'),
      pesagem_2:          pesagemKg('p2'),
      pesagem_3:          pesagemKg('p3'),
      qtd_refugo_kg:      parseNum(inpRefugo.value)  || 0,
      qtd_perda_mp_kg:    parseNum(inpPerdaMp.value) || 0,
      turno:              estado.turno,
      houve_parada:       houveParada && paradasArr.length > 0,
      cod_motivo_parada:  motivoCod,
      motivo_parada:      motivoDesc,
      paradas:            paradasArr,
      dt_inicio_producao: intervaloProd.inicio,
      dt_fim_producao:    intervaloProd.fim,
      dt_inicio_parada:   intervaloParada.inicio,
      dt_fim_parada:      intervaloParada.fim,
      // horas so e derivado quando o operador informou inicio E fim; senao null.
      horas_trabalhadas:  (intervaloProd.inicio && intervaloProd.fim)
        ? (() => {
            const minP = calcularMinutos(inpInicioProd.value, inpFimProd.value);
            const minS = somarMinutosParadas();
            return parseFloat((Math.max(0, minP - minS) / 60).toFixed(2));
          })()
        : null,
      encerrou_op:        chkEncerrar.checked,
      origem_op:          op.origem_op,
      op_divergiu:        estado.opDivergiu,
      cor_variante_cod:   selVariante.value || null,
      cor_variante_desc:  selVariante.value === 'OUTROS'
                            ? inpCorOutros.value.trim() || null
                            : (selVariante.value || null),
      outras_perdas:      perdasLista,
    };
  }

  function exibirErroGeral(msg) {
    let el = document.getElementById('erro-geral');
    if (!msg) { if (el) el.style.display = 'none'; return; }
    if (!el) {
      el = document.createElement('div');
      el.id = 'erro-geral';
      el.className = 'error-box';
      container.querySelector('.encerrar-op-box').before(el);
    }
    el.textContent = msg;
    el.style.display = '';
  }

  function exibirConfirmacao(offline, encerrou) {
    // Apontamento enviado/enfileirado — nao ha mais dados a proteger (A9).
    registrarGuardaNavegacao(null);
    container.innerHTML = `
      <div class="confirmacao">
        <div class="confirmacao-icon">${encerrou ? '⚠️' : '✅'}</div>
        <div class="confirmacao-titulo" style="color:${encerrou ? 'var(--color-warning)' : 'var(--color-success)'}">
          ${encerrou ? 'OP encerrada e apontamento registrado' : 'Apontamento registrado!'}
        </div>
        <div class="confirmacao-sub">
          ${encerrou
            ? 'A OP foi sinalizada ao Drummer para fechamento.'
            : 'Seu apontamento foi salvo com sucesso.'}
        </div>

        <div class="confirmacao-info">
          <div>OP: <strong>${escHtml(op.op_numero)}</strong></div>
          <div>Máquina: <strong>${escHtml(maquina.COD)} — ${escHtml(maquina.DESCRICAO)}</strong></div>
          ${selVariante.value ? `<div>Cor: <strong>${escHtml(selVariante.value === 'OUTROS' ? inpCorOutros.value.trim() : selVariante.value)}</strong></div>` : ''}
          <div>Horário: <strong>${new Date().toLocaleString('pt-BR')}</strong></div>
        </div>

        ${offline
          ? `<div class="badge badge-warning" style="margin-bottom:20px;font-size:13px;">
               ⚠ Na fila — será sincronizado quando online
             </div>`
          : `<div class="badge badge-success" style="margin-bottom:20px;font-size:13px;">
               ✓ Sincronizado com o servidor
             </div>`
        }

        <button id="btn-novo-apontamento" class="btn btn-primary btn-block">
          Novo apontamento
        </button>
      </div>
    `;

    document.getElementById('btn-novo-apontamento').addEventListener('click', () => {
      estado.maquinaSelecionada = null;
      estado.opSelecionada      = null;
      estado.opDivergiu         = false;
      estado.opDrummerSugerida  = null;
      // Se ha centro salvo no perfil, pula a tela de centro.
      const perfil = carregarPerfil();
      if (perfil?.centroTrabalho) {
        estado.centroTrabalho = estado.centroTrabalho || perfil.centroTrabalho;
        irParaTela(1);
      } else {
        irParaTela(0);
      }
    });
  }
}

/**
 * Busca motivos de parada do backend; fallback para cache IndexedDB; fallback hardcoded.
 */
async function carregarMotivosParada(tipoCt = null) {
  const res = await getMotivosParada(tipoCt);
  if (res.success && res.data?.length) {
    return res.data;
  }

  // Tentar cache offline
  const cached = await lerTodoCache('cache-motivos');
  if (cached?.length) {
    return tipoCt
      ? cached.filter(m => !m.TIPO_CT || m.TIPO_CT === tipoCt)
      : cached;
  }

  // Fallback hardcoded (garante que a tela nunca fica sem motivos)
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

function formatarPlanejado(op) {
  const fmt = (n) => Number(n).toLocaleString('pt-BR', { maximumFractionDigits: 1 });
  if (op.unid_medida === 'UN' && op.planejado_un) return fmt(op.planejado_un) + ' un';
  return fmt(op.planejado_kg) + ' kg';
}

function formatarSaldo(op) {
  const fmt = (n) => Number(n).toLocaleString('pt-BR', { maximumFractionDigits: 1 });
  if (op.unid_medida === 'UN') {
    const base = op.restante_un != null ? op.restante_un : (op.planejado_un || 0);
    return fmt(base) + ' un';
  }
  const baseKg = op.restante_kg != null ? op.restante_kg : (op.planejado_kg || 0);
  return fmt(baseKg) + ' kg';
}



