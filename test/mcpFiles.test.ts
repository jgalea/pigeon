import { describe, it, expect, beforeAll } from 'vitest'
import { mkdtempSync, mkdirSync, realpathSync, symlinkSync, writeFileSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { downloadDir, readUpload, sanitizeFilename, saveDownload, uploadPolicy, type UploadPolicy } from '../src/mcpFiles.js'

let base: string
let home: string
let repo: string

beforeAll(() => {
  base = realpathSync.native(mkdtempSync(join(tmpdir(), 'pigeon-files-')))
  home = join(base, 'home')
  repo = join(base, 'repo')
  for (const d of [
    join(home, 'Downloads', 'sub'),
    join(home, 'code', 'artifacts'),
    join(home, '.ssh'),
    join(home, 'extra'),
    join(repo, 'media'),
    join(repo, 'data'),
    join(home, 'Downloads', '.cache'),
  ]) {
    mkdirSync(d, { recursive: true })
  }
  writeFileSync(join(home, 'Downloads', 'a.pdf'), 'pdf')
  writeFileSync(join(home, 'Downloads', 'sub', 'b.jpg'), 'jpg')
  writeFileSync(join(home, 'Downloads', '..x'), 'odd')
  writeFileSync(join(home, 'Downloads', '.cache', 'c.png'), 'hidden')
  writeFileSync(join(home, 'code', 'artifacts', 'chart.png'), 'png')
  writeFileSync(join(home, 'extra', 'e.txt'), 'extra')
  writeFileSync(join(home, '.ssh', 'id_ed25519'), 'KEY')
  writeFileSync(join(home, 'secret.txt'), 'SECRET')
  writeFileSync(join(repo, '.env'), 'WA_API_KEY=k')
  writeFileSync(join(repo, 'media', 'm.ogg'), 'ogg')
  writeFileSync(join(repo, 'data', 'pigeon.sqlite'), 'db')
  symlinkSync(join(home, '.ssh', 'id_ed25519'), join(home, 'Downloads', 'key'))
  symlinkSync(join(home, 'secret.txt'), join(home, 'Downloads', 'secret.txt'))
  symlinkSync(join(repo, 'data'), join(home, 'Downloads', 'data'))
})

describe('uploadPolicy', () => {
  it('allows Downloads, code/artifacts, the media dir and PIGEON_UPLOAD_DIRS that exist', () => {
    const p = uploadPolicy({ PIGEON_UPLOAD_DIRS: '~/extra, /nonexistent/dir' }, repo, home, 'linux')
    expect(p.roots).toEqual([
      join(home, 'Downloads'),
      join(home, 'code', 'artifacts'),
      join(repo, 'media'),
      join(home, 'extra'),
    ])
    expect(p.labels).toEqual(['~/Downloads', '~/code/artifacts', join(repo, 'media'), '~/extra'])
    expect(p.deny).toEqual([join(repo, 'data'), join(repo, '.env'), join(home, '.ssh')])
    expect(p.caseInsensitive).toBe(false)
  })

  it('honours WA_MEDIA_DIR and WA_DATA_DIR and folds case on darwin', () => {
    const p = uploadPolicy({ WA_MEDIA_DIR: join(home, 'extra'), WA_DATA_DIR: join(home, 'Downloads', 'sub') }, repo, home, 'darwin')
    expect(p.roots[2]).toBe(join(home, 'extra'))
    expect(p.deny[0]).toBe(join(home, 'Downloads', 'sub'))
    expect(p.caseInsensitive).toBe(true)
  })
})

describe('readUpload', () => {
  let policy: UploadPolicy
  beforeAll(() => {
    policy = uploadPolicy({ PIGEON_UPLOAD_DIRS: '~/extra' }, repo, home, 'linux')
  })

  it('reads regular files under the allowed roots', () => {
    expect(readUpload(join(home, 'Downloads', 'a.pdf'), policy, home)).toMatchObject({ filename: 'a.pdf' })
    expect(readUpload('~/Downloads/sub/b.jpg', policy, home).data.toString()).toBe('jpg')
    expect(readUpload(join(home, 'code', 'artifacts', 'chart.png'), policy, home).filename).toBe('chart.png')
    expect(readUpload(join(repo, 'media', 'm.ogg'), policy, home).filename).toBe('m.ogg')
    expect(readUpload(join(home, 'extra', 'e.txt'), policy, home).data.toString()).toBe('extra')
  })

  it('refuses anything outside, including through symlinks', () => {
    expect(() => readUpload(join(home, 'secret.txt'), policy, home)).toThrow(/outside the allowed folders: ~\/Downloads, ~\/code\/artifacts/)
    expect(() => readUpload(join(home, 'Downloads', 'secret.txt'), policy, home)).toThrow(/not allowed/)
    expect(() => readUpload(join(home, 'Downloads', 'key'), policy, home)).toThrow(/not allowed/)
    expect(() => readUpload(join(home, 'Downloads', '..', 'secret.txt'), policy, home)).toThrow(/not allowed/)
    expect(() => readUpload(join(home, '.ssh', 'id_ed25519'), policy, home)).toThrow(/not allowed/)
    expect(() => readUpload(join(repo, '.env'), policy, home)).toThrow(/not allowed/)
  })

  it('refuses the data dir, dotfiles and dot-directories even under an allowed root', () => {
    const dataInside = uploadPolicy({ WA_DATA_DIR: join(home, 'Downloads', 'sub') }, repo, home, 'linux')
    expect(() => readUpload(join(home, 'Downloads', 'sub', 'b.jpg'), dataInside, home)).toThrow(/is under .*Downloads\/sub/)
    expect(() => readUpload(join(home, 'Downloads', 'data', 'pigeon.sqlite'), policy, home)).toThrow(/not allowed/)
    expect(() => readUpload(join(repo, 'data', 'pigeon.sqlite'), policy, home)).toThrow(/not allowed/)
    expect(() => readUpload(join(home, 'Downloads', '.cache', 'c.png'), policy, home)).toThrow(/dot-directories/)
    expect(() => readUpload(join(home, 'Downloads', '..x'), policy, home)).toThrow(/dot-directories/)
  })

  it('refuses directories, missing files, empty paths and oversized files', () => {
    expect(() => readUpload(join(home, 'Downloads'), policy, home)).toThrow(/not a regular file/)
    expect(() => readUpload(join(home, 'Downloads', 'nope.pdf'), policy, home)).toThrow(/file not found/)
    expect(() => readUpload('', policy, home)).toThrow(/empty/)
    expect(() => readUpload(join(home, 'Downloads', 'a.pdf'), { ...policy, maxBytes: 2 }, home)).toThrow(/too large/)
  })

  it('compares case-insensitively only when asked', () => {
    const upper = { ...policy, roots: [join(home, 'Downloads').toUpperCase()], caseInsensitive: true }
    expect(readUpload(join(home, 'Downloads', 'a.pdf'), upper, home).filename).toBe('a.pdf')
    const strict = { ...upper, caseInsensitive: false }
    expect(() => readUpload(join(home, 'Downloads', 'a.pdf'), strict, home)).toThrow(/not allowed/)
  })
})

describe('downloadDir', () => {
  it('defaults to ~/Downloads/pigeon and honours PIGEON_DOWNLOAD_DIR', () => {
    expect(downloadDir({}, home)).toBe(join(home, 'Downloads', 'pigeon'))
    expect(downloadDir({ PIGEON_DOWNLOAD_DIR: '~/dl' }, home)).toBe(join(home, 'dl'))
    expect(downloadDir({ PIGEON_DOWNLOAD_DIR: '/abs/dl' }, home)).toBe('/abs/dl')
  })
})

describe('sanitizeFilename', () => {
  it('keeps a bare name and strips directories, leading dots and unsafe characters', () => {
    expect(sanitizeFilename('report.pdf')).toBe('report.pdf')
    expect(sanitizeFilename('../../.ssh/evil.txt')).toBe('evil.txt')
    expect(sanitizeFilename('..\\..\\win.txt')).toBe('win.txt')
    expect(sanitizeFilename('.env')).toBe('env')
    expect(sanitizeFilename('  ...hidden.txt ')).toBe('hidden.txt')
    expect(sanitizeFilename('a​b<c>:d"e|f?g*h.txt\u0000')).toBe('abcdefgh.txt')
    expect(sanitizeFilename('trailing. ')).toBe('trailing')
    expect(sanitizeFilename('x'.repeat(300) + '.pdf')!.length).toBe(200)
  })

  it('refuses empty, dot and dot-dot', () => {
    for (const bad of ['', '.', '..', '...', '/', '\\', '   ', '​']) {
      expect(sanitizeFilename(bad), JSON.stringify(bad)).toBeUndefined()
    }
  })
})

describe('saveDownload', () => {
  it('creates the dir, never overwrites, and skips a symlink planted in its place', async () => {
    const dir = join(base, 'dl', 'nested')
    const first = await saveDownload(dir, 'f.txt', Buffer.from('one'))
    expect(first).toBe(join(dir, 'f.txt'))
    const second = await saveDownload(dir, 'f.txt', Buffer.from('two'))
    expect(second).toBe(join(dir, 'f (1).txt'))
    const third = await saveDownload(dir, 'f.txt', Buffer.from('three'))
    expect(third).toBe(join(dir, 'f (2).txt'))
    expect(readFileSync(first, 'utf8')).toBe('one')
    expect(readFileSync(second, 'utf8')).toBe('two')
    expect(statSync(first).mode & 0o777).toBe(0o600)

    const target = join(base, 'victim.txt')
    writeFileSync(target, 'intact')
    symlinkSync(target, join(dir, 'link.txt'))
    const viaLink = await saveDownload(dir, 'link.txt', Buffer.from('attack'))
    expect(viaLink).toBe(join(dir, 'link (1).txt'))
    expect(readFileSync(target, 'utf8')).toBe('intact')
    expect(readdirSync(dir).sort()).toEqual(['f (1).txt', 'f (2).txt', 'f.txt', 'link (1).txt', 'link.txt'])
  })
})
