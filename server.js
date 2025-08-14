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

/* ---------- db ---------- */
const db = new Database(DB_PATH)
db.pragma('journal_mode = WAL')
db.pragma('synchronous = NORMAL')
db.pragma('temp_store = MEMORY')
db.pragma(`cache_size = -${DB_CACHE_SIZE_MB * 1024}`)

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

const insertStmt = db.prepare(`INSERT OR IGNORE INTO images(path, fname, folder, ctime, mtime, size) VALUES(?,?,?,?,?,?)`)
const updateStmt = db.prepare(`UPDATE images SET ctime=?, mtime=?, size=? WHERE path=?`)

const IMG_EXT = new Set([
  '.jpg','.jpeg','.png','.webp','.avif','.gif',
  '.tif','.tiff','.bmp','.heic','.heif',
  '.dng','.arw','.cr2','.raf','.nef'
])

/* ---------- indexer ---------- */
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

/* ---------- tree ---------- */
function buildTree() {
  // Build nodes for every folder path we know
  const rows = db.prepare(`SELECT DISTINCT folder FROM images`).all()
  const root = { name: path.basename(PHOTOS_ROOT) || '/', path: '', count: 0, children: [] }
  const map = new Map([['', root]])

  for (const { folder } of rows) {
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
  }

  // Counts via prefix range (same as /api/photos)
  const prefixCount = db.prepare(`SELECT COUNT(*) as c FROM images WHERE folder >= ? AND folder < ?`)
  const fillCounts = (node) => {
    const lower = node.path
    const upper = node.path + '\uFFFF'
    node.count = prefixCount.get(lower, upper).c
    node.children.forEach(fillCounts)
  }
  fillCounts(root)

  // Sort children
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

/* ---------- api ---------- */
const app = express()
app.use(cors())
app.use(express.json())

app.get('/api/tree', (req, res) => {
  try { res.json(buildTree()) } catch (e) { res.status(500).json({ error: e.message }) }
})

// Prefix-range query (no LIKE). Handles subfolders and avoids wildcard issues with _ and %
app.get('/api/photos', (req, res) => {
  const folder = (req.query.folder || '').toString()        // '' => All Media
  const q = (req.query.q || '').toString().trim()
  const page = Math.max(1, parseInt(req.query.page || '1', 10))
  const pageSize = Math.max(1, Math.min(500, parseInt(req.query.pageSize || '200', 10)))
  const offset = (page - 1) * pageSize

  const lower = folder
  const upper = folder + '\uFFFF' // all strings starting with `folder`

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

// On-demand metadata + EXIF (lazy exifr import)
const metaCache = new Map() // id -> meta
app.get('/api/meta/:id', async (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'bad id' })
  if (metaCache.has(id)) return res.json(metaCache.get(id))

  try {
    const row = db.prepare('SELECT id, path, fname, folder, size, mtime, ctime FROM images WHERE id=?').get(id)
    if (!row) return res.status(404).end()
    const abs = path.join(PHOTOS_ROOT, row.path)

    const meta = await sharp(abs).metadata().catch(() => ({}))
    const base = {
      id: row.id,
      fname: row.fname,
      folder: row.folder,
      size: row.size,
      mtime: row.mtime,
      ctime: row.ctime,
      width: meta.width || null,
      height: meta.height || null,
      format: meta.format || null,
      exif: null,
    }

    // Try to parse EXIF (optional)
    try {
      const { default: exifr } = await import('exifr').catch(() => ({ default: null }))
      if (exifr) {
        const ex = await exifr.parse(abs, { tiff: true, ifd0: true, exif: true, gps: true })
        if (ex) {
          base.exif = {
            DateTimeOriginal: ex.DateTimeOriginal?.toISOString?.() || ex.CreateDate?.toISOString?.() || null,
            Make: ex.Make || null,
            Model: ex.Model || null,
            LensModel: ex.LensModel || null,
            FNumber: ex.FNumber || null,
            ExposureTime: ex.ExposureTime || null,
            ISO: ex.ISO || null,
            FocalLength: ex.FocalLength || null,
            GPSLatitude: ex.latitude ?? ex.GPSLatitude ?? null,
            GPSLongitude: ex.longitude ?? ex.GPSLongitude ?? null,
          }
        }
      }
    } catch {}

    metaCache.set(id, base)
    res.json(base)
  } catch (e) {
    console.error('/api/meta error', e)
    res.status(500).json({ error: e.message })
  }
})

app.post('/api/index', async (req, res) => {
  try { await scanAndIndex(); res.json({ ok: true }) } catch (e) { res.status(500).json({ error: e.message }) }
})

app.get('/thumb/:id', async (req, res) => {
  const id = Number(req.params.id)
  const row = db.prepare('SELECT path FROM images WHERE id=?').get(id)
  if (!row) return res.status(404).end()
  const abs = path.join(PHOTOS_ROOT, row.path)
  const thumb = await ensureThumb(abs)
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

// Optional: force-download with filename
app.get('/download/:id', (req, res) => {
  const id = Number(req.params.id)
  const row = db.prepare('SELECT path, fname FROM images WHERE id=?').get(id)
  if (!row) return res.status(404).end()
  const abs = path.join(PHOTOS_ROOT, row.path)
  const type = mime.lookup(abs) || 'application/octet-stream'
  const name = row.fname || path.basename(abs)
  res.setHeader('content-type', type)
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`)
  fs.createReadStream(abs).pipe(res)
})

app.listen(PORT, HOST, () => {
  console.log(`API on http://${HOST}:${PORT} (scanning: ${PHOTOS_ROOT})`)
})
