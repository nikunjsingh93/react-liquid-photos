import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import path from 'node:path'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import fg from 'fast-glob'
import chokidar from 'chokidar'
import Database from 'better-sqlite3'
import sharp from 'sharp'
import mime from 'mime-types'
import archiver from 'archiver'

/* ---------- config ---------- */
const ROOT = process.cwd()
const PHOTOS_ROOT = process.env.PHOTOS_PATH || '/pictures'
const PORT = Number(process.env.PORT || 5174)
const HOST = process.env.HOST || '0.0.0.0'
const CACHE_DIR = path.join(ROOT, '.cache')
const DB_PATH = path.join(CACHE_DIR, 'index.db')
const THUMBS_DIR = path.join(CACHE_DIR, 'thumbs')
const VIEWS_DIR = path.join(CACHE_DIR, 'views')
const RAW_PREVIEWS_DIR = path.join(CACHE_DIR, 'rawpreviews')
const MEDIA_PREVIEWS_DIR = path.join(CACHE_DIR, 'media')
const THUMB_WIDTH = Number(process.env.THUMB_WIDTH || 512)
const VIEW_WIDTH = Number(process.env.VIEW_WIDTH || 1920)
const DB_CACHE_SIZE_MB = Number(process.env.DB_CACHE_SIZE_MB || 256)

/* ---- watcher controls (disabled by default to avoid ENOSPC) ---- */
const WATCH_ENABLED = (process.env.WATCH_ENABLED ?? '0') !== '0'
const WATCH_DEPTH = Number(process.env.WATCH_DEPTH || 99)
const WATCH_POLL = (process.env.WATCH_POLL || '0') === '1'
const WATCH_IGNORED = (process.env.WATCH_IGNORED || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)

fs.mkdirSync(CACHE_DIR, { recursive: true })
fs.mkdirSync(THUMBS_DIR, { recursive: true })
fs.mkdirSync(VIEWS_DIR, { recursive: true })
fs.mkdirSync(RAW_PREVIEWS_DIR, { recursive: true })
fs.mkdirSync(MEDIA_PREVIEWS_DIR, { recursive: true })

/* ---------- helpers ---------- */
const toPosix = (p) => p.split(path.sep).join('/')
const rel = (abs) => toPosix(path.relative(PHOTOS_ROOT, abs))
const hashPath = (p) => crypto.createHash('sha1').update(p).digest('hex')
const nowMs = () => Date.now()

/* ---------- password hashing (low memory scrypt) ---------- */
const SCRYPT_N = 1 << 14 // 16384
const SCRYPT_R = 8
const SCRYPT_P = 1

function hashPassword(password) {
  const salt = crypto.randomBytes(16)
  const hash = crypto.scryptSync(password, salt, 64, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P })
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('hex')}$${hash.toString('hex')}`
}
function verifyPassword(password, stored) {
  try {
    const [scheme, nStr, rStr, pStr, saltHex, hashHex] = stored.split('$')
    if (scheme !== 'scrypt') return false
    const N = Number(nStr), r = Number(rStr), p = Number(pStr)
    const salt = Buffer.from(saltHex, 'hex')
    const want = Buffer.from(hashHex, 'hex')
    const got = crypto.scryptSync(password, salt, want.length, { N, r, p })
    return crypto.timingSafeEqual(want, got)
  } catch { return false }
}

/* ---------- db ---------- */
const db = new Database(DB_PATH)
db.pragma('journal_mode = WAL')
db.pragma('synchronous = NORMAL')
db.pragma('temp_store = MEMORY')
db.pragma(`cache_size = -${DB_CACHE_SIZE_MB * 1024}`)

/* base (images) schema */
db.exec(`
CREATE TABLE IF NOT EXISTS images (
  id INTEGER PRIMARY KEY,
  path   TEXT UNIQUE NOT NULL,
  fname  TEXT NOT NULL,
  folder TEXT NOT NULL,
  ctime  INTEGER,
  mtime  INTEGER,
  size   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_images_folder        ON images(folder);
CREATE INDEX IF NOT EXISTS idx_images_folder_mtime  ON images(folder, mtime DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS images_fts USING fts5(
  fname, folder, path, content='images', content_rowid='id'
);

CREATE TRIGGER IF NOT EXISTS images_ai AFTER INSERT ON images BEGIN
  INSERT INTO images_fts(rowid, fname, folder, path) VALUES (new.id, new.fname, new.folder, new.path);
END;
CREATE TRIGGER IF NOT EXISTS images_ad AFTER DELETE ON images BEGIN
  INSERT INTO images_fts(images_fts, rowid, fname, folder, path) VALUES('delete', old.id, old.fname, old.folder, old.path);
END;
CREATE TRIGGER IF NOT EXISTS images_au AFTER UPDATE ON images BEGIN
  INSERT INTO images_fts(images_fts, rowid, fname, folder, path) VALUES('delete', old.id, old.fname, old.folder, old.path);
  INSERT INTO images_fts(rowid, fname, folder, path) VALUES (new.id, new.fname, new.folder, new.path);
END;
`)

/* auth schema */
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username   TEXT UNIQUE NOT NULL,
  pass_hash  TEXT NOT NULL,
  is_admin   INTEGER NOT NULL DEFAULT 0,
  root_path  TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);

CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL,
  token      TEXT UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
`)

/* ---------- tiny migrations for old DBs ---------- */
function getCols(table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map(r => r.name)
}
function ensureColumn(table, specSql, colName, indexSql = null) {
  const cols = getCols(table)
  if (!cols.includes(colName)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${specSql}`)
    if (indexSql) db.exec(indexSql)
  }
}
ensureColumn('sessions', 'token TEXT', 'token', 'CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token)')
ensureColumn('sessions', 'created_at INTEGER NOT NULL DEFAULT 0', 'created_at')
ensureColumn('sessions', 'expires_at INTEGER NOT NULL DEFAULT 0', 'expires_at')
ensureColumn('users', 'is_admin INTEGER NOT NULL DEFAULT 0', 'is_admin')
ensureColumn('users', 'root_path TEXT', 'root_path')

/* ---------- indexer ---------- */
const insertStmt = db.prepare(`INSERT OR IGNORE INTO images(path, fname, folder, ctime, mtime, size) VALUES(?,?,?,?,?,?)`)
const updateStmt = db.prepare(`UPDATE images SET ctime=?, mtime=?, size=? WHERE path=?`)

const IMG_EXT = new Set([
  '.jpg','.jpeg','.png','.webp','.avif','.gif',
  '.tif','.tiff','.bmp','.heic','.heif',
  // RAW formats (index these so we can extract previews)
  '.dng','.arw','.cr2','.raf','.nef','.rw2'
])

const RAW_EXT = new Set(['.dng','.arw','.cr2','.raf','.nef','.rw2'])
const HEIC_EXT = new Set(['.heic', '.heif'])

function isRawExt(filePath) {
  const ext = path.extname(filePath).toLowerCase()
  return RAW_EXT.has(ext)
}

function isHeicExt(filePath) {
  const ext = path.extname(filePath).toLowerCase()
  return HEIC_EXT.has(ext)
}

async function fileExists(p) {
  try { await fsp.access(p); return true } catch { return false }
}

/**
 * Extract largest available embedded preview from a RAW file using exiftool.
 * Tries JpgFromRaw, PreviewImage, then ThumbnailImage. Returns absolute path to cached file or null.
 */
async function ensureRawEmbeddedPreview(absPath) {
  const h = hashPath(absPath)
  const out = path.join(RAW_PREVIEWS_DIR, `${h}.bin`)
  if (await fileExists(out)) return out

  async function tryExtractToOut(tag) {
    return new Promise((resolve) => {
      const args = ['-b', `-${tag}`, absPath]
      const ex = spawn('exiftool', args, { stdio: ['ignore', 'pipe', 'pipe'] })
      const ws = fs.createWriteStream(out)
      let wrote = 0
      ex.stdout.on('data', (chunk) => { wrote += chunk.length })
      ex.stdout.pipe(ws)
      ex.on('close', async (code) => {
        try { ws.close() } catch {}
        if (code === 0 && wrote > 0) resolve(true)
        else { try { await fsp.unlink(out) } catch {}; resolve(false) }
      })
      ex.on('error', async () => { try { await fsp.unlink(out) } catch {}; resolve(false) })
    })
  }

  // Prefer JPEG-like embedded previews that are widely present in DNG/RAW files
  const tags = [
    'JpgFromRaw',
    'PreviewImage',
    // OtherImage sometimes holds JPEG previews in some RAW containers
    'OtherImage', 'OtherImage1', 'OtherImage2', 'OtherImage3',
    // Last resort small thumbnail
    'ThumbnailImage'
  ]

  for (const tag of tags) {
    const ok = await tryExtractToOut(tag)
    if (!ok) continue
    // Validate that sharp can read it; if not, try next tag
    try {
      await sharp(out).metadata()
      return out
    } catch {
      try { await fsp.unlink(out) } catch {}
      continue
    }
  }
  return null
}

/**
 * Decode HEIC/HEIF using heif-convert to a lossless/displayable JPEG for downstream processing.
 */
async function ensureHeicDecodedPreview(absPath) {
  const h = hashPath(absPath)
  const out = path.join(RAW_PREVIEWS_DIR, `${h}.jpg`)
  if (await fileExists(out)) return out
  return new Promise((resolve) => {
    const args = [absPath, out]
    const ex = spawn('heif-convert', args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderrBuf = ''
    ex.stderr.on('data', (d) => { stderrBuf += String(d) })
    ex.on('close', async (code) => {
      if (code === 0 && await fileExists(out)) resolve(out)
      else { try { await fsp.unlink(out) } catch {}; resolve(null) }
    })
    ex.on('error', async () => { try { await fsp.unlink(out) } catch {}; resolve(null) })
  })
}

async function scanAndIndex() {
  console.log('[index] scanning…')
  const t0 = Date.now()
  const entries = await fg(['**/*'], {
    cwd: PHOTOS_ROOT, dot: false, onlyFiles: true,
    unique: true, absolute: true, suppressErrors: true
  })
  let count = 0
  const tx = db.transaction((batch) => { for (const b of batch) b() })
  const ops = []
  for (const abs of entries) {
    const ext = path.extname(abs).toLowerCase()
    if (!IMG_EXT.has(ext)) continue
    try {
      const st = await fsp.stat(abs)
      const r = rel(abs)
      const folder = toPosix(path.dirname(r))
      const fname = path.basename(abs)
      ops.push(() => insertStmt.run(r, fname, folder, Math.floor(st.ctimeMs), Math.floor(st.mtimeMs), st.size))
      count++
    } catch {}
  }
  tx(ops)
  console.log(`[index] done: ${count.toLocaleString()} files in ${((Date.now()-t0)/1000).toFixed(1)}s`)
}

async function ensureThumb(absPath) {
  const h = hashPath(absPath)
  const out = path.join(THUMBS_DIR, `${h}.webp`)
  try { await fsp.access(out); return out } catch {}
  try {
    try {
      await sharp(absPath).rotate().resize({ width: THUMB_WIDTH, withoutEnlargement: true }).webp({ quality: 82 }).toFile(out)
      return out
    } catch (e) {
      if (isRawExt(absPath)) {
        const prev = await ensureRawEmbeddedPreview(absPath)
        if (!prev) throw e
        await sharp(prev).rotate().resize({ width: THUMB_WIDTH, withoutEnlargement: true }).webp({ quality: 82 }).toFile(out)
      } else if (isHeicExt(absPath)) {
        const prev = await ensureHeicDecodedPreview(absPath)
        if (!prev) throw e
        await sharp(prev).rotate().resize({ width: THUMB_WIDTH, withoutEnlargement: true }).webp({ quality: 82 }).toFile(out)
      } else {
        throw e
      }
    }
    return out
  } catch (e) {
    console.warn('thumb failed', absPath, e.message)
    return null
  }
}

async function ensureView(absPath) {
  const h = hashPath(absPath)
  const out = path.join(VIEWS_DIR, `${h}.webp`)
  try { await fsp.access(out); return out } catch {}
  try {
    try {
      await sharp(absPath).rotate().resize({ width: VIEW_WIDTH, withoutEnlargement: true }).webp({ quality: 85 }).toFile(out)
      return out
    } catch (e) {
      if (isRawExt(absPath)) {
        const prev = await ensureRawEmbeddedPreview(absPath)
        if (!prev) throw e
        await sharp(prev).rotate().resize({ width: VIEW_WIDTH, withoutEnlargement: true }).webp({ quality: 85 }).toFile(out)
      } else if (isHeicExt(absPath)) {
        const prev = await ensureHeicDecodedPreview(absPath)
        if (!prev) throw e
        await sharp(prev).rotate().resize({ width: VIEW_WIDTH, withoutEnlargement: true }).webp({ quality: 85 }).toFile(out)
      } else {
        throw e
      }
    }
    return out
  } catch (e) {
    console.warn('view failed', absPath, e.message)
    return null
  }
}

/**
 * For browsers that cannot render RAW originals, provide a displayable media.
 * If RAW: return path to embedded preview (no resize). Else: return original file path.
 * Returns: { path, contentType }
 */
async function ensureDisplayableMedia(absPath) {
  if (!isRawExt(absPath) && !isHeicExt(absPath)) {
    const type = mime.lookup(absPath) || 'application/octet-stream'
    return { path: absPath, contentType: type }
  }
  // For RAW/HEIC, always provide a web-compatible media preview (WebP) without resizing
  const h = hashPath(absPath)
  const out = path.join(MEDIA_PREVIEWS_DIR, `${h}.webp`)
  try { await fsp.access(out); return { path: out, contentType: 'image/webp' } } catch {}
  const prev = isHeicExt(absPath) ? await ensureHeicDecodedPreview(absPath) : await ensureRawEmbeddedPreview(absPath)
  if (prev) {
    try {
      await sharp(prev).rotate().webp({ quality: 90 }).toFile(out)
      return { path: out, contentType: 'image/webp' }
    } catch (e) {
      // If transcode fails, stream the preview as-is with best-guess type
      let type = 'image/jpeg'
      try {
        const md = await sharp(prev).metadata()
        if (md?.format) {
          if (md.format === 'tiff') type = 'image/tiff'
          else if (md.format === 'png') type = 'image/png'
          else if (md.format === 'webp') type = 'image/webp'
          else type = 'image/jpeg'
        }
      } catch {}
      return { path: prev, contentType: type }
    }
  }
  // Fallback to original (may not render), but at least downloadable
  const type = mime.lookup(absPath) || 'application/octet-stream'
  return { path: absPath, contentType: type }
}

/* ---------- tree (scoped) ---------- */
function buildTreeForScope(scopePath) {
  const lower = scopePath
  const upper = scopePath + '\uFFFF'
  const rows = db.prepare(`SELECT DISTINCT folder FROM images WHERE folder >= ? AND folder < ?`).all(lower, upper)

  let rootName = path.basename(PHOTOS_ROOT) || '/'
  if (scopePath) {
    const parts = scopePath.split('/').filter(Boolean)
    rootName = parts.length ? parts[parts.length - 1] : rootName
  }
  const root = { name: rootName, path: '', count: 0, children: [] }

  const map = new Map([['', root]])

  for (const { folder } of rows) {
    const relPath = scopePath ? folder.replace(new RegExp(`^${scopePath}/?`), '') : folder
    if (relPath === '' || relPath === '.') continue
    const segs = relPath.split('/').filter(Boolean)
    let curPath = ''
    let parent = root
    for (const seg of segs) {
      curPath = curPath ? `${curPath}/${seg}` : seg
      if (!map.has(curPath)) {
        const node = { name: seg, path: curPath, count: 0, children: [] }
        map.set(curPath, node)
        parent.children.push(node)
      }
      parent = map.get(curPath)
    }
  }

  const prefixCount = db.prepare(`SELECT COUNT(*) as c FROM images WHERE folder >= ? AND folder < ?`)
  const fillCounts = (node, relPath) => {
    const absPrefix = scopePath ? (relPath ? `${scopePath}/${relPath}` : scopePath) : (relPath || '')
    const lowerP = absPrefix
    const upperP = absPrefix + '\uFFFF'
    node.count = prefixCount.get(lowerP, upperP).c
    node.children.forEach(child => fillCounts(child, child.path))
  }
  fillCounts(root, '')

  const sortRec = (n) => { n.children.sort((a,b)=>a.name.localeCompare(b.name)); n.children.forEach(sortRec) }
  sortRec(root)
  return root
}

/* ---------- initial index ---------- */
const empty = db.prepare('SELECT COUNT(*) as c FROM images').get().c === 0
if (empty) { await scanAndIndex() }

/* ---------- watch filesystem (optional) ---------- */
if (WATCH_ENABLED) {
  console.log(`[watch] enabled (depth=${WATCH_DEPTH}, polling=${WATCH_POLL ? 'on' : 'off'})`)
  const watcher = chokidar.watch(PHOTOS_ROOT, {
    ignoreInitial: true,
    depth: WATCH_DEPTH,
    usePolling: WATCH_POLL,
    awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
    ignored: WATCH_IGNORED.length ? WATCH_IGNORED : undefined,
  })

  watcher
    .on('add', async (abs) => {
      const ext = path.extname(abs).toLowerCase(); if (!IMG_EXT.has(ext)) return
      const st = await fsp.stat(abs).catch(() => null); if (!st) return
      const r = rel(abs); const folder = toPosix(path.dirname(r)); const fname = path.basename(abs)
      insertStmt.run(r, fname, folder, Math.floor(st.ctimeMs), Math.floor(st.mtimeMs), st.size)
    })
    .on('change', async (abs) => {
      const st = await fsp.stat(abs).catch(() => null); if (!st) return
      updateStmt.run(Math.floor(st.ctimeMs), Math.floor(st.mtimeMs), st.size, rel(abs))
    })
    .on('unlink', (abs) => {
      db.prepare('DELETE FROM images WHERE path=?').run(rel(abs))
    })
    .on('error', (e) => {
      console.warn('[watch] error:', e?.message || e)
    })
} else {
  console.log('[watch] disabled. Use POST /api/index to rescan, or set WATCH_ENABLED=1 to enable live watching.')
}

/* ---------- auth helpers ---------- */
function parseCookies(req) {
  const h = req.headers.cookie; if (!h) return {}
  return Object.fromEntries(
    h.split(/; */).map(p => {
      const i = p.indexOf('=')
      const k = decodeURIComponent(p.slice(0, i).trim())
      const v = decodeURIComponent(p.slice(i + 1))
      return [k, v]
    })
  )
}
const SESSION_COOKIE = 'lp_session'
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30 // 30d

const insertSession = db.prepare(`INSERT INTO sessions(user_id, token, created_at, expires_at) VALUES(?,?,?,?)`)
const getSession = db.prepare(`SELECT s.id, s.user_id, s.token, s.created_at, s.expires_at, u.username, u.is_admin, u.root_path
                               FROM sessions s JOIN users u ON u.id = s.user_id
                               WHERE s.token = ?`)
const deleteSession = db.prepare(`DELETE FROM sessions WHERE token = ?`)
const getUserByUsername = db.prepare(`SELECT * FROM users WHERE username = ?`)
const insertUser = db.prepare(`INSERT INTO users(username, pass_hash, is_admin, root_path, created_at) VALUES(?,?,?,?,?)`)
const anyAdmin = db.prepare(`SELECT id FROM users WHERE is_admin = 1 LIMIT 1`)

/* admin bootstrap */
function normalizeScopeInput(input) {
  if (!input) return ''
  let p = input
  if (path.isAbsolute(p)) {
    const relp = path.relative(PHOTOS_ROOT, p)
    if (relp.startsWith('..')) throw new Error('root_path must be inside PHOTOS_PATH')
    p = relp
  }
  p = toPosix(p).replace(/^\.\/+/, '').replace(/^\/+/, '').replace(/\/+$/, '')
  return p
}

function ensureAdmin() {
  if (anyAdmin.get()) return
  const ADMIN_USER = (process.env.ADMIN_USER || 'admin').trim()
  const ADMIN_PASS = (process.env.ADMIN_PASS || 'admin123').trim()
  const pass_hash = hashPassword(ADMIN_PASS)
  insertUser.run(ADMIN_USER, pass_hash, 1, null, nowMs())
  console.log(`[auth] created default admin '${ADMIN_USER}'`)
}
ensureAdmin()

/* ---------- app ---------- */
const app = express()
// if behind a proxy/ingress, trust X-Forwarded-* so req.secure works
app.set('trust proxy', true)
app.use(cors({ origin: true, credentials: true }))
app.use(express.json({ limit: '5mb' }))

// Decide whether to set the cookie with `Secure` flag.
// Rule: if COOKIE_SECURE is explicitly set, use it; else use HTTPS detection.
function shouldUseSecureCookie(req) {
  const override = process.env.COOKIE_SECURE
  if (override !== undefined) return override !== '0'
  const xfProto = (req.headers['x-forwarded-proto'] || '').toString().split(',')[0].trim().toLowerCase()
  return req.secure || xfProto === 'https'
}

// helper to set session cookie consistently
function setSessionCookie(req, res, value, maxAgeMs) {
  const secure = shouldUseSecureCookie(req)
  const attrs = `; Max-Age=${Math.floor(maxAgeMs/1000)}; Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`
  if (typeof res.cookie === 'function') {
    try {
      res.cookie(SESSION_COOKIE, value, { httpOnly: true, sameSite: 'lax', secure, maxAge: maxAgeMs, path: '/' })
      return
    } catch {}
  }
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${value}${attrs}`)
}

// helper to clear the cookie
function clearSessionCookie(req, res) {
  const secure = shouldUseSecureCookie(req)
  const attrs = `; Max-Age=0; Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=deleted${attrs}`)
}

/* auth routes */
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {}
  if (!username || !password) return res.status(400).json({ error: 'missing credentials' })
  const u = getUserByUsername.get(String(username).trim())
  if (!u || !verifyPassword(String(password), u.pass_hash)) return res.status(401).json({ error: 'invalid credentials' })
  const token = crypto.randomBytes(32).toString('hex')
  const created = nowMs(), expires = created + SESSION_TTL_MS
  insertSession.run(u.id, token, created, expires)
  setSessionCookie(req, res, token, SESSION_TTL_MS)
  res.json({ ok: true, user: { id: u.id, username: u.username, is_admin: !!u.is_admin, root_path: u.root_path || '' } })
})

app.get('/api/auth/me', (req, res) => {
  // lightweight inline optional auth so we can return 401 when missing
  let user = null
  try {
    const cookies = parseCookies(req)
    const token = cookies[SESSION_COOKIE]
    if (token) {
      const row = getSession.get(token)
      if (row && row.expires_at > nowMs()) {
        user = { id: row.user_id, username: row.username, is_admin: !!row.is_admin, root_path: row.root_path ? toPosix(row.root_path) : '' }
      }
    }
  } catch {}
  if (!user) return res.status(401).json({ user: null })
  res.json({ user })
})

app.post('/api/auth/logout', (req, res) => {
  try {
    const cookies = parseCookies(req)
    const token = cookies[SESSION_COOKIE]
    if (token) { try { deleteSession.run(token) } catch {} }
  } catch {}
  clearSessionCookie(req, res)
  res.json({ ok: true })
})

/* admin/require helpers */
function authOptional(req, _res, next) {
  req.user = null
  try {
    const cookies = parseCookies(req)
    const token = cookies[SESSION_COOKIE]
    if (!token) return next()
    const row = getSession.get(token)
    if (!row || row.expires_at < nowMs()) return next()
    req.user = { id: row.user_id, username: row.username, is_admin: !!row.is_admin, root_path: row.root_path ? toPosix(row.root_path) : '' }
  } catch {}
  next()
}
function requireAuth(req, res, next) {
  authOptional(req, res, () => {
    if (!req.user) return res.status(401).json({ error: 'auth required' })
    next()
  })
}
function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (!req.user?.is_admin) return res.status(403).json({ error: 'admin only' })
    next()
  })
}

/* admin routes */
app.get('/api/admin/users', requireAdmin, (_req, res) => {
  const rows = db.prepare(`SELECT id, username, is_admin, COALESCE(root_path,'') as root_path, created_at FROM users ORDER BY id ASC`).all()
  res.json({ items: rows })
})
app.post('/api/admin/users', requireAdmin, (req, res) => {
  const { username, password, root_path } = req.body || {}
  if (!username || !password) return res.status(400).json({ error: 'username & password required' })
  let scoped = ''
  try { scoped = normalizeScopeInput(root_path || '') } catch (e) { return res.status(400).json({ error: e.message }) }
  const pass_hash = hashPassword(String(password))
  try {
    const info = insertUser.run(String(username).trim(), pass_hash, 0, scoped || null, nowMs())
    res.json({ ok: true, id: info.lastInsertRowid })
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: 'username exists' })
    res.status(500).json({ error: e.message })
  }
})

/* tree/photos: require auth, scope by user.root_path */
function scopeJoin(scope, relFolder) {
  const a = (scope || '').trim()
  const b = (relFolder || '').trim()
  if (!a) return b
  if (!b) return a
  return `${a}/${b}`
}
function inScope(scope, folder) {
  const lower = scope || ''
  const upper = lower + '\uFFFF'
  return folder >= lower && folder < upper
}

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd']
  const v = n % 100
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`
}

function buildDateTreeForScope(scopePath) {
  const lower = scopePath || ''
  const upper = lower + '\uFFFF'
  const rows = db.prepare(`
    SELECT
      CAST(strftime('%Y', mtime/1000, 'unixepoch') AS INTEGER) AS y,
      CAST(strftime('%m', mtime/1000, 'unixepoch') AS INTEGER) AS m,
      CAST(strftime('%d', mtime/1000, 'unixepoch') AS INTEGER) AS d,
      COUNT(*) AS c
    FROM images
    WHERE folder >= ? AND folder < ?
    GROUP BY y, m, d
    ORDER BY y DESC, m DESC, d DESC
  `).all(lower, upper)

  const root = { name: 'Dates', path: 'date:', count: 0, children: [] }
  const yMap = new Map()
  const ymMap = new Map()

  for (const r of rows) {
    if (!Number.isFinite(r.y) || !Number.isFinite(r.m) || !Number.isFinite(r.d)) continue
    const yearKey = r.y
    let yNode = yMap.get(yearKey)
    if (!yNode) {
      yNode = { name: String(yearKey), path: `date:Y-${yearKey}`, count: 0, children: [] }
      yMap.set(yearKey, yNode)
      root.children.push(yNode)
    }
    yNode.count += r.c

    const monthKey = `${yearKey}-${String(r.m).padStart(2, '0')}`
    let mNode = ymMap.get(monthKey)
    if (!mNode) {
      const dateForName = new Date(Date.UTC(yearKey, r.m - 1, 1))
      const monthName = dateForName.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' })
      mNode = { name: monthName, path: `date:M-${yearKey}-${String(r.m).padStart(2, '0')}`, count: 0, children: [] }
      ymMap.set(monthKey, mNode)
      yNode.children.push(mNode)
    }
    mNode.count += r.c

    const dateForDay = new Date(Date.UTC(r.y, r.m - 1, r.d))
    const weekday = dateForDay.toLocaleString('en-US', { weekday: 'short', timeZone: 'UTC' })
    const dName = `${weekday}, ${r.d}`
    const dPath = `date:D-${r.y}-${String(r.m).padStart(2, '0')}-${String(r.d).padStart(2, '0')}`
    mNode.children.push({ name: dName, path: dPath, count: r.c, children: [] })
  }

  const sortRec = (n) => {
    if (!n.children) return
    // For dates tree, children already appended in descending order by query
    n.children.forEach(sortRec)
  }
  sortRec(root)
  root.count = root.children.reduce((a, y) => a + (y.count || 0), 0)
  return root
}

app.get('/api/tree', requireAuth, (req, res) => {
  try {
    const mode = String(req.query.mode || 'folders')
    if (mode === 'dates') {
      res.json(buildDateTreeForScope(req.user.root_path || ''))
    } else {
      res.json(buildTreeForScope(req.user.root_path || ''))
    }
  } catch (e) { res.status(500).json({ error: e.message }) }
})

app.get('/api/photos', requireAuth, (req, res) => {
  const userScope = req.user.root_path || ''
  const folderRel = (req.query.folder || '').toString()
  const folder = scopeJoin(userScope, folderRel)
  const q = (req.query.q || '').toString().trim()
  const page = Math.max(1, parseInt(req.query.page || '1', 10))
  const pageSize = Math.max(1, Math.min(500, parseInt(req.query.pageSize || '200', 10)))
  const offset = (page - 1) * pageSize

  const lower = folder
  const upper = folder + '\uFFFF'
  const hasFrom = Object.prototype.hasOwnProperty.call(req.query, 'from')
  const hasTo = Object.prototype.hasOwnProperty.call(req.query, 'to')
  const useDateRange = hasFrom && hasTo
  const fromMs = useDateRange ? Number(req.query.from) : 0
  const toMs = useDateRange ? Number(req.query.to) : 0

  try {
    let rows = []
    let total = 0

    if (q) {
      const term = q.replace(/\s+/g, ' ')
      if (useDateRange) {
        rows = db.prepare(`
          SELECT i.id, i.fname, i.folder, i.mtime, i.size
          FROM images i
          JOIN images_fts f ON f.rowid = i.id
          WHERE f MATCH ?
            AND i.folder >= ?
            AND i.folder < ?
            AND i.mtime >= ? AND i.mtime < ?
          ORDER BY i.mtime DESC, i.id DESC
          LIMIT ? OFFSET ?
        `).all(term, userScope, userScope + '\uFFFF', fromMs, toMs, pageSize, offset)

        total = db.prepare(`
          SELECT COUNT(*) AS c
          FROM images i
          JOIN images_fts f ON f.rowid = i.id
          WHERE f MATCH ?
            AND i.folder >= ?
            AND i.folder < ?
            AND i.mtime >= ? AND i.mtime < ?
        `).get(term, userScope, userScope + '\uFFFF', fromMs, toMs).c
      } else {
        rows = db.prepare(`
        SELECT i.id, i.fname, i.folder, i.mtime, i.size
        FROM images i
        JOIN images_fts f ON f.rowid = i.id
        WHERE f MATCH ?
          AND i.folder >= ?
          AND i.folder < ?
        ORDER BY i.mtime DESC, i.id DESC
        LIMIT ? OFFSET ?
        `).all(term, lower, upper, pageSize, offset)

        total = db.prepare(`
        SELECT COUNT(*) AS c
        FROM images i
        JOIN images_fts f ON f.rowid = i.id
        WHERE f MATCH ?
          AND i.folder >= ?
          AND i.folder < ?
        `).get(term, lower, upper).c
      }
    } else {
      if (useDateRange) {
        rows = db.prepare(`
          SELECT id, fname, folder, mtime, size
          FROM images
          WHERE folder >= ?
            AND folder < ?
            AND mtime >= ? AND mtime < ?
          ORDER BY mtime DESC, id DESC
          LIMIT ? OFFSET ?
        `).all(userScope, userScope + '\uFFFF', fromMs, toMs, pageSize, offset)

        total = db.prepare(`
          SELECT COUNT(*) AS c
          FROM images
          WHERE folder >= ?
            AND folder < ?
            AND mtime >= ? AND mtime < ?
        `).get(userScope, userScope + '\uFFFF', fromMs, toMs).c
      } else {
        rows = db.prepare(`
        SELECT id, fname, folder, mtime, size
        FROM images
        WHERE folder >= ?
          AND folder < ?
        ORDER BY mtime DESC, id DESC
        LIMIT ? OFFSET ?
        `).all(lower, upper, pageSize, offset)

        total = db.prepare(`
        SELECT COUNT(*) AS c
        FROM images
        WHERE folder >= ?
          AND folder < ?
        `).get(lower, upper).c
      }
    }

    res.json({ items: rows, total })
  } catch (e) {
    console.error('/api/photos error', e)
    res.status(500).json({ error: e.message })
  }
})

/* rescan: admin only */
app.post('/api/index', requireAdmin, async (_req, res) => {
  try { await scanAndIndex(); res.json({ ok: true }) } catch (e) { res.status(500).json({ error: e.message }) }
})

/* media endpoints: auth + scope check */
app.get('/thumb/:id', requireAuth, async (req, res) => {
  const id = Number(req.params.id)
  const row = db.prepare('SELECT path, folder FROM images WHERE id=?').get(id)
  if (!row) return res.status(404).end()
  if (!inScope(req.user.root_path || '', row.folder)) return res.status(403).end()
  const abs = path.join(PHOTOS_ROOT, row.path)
  const thumb = await ensureThumb(abs)
  if (!thumb) return res.status(500).end()
  res.setHeader('content-type', 'image/webp')
  fs.createReadStream(thumb).pipe(res)
})

app.get('/view/:id', requireAuth, async (req, res) => {
  const id = Number(req.params.id)
  const row = db.prepare('SELECT path, folder FROM images WHERE id=?').get(id)
  if (!row) return res.status(404).end()
  if (!inScope(req.user.root_path || '', row.folder)) return res.status(403).end()
  const abs = path.join(PHOTOS_ROOT, row.path)
  const view = await ensureView(abs)
  if (!view) return res.status(500).end()
  res.setHeader('content-type', 'image/webp')
  fs.createReadStream(view).pipe(res)
})

app.get('/media/:id', requireAuth, async (req, res) => {
  const id = Number(req.params.id)
  const row = db.prepare('SELECT path, folder FROM images WHERE id=?').get(id)
  if (!row) return res.status(404).end()
  if (!inScope(req.user.root_path || '', row.folder)) return res.status(403).end()
  const abs = path.join(PHOTOS_ROOT, row.path)
  try {
    const disp = await ensureDisplayableMedia(abs)
    res.setHeader('content-type', disp.contentType)
    fs.createReadStream(disp.path).pipe(res)
  } catch (e) {
    const type = mime.lookup(abs) || 'application/octet-stream'
    res.setHeader('content-type', type)
    fs.createReadStream(abs).pipe(res)
  }
})

app.get('/download/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id)
  const row = db.prepare('SELECT path, fname, folder FROM images WHERE id=?').get(id)
  if (!row) return res.status(404).end()
  if (!inScope(req.user.root_path || '', row.folder)) return res.status(403).end()
  const abs = path.join(PHOTOS_ROOT, row.path)
  const type = mime.lookup(abs) || 'application/octet-stream'
  const name = row.fname || path.basename(abs)
  res.setHeader('content-type', type)
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`)
  fs.createReadStream(abs).pipe(res)
})

/* Batch ZIP download (scoped) */
app.post('/download/batch', requireAuth, async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(x => parseInt(x, 10)).filter(Number.isFinite) : []
    if (ids.length === 0) return res.status(400).json({ error: 'no ids' })

    const CHUNK = 900
    let rows = []
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK)
      const marks = chunk.map(() => '?').join(',')
      const part = db.prepare(`SELECT id, path, fname, folder FROM images WHERE id IN (${marks})`).all(...chunk)
      rows = rows.concat(part)
    }
    const scope = req.user.root_path || ''
    rows = rows.filter(r => inScope(scope, r.folder))
    if (rows.length === 0) return res.status(404).json({ error: 'not found' })

    const ts = new Date().toISOString().slice(0,19).replace(/[:T]/g,'')
    const zipName = `photos-${ts}.zip`
    res.setHeader('Content-Type', 'application/zip')
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(zipName)}`)

    const archive = archiver('zip', { zlib: { level: 9 } })
    archive.on('error', (err) => { console.error('zip error', err); try { res.status(500).end() } catch {} })
    archive.pipe(res)

    for (const r of rows) {
      const abs = path.join(PHOTOS_ROOT, r.path)
      try {
        await fsp.access(abs)
        archive.file(abs, { name: r.fname || path.basename(abs) })
      } catch {}
    }
    await archive.finalize()
  } catch (e) {
    console.error('/download/batch error', e)
    res.status(500).json({ error: e.message })
  }
})

/* delete user */
app.delete('/api/admin/users/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' })
  if (req.user?.id === id) return res.status(400).json({ error: 'cannot delete your own account' })
  try {
    const stmt = db.prepare('DELETE FROM users WHERE id = ?')
    const info = stmt.run(id)
    if (info.changes === 0) return res.status(404).json({ error: 'not found' })
    try { db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id) } catch {}
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

/* ---------- static web (serve built UI) ---------- */
const DIST_DIR = path.join(ROOT, 'dist')
if (fs.existsSync(DIST_DIR)) {
  app.use(express.static(DIST_DIR, { fallthrough: true }))
  app.get('*', (req, res, next) => {
    if (
      req.path.startsWith('/api/') ||
      req.path.startsWith('/thumb/') ||
      req.path.startsWith('/media/') ||
      req.path.startsWith('/download/')
    ) return next()
    res.sendFile(path.join(DIST_DIR, 'index.html'))
  })
}

/* Debug 404 (keep last) */
app.use('*', (req, res) => {
  console.log('[DEBUG] Unhandled route:', req.method, req.originalUrl, 'Body:', req.body)
  res.status(404).json({ error: 'Route not found', method: req.method, url: req.originalUrl })
})

app.listen(PORT, HOST, () => {
  const cookieMode = (process.env.COOKIE_SECURE !== undefined)
    ? (process.env.COOKIE_SECURE !== '0' ? 'Secure cookies (forced)' : 'Non-secure cookies (forced)')
    : 'Auto: Secure on HTTPS, non-secure on HTTP'
  console.log(`API+Web on http://${HOST}:${PORT}`)
  console.log(`Photos root: ${PHOTOS_ROOT}`)
  console.log(`Cookie mode: ${cookieMode}`)
})
