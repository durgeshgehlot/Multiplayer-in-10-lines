/**
 * StateManager manages authoritative room state, revision numbering,
 * operation deduplication, and safe patch applications.
 */

class StateManager {
  /**
   * @param {Object} [initialData={}] - Optional initial state
   */
  constructor(initialData = {}) {
    this.revision = 0;
    this.data = initialData && typeof initialData === 'object' && !Array.isArray(initialData)
      ? JSON.parse(JSON.stringify(initialData))
      : {};
    this.initialized = Object.keys(this.data).length > 0;
    if (this.initialized) {
      this.revision = 1;
    }

    // Keep an LRU-like set of recent operation IDs for deduplication
    this.recentOpIds = new Map(); // opId -> { revision, timestamp }
    this.maxRecentOps = 300;
  }

  /**
   * Safely initializes the room state only if it hasn't been initialized yet.
   * If already initialized, preserves existing state and returns false.
   *
   * @param {Object} initialState
   * @param {string} [userId='system']
   * @returns {{ applied: boolean, revision: number, state: Object }}
   */
  initState(initialState, userId = 'system') {
    if (this.initialized || this.revision > 0) {
      return {
        applied: false,
        revision: this.revision,
        state: this.getSnapshot()
      };
    }

    if (initialState && typeof initialState === 'object' && !Array.isArray(initialState)) {
      this.data = JSON.parse(JSON.stringify(initialState));
    } else {
      this.data = {};
    }

    this.initialized = true;
    this.revision = 1;

    return {
      applied: true,
      revision: this.revision,
      state: this.getSnapshot(),
      updatedBy: userId
    };
  }

  /**
   * Applies a patch object to the authoritative state.
   * Merges patch keys into this.data.
   *
   * @param {Object} patch - Key-value updates to apply
   * @param {string} userId - Identifier of user submitting change
   * @param {string} [opId] - Unique operation ID for idempotency
   * @returns {{ applied: boolean, duplicate?: boolean, revision: number, state: Object, patch: Object, updatedBy: string }}
   */
  applyPatch(patch, userId, opId = null) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new Error('Patch must be a non-null plain object');
    }

    // Check for duplicate operation ID (idempotent retry)
    if (opId && this.recentOpIds.has(opId)) {
      const existing = this.recentOpIds.get(opId);
      return {
        applied: false,
        duplicate: true,
        revision: existing.revision,
        state: this.getSnapshot(),
        patch: {},
        updatedBy: userId
      };
    }

    // Apply patch shallowly (preserving unrelated properties)
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined || value === null) {
        this.data[key] = value;
      } else if (typeof value === 'object' && !Array.isArray(value) && typeof this.data[key] === 'object' && !Array.isArray(this.data[key]) && this.data[key] !== null) {
        // Deep merge 1 level for nested state objects
        this.data[key] = { ...this.data[key], ...value };
      } else {
        this.data[key] = JSON.parse(JSON.stringify(value));
      }
    }

    this.initialized = true;
    this.revision += 1;

    // Track opId
    if (opId) {
      this.recentOpIds.set(opId, {
        revision: this.revision,
        timestamp: Date.now()
      });

      // Evict oldest entries if capacity exceeded
      if (this.recentOpIds.size > this.maxRecentOps) {
        const firstKey = this.recentOpIds.keys().next().value;
        this.recentOpIds.delete(firstKey);
      }
    }

    return {
      applied: true,
      duplicate: false,
      revision: this.revision,
      state: this.getSnapshot(),
      patch: JSON.parse(JSON.stringify(patch)),
      updatedBy: userId,
      opId: opId || null
    };
  }

  /**
   * Returns a detached deep snapshot of the current state.
   * @returns {Object}
   */
  getSnapshot() {
    return JSON.parse(JSON.stringify(this.data));
  }

  /**
   * Returns current revision number.
   * @returns {number}
   */
  getRevision() {
    return this.revision;
  }
}

module.exports = StateManager;
