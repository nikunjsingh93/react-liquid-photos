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

// Helpers
const toPosix = (p) => p.split(path.sep).join('/')
const rel = (abs) => toPosix(path.relative(PHOTOS_ROOT, abs))
const hashPath = (p) => crypto.createHash('sha1').update(p).digest('hex')

// DB setup
const db = new Database(DB_PATH)
db.pragma('journal_mode = WAL')
db.pragma('synchronous = NORMAL')
db.pragma('temp_store = MEMORY')
db.pragma(`cache_size = -${DB_CACHE_SIZE_MB * 1024}`)

// schema
db.exec(`
CREATE TABLE IF NOT EXISTS images (
  id INTEGER PRIMARY KEY,
  path TEXT UNIQUE NOT NULL,
  fname TEXT NOT NULL,
  folder TEXT NOT NULL,
  ctime INTEGER,
  mtime INTEGER,
  size INTEGER
);
CREATE INDEX IF NOT EXISTS idx_images_folder ON images(folder);

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

const insertStmt = db.prepare(`INSERT OR IGNORE INTO images(path, fname, folder, ctime, mtime, size) VALUES(?,?,?,?,?,?)`)
const updateStmt = db.prepare(`UPDATE images SET ctime=?, mtime=?, size=? WHERE path=?`)

const IMG_EXT = new Set(['.jpg','.jpeg','.png','.webp','.avif','.gif','.tif','.tiff','.bmp','.heic','.heif','.dng','.arw','.cr2','.raf','.nef'])

async function scanAndIndex() {
  console.log('[index] scanning…')
  const t0 = Date.now()
  const entries = await fg(['**/*'], { cwd: PHOTOS_ROOT, dot: false, onlyFiles: true, unique: true, absolute: true, suppressErrors: true })
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

async function ensureThumb(absPath, id) {
  const h = hashPath(absPath)
  const out = path.join(THUMBS_DIR, `${h}.webp`)
  try {
    await fsp.access(out)
    return out
  } catch {}
  try {
    await sharp(absPath).rotate().resize({ width: THUMB_WIDTH, withoutEnlargement: true }).webp({ quality: 82 }).toFile(out)
    return out
  } catch (e) {
    console.warn('thumb failed', absPath, e.message)
    return null
  }
}

function buildTree() {
  const rows = db.prepare(`SELECT folder, COUNT(*) as count FROM images GROUP BY folder`).all()
  const root = { name: path.basename(PHOTOS_ROOT) || '/', path: '', count: 0, children: [] }
  const map = new Map([['', root]])
  for (const { folder, count } of rows) {
    const segs = folder === '.' ? [] : folder.split('/')
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
    // counts will be filled via prefix query later; ignore this row's count
  }
  // Fill counts using the same logic as header (prefix count per folder)
  const prefixCount = db.prepare(`SELECT COUNT(*) as c FROM images WHERE folder LIKE ? || '%'`)
  const fillCounts = (node) => {
    node.count = prefixCount.get(node.path).c
    node.children.forEach(fillCounts)
  }
  fillCounts(root)
  // sort children alphabetically
  const sortRec = (n) => { n.children.sort((a,b)=>a.name.localeCompare(b.name)); n.children.forEach(sortRec) }
  sortRec(root)
  return root
}

async function rescan() {
  await scanAndIndex()
}

// initial index if DB is empty
const empty = db.prepare('SELECT COUNT(*) as c FROM images').get().c === 0
if (empty) {
  await scanAndIndex()
}

// Watch for changes
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

const app = express()
app.use(cors())
app.use(express.json())

app.get('/api/tree', (req, res) => {
  try { res.json(buildTree()) } catch (e) { res.status(500).json({ error: e.message }) }
})

app.get('/api/photos', (req, res) => {
  const folder = (req.query.folder || '').toString()
  const q = (req.query.q || '').toString().trim()
  const page = Math.max(1, parseInt(req.query.page || '1', 10))
  const pageSize = Math.max(1, Math.min(500, parseInt(req.query.pageSize || '200', 10)))
  const offset = (page - 1) * pageSize

  try {
    let rows = []
    let total = 0
    if (q) {
      // FTS: search by file name + path + folder
      const term = q.replace(/\s+/g, ' ')
      const stmt = db.prepare(`
        SELECT i.id, i.fname, i.folder FROM images i
        JOIN images_fts f ON f.rowid = i.id
        WHERE f MATCH ? AND i.folder LIKE ? || '%'
        ORDER BY i.mtime DESC, i.id DESC
        LIMIT ? OFFSET ?`)
      rows = stmt.all(term, folder, pageSize, offset)
      total = db.prepare(`
        SELECT COUNT(*) as c FROM images i
        JOIN images_fts f ON f.rowid = i.id
        WHERE f MATCH ? AND i.folder LIKE ? || '%'`).get(term, folder).c
    } else {
      rows = db.prepare(`
        SELECT id, fname, folder FROM images WHERE folder LIKE ? || '%'
        ORDER BY mtime DESC, id DESC LIMIT ? OFFSET ?`).all(folder, pageSize, offset)
      total = db.prepare(`SELECT COUNT(*) as c FROM images WHERE folder LIKE ? || '%'`).get(folder).c
    }
    res.json({ items: rows, total })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.post('/api/index', async (req, res) => {
  try { await rescan(); res.json({ ok: true }) } catch (e) { res.status(500).json({ error: e.message }) }
})

app.get('/thumb/:id', async (req, res) => {
  const id = Number(req.params.id)
  const row = db.prepare('SELECT path FROM images WHERE id=?').get(id)
  if (!row) return res.status(404).end()
  const abs = path.join(PHOTOS_ROOT, row.path)
  const thumb = await ensureThumb(abs, id)
  if (!thumb) return res.status(500).end()
  res.setHeader('content-type', 'image/webp')
  fs.createReadStream(thumb).pipe(res)
})

app.get('/media/:id', (req, res) => {
  const id = Number(req.params.id)
  const row = db.prepare('SELECT path FROM images WHERE id=?').get(id)
  if (!row) return res.status(404).end()
  const abs = path.join(PHOTOS_ROOT, row.path)
  const type = mime.lookup(abs) || 'application/octet-stream'
  res.setHeader('content-type', type)
  fs.createReadStream(abs).pipe(res)
})

// Download original with correct filename+extension
app.get('/download/:id', (req, res) => {
  const id = Number(req.params.id)
  const row = db.prepare('SELECT path, fname FROM images WHERE id=?').get(id)
  if (!row) return res.status(404).end()
  const abs = path.join(PHOTOS_ROOT, row.path)
  const type = mime.lookup(abs) || 'application/octet-stream'
  const fileName = row.fname || path.basename(abs)
  const encoded = encodeURIComponent(fileName).replace(/%20/g, ' ')
  res.setHeader('content-type', type)
  res.setHeader('content-disposition', `attachment; filename="${fileName.replace(/"/g, '')}"; filename*=UTF-8''${encoded}`)
  fs.createReadStream(abs).pipe(res)
})

app.listen(PORT, HOST, () => {
  console.log(`API on http://${HOST}:${PORT} (scanning: ${PHOTOS_ROOT})`)
})