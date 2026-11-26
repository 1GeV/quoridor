export const MAX_ROOM_MESSAGE_BYTES = 64 * 1024;
export const MAX_ROOM_FRAME_CHARS = 1 + Math.ceil((MAX_ROOM_MESSAGE_BYTES + 28) * 4 / 3);
