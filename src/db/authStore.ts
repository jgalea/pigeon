import {
  initAuthCreds,
  BufferJSON,
  type AuthenticationCreds,
  type SignalDataTypeMap,
} from '@whiskeysockets/baileys'
import type { DB } from './database.js'

export async function useSqliteAuthState(db: DB, session: string) {
  const get = db.prepare('SELECT value FROM auth_state WHERE session=? AND key=?')
  const put = db.prepare(
    'INSERT INTO auth_state(session,key,value) VALUES(?,?,?) ON CONFLICT(session,key) DO UPDATE SET value=excluded.value',
  )
  const del = db.prepare('DELETE FROM auth_state WHERE session=? AND key=?')

  const read = (key: string) => {
    const row = get.get(session, key) as { value: string } | undefined
    return row ? JSON.parse(row.value, BufferJSON.reviver) : undefined
  }
  const write = (key: string, value: unknown) =>
    put.run(session, key, JSON.stringify(value, BufferJSON.replacer))

  const creds: AuthenticationCreds = read('creds') ?? initAuthCreds()

  return {
    state: {
      creds,
      keys: {
        get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
          const data: { [id: string]: SignalDataTypeMap[T] } = {}
          for (const id of ids) {
            const v = read(`${type}-${id}`)
            if (v) data[id] = v
          }
          return data
        },
        set: async (data: { [k: string]: { [id: string]: unknown } }) => {
          for (const type of Object.keys(data)) {
            for (const id of Object.keys(data[type])) {
              const value = data[type][id]
              const key = `${type}-${id}`
              if (value) write(key, value)
              else del.run(session, key)
            }
          }
        },
      },
    },
    saveCreds: async () => {
      write('creds', creds)
    },
  }
}
