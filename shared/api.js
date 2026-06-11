/**
 * api.js — Wrapper de chamadas ao backend.
 * Timeout de 8s em todas as chamadas.
 * Se offline ou erro de rede: salva na fila IndexedDB e retorna { success: true, offline: true }
 */

import { adicionarApontamentoNaFila, adicionarEventoNaFila } from './sync.js';
import { adicionarNaFila } from './db.js';

// -----------------------------------------------------------------------------
// Fila offline para operacoes (reabrir OP, corrigir apontamento).
// A resposta do fetch pode chegar depois ou nao chegar; o client_uuid garante
// idempotencia no servidor quando a sync reenviar.
// -----------------------------------------------------------------------------
function gerarUUID() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, ch => {
    const r = Math.random() * 16 | 0;
    return (ch === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

async function enfileirarOperacao(tipo, endpoint, method, body) {
  const envelope = {
    dados: {
      tipo,
      endpoint,
      method,
      body: { ...body, client_uuid: (body && body.client_uuid) || gerarUUID() },
    },
    error_count: 0,
    last_error: null,
    next_retry_at: 0,
  };
  await adicionarNaFila('fila-operacoes', envelope);
}


const BACKEND_URL = window.APP_CONFIG?.backendUrl || 'http://localhost:3001';
const TIMEOUT_MS  = 8000;

const TOKEN_KEY = 'apontamento-auth-v1';
const USER_KEY  = 'apontamento-user-v1';

function lerToken() {
  try { return localStorage.getItem(TOKEN_KEY) || null; } catch (_) { return null; }
}

function limparTokenLocal() {
  try {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  } catch (_) {}
}

export function lerUsuario() {
  try {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (_) { return null; }
}

export function lerRole() {
  return lerUsuario()?.role || null;
}

/**
 * Fetch com timeout configurável. Injeta Authorization quando ha token salvo.
 * Em 401 (token invalido/expirado), limpa storage e dispara evento global
 * `auth:expired` para a UI redirecionar pra tela de login.
 */
async function fetchComTimeout(url, opcoes = {}) {
  const controller = new AbortController();
  const timeoutId  = setTimeout(() => controller.abort(), TIMEOUT_MS);

  const headers = { ...(opcoes.headers || {}) };
  const token = lerToken();
  if (token && !headers.Authorization) headers.Authorization = `Bearer ${token}`;

  try {
    const response = await fetch(url, { ...opcoes, headers, signal: controller.signal });
    clearTimeout(timeoutId);

    if (response.status === 401) {
      // Token invalido/ausente — sai do contexto autenticado.
      // Nao tratar a tela de login (que tambem chama fetchComTimeout sem token).
      if (token) {
        limparTokenLocal();
        window.dispatchEvent(new CustomEvent('auth:expired'));
      }
      const corpo = await response.json().catch(() => ({ error: 'unauthorized' }));
      throw new Error(corpo.error || 'unauthorized');
    }

    if (!response.ok) {
      const corpo = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
      throw new Error(corpo.error || `Erro HTTP ${response.status}`);
    }

    return response.json();
  } catch (err) {
    clearTimeout(timeoutId);

    if (err.name === 'AbortError') {
      throw new Error('Tempo limite de conexão excedido (8s)');
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Autenticacao
// ---------------------------------------------------------------------------

export async function login(username, password) {
  try {
    const r = await fetchComTimeout(`${BACKEND_URL}/api/auth/login`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ username, password }),
    });
    if (r && r.success && r.token) {
      try {
        localStorage.setItem(TOKEN_KEY, r.token);
        if (r.user) localStorage.setItem(USER_KEY, JSON.stringify(r.user));
      } catch (_) {}
    }
    return r;
  } catch (err) {
    if (erroDeConexao(err)) {
      return { success: false, offline: true, error: 'Sem conexão com o servidor' };
    }
    return { success: false, error: err.message };
  }
}

export async function logout() {
  try {
    await fetchComTimeout(`${BACKEND_URL}/api/auth/logout`, { method: 'POST' });
  } catch (_) { /* ignora — limpar local e suficiente */ }
  limparTokenLocal();
}

export async function authMe() {
  try {
    return await fetchComTimeout(`${BACKEND_URL}/api/auth/me`);
  } catch (err) {
    if (erroDeConexao(err)) return { success: false, offline: true };
    return { success: false, error: err.message };
  }
}

export function temToken() {
  return !!lerToken();
}

/**
 * Verifica se o erro é de conectividade (offline ou servidor inacessível).
 */
function erroDeConexao(err) {
  return (
    !navigator.onLine ||
    err.message.includes('Failed to fetch') ||
    err.message.includes('NetworkError') ||
    err.message.includes('Tempo limite')
  );
}

// ---------------------------------------------------------------------------
// Turnos do apontador (APA010)
// ---------------------------------------------------------------------------

/** Abre/retoma/troca o turno do apontador. @param {string} turno A|B|C|D */
export async function abrirTurno(turno) {
  try {
    return await fetchComTimeout(`${BACKEND_URL}/api/turno/abrir`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ turno }),
    });
  } catch (err) {
    if (erroDeConexao(err)) return { success: false, offline: true, error: 'Sem conexão com o servidor' };
    return { success: false, error: err.message };
  }
}

/** Fecha o turno aberto do apontador. */
export async function fecharTurno() {
  try {
    return await fetchComTimeout(`${BACKEND_URL}/api/turno/fechar`, { method: 'POST' });
  } catch (err) {
    if (erroDeConexao(err)) return { success: false, offline: true, error: 'Sem conexão com o servidor' };
    return { success: false, error: err.message };
  }
}

/** Turno aberto do apontador logado (data = objeto do turno, ou null). */
export async function getTurnoAtual() {
  try {
    return await fetchComTimeout(`${BACKEND_URL}/api/turno/atual`);
  } catch (err) {
    if (erroDeConexao(err)) return { success: false, offline: true };
    return { success: false, error: err.message };
  }
}

/** Consolidado descritivo por apontador x turno x dia. @param {{inicio?,fim?,apontador?}} f */
export async function getConsolidadoTurno(f = {}) {
  const params = new URLSearchParams();
  if (f.inicio)    params.set('inicio', f.inicio);
  if (f.fim)       params.set('fim', f.fim);
  if (f.apontador) params.set('apontador', f.apontador);
  const qs = params.toString();
  try {
    return await fetchComTimeout(`${BACKEND_URL}/api/turno/consolidado${qs ? '?' + qs : ''}`);
  } catch (err) {
    if (erroDeConexao(err)) return { success: false, offline: true };
    return { success: false, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

/**
 * Lista máquinas com status, opcionalmente filtradas por centro de trabalho.
 * @param {string|null} centroCod - Código do centro (ex: '0002'), ou null para todos
 * @returns {{ success: boolean, data?: Array, offline?: boolean }}
 */
export async function getMaquinas(centroCod = null) {
  const url = centroCod
    ? `${BACKEND_URL}/api/maquinas?centro=${encodeURIComponent(centroCod)}`
    : `${BACKEND_URL}/api/maquinas`;
  try {
    return await fetchComTimeout(url);
  } catch (err) {
    if (erroDeConexao(err)) {
      return { success: false, offline: true, error: 'Sem conexão com o servidor' };
    }
    return { success: false, error: err.message };
  }
}

/**
 * Lista OPs disponíveis para uma máquina.
 * @param {string} maquinaCod
 */
export async function getOps(maquinaCod) {
  try {
    return await fetchComTimeout(`${BACKEND_URL}/api/ops/${encodeURIComponent(maquinaCod)}`);
  } catch (err) {
    if (erroDeConexao(err)) {
      return { success: false, offline: true, error: 'Sem conexão com o servidor' };
    }
    return { success: false, error: err.message };
  }
}

/**
 * Lista TODAS as OPs ainda nao encerradas (para autocomplete no apontamento
 * retroativo). Retorna { op_numero, produto, maquina_cod, planejado_un, ... }.
 */
export async function getOpsAbertas() {
  try {
    return await fetchComTimeout(`${BACKEND_URL}/api/ops/abertas`);
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Lista OPs abertas destinadas a OUTRAS maquinas (para permitir "puxar"
 * uma OP que estava em outra maquina).
 * @param {string} maquinaCod - Codigo da maquina atual (sera excluida da resposta)
 */
export async function getOpsOutrasMaquinas(maquinaCod) {
  try {
    return await fetchComTimeout(`${BACKEND_URL}/api/ops/${encodeURIComponent(maquinaCod)}/outras`);
  } catch (err) {
    if (erroDeConexao(err)) {
      return { success: false, offline: true, error: 'Sem conexão com o servidor' };
    }
    return { success: false, error: err.message };
  }
}

/**
 * Registra o início de uma OP na máquina.
 * Se offline, salva na fila e retorna sucesso para o fluxo continuar.
 * @param {Object} dados - { op_numero, maquina_cod, operador_cod, turno, origem_op, op_divergiu }
 */
export async function iniciarOP(dados) {
  try {
    return await fetchComTimeout(`${BACKEND_URL}/api/op/iniciar`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(dados),
    });
  } catch (err) {
    if (erroDeConexao(err)) {
      await adicionarEventoNaFila(dados);
      return { success: true, offline: true };
    }
    return { success: false, error: err.message };
  }
}

/**
 * Pausa uma OP: grava evento OP_PAUSADA com motivo + libera a maquina.
 * @param {Object} dados - { op_numero, maquina_cod, operador_cod, turno, origem_op, cod_motivo_pausa, motivo_pausa }
 */
export async function pausarOP(dados) {
  try {
    return await fetchComTimeout(`${BACKEND_URL}/api/op/pausar`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(dados),
    });
  } catch (err) {
    if (erroDeConexao(err)) return { success: false, offline: true, error: 'Sem conexão' };
    return { success: false, error: err.message };
  }
}

/**
 * Retoma uma OP pausada: fecha a janela OP_PAUSADA e grava evento OP_RETOMADA.
 * @param {Object} dados - { op_numero, maquina_cod, operador_cod, turno, origem_op }
 */
export async function retomarOP(dados) {
  try {
    return await fetchComTimeout(`${BACKEND_URL}/api/op/retomar`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(dados),
    });
  } catch (err) {
    if (erroDeConexao(err)) return { success: false, offline: true, error: 'Sem conexão' };
    return { success: false, error: err.message };
  }
}

/**
 * Encerra uma OP sem registrar apontamento de producao. Somente admin/editor.
 * Casos de uso: OP iniciada por engano, OP concluida mas operador esqueceu de
 * marcar encerrou_op, admin fechando OP travada. Grava OP_ENCERRADA em AP4010,
 * fecha OP_INICIADA aberto e libera a maquina (OP_ATIVA = null).
 * @param {Object} dados - { op_numero, maquina_cod, operador_cod, turno, motivo }
 */
export async function encerrarOpSemApontamento(dados) {
  try {
    return await fetchComTimeout(`${BACKEND_URL}/api/op/encerrar`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(dados),
    });
  } catch (err) {
    if (erroDeConexao(err)) return { success: false, offline: true, error: 'Sem conexão' };
    return { success: false, error: err.message };
  }
}

/**
 * Exclui um evento de AP4010 pelo ID. Somente admin/editor.
 * @param {number} id - ID do evento (AP4_ID)
 */
export async function excluirEvento(id) {
  try {
    return await fetchComTimeout(`${BACKEND_URL}/api/op/evento/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  } catch (err) {
    if (erroDeConexao(err)) return { success: false, offline: true, error: 'Sem conexão' };
    return { success: false, error: err.message };
  }
}

// Atualiza a DT_EVENTO de um evento OP_INICIADA (corrigir inicio retroativo).
export async function atualizarDtEvento(id, dtEvento) {
  try {
    return await fetchComTimeout(`${BACKEND_URL}/api/op/evento/${encodeURIComponent(id)}/dt-evento`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dt_evento: dtEvento }),
    });
  } catch (err) {
    if (erroDeConexao(err)) return { success: false, offline: true, error: 'Sem conexão' };
    return { success: false, error: err.message };
  }
}

/**
 * Lista centros de trabalho ativos.
 */
export async function getCentrosTrabalho() {
  try {
    return await fetchComTimeout(`${BACKEND_URL}/api/centros-trabalho`);
  } catch (err) {
    if (erroDeConexao(err)) return { success: false, offline: true };
    return { success: false, error: err.message };
  }
}

/**
 * Lista motivos de parada (aceita tipo_ct para filtrar por centro).
 */
export async function getMotivosParada(tipoCt = null) {
  const url = tipoCt
    ? `${BACKEND_URL}/api/motivos-parada?tipo_ct=${encodeURIComponent(tipoCt)}`
    : `${BACKEND_URL}/api/motivos-parada`;
  try {
    return await fetchComTimeout(url);
  } catch (err) {
    if (erroDeConexao(err)) return { success: false, offline: true };
    return { success: false, error: err.message };
  }
}

/**
 * Retorna variantes de cor/item de uma OP.
 * Array vazio = OP sem variantes (não exibir seletor de cor).
 */
export async function getVariantesOP(opNumero) {
  try {
    return await fetchComTimeout(`${BACKEND_URL}/api/op/${encodeURIComponent(opNumero)}/variantes`);
  } catch (err) {
    if (erroDeConexao(err)) return { success: false, offline: true, data: [] };
    return { success: false, data: [] };
  }
}

/**
 * Retorna total produzido da OP desde o último encerramento.
 */
export async function getAcumuladoOP(opNumero) {
  try {
    return await fetchComTimeout(`${BACKEND_URL}/api/op/${encodeURIComponent(opNumero)}/acumulado`);
  } catch (err) {
    if (erroDeConexao(err)) return { success: false, offline: true };
    return { success: false, error: err.message };
  }
}

/**
 * Lista operadores ativos (do Protheus, via backend).
 * @param {string|null} setor - Filtrar por setor (opcional)
 */
export async function getOperadores(setor = null) {
  const url = setor
    ? `${BACKEND_URL}/api/operadores?setor=${encodeURIComponent(setor)}`
    : `${BACKEND_URL}/api/operadores`;
  try {
    return await fetchComTimeout(url);
  } catch (err) {
    if (erroDeConexao(err)) {
      return { success: false, offline: true, error: 'Sem conexão com o servidor' };
    }
    return { success: false, error: err.message };
  }
}

/**
 * Lista moldes de uma máquina (do Protheus, via backend).
 * Usado para pré-preencher o peso padrão na Tela 3.
 * @param {string} maquinaCod
 */
export async function getMoldes(maquinaCod) {
  try {
    return await fetchComTimeout(`${BACKEND_URL}/api/moldes/${encodeURIComponent(maquinaCod)}`);
  } catch (err) {
    if (erroDeConexao(err)) {
      return { success: false, offline: true, error: 'Sem conexão com o servidor' };
    }
    return { success: false, error: err.message };
  }
}

/**
 * Envia um apontamento de produção.
 * Se offline, salva na fila para sincronização posterior.
 * @param {Object} dados - Payload completo do apontamento
 */
export async function enviarApontamento(dados) {
  // Garantir client_uuid para idempotencia: se o request der timeout e o frontend
  // enfileirar + o backend tambem tiver gravado, o retry vai duplicar. Com client_uuid
  // o backend devolve { duplicate: true } no 2o envio.
  const payload = { ...dados, client_uuid: dados.client_uuid || gerarUUID() };
  try {
    return await fetchComTimeout(`${BACKEND_URL}/api/apontamento`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });
  } catch (err) {
    if (erroDeConexao(err)) {
      await adicionarApontamentoNaFila(payload);
      return { success: true, offline: true };
    }
    return { success: false, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Painel de Produção
// ---------------------------------------------------------------------------

/**
 * Busca OPs em execução com progresso de produção.
 */
export async function getPainelProducao() {
  try {
    return await fetchComTimeout(`${BACKEND_URL}/api/painel-producao`);
  } catch (err) {
    if (erroDeConexao(err)) return { success: false, offline: true };
    return { success: false, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Histórico e Correção
// ---------------------------------------------------------------------------

/**
 * Lista histórico geral de apontamentos com filtros opcionais.
 * @param {Object} filtros - { maquina?, op?, centro? }
 */
export async function getHistoricoGeral(filtros = {}) {
  const params = new URLSearchParams();
  if (filtros.maquina)     params.set('maquina', filtros.maquina);
  if (filtros.op)          params.set('op', filtros.op);
  if (filtros.centro)      params.set('centro', filtros.centro);
  if (filtros.data)        params.set('data', filtros.data);
  if (filtros.data_inicio) params.set('data_inicio', filtros.data_inicio);
  if (filtros.data_fim)    params.set('data_fim', filtros.data_fim);
  if (filtros.apontador)        params.set('apontador', filtros.apontador);
  if (filtros.turno)            params.set('turno', filtros.turno);
  if (filtros.dia_operacional)  params.set('dia_operacional', filtros.dia_operacional);
  if (filtros.limite)           params.set('limite', String(filtros.limite));
  const qs = params.toString();
  try {
    return await fetchComTimeout(`${BACKEND_URL}/api/apontamentos/historico${qs ? '?' + qs : ''}`);
  } catch (err) {
    if (erroDeConexao(err)) return { success: false, offline: true };
    return { success: false, error: err.message };
  }
}

/**
 * Busca um apontamento específico pelo ID.
 */
export async function getApontamentoById(id) {
  try {
    return await fetchComTimeout(`${BACKEND_URL}/api/apontamento/${id}`);
  } catch (err) {
    if (erroDeConexao(err)) return { success: false, offline: true };
    return { success: false, error: err.message };
  }
}

/**
 * Corrige um apontamento existente.
 * @param {number} id - ID do apontamento
 * @param {Object} dados - Campos corrigidos
 */
export async function corrigirApontamento(id, dados) {
  const body = { ...dados, client_uuid: dados.client_uuid || gerarUUID() };
  try {
    return await fetchComTimeout(`${BACKEND_URL}/api/apontamento/${id}`, {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    });
  } catch (err) {
    if (erroDeConexao(err)) {
      await enfileirarOperacao('CORRIGIR_APT', `/api/apontamento/${id}`, 'PUT', body);
      return { success: true, offline: true, queued: true, data: { apontamento_id: id } };
    }
    return { success: false, error: err.message };
  }
}

/**
 * Cria apontamento RETROATIVO (admin/editor) — registra producao de turno
 * passado. dados.dt_evento_real e dados.justificativa sao obrigatorios.
 * Sem fila offline: e fluxo de admin, exige conexao.
 */
export async function criarApontamentoRetroativo(dados) {
  const body = { ...dados, client_uuid: dados.client_uuid || gerarUUID() };
  try {
    return await fetchComTimeout(`${BACKEND_URL}/api/apontamento/retroativo`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    });
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Busca log de edições de um apontamento.
 */
export async function getLogsEdicao(apontamentoId) {
  try {
    // O endpoint GET /api/apontamento/:id já retorna log_edicoes
    const res = await fetchComTimeout(`${BACKEND_URL}/api/apontamento/${apontamentoId}`);
    if (res.success && res.data) return { success: true, data: res.data.log_edicoes || [] };
    return { success: false, data: [] };
  } catch (err) {
    return { success: false, data: [] };
  }
}

// ---------------------------------------------------------------------------
// Paradas em aberto — maquina parou sem apontamento ainda
// ---------------------------------------------------------------------------

export async function getParadasAbertas() {
  try {
    return await fetchComTimeout(`${BACKEND_URL}/api/paradas-abertas`);
  } catch (err) {
    if (erroDeConexao(err)) return { success: false, offline: true, data: [] };
    return { success: false, error: err.message, data: [] };
  }
}

export async function registrarParadaAberta({ maquina_cod, operador_cod, cod_motivo, motivo }) {
  try {
    return await fetchComTimeout(`${BACKEND_URL}/api/paradas-abertas`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ maquina_cod, operador_cod, cod_motivo, motivo }),
    });
  } catch (err) {
    if (erroDeConexao(err)) return { success: false, offline: true };
    return { success: false, error: err.message };
  }
}

export async function fecharParadaAberta(maquinaCod) {
  try {
    return await fetchComTimeout(`${BACKEND_URL}/api/paradas-abertas/${encodeURIComponent(maquinaCod)}`, {
      method: 'DELETE',
    });
  } catch (err) {
    if (erroDeConexao(err)) return { success: false, offline: true };
    return { success: false, error: err.message };
  }
}

// Parada de OP (nao da maquina): registra OP_PAUSADA com inicio[->fim opcional].
// Se fim for informado, tambem grava OP_RETOMADA em fim. NAO mexe na maquina
// (OP_ATIVA continua, OP_INICIADA fica aberta). Usado na Tela 2.
export async function registrarParadaOp({ op_numero, maquina_cod, operador_cod, turno, cod_motivo_pausa, motivo_pausa, inicio, fim }) {
  try {
    return await fetchComTimeout(`${BACKEND_URL}/api/op/registrar-parada`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op_numero, maquina_cod, operador_cod, turno, cod_motivo_pausa, motivo_pausa, inicio, fim }),
    });
  } catch (err) {
    if (erroDeConexao(err)) return { success: false, offline: true, error: 'Sem conexão' };
    return { success: false, error: err.message };
  }
}

// Parada de maquina ja fechada (inicio + fim) — registrada da tela de OP,
// sem criar apontamento. Grava um evento PARADA_AVULSA no historico.
export async function registrarParadaAvulsa({ maquina_cod, operador_cod, cod_motivo, motivo, inicio, fim }) {
  try {
    return await fetchComTimeout(`${BACKEND_URL}/api/paradas-avulsas`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ maquina_cod, operador_cod, cod_motivo, motivo, inicio, fim }),
    });
  } catch (err) {
    if (erroDeConexao(err)) return { success: false, offline: true };
    return { success: false, error: err.message };
  }
}

/**
 * Reabre uma OP que foi encerrada por engano.
 * @param {number} apontamentoId - ID do apontamento que encerrou a OP
 */
export async function reabrirOP(apontamentoId) {
  const body = { client_uuid: gerarUUID() };
  try {
    return await fetchComTimeout(`${BACKEND_URL}/api/apontamento/${apontamentoId}/reabrir-op`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    });
  } catch (err) {
    if (erroDeConexao(err)) {
      await enfileirarOperacao('REABRIR_OP', `/api/apontamento/${apontamentoId}/reabrir-op`, 'POST', body);
      return { success: true, offline: true, queued: true, data: { apontamento_id: apontamentoId } };
    }
    return { success: false, error: err.message };
  }
}
