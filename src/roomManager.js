/**
 * RoomManager manages the lifecycle of rooms, participant presence,
 * socket mapping, and empty room cleanup.
 */

const StateManager = require('./stateManager');

class Room {
  /**
   * @param {string} id - Room identifier
   * @param {Object} [options]
   * @param {number} [options.cleanupTtlMs=300000]
   */
  constructor(id, options = {}) {
    this.id = id;
    this.stateManager = new StateManager();
    this.participants = new Map(); // sessionId -> Participant
    this.socketToSession = new Map(); // socketId -> sessionId
    this.cleanupTtlMs = options.cleanupTtlMs || 300000; // 5 minutes default
    this.cleanupTimer = null;
    this.password = null; // Room password set by host
    this.hostSessionId = null;
    this.createdAt = Date.now();
    this.lastActivityAt = Date.now();
  }

  /**
   * Set password for this room (host only).
   * @param {string} password
   */
  setPassword(password) {
    this.password = typeof password === 'string' && password.trim() ? password.trim() : null;
  }

  /**
   * Verify password for joining this room.
   * Returns true if no password is set or if the password matches.
   * @param {string} password
   * @returns {boolean}
   */
  verifyPassword(password) {
    if (!this.password) return true; // No password set
    return this.password === (password || '').trim();
  }

  /**
   * Check if room has a password.
   * @returns {boolean}
   */
  hasPassword() {
    return !!this.password;
  }

  touchActivity() {
    this.lastActivityAt = Date.now();
    if (this.cleanupTimer) {
      clearTimeout(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  /**
   * Adds or reconnects a participant in the room.
   *
   * @param {Object} info
   * @param {string} info.sessionId
   * @param {string} info.socketId
   * @param {string} info.name
   * @param {string} info.color
   * @returns {{ isNew: boolean, participant: Object }}
   */
  addOrUpdateParticipant({ sessionId, socketId, name, color }) {
    this.touchActivity();
    if (!this.hostSessionId) this.hostSessionId = sessionId;

    // Map socket to session
    this.socketToSession.set(socketId, sessionId);

    let isNew = true;
    let participant;

    if (this.participants.has(sessionId)) {
      isNew = false;
      participant = this.participants.get(sessionId);
      participant.socketId = socketId;
      participant.name = name || participant.name;
      participant.color = color || participant.color;
      participant.status = 'online';
      participant.lastSeenAt = Date.now();
    } else {
      participant = {
        sessionId,
        socketId,
        name,
        color,
        joinedAt: Date.now(),
        lastSeenAt: Date.now(),
        status: 'online'
      };
      this.participants.set(sessionId, participant);
    }

    return { isNew, participant };
  }

  /**
   * Removes a socket from the room on disconnect.
   * Marks participant as disconnected or removes if explicitly left.
   *
   * @param {string} socketId
   * @param {boolean} [permanent=false]
   * @returns {Object|null} The affected participant or null
   */
  removeSocket(socketId, permanent = false) {
    this.touchActivity();
    const sessionId = this.socketToSession.get(socketId);
    if (!sessionId) return null;

    this.socketToSession.delete(socketId);
    const participant = this.participants.get(sessionId);
    if (!participant) return null;

    // Only affect the participant if their active socket matches the one disconnecting
    if (participant.socketId === socketId) {
      if (permanent) {
        this.participants.delete(sessionId);
      } else {
        // Mark disconnected temporarily (for reconnection recovery)
        participant.status = 'disconnected';
        participant.lastSeenAt = Date.now();
      }
    }

    return participant;
  }

  /**
   * Explicitly remove a participant by session ID.
   * @param {string} sessionId
   */
  removeParticipant(sessionId) {
    this.touchActivity();
    const participant = this.participants.get(sessionId);
    if (participant) {
      this.socketToSession.delete(participant.socketId);
      this.participants.delete(sessionId);
    }
    return participant;
  }

  /**
   * Returns list of public participant profiles.
   * @returns {Array<Object>}
   */
  getParticipantList() {
    return Array.from(this.participants.values()).map(p => ({
      sessionId: p.sessionId,
      name: p.name,
      color: p.color,
      status: p.status,
      joinedAt: p.joinedAt
    }));
  }

  /**
   * Number of currently online participants.
   * @returns {number}
   */
  getOnlineCount() {
    let count = 0;
    for (const p of this.participants.values()) {
      if (p.status === 'online') count++;
    }
    return count;
  }

  /**
   * Schedules cleanup if room has 0 active participants.
   * @param {Function} onExpire
   */
  checkEmptyAndScheduleCleanup(onExpire) {
    if (this.getOnlineCount() === 0) {
      if (!this.cleanupTimer) {
        this.cleanupTimer = setTimeout(() => {
          if (this.getOnlineCount() === 0) {
            onExpire(this.id);
          }
        }, this.cleanupTtlMs);
      }
    } else if (this.cleanupTimer) {
      clearTimeout(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  destroy() {
    if (this.cleanupTimer) {
      clearTimeout(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.participants.clear();
    this.socketToSession.clear();
  }
}

class RoomManager {
  /**
   * @param {Object} [options]
   * @param {number} [options.cleanupTtlMs=300000]
   */
  constructor(options = {}) {
    this.rooms = new Map(); // roomId -> Room
    this.cleanupTtlMs = options.cleanupTtlMs || 300000;
  }

  /**
   * Get an existing room or optionally create a new one.
   * @param {string} roomId
   * @param {boolean} [createIfMissing=false]
   * @returns {Room|null}
   */
  getRoom(roomId, createIfMissing = false) {
    if (this.rooms.has(roomId)) {
      return this.rooms.get(roomId);
    }
    if (createIfMissing) {
      const room = new Room(roomId, { cleanupTtlMs: this.cleanupTtlMs });
      this.rooms.set(roomId, room);
      return room;
    }
    return null;
  }

  /**
   * Checks if a room exists.
   * @param {string} roomId
   * @returns {boolean}
   */
  hasRoom(roomId) {
    return this.rooms.has(roomId);
  }

  /**
   * Remove and clean up a room.
   * @param {string} roomId
   */
  removeRoom(roomId) {
    const room = this.rooms.get(roomId);
    if (room) {
      room.destroy();
      this.rooms.delete(roomId);
    }
  }

  /**
   * Returns total number of active rooms.
   * @returns {number}
   */
  getRoomCount() {
    return this.rooms.size;
  }

  /**
   * Returns all room IDs.
   * @returns {string[]}
   */
  getAllRoomIds() {
    return Array.from(this.rooms.keys());
  }

  /**
   * Finds the room and session associated with a socket ID.
   * @param {string} socketId
   * @returns {{ room: Room, sessionId: string } | null}
   */
  findRoomBySocket(socketId) {
    for (const room of this.rooms.values()) {
      if (room.socketToSession.has(socketId)) {
        return {
          room,
          sessionId: room.socketToSession.get(socketId)
        };
      }
    }
    return null;
  }
}

module.exports = RoomManager;
