/**
 * admin.js — controle de papel (role) do usuario logado no frontend.
 *
 * Roles:
 *   - 'editor'        → acesso total (lixeira, historico, painel, backup)
 *   - 'visualizador'  → so o fluxo de apontamento (telas 0..3)
 *   - null            → nao logado (ou JWT sem role — nao deveria acontecer)
 *
 * Role vem do JWT no login e fica salvo em localStorage (api.js USER_KEY).
 *
 * Fallback de emergencia: se o AD estiver fora ou o usuario logado nao for
 * editor, ele pode digitar o ADMIN_TOKEN do .env via entrarFallback() para
 * desbloquear acoes administrativas temporariamente (sessionStorage).
 *
 * API:
 *   getRole()         → 'editor' | 'visualizador' | null
 *   isEditor()        → bool (role editor OU fallback ADMIN_TOKEN ativo)
 *   isVisualizador()  → bool
 *   isAdmin()         → alias de isEditor (back-compat)
 *   entrarFallback()  → prompt + valida; em sucesso ativa o fallback admin
 *   sairFallback()    → desativa o fallback admin
 *   fetchAdmin(url, opts) → fetch que envia JWT normal + x-admin-token quando ha fallback
 */

import { promptTexto, confirmar } from './modal.js';
import { lerRole } from './api.js';

const FALLBACK_KEY = 'admin-token';
const BACKEND_URL  = window.APP_CONFIG?.backendUrl || '';

export function getRole() {
  return lerRole();
}

function getFallbackToken() {
  return sessionStorage.getItem(FALLBACK_KEY);
}

export function isEditor() {
  return getRole() === 'editor' || !!getFallbackToken();
}

export function isVisualizador() {
  return getRole() === 'visualizador' && !getFallbackToken();
}

// Back-compat: codigo legado em s4/s5 chama admin.isAdmin().
export function isAdmin() {
  return isEditor();
}

/**
 * Prompt + valida ADMIN_TOKEN contra POST /api/admin/auth. Em sucesso,
 * salva em sessionStorage e libera fetchAdmin a enviar o header.
 */
export async function entrarFallback() {
  const token = await promptTexto({
    titulo: 'Entrar como admin (fallback)',
    mensagem: 'Cole o ADMIN_TOKEN configurado no servidor:',
    placeholder: 'ex: admin-xxx-2026',
    tipo: 'info',
    senha: true,
    textoOk: 'Entrar',
  });
  if (!token || !token.trim()) return false;

  try {
    const res = await fetch(`${BACKEND_URL}/api/admin/auth`, {
      method: 'POST',
      headers: { 'x-admin-token': token.trim() },
    });
    if (res.status === 503) {
      await confirmar({
        titulo: 'Servidor nao configurado',
        mensagem: 'O servidor nao tem ADMIN_TOKEN definido. Procure o TI.',
        tipo: 'warning', textoOk: 'Entendi', textoCancelar: '',
      });
      return false;
    }
    if (res.status === 403) {
      await confirmar({
        titulo: 'Token invalido',
        mensagem: 'O token digitado nao confere. Tente novamente.',
        tipo: 'danger', textoOk: 'Entendi', textoCancelar: '',
      });
      return false;
    }
    if (!res.ok) {
      await confirmar({
        titulo: 'Erro de autenticacao',
        mensagem: `Erro HTTP ${res.status}.`,
        tipo: 'danger', textoOk: 'Entendi', textoCancelar: '',
      });
      return false;
    }
    sessionStorage.setItem(FALLBACK_KEY, token.trim());
    return true;
  } catch (e) {
    await confirmar({
      titulo: 'Erro de rede',
      mensagem: 'Nao foi possivel contactar o servidor: ' + e.message,
      tipo: 'danger', textoOk: 'Entendi', textoCancelar: '',
    });
    return false;
  }
}

export function sairFallback() {
  sessionStorage.removeItem(FALLBACK_KEY);
}

// Back-compat: nomes antigos
export const entrar = entrarFallback;
export const sair   = sairFallback;
export const getToken = getFallbackToken;

/**
 * Fetch que injeta o JWT (header Authorization) ja por padrao e, se houver
 * sessao fallback ativa, tambem inclui x-admin-token. Usar para rotas que
 * precisam de role editor. Se 403, limpa fallback e propaga erro.
 */
export async function fetchAdmin(url, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  // Authorization Bearer ja vai pelo fetchComTimeout em api.js, mas aqui
  // chamamos fetch direto entao precisamos injetar manualmente.
  try {
    const tok = localStorage.getItem('apontamento-auth-v1');
    if (tok && !headers.Authorization) headers.Authorization = `Bearer ${tok}`;
  } catch (_) {}
  const fb = getFallbackToken();
  if (fb) headers['x-admin-token'] = fb;

  const res = await fetch(url, { ...opts, headers });
  if (res.status === 403) {
    if (fb) sairFallback();
    throw new Error('sem_permissao');
  }
  return res;
}
