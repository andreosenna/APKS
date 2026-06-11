/**
 * modal.js — Modal de confirmacao customizado (substitui window.confirm).
 * Retorna uma Promise<boolean>. Suporta conteudo HTML estruturado.
 *
 * Uso simples:
 *   const ok = await confirmar('Deseja excluir?');
 *
 * Uso completo:
 *   const ok = await confirmar({
 *     titulo: 'Confirmar correcao',
 *     html: '<p>Voce vai alterar...</p>',
 *     tipo: 'warning',       // 'info' | 'warning' | 'danger' (cor do botao principal)
 *     textoOk: 'Salvar',
 *     textoCancelar: 'Voltar',
 *   });
 */

import { escHtml } from './utils.js';

/**
 * Modal de input — substitui window.prompt. Retorna Promise<string|null>
 * (null se cancelou, string (possivelmente vazia) se confirmou).
 */
export function promptTexto(opcoes = {}) {
  const {
    titulo = 'Digite o valor',
    mensagem = '',
    placeholder = '',
    valorInicial = '',
    tipo = 'info',
    senha = false,
    textoOk = 'OK',
    textoCancelar = 'Cancelar',
  } = opcoes;

  return new Promise((resolve) => {
    const existente = document.getElementById('app-modal-backdrop');
    if (existente) existente.remove();

    const backdrop = document.createElement('div');
    backdrop.id = 'app-modal-backdrop';
    backdrop.className = 'app-modal-backdrop';

    const icone = tipo === 'danger' ? '⚠' : tipo === 'info' ? '🔑' : '✏';
    const corBtn = tipo === 'danger' ? 'btn-danger' : 'btn-primary';
    const inputType = senha ? 'password' : 'text';

    backdrop.innerHTML = `
      <div class="app-modal" role="dialog" aria-modal="true" aria-labelledby="app-modal-title">
        <div class="app-modal-header app-modal-${tipo}">
          <span class="app-modal-icon">${icone}</span>
          <h3 id="app-modal-title">${escHtml(titulo)}</h3>
        </div>
        <div class="app-modal-body">
          ${mensagem ? `<p>${escHtml(mensagem)}</p>` : ''}
          <input
            type="${inputType}"
            id="app-modal-input"
            class="field-input"
            placeholder="${escHtml(placeholder)}"
            value="${escHtml(valorInicial)}"
            autocomplete="off"
            spellcheck="false"
            style="width: 100%; margin-top: 8px;"
          />
        </div>
        <div class="app-modal-footer">
          <button type="button" class="btn btn-secondary" id="app-modal-cancelar">${escHtml(textoCancelar)}</button>
          <button type="button" class="btn ${corBtn}" id="app-modal-ok">${escHtml(textoOk)}</button>
        </div>
      </div>`;

    document.body.appendChild(backdrop);

    const input = document.getElementById('app-modal-input');
    setTimeout(() => { input.focus(); input.select(); }, 50);

    function fechar(valor) {
      backdrop.classList.add('fechando');
      setTimeout(() => {
        backdrop.remove();
        document.removeEventListener('keydown', onKey);
        resolve(valor);
      }, 150);
    }

    function onKey(e) {
      if (e.key === 'Escape') fechar(null);
      if (e.key === 'Enter')  fechar(input.value);
    }

    document.getElementById('app-modal-ok').addEventListener('click', () => fechar(input.value));
    document.getElementById('app-modal-cancelar').addEventListener('click', () => fechar(null));
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) fechar(null); });
    document.addEventListener('keydown', onKey);
  });
}

export function confirmar(opcoes) {
  // Se chamou com string simples, normaliza
  if (typeof opcoes === 'string') opcoes = { mensagem: opcoes };

  const {
    titulo = 'Confirmar',
    mensagem = '',
    html = '',
    tipo = 'warning',       // info | warning | danger
    textoOk = 'Confirmar',
    textoCancelar = 'Cancelar',
  } = opcoes;

  return new Promise((resolve) => {
    // Evitar multiplos modais abertos
    const existente = document.getElementById('app-modal-backdrop');
    if (existente) existente.remove();

    const backdrop = document.createElement('div');
    backdrop.id = 'app-modal-backdrop';
    backdrop.className = 'app-modal-backdrop';

    const icone = tipo === 'danger' ? '⚠' : tipo === 'info' ? 'ℹ' : '⚠';
    const corBtn = tipo === 'danger' ? 'btn-danger' : tipo === 'info' ? 'btn-primary' : 'btn-amber';

    const conteudoHtml = html
      ? html
      : `<p>${escHtml(mensagem).replace(/\n/g, '<br>')}</p>`;

    const btnCancelarHtml = textoCancelar
      ? `<button type="button" class="btn btn-secondary" id="app-modal-cancelar">${escHtml(textoCancelar)}</button>`
      : '';

    backdrop.innerHTML = `
      <div class="app-modal" role="dialog" aria-modal="true" aria-labelledby="app-modal-title">
        <div class="app-modal-header app-modal-${tipo}">
          <span class="app-modal-icon">${icone}</span>
          <h3 id="app-modal-title">${escHtml(titulo)}</h3>
        </div>
        <div class="app-modal-body">${conteudoHtml}</div>
        <div class="app-modal-footer">
          ${btnCancelarHtml}
          <button type="button" class="btn ${corBtn}" id="app-modal-ok">${escHtml(textoOk)}</button>
        </div>
      </div>`;

    document.body.appendChild(backdrop);

    // Foco no botao de confirmar apos abrir
    setTimeout(() => document.getElementById('app-modal-ok').focus(), 50);

    function fechar(valor) {
      backdrop.classList.add('fechando');
      setTimeout(() => {
        backdrop.remove();
        document.removeEventListener('keydown', onKey);
        resolve(valor);
      }, 150);
    }

    function onKey(e) {
      if (e.key === 'Escape')           fechar(false);
      if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') fechar(true);
    }

    document.getElementById('app-modal-ok').addEventListener('click', () => fechar(true));
    const btnCancelar = document.getElementById('app-modal-cancelar');
    if (btnCancelar) btnCancelar.addEventListener('click', () => fechar(false));
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) fechar(false); });
    document.addEventListener('keydown', onKey);
  });
}

