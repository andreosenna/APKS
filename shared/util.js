/**
 * utils.js — Helpers compartilhados entre telas e componentes.
 *
 * Zero dependencias. Cada funcao preserva o comportamento visual exato das
 * versoes duplicadas anteriores — divergencias historicas foram mantidas
 * como variantes nomeadas para evitar mudanca de UI.
 */

// Escapa HTML para injecao segura em template strings.
export function escHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Formato BR com separador de milhar e virgula decimal ("1.234,5").
// Usado no painel (valores grandes).
export function formatarNumBR(n, dec = 1) {
  if (n === null || n === undefined) return '—';
  return Number(n).toLocaleString('pt-BR', {
    minimumFractionDigits: dec,
    maximumFractionDigits: dec,
  });
}

// Formato simples com ponto decimal ("1.5"). Usado no historico.
export function formatarNumFixo(n, dec = 1) {
  if (n === null || n === undefined) return '—';
  return Number(n).toFixed(dec);
}

// "YYYY-MM-DD" da data atual em fuso local (sem virar o dia em UTC).
export function hojeISO() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// "dd/mm" — usado no painel.
export function formatarDataDiaMes(dt) {
  if (!dt) return '—';
  const d = new Date(dt);
  const dia = String(d.getDate()).padStart(2, '0');
  const mes = String(d.getMonth() + 1).padStart(2, '0');
  return `${dia}/${mes}`;
}

// "dd/mm HH:MM" — usado no historico.
export function formatarDataDiaMesHora(dt) {
  if (!dt) return '—';
  const d = new Date(dt);
  const dia = String(d.getDate()).padStart(2, '0');
  const mes = String(d.getMonth() + 1).padStart(2, '0');
  const hora = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${dia}/${mes} ${hora}:${min}`;
}

// Formato via toLocaleString (com virgula entre data e hora) — usado em s2-op.
export function formatarDataHoraLocale(isoString) {
  try {
    const d = new Date(isoString);
    return d.toLocaleString('pt-BR', {
      day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
    });
  } catch { return isoString; }
}

// "há 42 min" / "há 2h30" — usado em s1-maquina (paradas em aberto).
export function formatarDuracaoHa(inicioIso) {
  if (!inicioIso) return '';
  const mins = Math.floor((Date.now() - new Date(inicioIso).getTime()) / 60000);
  if (mins < 1)  return 'há < 1 min';
  if (mins < 60) return `há ${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `há ${h}h${String(m).padStart(2, '0')}`;
}

// "agora" / "42m" / "2h 30m" — usado em s2-op (badge de OP pausada).
export function formatarDuracaoCurta(dtInicio) {
  if (!dtInicio) return '—';
  const ms = Date.now() - new Date(dtInicio).getTime();
  if (ms < 60_000) return 'agora';
  const min = Math.floor(ms / 60_000);
  if (min < 60) return min + 'm';
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? (h + 'h ' + m + 'm') : (h + 'h');
}
