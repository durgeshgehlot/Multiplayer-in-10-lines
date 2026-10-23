/**
 * Lightweight Real-Time Multiplayer Client Library
 *
 * Exposes a simple, high-level API for real-time state sync, presence, and live cursors.
 * Hides all underlying Socket.IO details.
 */

(function (global) {
  'use strict';

  // Helper to generate UUID v4
  function generateUUID() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return crypto.randomUUID();
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  // Throttle helper
  function throttle(func, wait) {
    let timeout = null;
    let previous = 0;
    return function (...args) {
      const now = Date.now();
      const remaining = wait - (now - previous);
      if (remaining <= 0 || remaining > wait) {
        if (timeout) {
          clearTimeout(timeout);
          timeout = null;
        }
        previous = now;
        func.apply(this, args);
      } else if (!timeout) {
        timeout = setTimeout(() => {
          previous = Date.now();
          timeout = null;
          func.apply(this, args);
        }, remaining);
      }
    };
  }

  // Dynamic Socket.IO client loader if not already present
  function ensureSocketIO(serverUrl) {
    return new Promise((resolve, reject) => {
      if (typeof io !== 'undefined') {
        return resolve(io);
      }

      // Check if script tag is already inserted
      const existingScript = document.querySelector('script[data-multiplayer-socketio]');
      if (existingScript) {
        existingScript.addEventListener('load', () => resolve(window.io));
        existingScript.addEventListener('error', reject);
        return;
      }

      const script = document.createElement('script');
      script.setAttribute('data-multiplayer-socketio', 'true');
      const base = serverUrl.replace(/\/+$/, '');
      script.src = `${base}/socket.io/socket.io.js`;
      script.onload = () => {
        if (typeof io !== 'undefined') {
          resolve(window.io);
        } else {
          reject(new Error('Socket.IO script loaded but "io" is undefined'));
        }
      };
      script.onerror = () => {
        reject(new Error(`Failed to load Socket.IO client from ${script.src}`));
      };
      document.head.appendChild(script);
    });
  }

  class MultiplayerClient {
    /**
     * @param {string} serverUrl
     * @param {Object} [options]
     */
    constructor(serverUrl, options = {}) {
      this.serverUrl = serverUrl || (typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000');
      this.options = options;

      // Session ID persistence across page lifecycle
      this.sessionIdKey = `mp_session_${this.serverUrl.replace(/[^a-zA-Z0-9]/g, '_')}`;
      this.sessionId = this._getOrInitSessionId();

      this.socket = null;
      this.roomId = null;
      this.roomPassword = null;
      this.user = {
        name: options.name || 'Anonymous',
        color: options.color || null
      };

      // Internal State
      this.state = {};
      this.revision = 0;
      this.users = [];
      this.cursors = {}; // sessionId -> { name, color, x, y, lastUpdated }

      // Event Subscriptions
      this.subscribers = {
        state: new Set(),
        users: new Set(),
        cursors: new Set(),
        status: new Set(),
        error: new Set()
      };

      // Connection Status
      this.status = 'disconnected'; // 'connecting' | 'connected' | 'reconnecting' | 'synchronizing' | 'disconnected'

      // Offline update queue: [ { patch, opId, resolve, reject, retries } ]
      this.offlineQueue = [];
      this.inFlightOps = new Map(); // opId -> { patch, resolve, reject, timestamp }

      // Cursor throttle broadcaster
      this._throttledCursorBroadcast = throttle((x, y) => {
        if (this.socket && this.socket.connected && this.roomId) {
          this.socket.emit('cursor:update', {
            roomId: this.roomId,
            x,
            y
          });
        }
      }, 35); // ~30 updates/sec maximum
    }

    _getOrInitSessionId() {
      try {
        if (typeof sessionStorage !== 'undefined') {
          let sid = sessionStorage.getItem(this.sessionIdKey);
          if (!sid) {
            sid = generateUUID();
            sessionStorage.setItem(this.sessionIdKey, sid);
          }
          return sid;
        }
      } catch (e) {
        // Fallback if sessionStorage is disabled/blocked
      }
      return generateUUID();
    }

    _setStatus(newStatus) {
      if (this.status !== newStatus) {
        this.status = newStatus;
        this._notify('status', newStatus);
      }
    }

    _notify(channel, payload, meta) {
      const callbacks = this.subscribers[channel];
      if (callbacks) {
        for (const cb of callbacks) {
          try {
            cb(payload, meta);
          } catch (err) {
            console.error(`[Multiplayer] Error in ${channel} callback:`, err);
          }
        }
      }
    }

    /**
     * Initializes Socket connection and joins or rejoins a room.
     *
     * @param {string} roomId - Room to join
     * @param {Object} [options]
     * @param {string} [options.name]
     * @param {string} [options.color]
     * @param {Object} [options.initialData]
     * @returns {Promise<Object>} Snapshot of room state and participants
     */
    async join(roomId, options = {}) {
      if (!roomId) {
        throw new Error('roomId is required to join');
      }
      this.roomId = roomId;
      if (Object.prototype.hasOwnProperty.call(options, 'password')) {
        this.roomPassword = options.password || null;
      }
      if (options.name) this.user.name = options.name;
      if (options.color) this.user.color = options.color;

      this._setStatus('connecting');

      // Ensure Socket.IO client library is loaded
      let ioConstructor;
      try {
        ioConstructor = await ensureSocketIO(this.serverUrl);
      } catch (err) {
        this._setStatus('disconnected');
        this._notify('error', err);
        throw err;
      }

      return new Promise((resolve, reject) => {
        if (this.socket) {
          this.socket.removeAllListeners();
          this.socket.disconnect();
        }

        // Every explicit join (including each password retry) must authenticate
        // with room:join. Recovery is valid only after that join succeeded.
        let joinedSuccessfully = false;

        this.socket = ioConstructor(this.serverUrl, {
          transports: ['websocket', 'polling'],
          reconnection: true,
          reconnectionAttempts: Infinity,
          reconnectionDelay: 1000,
          reconnectionDelayMax: 5000,
          randomizationFactor: 0.5,
          timeout: 10000
        });

        // Socket.IO lifecycle events
        this.socket.on('connect', () => {
          if (joinedSuccessfully) {
            // Automatic reconnection recovery
            this._recoverSession();
          } else {
            // First-time join
            this.socket.emit(
              'room:join',
              {
                roomId: this.roomId,
                sessionId: this.sessionId,
                name: this.user.name,
                color: this.user.color,
                password: this.roomPassword,
                initialData: options.initialData || null
              },
              (response) => {
                if (response && response.success) {
                  joinedSuccessfully = true;
                  this.state = response.state || {};
                  this.revision = response.revision || 0;
                  this.users = response.participants || [];
                  this.user.color = response.user.color;

                  this._setStatus('connected');
                  this._notify('state', this.state, { revision: this.revision });
                  this._notify('users', this.users);

                  // Flush any queued offline updates
                  this._flushOfflineQueue();

                  resolve(response);
                } else {
                  this._setStatus('disconnected');
                  const err = new Error(response ? response.error : 'Failed to join room');
                  this._notify('error', err);
                  reject(err);
                }
              }
            );
          }
        });

        this.socket.on('reconnect_attempt', () => {
          this._setStatus('reconnecting');
        });

        this.socket.on('disconnect', (reason) => {
          // If server disconnects or transport drops, track status
          if (reason === 'io client disconnect') {
            this._setStatus('disconnected');
          } else {
            this._setStatus('reconnecting');
          }
        });

        this.socket.on('connect_error', (err) => {
          this._setStatus('reconnecting');
          this._notify('error', err);
        });

        // Server-broadcasted state updates
        this.socket.on('state:update', (data) => {
          if (data.roomId === this.roomId) {
            this.state = data.state;
            this.revision = data.revision;

            // If an in-flight operation matches this opId, resolve it
            if (data.opId && this.inFlightOps.has(data.opId)) {
              const pending = this.inFlightOps.get(data.opId);
              pending.resolve({ success: true, revision: this.revision, state: this.state });
              this.inFlightOps.delete(data.opId);
            }

            this._notify('state', this.state, {
              patch: data.patch,
              revision: data.revision,
              updatedBy: data.updatedBy,
              opId: data.opId
            });
          }
        });

        // Presence updates
        this.socket.on('presence:update', (data) => {
          if (data.roomId === this.roomId) {
            this.users = data.participants || [];
            this._notify('users', this.users);
          }
        });

        // Live Cursor updates
        this.socket.on('cursor:update', (data) => {
          // Ignore own cursor echo
          if (data.sessionId === this.sessionId) return;

          this.cursors[data.sessionId] = {
            sessionId: data.sessionId,
            name: data.name,
            color: data.color,
            x: data.x,
            y: data.y,
            lastSeen: Date.now()
          };

          this._notify('cursors', this.cursors);
        });

        // Cursor remove
        this.socket.on('cursor:remove', (data) => {
          if (this.cursors[data.sessionId]) {
            delete this.cursors[data.sessionId];
            this._notify('cursors', this.cursors);
          }
        });
      });
    }

    /**
     * Explicitly resynchronizes room state and presence after reconnection.
     */
    _recoverSession() {
      if (!this.socket || !this.socket.connected || !this.roomId) return;

      this._setStatus('synchronizing');

      this.socket.emit(
        'room:rejoin',
        {
          roomId: this.roomId,
          sessionId: this.sessionId,
          name: this.user.name,
          color: this.user.color,
          password: this.roomPassword,
          lastRevision: this.revision
        },
        (response) => {
          if (response && response.success) {
            this.state = response.state || {};
            this.revision = response.revision || 0;
            this.users = response.participants || [];

            this._setStatus('connected');
            this._notify('state', this.state, { revision: this.revision, recovered: true });
            this._notify('users', this.users);

            // Re-apply or flush offline queued updates
            this._flushOfflineQueue();
          } else {
            console.warn('[Multiplayer] Rejoin resync failed:', response);
            this._setStatus('reconnecting');
          }
        }
      );
    }

    /**
     * Flushes updates queued while disconnected.
     */
    _flushOfflineQueue() {
      if (!this.socket || !this.socket.connected || this.offlineQueue.length === 0) return;

      const queue = [...this.offlineQueue];
      this.offlineQueue = [];

      for (const item of queue) {
        this._sendStateUpdate(item.patch, item.opId)
          .then(item.resolve)
          .catch(item.reject);
      }
    }

    _sendStateUpdate(patch, opId) {
      return new Promise((resolve, reject) => {
        if (!this.socket || !this.socket.connected) {
          // Queue for when connection is restored
          this.offlineQueue.push({ patch, opId, resolve, reject });
          return;
        }

        this.inFlightOps.set(opId, { patch, resolve, reject, timestamp: Date.now() });

        this.socket.emit(
          'state:update',
          {
            roomId: this.roomId,
            patch,
            opId,
            baseRevision: this.revision
          },
          (response) => {
            if (response && response.success) {
              if (response.revision) {
                this.revision = response.revision;
              }
              resolve(response);
            } else {
              this.inFlightOps.delete(opId);
              reject(new Error(response ? response.error : 'State update rejected'));
            }
          }
        );
      });
    }

    /**
     * Retrieve current cached synchronized state.
     * @returns {Object}
     */
    getState() {
      return JSON.parse(JSON.stringify(this.state));
    }

    /**
     * Retrieve current revision number.
     * @returns {number}
     */
    getRevision() {
      return this.revision;
    }

    /**
     * Update shared state via server.
     *
     * @param {Object} patch - Object containing keys to update
     * @returns {Promise<Object>}
     */
    setState(patch) {
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
        return Promise.reject(new Error('setState requires a non-null plain object'));
      }
      const opId = generateUUID();
      return this._sendStateUpdate(patch, opId);
    }

    /**
     * Initialize state only if room state has not been initialized yet.
     *
     * @param {Object} initialState
     * @returns {Promise<Object>}
     */
    initState(initialState) {
      if (!this.socket || !this.roomId) {
        return Promise.reject(new Error('Must join a room before initializing state'));
      }

      return new Promise((resolve, reject) => {
        this.socket.emit(
          'state:init',
          {
            roomId: this.roomId,
            initialState
          },
          (response) => {
            if (response && response.success) {
              if (response.applied) {
                this.state = response.state;
                this.revision = response.revision;
              }
              resolve(response);
            } else {
              reject(new Error(response ? response.error : 'Failed to init state'));
            }
          }
        );
      });
    }

    /**
     * Subscribe to shared state changes.
     * @param {Function} callback - (state, meta) => void
     * @returns {Function} Unsubscribe function
     */
    onState(callback) {
      this.subscribers.state.add(callback);
      // Immediately call with current state if already populated
      if (this.revision > 0 || Object.keys(this.state).length > 0) {
        try {
          callback(this.getState(), { revision: this.revision, initial: true });
        } catch (e) {
          console.error(e);
        }
      }
      return () => this.subscribers.state.delete(callback);
    }

    /**
     * Subscribe to user presence updates.
     * @param {Function} callback - (users) => void
     * @returns {Function} Unsubscribe function
     */
    onUsers(callback) {
      this.subscribers.users.add(callback);
      if (this.users.length > 0) {
        try {
          callback([...this.users]);
        } catch (e) {
          console.error(e);
        }
      }
      return () => this.subscribers.users.delete(callback);
    }

    /**
     * Subscribe to live mouse cursor updates of other users.
     * @param {Function} callback - (cursors) => void
     * @returns {Function} Unsubscribe function
     */
    onCursors(callback) {
      this.subscribers.cursors.add(callback);
      return () => this.subscribers.cursors.delete(callback);
    }

    /**
     * Broadcast local cursor position (automatically throttled).
     * @param {number} x
     * @param {number} y
     */
    updateCursor(x, y) {
      this._throttledCursorBroadcast(x, y);
    }

    /**
     * Subscribe to connection status changes.
     * @param {Function} callback - (status: 'connecting' | 'connected' | 'reconnecting' | 'synchronizing' | 'disconnected') => void
     * @returns {Function} Unsubscribe function
     */
    onStatus(callback) {
      this.subscribers.status.add(callback);
      callback(this.status);
      return () => this.subscribers.status.delete(callback);
    }

    /**
     * Subscribe to errors.
     * @param {Function} callback - (error) => void
     * @returns {Function} Unsubscribe function
     */
    onError(callback) {
      this.subscribers.error.add(callback);
      return () => this.subscribers.error.delete(callback);
    }

    /**
     * Emit a raw socket event (for custom events like room:checkPassword).
     * @param {string} event
     * @param {Object} data
     * @param {Function} [callback]
     */
    emitRaw(event, data, callback) {
      if (this.socket && this.socket.connected) {
        this.socket.emit(event, data, callback);
      } else {
        if (callback) callback({ success: false, error: 'Not connected' });
      }
    }

    /**
     * Leave the current room and clean up resources.
     */
    leave() {
      if (this.socket && this.roomId) {
        this.socket.emit('room:leave', { roomId: this.roomId });
        this.socket.removeAllListeners();
        this.socket.disconnect();
      }
      this.socket = null;
      this.roomId = null;
      this.state = {};
      this.revision = 0;
      this.users = [];
      this.cursors = {};
      this.offlineQueue = [];
      this.inFlightOps.clear();
      this._setStatus('disconnected');
    }

    /**
     * Simulates network disconnection for testing recovery.
     * Disconnects the socket, stays disconnected for durationMs, then reconnects and resynchronizes.
     *
     * @param {number} [durationMs=10000]
     * @returns {Promise<void>} Resolves when reconnected and synchronized
     */
    simulateDisconnect(durationMs = 10000) {
      return new Promise((resolve) => {
        if (!this.socket) {
          return resolve();
        }

        this._setStatus('disconnected');
        this.socket.disconnect();

        setTimeout(() => {
          this._setStatus('reconnecting');
          this.socket.connect();

          const checkConnected = (status) => {
            if (status === 'connected') {
              this.subscribers.status.delete(checkConnected);
              resolve();
            }
          };
          this.subscribers.status.add(checkConnected);
        }, durationMs);
      });
    }

    /**
     * Manually triggers socket reconnection.
     */
    reconnect() {
      if (this.socket && !this.socket.connected) {
        this._setStatus('reconnecting');
        this.socket.connect();
      }
    }

    /**
     * Manually disconnects socket.
     */
    disconnect() {
      if (this.socket && this.socket.connected) {
        this.socket.disconnect();
        this._setStatus('disconnected');
      }
    }

    /**
     * Returns persistent session ID for this client.
     */
    getSessionId() {
      return this.sessionId;
    }
  }

  // Library root entry point
  const Multiplayer = {
    /**
     * Create and return a new Multiplayer client instance.
     * @param {string} [serverUrl]
     * @param {Object} [options]
     * @returns {MultiplayerClient}
     */
    connect(serverUrl, options = {}) {
      return new MultiplayerClient(serverUrl, options);
    },
    async checkRoomPassword(serverUrl, roomId) {
      const ioConstructor = await ensureSocketIO(serverUrl || (typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000'));
      const socket = ioConstructor(serverUrl || window.location.origin, { transports: ['websocket', 'polling'] });
      return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (error, value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeoutId);
          socket.disconnect();
          if (error) reject(error);
          else resolve(value);
        };
        const timeoutId = setTimeout(() => finish(new Error('Room password check timed out')), 10000);
        socket.once('connect', () => socket.emit('room:checkPassword', { roomId }, (result) => {
          if (result && result.success) finish(null, result.requiresPassword);
          else finish(new Error(result?.error || 'Could not check room password'));
        }));
        socket.once('connect_error', (error) => finish(error));
        socket.once('disconnect', (reason) => {
          if (!settled) finish(new Error(`Disconnected while checking password: ${reason}`));
        });
      });
    },
    Client: MultiplayerClient
  };

  // Export for browser window global and CommonJS / ES modules
  if (typeof window !== 'undefined') {
    window.Multiplayer = Multiplayer;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = Multiplayer;
  }
})(typeof window !== 'undefined' ? window : globalThis);
