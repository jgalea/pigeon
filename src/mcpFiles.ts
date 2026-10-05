import { closeSync, constants, fstatSync, mkdirSync, openSync, readFileSync, realpathSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { homedir, platform } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'

// The MCP server runs on the host with the user's own file access, so the
// model's send_media and download_media paths are confined here: uploads only
// from a few known folders, downloads only into one.

// Base64 of this fits inside the gateway's 64 MB JSON body limit.
export const MAX_UPLOAD_BYTES = 48 * 1024 * 1024

const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0

export interface UploadPolicy {
  // Real paths of the directories uploads may come from, and how to name
  // them in errors.
  roots: string[]
  labels: string[]
  // Paths refused even when they sit under an allowed root.
  deny: string[]
  caseInsensitive: boolean
  maxBytes: number
}

type Env = Record<string, string | undefined>

function expandHome(p: string, home: string): string {
  return p === '~' ? home : p.startsWith('~/') ? join(home, p.slice(2)) : p
}

function realIfExists(p: string): string | undefined {
  try {
    return realpathSync.native(p)
  } catch {
    return undefined
  }
}

// Containment check on already-resolved absolute paths. The first segment
// test (not startsWith) keeps a child literally named "..x" from reading as
// an escape.
function inside(parent: string, child: string, caseInsensitive: boolean): boolean {
  const p = caseInsensitive ? parent.toLowerCase() : parent
  const c = caseInsensitive ? child.toLowerCase() : child
  const rel = relative(p, c)
  return rel === '' || (!isAbsolute(rel) && rel.split(sep)[0] !== '..')
}

export function uploadPolicy(
  env: Env,
  repoRoot: string,
  home = homedir(),
  os: string = platform(),
): UploadPolicy {
  const labels = [
    '~/Downloads',
    '~/code/artifacts',
    env.WA_MEDIA_DIR ?? join(repoRoot, 'media'),
    ...(env.PIGEON_UPLOAD_DIRS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  ]
  const roots: string[] = []
  const kept: string[] = []
  for (const label of labels) {
    const real = realIfExists(resolve(repoRoot, expandHome(label, home)))
    if (!real) continue
    roots.push(real)
    kept.push(label)
  }
  const deny = [
    resolve(repoRoot, env.WA_DATA_DIR ?? 'data'),
    join(repoRoot, '.env'),
    join(home, '.ssh'),
  ].map((p) => realIfExists(p) ?? p)
  return {
    roots,
    labels: kept,
    deny,
    caseInsensitive: os === 'darwin' || os === 'win32',
    maxBytes: MAX_UPLOAD_BYTES,
  }
}

export interface UploadFile {
  path: string
  filename: string
  data: Buffer
}

export function readUpload(input: string, policy: UploadPolicy, home = homedir()): UploadFile {
  const given = (input ?? '').trim()
  if (!given) throw new Error('path is empty')
  const allowed = `allowed folders: ${policy.labels.join(', ') || '(none exist)'}; add more with PIGEON_UPLOAD_DIRS`
  let real: string
  try {
    real = realpathSync.native(resolve(expandHome(given, home)))
  } catch {
    throw new Error(`file not found: ${given} (${allowed})`)
  }
  const root = policy.roots.find((r) => inside(r, real, policy.caseInsensitive))
  if (!root) throw new Error(`path not allowed: ${given} resolves outside the ${allowed}`)
  for (const d of policy.deny) {
    if (inside(d, real, policy.caseInsensitive)) throw new Error(`path not allowed: ${given} is under ${d}`)
  }
  const fold = (p: string) => (policy.caseInsensitive ? p.toLowerCase() : p)
  const dotted = relative(fold(root), fold(real))
    .split(sep)
    .find((seg) => seg.startsWith('.'))
  if (dotted) throw new Error(`path not allowed: dotfiles and dot-directories are refused (${dotted})`)

  const fd = openSync(real, constants.O_RDONLY | O_NOFOLLOW)
  try {
    const st = fstatSync(fd)
    if (!st.isFile()) throw new Error(`path not allowed: ${given} is not a regular file`)
    if (st.size > policy.maxBytes) {
      throw new Error(`file too large: ${st.size} bytes (limit ${policy.maxBytes})`)
    }
    return { path: real, filename: basename(real), data: readFileSync(fd) }
  } finally {
    closeSync(fd)
  }
}

export function downloadDir(env: Env, home = homedir()): string {
  const dir = env.PIGEON_DOWNLOAD_DIR?.trim()
  return dir ? resolve(expandHome(dir, home)) : join(home, 'Downloads', 'pigeon')
}

// Control and invisible characters, then anything a filesystem or shell
// treats specially.
const UNSAFE_NAME_CHARS = /[\u0000-\u001f\u007f​-‏‪-‮⁠-⁤⁦-⁩﻿<>:"|?*\\/]/g

// A bare file name derived from an untrusted suggestion: no directory part,
// no leading dots, nothing that could escape or hide. Returns undefined when
// nothing usable is left.
export function sanitizeFilename(name: string): string | undefined {
  let n = (name ?? '').split(/[\\/]/).pop() ?? ''
  n = n.replace(UNSAFE_NAME_CHARS, '').replace(/^[.\s]+/, '').replace(/[.\s]+$/, '')
  if (n.length > 200) {
    const ext = extname(n).slice(0, 20)
    n = n.slice(0, 200 - ext.length) + ext
  }
  return n && n !== '.' && n !== '..' ? n : undefined
}

// Write into dir under the given name, never over an existing file: on a
// clash the name gets " (1)", " (2)", ... before the extension. The file is
// created exclusively and without following a symlink in its place.
export async function saveDownload(dir: string, name: string, data: Buffer): Promise<string> {
  mkdirSync(dir, { recursive: true })
  const realDir = realpathSync.native(dir)
  const ext = extname(name)
  const stem = name.slice(0, name.length - ext.length)
  for (let n = 0; n < 1000; n++) {
    const candidate = n === 0 ? name : `${stem} (${n})${ext}`
    const path = join(realDir, candidate)
    if (dirname(path) !== realDir) throw new Error(`refusing to write outside ${realDir}`)
    try {
      const fh = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW, 0o600)
      try {
        await fh.writeFile(data)
      } finally {
        await fh.close()
      }
      return path
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
    }
  }
  throw new Error(`too many files named ${name} in ${realDir}`)
}
