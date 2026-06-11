/**
 * db.js — Wrapper do IndexedDB para persistência offline.
 * Banco: "apontamento-db" versão 1
 *
 * Object stores:
 *   - fila-apontamentos : apontamentos aguardando sync com backend
 *   - fila-eventos      : eventos de OP (início/encerramento) aguardando sync
 *   - cache-maquinas    : lista de máquinas cacheada localmente
 *   - cache-ops         : OPs por máquina cacheadas localmente
 */

const DB_NAME    = 'apontamento-db';
const DB_VERSION = 4;

let _db = null;

/**
 * Abre (ou reabre) a conexão com o IndexedDB.
 * @returns {Promise<IDBDatabase>}
 */
function abrirBanco() {
  if (_db) return Promise.resolve(_db);

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;

      // Fila de apontamentos offline
      if (!db.objectStoreNames.contains('fila-apontamentos')) {
        db.createObjectStore('fila-apontamentos', { keyPath: 'id', autoIncrement: true });
      }

      // Fila de eventos offline (início/encerramento de OP)
      if (!db.objectStoreNames.contains('fila-eventos')) {
        db.createObjectStore('fila-eventos', { keyPath: 'id', autoIncrement: true });
      }

      // Cache de centros de trabalho
      if (!db.objectStoreNames.contains('cache-centros')) {
        db.createObjectStore('cache-centros', { keyPath: 'COD' });
      }

      // Cache de máquinas (key: cod da máquina)
      if (!db.objectStoreNames.contains('cache-maquinas')) {
        db.createObjectStore('cache-maquinas', { keyPath: 'COD' });
      }

      // Cache de OPs por máquina (key: cod da máquina como string)
      if (!db.objectStoreNames.contains('cache-ops')) {
        db.createObjectStore('cache-ops', { keyPath: 'key' });
      }

      // Cache de operadores
      if (!db.objectStoreNames.contains('cache-operadores')) {
        db.createObjectStore('cache-operadores', { keyPath: 'matricula' });
      }

      // Cache de motivos de parada
      if (!db.objectStoreNames.contains('cache-motivos')) {
        db.createObjectStore('cache-motivos', { keyPath: 'COD' });
      }


      // Fila de operacoes (reabrir OP, corrigir apontamento, etc.) com retry.
      // Necessario para que acoes feitas offline nao se percam.
      if (!db.objectStoreNames.contains('fila-operacoes')) {
        db.createObjectStore('fila-operacoes', { keyPath: 'id', autoIncrement: true });
      }

    };

    request.onsuccess = (event) => {
      _db = event.target.result;
      resolve(_db);
    };

    request.onerror = (event) => {
      reject(new Error('Erro ao abrir IndexedDB: ' + event.target.error));
    };
  });
}

/**
 * Adiciona um item na fila especificada.
 * @param {string} store - Nome do object store
 * @param {Object} dados - Dados a armazenar (sem 'id', é autoIncrement)
 * @returns {Promise<number>} ID gerado
 */
export async function adicionarNaFila(store, dados) {
  const db = await abrirBanco();
  return new Promise((resolve, reject) => {
    const tx      = db.transaction(store, 'readwrite');
    const request = tx.objectStore(store).add({ ...dados, _adicionado_em: new Date().toISOString() });
    request.onsuccess = () => resolve(request.result);
    request.onerror   = () => reject(request.error);
  });
}

/**
 * Lista todos os itens da fila em ordem de inserção.
 * @param {string} store
 * @returns {Promise<Array>}
 */
export async function listarFila(store) {
  const db = await abrirBanco();
  return new Promise((resolve, reject) => {
    const tx      = db.transaction(store, 'readonly');
    const request = tx.objectStore(store).getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror   = () => reject(request.error);
  });
}

/**
 * Remove um item da fila pelo seu ID.
 * @param {string} store
 * @param {number} id
 */
export async function removerDaFila(store, id) {
  const db = await abrirBanco();
  return new Promise((resolve, reject) => {
    const tx      = db.transaction(store, 'readwrite');
    const request = tx.objectStore(store).delete(id);
    request.onsuccess = () => resolve();
    request.onerror   = () => reject(request.error);
  });
}

/**
 * Salva dados no cache (substitui se já existir pela mesma key).
 * @param {string} store
 * @param {Object|Array} dados - Se Array, salva cada item individualmente
 */
export async function salvarCache(store, dados) {
  const db    = await abrirBanco();
  const itens = Array.isArray(dados) ? dados : [dados];

  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    const os = tx.objectStore(store);

    for (const item of itens) {
      os.put(item);
    }

    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(tx.error);
  });
}

/**
 * Lê um item do cache pela sua key.
 * @param {string} store
 * @param {string|number} key
 * @returns {Promise<Object|undefined>}
 */
export async function lerCache(store, key) {
  const db = await abrirBanco();
  return new Promise((resolve, reject) => {
    const tx      = db.transaction(store, 'readonly');
    const request = tx.objectStore(store).get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror   = () => reject(request.error);
  });
}

/**
 * Retorna todos os itens de um cache.
 * @param {string} store
 * @returns {Promise<Array>}
 */
export async function lerTodoCache(store) {
  const db = await abrirBanco();
  return new Promise((resolve, reject) => {
    const tx      = db.transaction(store, 'readonly');
    const request = tx.objectStore(store).getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror   = () => reject(request.error);
  });
}

// Inicializar banco ao carregar o módulo
abrirBanco().catch(err => console.error('[DB] Erro na inicialização:', err.message));
