// Normalize a chat id or phone number to a Baileys-compatible JID.
// Baileys uses @s.whatsapp.net for individuals; WAHA and some tooling use @c.us.
// Groups (@g.us), newsletters (@newsletter), and status@broadcast are left as-is.
export function normalizeJid(idOrPhone: string): string {
  if (!idOrPhone) return idOrPhone
  if (idOrPhone.includes('@')) {
    return idOrPhone.replace(/@c\.us$/i, '@s.whatsapp.net')
  }
  return `${idOrPhone.replace(/[^0-9]/g, '')}@s.whatsapp.net`
}
