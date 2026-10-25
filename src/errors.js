export class UserError extends Error {}

export const validSiteId = (id) => /^[\w.-]+$/.test(String(id || '')) && !/^\.+$/.test(id);
