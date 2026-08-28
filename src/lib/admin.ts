// The two site owners, by verified X handle. Client-safe (no db/crypto
// imports): the chat panel keys admin tags off it, and the server gates the
// /admin dashboard and its API routes with it. Safe to trust because
// x_handle only ever comes out of the OAuth-verified x_connections table.
export const ADMIN_HANDLES = new Set(["ahmadafterhours", "omarships"]);

export function isAdminHandle(xHandle: string | null | undefined): boolean {
  return !!xHandle && ADMIN_HANDLES.has(xHandle.toLowerCase());
}
