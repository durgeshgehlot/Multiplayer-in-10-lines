/**
 * Socket.IO event handlers for multiplayer rooms, state sync, cursors, and presence.
 */

const {
  validateRoomId,
  sanitizeDisplayName,
  validateColor,
  validateStatePayload,
  validateCursor,
  validateOpId
} = require('./validation');

function setupSocketHandlers(io, roomManager, options = {}) {
  const maxPayloadBytes = options.maxPayloadBytes || 65536;
  const stateRateLimit = options.stateRateLimit || 60; // per second
  const cursorRateLimit = options.cursorRateLimit || 120; // per second

  io.on('connection', (socket) => {
    // Rate limit tracking for this socket
    let stateUpdatesThisSec = 0;
    let cursorUpdatesThisSec = 0;
    let lastSecTimestamp = Date.now();

    function checkRateLimit(type) {
      const now = Date.now();
      if (now - lastSecTimestamp >= 1000) {
        stateUpdatesThisSec = 0;
        cursorUpdatesThisSec = 0;
        lastSecTimestamp = now;
      }
      if (type === 'state') {
        stateUpdatesThisSec++;
        return stateUpdatesThisSec <= stateRateLimit;
      }
      if (type === 'cursor') {
        cursorUpdatesThisSec++;
        return cursorUpdatesThisSec <= cursorRateLimit;
      }
      return true;
    }

    /**
     * Join Room
     */
    socket.on('room:join', (payload, callback = () => {}) => {
      try {
        if (!payload || typeof payload !== 'object') {
          return callback({ success: false, error: 'Invalid join payload' });
        }

        const roomVal = validateRoomId(payload.roomId);
        if (!roomVal.valid) {
          return callback({ success: false, error: roomVal.error });
        }
        const roomId = roomVal.value;

        const sessionId = typeof payload.sessionId === 'string' && payload.sessionId.trim()
          ? payload.sessionId.trim()
          : socket.id;

        const name = sanitizeDisplayName(payload.name);
        const color = validateColor(payload.color);

        // Only accept a password on the first creation of a room. A room with
        // zero online participants may still have an existing host password.
        const isNewRoom = !roomManager.hasRoom(roomId);
        const room = roomManager.getRoom(roomId, true);

        if (isNewRoom && payload.password) {
          if (typeof payload.password !== 'string' || payload.password.trim().length > 128) {
            return callback({ success: false, error: 'Password must be 1-128 characters' });
          }
          room.setPassword(payload.password);
        }

        // A known/reused session ID must never skip the room password check.
        if (room.hasPassword() && !room.verifyPassword(payload.password)) {
          return callback({ success: false, error: 'WRONG_PASSWORD' });
        }

        // Add or update participant
        const { participant } = room.addOrUpdateParticipant({
          sessionId,
          socketId: socket.id,
          name,
          color
        });

        socket.join(roomId);

        // Safe initial state if supplied and room has not yet initialized
        if (payload.initialData && typeof payload.initialData === 'object') {
          const stateVal = validateStatePayload(payload.initialData, maxPayloadBytes);
          if (stateVal.valid) {
            room.stateManager.initState(stateVal.value, sessionId);
          }
        }

        // Broadcast presence to entire room
        io.to(roomId).emit('presence:update', {
          roomId,
          participants: room.getParticipantList()
        });

        // Acknowledge with full room snapshot
        callback({
          success: true,
          roomId,
          sessionId,
          user: {
            sessionId: participant.sessionId,
            name: participant.name,
            color: participant.color
          },
          state: room.stateManager.getSnapshot(),
          revision: room.stateManager.getRevision(),
          participants: room.getParticipantList()
        });
      } catch (err) {
        console.error('Error in room:join:', err);
        callback({ success: false, error: 'Internal server error while joining room' });
      }
    });

    /**
     * Check if a room requires a password (pre-join check for guests)
     */
    socket.on('room:checkPassword', (payload, callback = () => {}) => {
      try {
        if (!payload || !payload.roomId) {
          return callback({ success: false, error: 'roomId required' });
        }
        const room = roomManager.getRoom(payload.roomId);
        if (!room) {
          return callback({ success: true, requiresPassword: false });
        }
        callback({ success: true, requiresPassword: room.hasPassword() });
      } catch (err) {
        callback({ success: false, error: 'Failed to check room' });
      }
    });

    socket.on('room:setPassword', (payload, callback = () => {}) => {
      const room = payload && roomManager.getRoom(payload.roomId);
      const sessionInfo = roomManager.findRoomBySocket(socket.id);
      if (!room || !sessionInfo || sessionInfo.room !== room || sessionInfo.sessionId !== room.hostSessionId) {
        return callback({ success: false, error: 'Only the host can change the room password' });
      }
      if (typeof payload.password !== 'string' || payload.password.trim().length > 128) {
        return callback({ success: false, error: 'Password must be 1-128 characters' });
      }
      room.setPassword(payload.password);
      callback({ success: true, hasPassword: room.hasPassword() });
    });

    socket.on('room:getPassword', (payload, callback = () => {}) => {
      const room = payload && roomManager.getRoom(payload.roomId);
      const sessionInfo = roomManager.findRoomBySocket(socket.id);
      if (!room || !sessionInfo || sessionInfo.room !== room || sessionInfo.sessionId !== room.hostSessionId) {
        return callback({ success: false, error: 'Only the host can view the room password' });
      }
      callback({ success: true, hasPassword: room.hasPassword(), password: room.password || '' });
    });

    /**
     * Rejoin / Resynchronize Room after disconnect
     */
    socket.on('room:rejoin', (payload, callback = () => {}) => {
      try {
        if (!payload || typeof payload !== 'object') {
          return callback({ success: false, error: 'Invalid rejoin payload' });
        }

        const roomVal = validateRoomId(payload.roomId);
        if (!roomVal.valid) {
          return callback({ success: false, error: roomVal.error });
        }
        const roomId = roomVal.value;

        const sessionId = typeof payload.sessionId === 'string' && payload.sessionId.trim()
          ? payload.sessionId.trim()
          : null;

        if (!sessionId) {
          return callback({ success: false, error: 'Session ID is required for rejoining' });
        }

        const room = roomManager.getRoom(roomId);
        if (!room) {
          return callback({ success: false, error: 'Room does not exist' });
        }
        if (room.hasPassword() && !room.verifyPassword(payload.password)) {
          return callback({ success: false, error: 'WRONG_PASSWORD' });
        }
        const name = sanitizeDisplayName(payload.name);
        const color = validateColor(payload.color);

        const { participant } = room.addOrUpdateParticipant({
          sessionId,
          socketId: socket.id,
          name,
          color
        });

        socket.join(roomId);

        // Broadcast updated presence to room
        io.to(roomId).emit('presence:update', {
          roomId,
          participants: room.getParticipantList()
        });

        // Acknowledge with latest authoritative state
        callback({
          success: true,
          roomId,
          sessionId,
          user: {
            sessionId: participant.sessionId,
            name: participant.name,
            color: participant.color
          },
          state: room.stateManager.getSnapshot(),
          revision: room.stateManager.getRevision(),
          participants: room.getParticipantList()
        });
      } catch (err) {
        console.error('Error in room:rejoin:', err);
        callback({ success: false, error: 'Internal server error during reconnection' });
      }
    });

    /**
     * Initialize Room State (only if room is uninitialized)
     */
    socket.on('state:init', (payload, callback = () => {}) => {
      try {
        if (!payload || typeof payload !== 'object') {
          return callback({ success: false, error: 'Invalid state init payload' });
        }

        const room = roomManager.getRoom(payload.roomId);
        if (!room) {
          return callback({ success: false, error: 'Room not found' });
        }

        const sessionInfo = roomManager.findRoomBySocket(socket.id);
        if (!sessionInfo || sessionInfo.room !== room) {
          return callback({ success: false, error: 'Join the room before initializing state' });
        }

        const stateVal = validateStatePayload(payload.initialState, maxPayloadBytes);
        if (!stateVal.valid) {
          return callback({ success: false, error: stateVal.error });
        }

        const userId = sessionInfo ? sessionInfo.sessionId : socket.id;

        const result = room.stateManager.initState(stateVal.value, userId);

        if (result.applied) {
          io.to(payload.roomId).emit('state:update', {
            roomId: payload.roomId,
            patch: stateVal.value,
            revision: result.revision,
            state: result.state,
            updatedBy: userId,
            opId: null
          });
        }

        callback({
          success: true,
          applied: result.applied,
          revision: result.revision,
          state: result.state
        });
      } catch (err) {
        console.error('Error in state:init:', err);
        callback({ success: false, error: 'Failed to initialize state' });
      }
    });

    /**
     * Apply Patch to Shared State
     */
    socket.on('state:update', (payload, callback = () => {}) => {
      try {
        if (!checkRateLimit('state')) {
          return callback({ success: false, error: 'State update rate limit exceeded' });
        }

        if (!payload || typeof payload !== 'object') {
          return callback({ success: false, error: 'Invalid state update payload' });
        }

        const room = roomManager.getRoom(payload.roomId);
        if (!room) {
          return callback({ success: false, error: 'Room does not exist' });
        }

        const sessionInfo = roomManager.findRoomBySocket(socket.id);
        if (!sessionInfo || sessionInfo.room !== room) {
          return callback({ success: false, error: 'Join the room before updating state' });
        }

        const patchVal = validateStatePayload(payload.patch, maxPayloadBytes);
        if (!patchVal.valid) {
          return callback({ success: false, error: patchVal.error });
        }

        const opId = validateOpId(payload.opId);
        const userId = sessionInfo ? sessionInfo.sessionId : socket.id;

        const result = room.stateManager.applyPatch(patchVal.value, userId, opId);
        room.touchActivity();

        if (result.duplicate) {
          // Idempotent retry: operation already applied, acknowledge without rebroadcasting
          return callback({
            success: true,
            duplicate: true,
            revision: result.revision,
            opId
          });
        }

        // Broadcast to all clients in the room
        io.to(payload.roomId).emit('state:update', {
          roomId: payload.roomId,
          patch: result.patch,
          revision: result.revision,
          state: result.state,
          updatedBy: userId,
          opId: result.opId
        });

        // Acknowledge back to sender
        callback({
          success: true,
          revision: result.revision,
          opId: result.opId
        });
      } catch (err) {
        console.error('Error in state:update:', err);
        callback({ success: false, error: 'Failed to apply state update' });
      }
    });

    /**
     * Live Ephemeral Mouse Cursor Position
     */
    socket.on('cursor:update', (payload) => {
      try {
        if (!checkRateLimit('cursor')) return;
        if (!payload || typeof payload !== 'object' || !payload.roomId) return;

        const cursorVal = validateCursor(payload.x, payload.y);
        if (!cursorVal.valid) return;

        const room = roomManager.getRoom(payload.roomId);
        if (!room) return;

        const sessionId = room.socketToSession.get(socket.id);
        if (!sessionId) return;
        const participant = sessionId ? room.participants.get(sessionId) : null;

        // Broadcast to other users in room, excluding sender
        socket.to(payload.roomId).emit('cursor:update', {
          sessionId: sessionId || socket.id,
          name: participant ? participant.name : 'Participant',
          color: participant ? participant.color : '#6366f1',
          x: cursorVal.x,
          y: cursorVal.y
        });
      } catch (err) {
        // Ephemeral cursor errors should not crash
      }
    });

    /**
     * Leave Room explicitly
     */
    socket.on('room:leave', (payload, callback = () => {}) => {
      try {
        if (!payload || !payload.roomId) {
          return callback({ success: false, error: 'roomId required' });
        }

        const room = roomManager.getRoom(payload.roomId);
        if (room) {
          const participant = room.removeSocket(socket.id, true);
          socket.leave(payload.roomId);

          if (participant) {
            io.to(payload.roomId).emit('presence:update', {
              roomId: payload.roomId,
              participants: room.getParticipantList()
            });
            io.to(payload.roomId).emit('cursor:remove', {
              sessionId: participant.sessionId
            });
          }

          room.checkEmptyAndScheduleCleanup((id) => {
            roomManager.removeRoom(id);
          });
        }

        callback({ success: true });
      } catch (err) {
        console.error('Error in room:leave:', err);
        callback({ success: false, error: 'Failed to leave room' });
      }
    });

    /**
     * Socket Disconnect
     */
    socket.on('disconnect', () => {
      const match = roomManager.findRoomBySocket(socket.id);
      if (match) {
        const { room, sessionId } = match;
        const participant = room.removeSocket(socket.id, false);

        if (participant) {
          // Broadcast presence update (marked disconnected)
          io.to(room.id).emit('presence:update', {
            roomId: room.id,
            participants: room.getParticipantList()
          });

          // Remove cursor immediately
          io.to(room.id).emit('cursor:remove', {
            sessionId
          });
        }

        room.checkEmptyAndScheduleCleanup((id) => {
          roomManager.removeRoom(id);
        });
      }
    });
  });
}

module.exports = setupSocketHandlers;
