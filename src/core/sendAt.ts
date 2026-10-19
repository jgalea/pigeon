const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/i

export function parseSendAt(input: unknown, now = Date.now()): number {
  let at: number
  if (typeof input === 'number') {
    if (!Number.isSafeInteger(input)) throw new Error('sendAt must be an integer epoch in milliseconds')
    at = input
  } else if (typeof input === 'string') {
    const s = input.trim()
    if (!ISO_WITH_OFFSET.test(s)) {
      throw new Error('sendAt must be ISO-8601 with an explicit offset or Z (e.g. 2026-10-20T07:30:00+01:00), or epoch milliseconds')
    }
    at = Date.parse(s)
    if (Number.isNaN(at)) throw new Error(`sendAt "${s}" is not a valid date`)
  } else {
    throw new Error('sendAt is required: ISO-8601 with an offset, or epoch milliseconds')
  }
  if (at <= now) throw new Error('sendAt is in the past')
  return at
}
