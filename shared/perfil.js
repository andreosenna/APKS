/**
 * perfil.js — Perfil persistido em localStorage.
 *
 * Guarda apenas o centro de trabalho, para poupar cliques entre apontamentos.
 * O operador NAO e persistido (e 1 por maquina, varia entre maquinas) e o turno
 * tambem nao (vem do turno aberto pelo apontador no login).
 */

const CHAVE = 'apontamento-perfil-v1';

export function carregarPerfil() {
  try {
    const raw = localStorage.getItem(CHAVE);
    if (!raw) return null;
    const p = JSON.parse(raw);
    // Valida campo minimo: o centro de trabalho.
    if (!p || !p.centroTrabalho) return null;
    return p;
  } catch (_) {
    return null;
  }
}

export function salvarPerfil(p) {
  try {
    localStorage.setItem(CHAVE, JSON.stringify(p));
  } catch (_) { /* storage pode estar cheio/bloqueado */ }
}

export function atualizarCampo(campo, valor) {
  const p = carregarPerfil() || {};
  p[campo] = valor;
  p.atualizado_em = new Date().toISOString();
  salvarPerfil(p);
}

export function limparPerfil() {
  try { localStorage.removeItem(CHAVE); } catch (_) {}
}
