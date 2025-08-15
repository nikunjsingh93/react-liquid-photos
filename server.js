import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import path from 'node:path'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import crypto from 'node:crypto'
import fg from 'fast-glob'
import chokidar from 'chokidar'
import Database from 'better-sqlite3'
import sharp from 'sharp'
import mime from 'mime-types'
import archiver from 'archiver'

/* ---------- config ---------- */
const ROOT = process.cwd()
const PHOTOS_ROOT = process.env.PHOTOS_PATH
if (!PHOTOS_ROOT) {
  console.error('Please set PHOTOS_PATH in .env')
  process.exit(1)
}
const PORT = Number(process.env.PORT || 5174)
const HOST = process.env.HOST || '127.0.0.1'
const CACHE_DIR = path.join(ROOT, '.cache')
const DB_PATH = path.join(CACHE_DIR, 'index.db')
const THUMBS_DIR = path.join(CACHE_DIR, 'thumbs')
const THUMB_WIDTH = Number(process.env.THUMB_WIDTH || 512)
const DB_CACHE_SIZE_MB = Number(process.env.DB_CACHE_SIZE_MB || 256)

fs.mkdirSync(CACHE_DIR, { recursive: true })
fs.mkdirSync(THUMBS_DIR, { recursive: true })

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
// ensure sessions has token/created_at/expires_at (old DBs may be missing token)
ensureColumn('sessions', 'token TEXT', 'token', 'CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token)')
ensureColumn('sessions', 'created_at INTEGER NOT NULL DEFAULT 0', 'created_at')
ensureColumn('sessions', 'expires_at INTEGER NOT NULL DEFAULT 0', 'expires_at')
// ensure users has is_admin/root_path if very old
ensureColumn('users', 'is_admin INTEGER NOT NULL DEFAULT 0', 'is_admin')
ensureColumn('users', 'root_path TEXT', 'root_path')

/* ---------- indexer ---------- */
const insertStmt = db.prepare(`INSERT OR IGNORE INTO images(path, fname, folder, ctime, mtime, size) VALUES(?,?,?,?,?,?)`)
const updateStmt = db.prepare(`UPDATE images SET ctime=?, mtime=?, size=? WHERE path=?`)

const IMG_EXT = new Set([
  '.jpg','.jpeg','.png','.webp','.avif','.gif',
  '.tif','.tiff','.bmp','.heic','.heif',
  '.dng','.arw','.cr2','.raf','.nef'
])

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
      const folder = toPosix(path.dirname(r)) // root files ⇒ '.'
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
    await sharp(absPath).rotate().resize({ width: THUMB_WIDTH, withoutEnlargement: true }).webp({ quality: 82 }).toFile(out)
    return out
  } catch (e) {
    console.warn('thumb failed', absPath, e.message)
    return null
  }
}

/* ---------- tree (scoped) ---------- */
function buildTreeForScope(scopePath /* posix, '' for whole */) {
  const lower = scopePath
  const upper = scopePath + '\uFFFF'
  const rows = db.prepare(`SELECT DISTINCT folder FROM images WHERE folder >= ? AND folder < ?`).all(lower, upper)

  // root node name
  let rootName = path.basename(PHOTOS_ROOT) || '/'
  if (scopePath) {
    const parts = scopePath.split('/').filter(Boolean)
    rootName = parts.length ? parts[parts.length - 1] : rootName
  }
  const root = { name: rootName, path: '', count: 0, children: [] }

  // Map of relative (to scope) node path → node
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

/* ---------- watch filesystem ---------- */
chokidar.watch(PHOTOS_ROOT, { ignoreInitial: true, depth: 99 })
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
  // Convert to posix relative to PHOTOS_ROOT; reject if outside
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

/* middleware */
function authOptional(req, _res, next) {
  req.user = null
  const cookies = parseCookies(req)
  const token = cookies[SESSION_COOKIE]
  if (!token) return next()
  const row = getSession.get(token)
  if (!row) return next()
  if (row.expires_at < nowMs()) { try { deleteSession.run(token) } catch {} ; return next() }
  req.user = { id: row.user_id, username: row.username, is_admin: !!row.is_admin, root_path: row.root_path ? toPosix(row.root_path) : '' }
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

/* ---------- api ---------- */
const app = express()
app.use(cors({ origin: true, credentials: true }))
app.use(express.json({ limit: '5mb' }))

/* auth routes */
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {}
  if (!username || !password) return res.status(400).json({ error: 'missing credentials' })
  const u = getUserByUsername.get(String(username).trim())
  if (!u || !verifyPassword(String(password), u.pass_hash)) return res.status(401).json({ error: 'invalid credentials' })
  const token = crypto.randomBytes(32).toString('hex')
  const created = nowMs(), expires = created + SESSION_TTL_MS
  insertSession.run(u.id, token, created, expires)
  const isProd = process.env.NODE_ENV === 'production'
  res.cookie?.(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProd,
    maxAge: SESSION_TTL_MS,
    path: '/',
  }) || res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${token}; Max-Age=${Math.floor(SESSION_TTL_MS/1000)}; Path=/; HttpOnly; SameSite=Lax${isProd?'; Secure':''}`)
  res.json({ ok: true, user: { id: u.id, username: u.username, is_admin: !!u.is_admin, root_path: u.root_path || '' } })
})

app.get('/api/auth/me', authOptional, (req, res) => {
  if (!req.user) return res.status(401).json({ user: null })
  res.json({ user: req.user })
})

app.post('/api/auth/logout', authOptional, (req, res) => {
  const cookies = parseCookies(req)
  const token = cookies[SESSION_COOKIE]
  if (token) { try { deleteSession.run(token) } catch {} }
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax`)
  res.json({ ok: true })
})

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
app.get('/api/tree', requireAuth, (req, res) => {
  try { res.json(buildTreeForScope(req.user.root_path || '')) } catch (e) { res.status(500).json({ error: e.message }) }
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

  try {
    let rows = []
    let total = 0

    if (q) {
      const term = q.replace(/\s+/g, ' ')
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

app.get('/media/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id)
  const row = db.prepare('SELECT path, folder FROM images WHERE id=?').get(id)
  if (!row) return res.status(404).end()
  if (!inScope(req.user.root_path || '', row.folder)) return res.status(403).end()
  const abs = path.join(PHOTOS_ROOT, row.path)
  const type = mime.lookup(abs) || 'application/octet-stream'
  res.setHeader('content-type', type)
  fs.createReadStream(abs).pipe(res)
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
    // scope filter
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

// server.js (admin routes)
app.delete('/api/admin/users/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' })
  // prevent deleting yourself to avoid lockout
  if (req.user?.id === id) return res.status(400).json({ error: 'cannot delete your own account' })
  try {
    const stmt = db.prepare('DELETE FROM users WHERE id = ?')
    const info = stmt.run(id)
    if (info.changes === 0) return res.status(404).json({ error: 'not found' })
    // also clear sessions for that user
    try { db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id) } catch {}
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})


/* Debug 404 (keep last) */
app.use('*', (req, res) => {
  console.log('[DEBUG] Unhandled route:', req.method, req.originalUrl, 'Body:', req.body)
  res.status(404).json({ error: 'Route not found', method: req.method, url: req.originalUrl })
})

app.listen(PORT, HOST, () => {
  console.log(`API on http://${HOST}:${PORT} (scanning: ${ PHOTOS_ROOT })`)
})
