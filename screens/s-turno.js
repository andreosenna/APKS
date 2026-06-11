/**
 * s-turno.js — Tela de abertura de turno.
 *
 * Aberta sob demanda: pelo botao "ABRIR TURNO" do header (qualquer papel) ou
 * quando um apontamento e tentado sem turno aberto. O turno escolhido aqui e
 * herdado por todos os apontamentos (o backend e a fonte da verdade) ate
 * "FECHAR TURNO". E opcional — "Voltar sem abrir turno" sai sem abrir nada.
 */

import { abrirTurno, getTurnoAtual } from '../api.js';
import { estado, irParaTela, atualizarBadgeTurno } from '../app.js';
import { carregarPerfil } from '../perfil.js';
import { confirmar } from '../modal.js';
import { labelJanela, periodoTurno, desvioHorarioTurno } from '../shared/turno-janela.mjs';

const TURNOS = ['A', 'B', 'C', 'D'];

export function render(container) {
  container.innerHTML = `
    <div class="turno-wrap">
      <div class="turno-card">
        <h2 class="turno-titulo">Abrir turno</h2>
        <p class="turno-sub">
          Escolha o turno em que você vai trabalhar. Todos os apontamentos serão
          registrados neste turno até você fechá-lo no botão do topo.
        </p>
        <div class="turno-grid">
          ${TURNOS.map(t => `
            <button class="turno-btn" data-turno="${t}" type="button">
              <span class="turno-btn-letra">${t}</span>
              <span class="turno-btn-periodo">${periodoTurno(t)}</span>
              <span class="turno-btn-horario">${labelJanela(t)}</span>
            </button>
          `).join('')}
        </div>
        <div id="turno-erro" class="error-box" style="display:none; margin-top:16px; margin-bottom:0;"></div>
        <button class="btn btn-secondary btn-block" id="turno-voltar" type="button" style="margin-top:16px;">Voltar sem abrir turno</button>
      </div>
    </div>
  `;

  const erroBox = document.getElementById('turno-erro');
  const botoes  = [...container.querySelectorAll('.turno-btn')];

  function exibirErro(msg) {
    erroBox.textContent = msg;
    erroBox.style.display = 'block';
  }

  botoes.forEach(btn => {
    btn.addEventListener('click', async () => {
      const turno = btn.dataset.turno;
      botoes.forEach(b => { b.disabled = true; });
      erroBox.style.display = 'none';

      // Turno global: confirma sempre, deixando claro que afeta TODOS os
      // apontadores. Consulta o estado atual fresco — se ja ha outro turno
      // aberto, isto e uma TROCA e a confirmacao e reforcada (danger).
      let turnoAtual = null;
      try {
        const ta = await getTurnoAtual();
        if (ta && ta.success) turnoAtual = ta.data || null;
      } catch (_) { /* segue — o backend e a fonte da verdade */ }

      if (!turnoAtual || turnoAtual.turno !== turno) {
        const ehTroca = !!turnoAtual;
        const dev = desvioHorarioTurno(turno, 'abrir');
        const linhaHorario = dev.foraDoHorario
          ? `⚠ O turno ${turno} normalmente abre às ${dev.esperadoHHMM}, mas agora `
            + `são ${dev.agoraHHMM} — ${dev.diferencaTexto} de diferença.\n\n`
          : '';
        const corpo = ehTroca
          ? `O turno ${turnoAtual.turno} está aberto para TODOS os apontadores. `
            + `Abrir o turno ${turno} vai TROCAR o turno de todo o sistema.`
          : `O turno ${turno} ficará ativo para TODOS os apontadores do sistema.`;
        const ok = await confirmar({
          titulo: ehTroca ? `Trocar para o turno ${turno}?` : `Abrir o turno ${turno}?`,
          mensagem: linhaHorario + corpo + '\n\nConfirma?',
          tipo: ehTroca ? 'danger' : 'warning',
          textoOk: ehTroca ? `Trocar para ${turno}` : `Abrir turno ${turno}`,
          textoCancelar: 'Cancelar',
        });
        if (!ok) {
          botoes.forEach(b => { b.disabled = false; });
          return;
        }
      }

      const r = await abrirTurno(turno);
      if (!r || !r.success) {
        // Corrida: outro apontador abriu o turno no mesmo instante. Para um
        // turno global isso nao e erro — o turno esta aberto. Recarrega e segue.
        if (r && r.error === 'turno_ja_aberto') {
          try {
            const ta = await getTurnoAtual();
            if (ta && ta.success && ta.data) {
              estado.turnoAberto = ta.data;
              atualizarBadgeTurno();
              irFluxoNormal();
              return;
            }
          } catch (_) { /* cai no erro generico abaixo */ }
        }
        botoes.forEach(b => { b.disabled = false; });
        if (r && r.offline) exibirErro('Sem conexão com o servidor. Tente novamente.');
        else exibirErro('Não foi possível abrir o turno: ' + ((r && r.error) || 'erro desconhecido'));
        return;
      }

      estado.turnoAberto = (r.data && r.data.turno_aberto) || { turno };
      atualizarBadgeTurno();
      irFluxoNormal();
    });
  });

  // Turno e opcional (ex.: admin que so vai ver o painel) — sai sem abrir nada.
  document.getElementById('turno-voltar').addEventListener('click', irFluxoNormal);

  // Segue para o fluxo normal (Tela 1 se ja tem centro salvo, senao Tela 0).
  function irFluxoNormal() {
    const perfil = carregarPerfil();
    if (perfil && perfil.centroTrabalho) {
      estado.centroTrabalho = perfil.centroTrabalho;
      irParaTela(1);
    } else {
      irParaTela(0);
    }
  }
}
