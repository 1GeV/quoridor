export const ROOM_INVITE = /^#room=([RW]-[\w-]{22})$/;

export function base64(bytes) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function unbase64(text) {
  const binary = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
  return Uint8Array.from(binary, (letter) => letter.charCodeAt(0));
}

export function newRelayCode() {
  return base64(crypto.getRandomValues(new Uint8Array(16)));
}

export function isRelayCode(code) {
  return /^[RW]-[\w-]{22}$/.test(code) && base64(unbase64(code.slice(2))) === code.slice(2);
}
