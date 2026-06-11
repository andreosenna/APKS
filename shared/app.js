/**
 * app.js — Ponto de entrada principal do PWA.
 * Gerencia o estado global e a navegação entre telas.
 * Fluxo: Tela 0 (Centro) → 1 (Máquina) → 2 (OP) → 3 (Apontamento)
 */

import { sincronizar, atualizarBadgeSync } from './sync.js';
import { getCentrosTrabalho, getMotivosParada, getOperadores, authMe, temToken, logout, lerRole, getTurnoAtual, fecharTurno } from './api.js';
import { salvarCache }            from './db.js';
import { carregarPerfil, limparPerfil } from './perfil.js';
import { confirmar }              from './modal.js';
import { desvioHorarioTurno }     from './shared/turno-janela.mjs';
import { render as renderLogin  } from './screens/s-login.js';
import { render as renderTurno  } from './screens/s-turno.js';
import { render as renderTela0 } from './screens/s0-centro.js';
import { render as renderTela1 } from './screens/s1-maquina.js';
import { render as renderTela2 } from './screens/s2-op.js';
import { render as renderTela3 } from './screens/s3-apontamento.js';
import { render as renderTela4 } from './screens/s4-historico.js';
import { render as renderTela5 } from './screens/s5-painel.js';
import { render as renderConsolidado } from './screens/s6-consolidado.js';

// ---------------------------------------------------------------------------
// Estado global do app
// ---------------------------------------------------------------------------

export const estado = {
  tela:               0,
  user:               null,   // { username }  — preenchido apos login AD
  centroTrabalho:     null,   // { COD, DESCRICAO, TIPO }
  maquinaSelecionada: null,   // { COD, DESCRICAO, SETOR, STATUS, OP_ATIVA, CENTRO_TRAB_COD }
  opSelecionada:      null,   // { op_numero, produto, ... }
  operadorCod:        null,   // = user.username apos login
  turno:              null,   // 'A' | 'B' | 'C' | 'D' — espelha turnoAberto.turno
  turnoAberto:        null,   // { id, turno, dt_abertura, ... } do APA010 (null = sem turno)
  opDivergiu:         false,
  opDrummerSugerida:  null,
};

// ---------------------------------------------------------------------------
// Navegação entre telas
// ---------------------------------------------------------------------------

// Guarda de navegacao (A9): uma tela com dados nao salvos registra aqui uma
// funcao que retorna true quando ha algo a perder. Os botoes do header
// consultam a guarda antes de sair. Trocar de tela limpa a guarda.
let _guardaNavegacao = null;
export function registrarGuardaNavegacao(fn) {
  _guardaNavegacao = typeof fn === 'function' ? fn : null;
}

// Retorna true se a navegacao pode prosseguir. Se a tela atual tem dados nao
// salvos, pede confirmacao ao usuario antes.
export async function podeNavegar() {
  if (typeof _guardaNavegacao !== 'function') return true;
  let sujo = false;
  try { sujo = !!_guardaNavegacao(); } catch (_) { sujo = false; }
  if (!sujo) return true;
  return confirmar({
    titulo: 'Sair sem salvar?',
    mensagem: 'Você tem dados preenchidos que ainda não foram enviados. Se sair agora eles serão perdidos.',
    tipo: 'warning',
    textoOk: 'Descartar e sair',
    textoCancelar: 'Continuar aqui',
  });
}

export function irParaTela(numero) {
  // Trocar de tela invalida a guarda de navegacao da tela anterior.
  _guardaNavegacao = null;
  // Visualizador nao acessa Painel (5). Pode acessar Historico (4) em modo read-only.
  if (numero === 5 && lerRole() === 'visualizador') {
    console.warn('[APP] visualizador tentou acessar tela', numero, '— bloqueado');
    numero = 1;
  }
  estado.tela = numero;

  // Tela de login esconde steps e header da app (header continua visivel mas
  // sem botao painel/historico — implementado via classe no body)
  const stepsBar = document.getElementById('steps');
  const ehLogin = numero === 'login';
  const ehTurno = numero === 'turno';
  if (stepsBar) stepsBar.style.display = (ehLogin || ehTurno || numero === 4 || numero === 5 || numero === 'consolidado') ? 'none' : 'flex';
  document.body.classList.toggle('em-login', ehLogin || ehTurno);

  if (numero >= 0 && numero <= 3) atualizarSteps(numero);

  const container = document.getElementById('screens');
  container.innerHTML = '';

  switch (numero) {
    case 'login': renderLogin(container); break;
    case 'turno': renderTurno(container); break;
    case 0: renderTela0(container); break;
    case 1: renderTela1(container); break;
    case 2: renderTela2(container); break;
    case 3: renderTela3(container); break;
    case 4: renderTela4(container); break;
    case 5: renderTela5(container); break;
    case 'consolidado': renderConsolidado(container); break;
  }

  container.scrollTop = 0;
}

/**
 * Atualiza o indicador visual de etapas (4 dots: 0-3).
 */
function atualizarSteps(telaAtual) {
  for (let i = 0; i <= 3; i++) {
    const dot = document.getElementById(`dot-${i}`);
    if (!dot) continue;

    dot.classList.remove('active', 'done');
    if (i < telaAtual)  dot.classList.add('done');
    if (i === telaAtual) dot.classList.add('active');

    dot.textContent = i < telaAtual ? '✓' : String(i + 1);
  }
}

// ---------------------------------------------------------------------------
// Pré-carga de cache para funcionamento offline
// ---------------------------------------------------------------------------

/**
 * Busca e armazena em IndexedDB os dados de suporte (centros, motivos, operadores).
 * Feito em paralelo; falhas são silenciosas (não bloqueiam a UI).
 */
async function preCacharDados() {
  await Promise.allSettled([
    getCentrosTrabalho().then(r => {
      if (r.success && r.data?.length) salvarCache('cache-centros', r.data);
    }),
    getMotivosParada().then(r => {
      if (r.success && r.data?.length) salvarCache('cache-motivos', r.data);
    }),
    getOperadores().then(r => {
      if (r.success && r.data?.length) salvarCache('cache-operadores', r.data);
    }),
  ]);
}

// ---------------------------------------------------------------------------
// Indicador de status online/offline
// ---------------------------------------------------------------------------

/**
 * Nomes amigáveis para o modo de integração (sem citar sistemas externos).
 */
const MODO_LABELS = {
  EXCEL:        'Modo arquivo',
  PROTHEUS_SQL: 'Modo integrado',
  PROTHEUS:     'Modo integrado',
  MOCK:         'Modo demo',
};

/**
 * Busca o status da integração e:
 *   - Exibe banner de aviso se DB_MOCK=true ou outro problema
 *   - Preenche o badge discreto do modo ao lado do "Online"
 */
async function verificarBannerAviso() {
  const banner      = document.getElementById('aviso-global');
  const badgeModo   = document.getElementById('modo-badge');

  // No Vercel (não-local), esconder badges de modo/storage — não se aplicam
  const host = window.location.hostname;
  const isLocal = host === 'localhost' || host === '127.0.0.1' || /^192\.168\./.test(host) || /^10\./.test(host);
  if (!isLocal) {
    if (badgeModo) badgeModo.style.display = 'none';
    const storageBadge = document.getElementById('storage-badge');
    if (storageBadge) storageBadge.style.display = 'none';
    return;
  }

  try {
    const backendUrl = window.APP_CONFIG?.backendUrl || 'http://localhost:3001';
    const res = await fetch(`${backendUrl}/api/integracao/status`).then(r => r.json());
    if (!res.success) return;
    const { aviso, db_mock, node_env, modo } = res.data || {};

    if (banner && aviso) {
      banner.textContent = '⚠ ' + aviso;
      banner.className = 'aviso-global' + (node_env === 'production' ? ' critico' : '');
      banner.style.display = 'block';
    }

    if (badgeModo) {
      const label = MODO_LABELS[modo] || 'Modo integrado';
      badgeModo.textContent = label;
      badgeModo.style.display = 'inline-block';
    }
  } catch (_) { /* silencioso */ }
}

const atualizarBadgeConexao = atualizarBadgeSync;

/**
 * Atualiza o badge de storage (rede corporativa / fallback local / erro).
 * Some se o servidor não tem STORAGE_DIR configurado.
 */
async function atualizarStorageBadge() {
  const el = document.getElementById('storage-badge');
  if (!el) return;
  // No Vercel, esconder — storage é via Blob, não disco
  const host = window.location.hostname;
  const isLocal = host === 'localhost' || host === '127.0.0.1' || /^192\.168\./.test(host) || /^10\./.test(host);
  if (!isLocal) { el.style.display = 'none'; return; }
  try {
    const backendUrl = window.APP_CONFIG?.backendUrl || 'http://localhost:3001';
    const res = await fetch(`${backendUrl}/api/storage/status`).then(r => r.json());
    if (!res.success) { el.style.display = 'none'; return; }
    const { modo, path_ativo, last_write_iso, last_error } = res.data || {};

    if (modo === 'desabilitado') { el.style.display = 'none'; return; }

    const estilos = {
      rede:     { label: '💾 Rede',        cor: '#16a34a', bg: '#dcfce7' },
      fallback: { label: '⚠ Local',        cor: '#92400e', bg: '#fef3c7' },
      erro:     { label: '✖ Sem storage',  cor: '#991b1b', bg: '#fee2e2' },
    };
    const s = estilos[modo] || estilos.erro;
    el.textContent = s.label;
    el.style.color = s.cor;
    el.style.background = s.bg;
    el.style.display = 'inline-block';
    el.title = [
      `Path: ${path_ativo || '(n/a)'}`,
      last_write_iso ? `Ultimo write: ${new Date(last_write_iso).toLocaleString('pt-BR')}` : 'Sem writes ainda',
      last_error ? `Erro: ${last_error}` : '',
    ].filter(Boolean).join('\n');
  } catch (_) {
    el.style.display = 'none';
  }
}

// ---------------------------------------------------------------------------
// Inicialização
// ---------------------------------------------------------------------------

async function inicializar() {
  // Registrar Service Worker
  if ('serviceWorker' in navigator) {
    try {
      await navigator.serviceWorker.register('/sw.js');
      console.log('[APP] Service Worker registrado.');
    } catch (err) {
      console.warn('[APP] Falha ao registrar Service Worker:', err.message);
    }
  }

  // Monitorar conexão
  atualizarBadgeConexao();
  window.addEventListener('online',  () => {
    atualizarBadgeConexao();
    sincronizar().catch(() => {});
    preCacharDados().catch(() => {});
  });
  window.addEventListener('offline', atualizarBadgeConexao);

  // Sincronização inicial + pré-cache em background
  sincronizar().catch(err => console.warn('[APP] Erro na sync inicial:', err.message));
  preCacharDados().catch(err => console.warn('[APP] Erro no pré-cache:', err.message));

  // Verificar status do backend e mostrar banner de aviso se necessário
  verificarBannerAviso().catch(() => {});

  // Badge de storage (rede / fallback / erro) atualizado periodicamente
  atualizarStorageBadge();
  setInterval(atualizarStorageBadge, 60000);

  // Botões do header — eventos só registrados aqui; visibilidade controlada
  // pela atualizarBadgePerfil (sem login, todos ocultos pra evitar vazamento).
  const btnHist = document.getElementById('btn-historico');
  if (btnHist) btnHist.addEventListener('click', async () => { if (await podeNavegar()) irParaTela(4); });

  const btnPainel = document.getElementById('btn-painel');
  if (btnPainel) {
    btnPainel.addEventListener('click', async () => { if (await podeNavegar()) irParaTela(5); });
  }

  // Estado inicial dos botoes (escondidos ate login).
  atualizarBadgePerfil();

  // Botão Home — volta ao início, resetando a seleção para evitar dados residuais
  const btnHome = document.getElementById('btn-home');
  if (btnHome) {
    btnHome.addEventListener('click', async () => {
      if (!(await podeNavegar())) return;
      estado.maquinaSelecionada = null;
      estado.opSelecionada      = null;
      estado.opDivergiu         = false;
      estado.opDrummerSugerida  = null;
      // Mantem centro/operador se ja havia perfil (login rapido)
      const perfil = carregarPerfil();
      if (perfil?.centroTrabalho) irParaTela(1);
      else {
        estado.centroTrabalho = null;
        estado.operadorCod    = null;
        irParaTela(0);
      }
    });
  }

  // Botao "Sair" no header — desloga e volta pra tela de login
  const btnTrocarOp = document.getElementById('btn-trocar-operador');
  if (btnTrocarOp) {
    btnTrocarOp.textContent = '↩ Sair';
    btnTrocarOp.title = 'Sair (desloga do AD)';
    btnTrocarOp.addEventListener('click', async () => {
      if (!(await podeNavegar())) return;
      try { await logout(); } catch (_) {}
      limparPerfil();
      estado.user           = null;
      estado.centroTrabalho = null;
      estado.operadorCod    = null;
      estado.turno          = null;
      estado.turnoAberto    = null;
      estado.maquinaSelecionada = null;
      estado.opSelecionada  = null;
      atualizarBadgePerfil();
      atualizarBadgeTurno();
      irParaTela('login');
    });
  }

  // Botao de turno no header — dois modos. Sem turno aberto: leva a tela de
  // abrir turno. Com turno aberto: fecha o turno. Turno e opcional para todos
  // os papeis (admin inclusive), mas e preciso ter um aberto para apontar.
  const btnTurno = document.getElementById('btn-fechar-turno');
  if (btnTurno) {
    btnTurno.addEventListener('click', async () => {
      if (!estado.turnoAberto) {
        if (await podeNavegar()) irParaTela('turno');
        return;
      }
      // Turno global: fechar afeta TODOS os apontadores do sistema. Confirmacao
      // reforcada (danger), deixando isso explicito.
      const turnoLetra = estado.turnoAberto.turno;
      const dev = desvioHorarioTurno(turnoLetra, 'fechar');
      let msgFechar = `Isto vai FECHAR o turno ${turnoLetra} para TODOS os `
        + `apontadores do sistema — não só para você. Ninguém poderá apontar `
        + `até que um novo turno seja aberto.\n\n`
        + `Todas as OPs em produção serão pausadas automaticamente. O próximo `
        + `turno precisará retomar cada uma manualmente na tela de seleção de máquina.`;
      if (dev.foraDoHorario) {
        msgFechar = `⚠ O turno ${turnoLetra} normalmente fecha às ${dev.esperadoHHMM}, `
          + `mas agora são ${dev.agoraHHMM} — ${dev.diferencaTexto} de diferença.`
          + `\n\n` + msgFechar;
      }
      const ok = await confirmar({
        titulo: `Fechar o turno ${turnoLetra} para todos?`,
        mensagem: msgFechar,
        tipo: 'danger',
        textoOk: `Fechar turno ${turnoLetra} para todos`,
        textoCancelar: 'Cancelar',
      });
      if (!ok) return;
      const r = await fecharTurno();
      if (r && (r.success || r.error === 'sem_turno_aberto')) {
        estado.turnoAberto = null;
        atualizarBadgeTurno();
        const n = r?.data?.opsPausadas ?? 0;
        const falhas = r?.data?.falhas ?? 0;
        let msgToast;
        if (n === 0) {
          msgToast = 'Turno fechado. Nenhuma OP estava em produção.';
        } else {
          msgToast = `Turno fechado. ${n} OP${n > 1 ? 's' : ''} pausada${n > 1 ? 's' : ''} automaticamente. `
            + `O próximo turno deverá retomar cada uma na tela de seleção de máquina.`;
        }
        if (falhas > 0) {
          msgToast += `\n\n⚠ ${falhas} falha(s) ao pausar — verifique o histórico.`;
        }
        await confirmar({
          titulo: 'Turno fechado',
          mensagem: msgToast,
          tipo: 'info',
          textoOk: 'Entendi',
          textoCancelar: '',
        });
      } else {
        await confirmar({
          titulo: 'Erro ao fechar turno',
          mensagem: 'Não foi possível fechar o turno: ' + ((r && r.error) || 'tente novamente'),
          tipo: 'danger',
          textoOk: 'Entendi',
          textoCancelar: '',
        });
      }
    });
  }

  // Se token expirou em alguma chamada, volta pra login.
  window.addEventListener('auth:expired', () => {
    estado.user           = null;
    estado.operadorCod    = null;
    estado.turno          = null;
    estado.turnoAberto    = null;
    estado.maquinaSelecionada = null;
    estado.opSelecionada  = null;
    atualizarBadgePerfil();
    atualizarBadgeTurno();
    irParaTela('login');
  });

  // Sem token: vai direto pra tela de login
  if (!temToken()) {
    irParaTela('login');
    return;
  }

  // Tem token: valida no backend e segue
  const me = await authMe();
  if (!me?.success) {
    // Sem rede: deixa o user navegar mesmo assim — apontamentos vao pra fila e
    // serao reenviados quando voltar online. Quando o token expirar de fato,
    // o handler `auth:expired` redireciona pro login.
    if (me?.offline) {
      console.warn('[APP] Offline no boot — seguindo com token salvo');
    } else {
      irParaTela('login');
      return;
    }
  } else {
    estado.user = me.user || null;
  }

  // Apos autenticar: segue pro fluxo normal. Turno e opcional — o header
  // mostra "ABRIR TURNO" ou "FECHAR TURNO" conforme o estado.
  atualizarBadgePerfil();
  await entrarNoAppAutenticado();
}

// Atualiza o botao de turno no header: "FECHAR TURNO X" quando ha turno aberto,
// "ABRIR TURNO" quando nao ha. Escondido quando nao ha sessao (tela de login).
// Mantem estado.turno em sincronia com estado.turnoAberto.turno (telas legadas
// continuam lendo estado.turno).
export function atualizarBadgeTurno() {
  estado.turno = estado.turnoAberto?.turno || null;
  const btn = document.getElementById('btn-fechar-turno');
  if (!btn) return;
  if (!temToken()) { btn.style.display = 'none'; return; }
  const aberto = estado.turnoAberto?.turno;
  if (aberto) {
    btn.innerHTML = '⏹ FECHAR TURNO ' + aberto;
    btn.title = 'Fechar o turno ' + aberto;
  } else {
    btn.innerHTML = '▶ ABRIR TURNO';
    btn.title = 'Abrir um turno para poder apontar';
  }
  btn.style.display = 'inline-flex';
}

// Turno global: o turno e compartilhado por todo o sistema. Quem ja esta logado
// precisa ver quando outro apontador abre, troca ou fecha o turno — entao
// re-consultamos o turno atual a cada 30s e atualizamos o badge do header.
setInterval(async () => {
  if (!temToken()) return;
  try {
    const r = await getTurnoAtual();
    if (!r || !r.success) return;   // offline / erro: mantem o estado atual
    estado.turnoAberto = r.data || null;
    atualizarBadgeTurno();
  } catch (_) { /* silencioso — a proxima checagem tenta de novo */ }
}, 30000);

// Decide a tela inicial apos autenticar. Turno e opcional para todos os papeis
// — ninguem e forcado a abrir um turno aqui. Buscamos o turno atual apenas
// para o header refletir a realidade (ABRIR TURNO vs FECHAR TURNO).
export async function entrarNoAppAutenticado() {
  const r = await getTurnoAtual();
  if (r && r.success) estado.turnoAberto = r.data || null;
  // r.offline: nao da pra confirmar o turno — segue com o que houver em memoria.
  atualizarBadgeTurno();

  const perfil = carregarPerfil();
  if (perfil?.centroTrabalho) {
    estado.centroTrabalho = perfil.centroTrabalho;
    irParaTela(1);
  } else {
    irParaTela(0);
  }
}

// Exibe o usuario logado no header (vem do JWT, nao mais do perfil)
// Tambem controla a visibilidade dos botoes do header — sem login, nada aparece
// (evita vazamento de centros/maquinas/OPs antes da autenticacao).
export function atualizarBadgePerfil() {
  const el        = document.getElementById('badge-perfil');
  const btnTrocar = document.getElementById('btn-trocar-operador');
  const btnHome   = document.getElementById('btn-home');
  const btnPainel = document.getElementById('btn-painel');
  const btnHist   = document.getElementById('btn-historico');
  const username  = estado.user?.username;
  const logado    = !!username;

  // Badge do operador + botao Sair
  if (el && logado) {
    el.textContent = `👷 ${username}`;
    el.style.display = 'inline-flex';
    if (btnTrocar) btnTrocar.style.display = 'inline-flex';
  } else {
    if (el) el.style.display = 'none';
    if (btnTrocar) btnTrocar.style.display = 'none';
  }

  // Botoes de navegacao do header — so aparecem com login feito
  if (btnHome) btnHome.style.display = logado ? 'inline-flex' : 'none';
  if (btnHist) btnHist.style.display = logado ? 'inline-flex' : 'none';
  if (btnPainel) {
    // Painel respeita tambem a regra de role (visualizador nao ve)
    const ehVisualizador = lerRole() === 'visualizador';
    btnPainel.style.display = (logado && !ehVisualizador) ? 'inline-flex' : 'none';
  }
}

inicializar();
