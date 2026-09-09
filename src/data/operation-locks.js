/**
 * Cross-tab coordination for operations that snapshot, replace, or erase the
 * user's data. A token lets composed operations share one Web Lock without
 * trying to acquire the same non-reentrant lock twice.
 */

export const DATA_LIFECYCLE_LOCK_NAME = 'librelog:data-lifecycle:v1';
export const DATA_WRITE_LOCK_NAME = 'librelog:data-write:v1';
export const DATA_DESTRUCTIVE_LOCK_NAME = 'librelog:data-destructive:v1';
export const DATA_MUTATION_GENERATION_STORAGE_KEY = 'librelog_data_generation_v1';

const activeTokens = new WeakSet();
const activeWriteTokens = new WeakSet();
const activeDestructiveTokens = new WeakSet();
const activeMutationGuardTokens = new WeakSet();
const localLockStates = new Map();
let inMemoryMutationGeneration = 0;

function readStoredMutationGeneration() {
  try {
    const storage = globalThis.localStorage;
    if (!storage) return 'unavailable';
    const stored = storage.getItem(DATA_MUTATION_GENERATION_STORAGE_KEY);
    return stored != null && /^\d+$/.test(stored) ? stored : 'none';
  } catch {
    return 'unavailable';
  }
}

export function captureDataMutationGeneration() {
  // Always include the context-local epoch. If storage is readable but a later
  // write is denied, the in-memory component must still invalidate stale work.
  return `storage:${readStoredMutationGeneration()}:memory:${inMemoryMutationGeneration}`;
}

function advanceDataMutationGeneration() {
  inMemoryMutationGeneration += 1;
  try {
    const storage = globalThis.localStorage;
    const stored = storage?.getItem(DATA_MUTATION_GENERATION_STORAGE_KEY);
    const current = stored != null && /^\d+$/.test(stored) ? BigInt(stored) : 0n;
    storage?.setItem(DATA_MUTATION_GENERATION_STORAGE_KEY, String(current + 1n));
  } catch {
    // The local generation still protects this JavaScript context.
  }
  return captureDataMutationGeneration();
}

function getLocalLockState(name) {
  let state = localLockStates.get(name);
  if (!state) {
    state = { activeMode: null, activeCount: 0, queue: [] };
    localLockStates.set(name, state);
  }
  return state;
}

function localLockAvailable(state, mode) {
  if (state.queue.length > 0) return false;
  if (mode === 'exclusive') return state.activeCount === 0;
  return state.activeMode !== 'exclusive';
}

function drainLocalLock(name, state) {
  if (state.activeMode === 'exclusive') return;
  if (state.activeMode === 'shared' && state.queue[0]?.mode === 'exclusive') return;
  if (state.queue.length === 0) {
    if (state.activeCount === 0) localLockStates.delete(name);
    return;
  }

  const grantNext = () => {
    const request = state.queue.shift();
    state.activeMode = request.mode;
    state.activeCount += 1;
    const release = () => {
      state.activeCount -= 1;
      if (state.activeCount === 0) state.activeMode = null;
      drainLocalLock(name, state);
    };
    Promise.resolve()
      .then(() => request.operation({ name, mode: request.mode }))
      .then(
        value => {
          release();
          request.resolve(value);
        },
        error => {
          release();
          request.reject(error);
        },
      );
  };

  if (state.activeCount === 0 && state.queue[0].mode === 'exclusive') {
    grantNext();
    return;
  }
  while (state.queue[0]?.mode === 'shared' && state.activeMode !== 'exclusive') {
    grantNext();
  }
}

const localLockManager = {
  request(name, options, operation) {
    const mode = options?.mode === 'shared' ? 'shared' : 'exclusive';
    const state = getLocalLockState(name);
    if (options?.ifAvailable && !localLockAvailable(state, mode)) {
      return Promise.resolve().then(() => operation(null));
    }
    return new Promise((resolve, reject) => {
      state.queue.push({ mode, operation, resolve, reject });
      drainLocalLock(name, state);
    });
  },
};

/** Use a fair, context-local lock queue when the Web Locks API is unavailable. */
export function getDataLockManager(lockManager = globalThis.navigator?.locks) {
  return lockManager?.request ? lockManager : localLockManager;
}

export function assertDataMutationGenerationCurrent(expectedGeneration) {
  if (expectedGeneration == null || expectedGeneration === captureDataMutationGeneration()) return;
  const error = new Error('This operation was cancelled because local data was cleared or replaced.');
  error.code = 'DATA_OPERATION_INVALIDATED';
  throw error;
}

export function hasDataLifecycleLock(token) {
  return token != null && typeof token === 'object' && activeTokens.has(token);
}

export function hasDataWriteLock(token) {
  return token != null && typeof token === 'object' && activeWriteTokens.has(token);
}

export function hasDataDestructiveLock(token) {
  return token != null && typeof token === 'object' && activeDestructiveTokens.has(token);
}

export function hasDataMutationGuard(token) {
  return token != null && typeof token === 'object' && activeMutationGuardTokens.has(token);
}

export async function withDataLifecycleLock(
  operation,
  lockManager = globalThis.navigator?.locks,
) {
  if (typeof operation !== 'function') {
    throw new TypeError('A data lifecycle operation is required');
  }

  const run = async () => {
    const token = {};
    activeTokens.add(token);
    try {
      return await operation(token);
    } finally {
      activeTokens.delete(token);
    }
  };

  return getDataLockManager(lockManager)
    .request(DATA_LIFECYCLE_LOCK_NAME, { mode: 'exclusive' }, run);
}

/** Serialize durable writers and composed snapshot/erase operations. */
export async function withDataWriteLock(
  operation,
  lockManager = globalThis.navigator?.locks,
  { destructiveLockToken, mutationGuardToken } = {},
) {
  if (typeof operation !== 'function') throw new TypeError('A data write operation is required');
  const runWriter = async () => {
    const token = {};
    activeWriteTokens.add(token);
    try {
      return await operation(token);
    } finally {
      activeWriteTokens.delete(token);
    }
  };

  const acquireWriter = () => getDataLockManager(lockManager)
    .request(DATA_WRITE_LOCK_NAME, { mode: 'exclusive' }, runWriter);
  if (hasDataDestructiveLock(destructiveLockToken)
    || hasDataMutationGuard(mutationGuardToken)) return acquireWriter();
  return withDataMutationGuard(acquireWriter, lockManager);
}

function destructiveOperationError() {
  const error = new Error('Data is being cleared or replaced in another LibreLog tab. Try again when it finishes.');
  error.code = 'DATA_DESTRUCTIVE_OPERATION_IN_PROGRESS';
  return error;
}

/**
 * Hold a shared guard for a normal IndexedDB/local-draft mutation. This lets a
 * destructive operation wait for already-started work and reject work that is
 * first attempted while destruction is actively in progress.
 */
export async function withDataMutationGuard(
  operation,
  lockManager = globalThis.navigator?.locks,
) {
  if (typeof operation !== 'function') throw new TypeError('A data mutation is required');
  const run = async () => {
    const token = {};
    activeMutationGuardTokens.add(token);
    try {
      return await operation(token);
    } finally {
      activeMutationGuardTokens.delete(token);
    }
  };
  return getDataLockManager(lockManager).request(
    DATA_DESTRUCTIVE_LOCK_NAME,
    { mode: 'shared', ifAvailable: true },
    lock => {
      // Real Web Locks pass null when ifAvailable cannot be granted. Small
      // test/fallback lock managers often omit the callback argument.
      if (lock === null) throw destructiveOperationError();
      return run();
    },
  );
}

/**
 * Block new ordinary writers and wait for writers that already started before
 * running a database clear, replacement, or import.
 */
export async function withDataDestructiveLock(
  operation,
  lockManager = globalThis.navigator?.locks,
  { mutationGeneration } = {},
) {
  if (typeof operation !== 'function') {
    throw new TypeError('A destructive data operation is required');
  }
  const run = async () => {
    // Check a caller's preflight immediately before invalidating other work.
    // This closes the wait between a stale UI decision and lock acquisition.
    assertDataMutationGenerationCurrent(mutationGeneration);
    const token = {};
    activeDestructiveTokens.add(token);
    const advancedGeneration = advanceDataMutationGeneration();
    try {
      return await operation(token, advancedGeneration);
    } finally {
      activeDestructiveTokens.delete(token);
    }
  };
  return getDataLockManager(lockManager)
    .request(DATA_DESTRUCTIVE_LOCK_NAME, { mode: 'exclusive' }, run);
}
