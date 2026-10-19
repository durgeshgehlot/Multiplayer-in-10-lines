/**
 * Validation utilities for payload sanitization, room IDs, and rate limiting.
 */

const ROOM_ID_REGEX = /^[a-zA-Z0-9_-]{1,64}$/;
const HEX_COLOR_REGEX = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

function validateRoomId(roomId) {
  if (typeof roomId !== 'string') {
    return { valid: false, error: 'Room ID must be a string' };
  }
  const trimmed = roomId.trim();
  if (!ROOM_ID_REGEX.test(trimmed)) {
    return { valid: false, error: 'Room ID must be 1-64 alphanumeric characters, underscores, or hyphens' };
  }
  return { valid: true, value: trimmed };
}

function sanitizeDisplayName(name) {
  if (typeof name !== 'string') {
    return 'Anonymous';
  }
  const clean = name.trim().replace(/[<>]/g, '').slice(0, 50);
  return clean || 'Anonymous';
}

function validateColor(color) {
  if (typeof color === 'string' && HEX_COLOR_REGEX.test(color)) {
    return color;
  }
  // Generate a pleasant default color if invalid
  const palette = ['#6366f1', '#ec4899', '#10b981', '#f59e0b', '#3b82f6', '#8b5cf6', '#14b8a6', '#f43f5e'];
  return palette[Math.floor(Math.random() * palette.length)];
}

function validateStatePayload(payload, maxBytes = 65536) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { valid: false, error: 'State update payload must be a non-null plain object' };
  }

  // Prevent prototype pollution
  const forbiddenKeys = ['__proto__', 'constructor', 'prototype'];
  for (const key of Object.keys(payload)) {
    if (forbiddenKeys.includes(key)) {
      return { valid: false, error: `Illegal key name: ${key}` };
    }
  }

  let serialized;
  try {
    serialized = JSON.stringify(payload);
  } catch (err) {
    return { valid: false, error: 'State update payload must be JSON-serializable' };
  }

  if (Buffer.byteLength(serialized, 'utf8') > maxBytes) {
    return { valid: false, error: `State update exceeds maximum allowed size of ${maxBytes} bytes` };
  }

  return { valid: true, value: JSON.parse(serialized) };
}

function validateCursor(x, y) {
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) {
    return { valid: false, error: 'Cursor coordinates must be finite numbers' };
  }
  // Clamp coordinates within a reasonable canvas/window boundary (0 to 1 for normalized, or 0 to 10000 for pixels)
  const clampedX = Math.max(0, Math.min(10000, x));
  const clampedY = Math.max(0, Math.min(10000, y));
  return { valid: true, x: clampedX, y: clampedY };
}

function validateOpId(opId) {
  if (typeof opId !== 'string' || !opId.trim() || opId.length > 64) {
    return null;
  }
  return opId.trim();
}

module.exports = {
  validateRoomId,
  sanitizeDisplayName,
  validateColor,
  validateStatePayload,
  validateCursor,
  validateOpId
};
