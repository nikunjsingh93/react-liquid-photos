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
import exifr from 'exifr'

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
const HLS_DIR = path.join(CACHE_DIR, 'hls')
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
fs.mkdirSync(HLS_DIR, { recursive: true })

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

/* shares schema */
db.exec(`
CREATE TABLE IF NOT EXISTS shares (
  id INTEGER PRIMARY KEY,
  token     TEXT UNIQUE NOT NULL,
  user_id   INTEGER NOT NULL,
  folder    TEXT NOT NULL,
  name      TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_shares_user ON shares(user_id);
CREATE INDEX IF NOT EXISTS idx_shares_token ON shares(token);
`)

/* share selected items schema */
db.exec(`
CREATE TABLE IF NOT EXISTS share_items (
  share_id  INTEGER NOT NULL,
  image_id  INTEGER NOT NULL,
  PRIMARY KEY (share_id, image_id),
  FOREIGN KEY(share_id) REFERENCES shares(id) ON DELETE CASCADE,
  FOREIGN KEY(image_id) REFERENCES images(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_share_items_share ON share_items(share_id);
CREATE INDEX IF NOT EXISTS idx_share_items_image ON share_items(image_id);
`)

/* favorites schema */
db.exec(`
CREATE TABLE IF NOT EXISTS favorites (
  user_id  INTEGER NOT NULL,
  image_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, image_id),
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY(image_id) REFERENCES images(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_fav_user ON favorites(user_id);
CREATE INDEX IF NOT EXISTS idx_fav_image ON favorites(image_id);
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

// Extend images with kind (image|video) and duration (ms)
ensureColumn('images', 'kind TEXT NOT NULL DEFAULT "image"', 'kind')
ensureColumn('images', 'duration INTEGER NOT NULL DEFAULT 0', 'duration')

/* ---------- indexer ---------- */
let currentIndexJob = { token: 0, cancel: false, running: false }
function beginIndexJob() {
  if (currentIndexJob.running) return null
  currentIndexJob = { token: Date.now(), cancel: false, running: true }
  return currentIndexJob
}
function endIndexJob(job) {
  if (job && currentIndexJob.token === job.token) currentIndexJob.running = false
}

const insertStmt = db.prepare(`INSERT INTO images(path, fname, folder, ctime, mtime, size, kind, duration)
  VALUES(?,?,?,?,?,?,?,?)
  ON CONFLICT(path) DO UPDATE SET
    fname=excluded.fname,
    folder=excluded.folder,
    ctime=excluded.ctime,
    mtime=excluded.mtime,
    size=excluded.size,
    kind=excluded.kind,
    duration=excluded.duration`)
const updateStmt = db.prepare(`UPDATE images SET ctime=?, mtime=?, size=? WHERE path=?`)

const IMG_EXT = new Set([
  '.jpg','.jpeg','.png','.webp','.avif','.gif',
  '.tif','.tiff','.bmp','.heic','.heif',
  // RAW formats (index these so we can extract previews)
  '.dng','.arw','.cr2','.raf','.nef','.rw2'
])

const RAW_EXT = new Set(['.dng','.arw','.cr2','.raf','.nef','.rw2'])
const HEIC_EXT = new Set(['.heic', '.heif'])
const VIDEO_EXT = new Set([
  '.mp4', '.m4v', '.mov', '.mkv', '.webm', '.avi', '.wmv', '.flv', '.3gp', '.mts', '.m2ts', '.ts'
])

function isRawExt(filePath) {
  const ext = path.extname(filePath).toLowerCase()
  return RAW_EXT.has(ext)
}

function isHeicExt(filePath) {
  const ext = path.extname(filePath).toLowerCase()
  return HEIC_EXT.has(ext)
}

function isVideoExt(filePath) {
  const ext = path.extname(filePath).toLowerCase()
  return VIDEO_EXT.has(ext)
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
    console.log('[heic] converting:', absPath, '->', out)
    const ex = spawn('heif-convert', args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderrBuf = ''
    ex.stderr.on('data', (d) => { stderrBuf += String(d) })
    ex.on('close', async (code) => {
      if (code === 0 && await fileExists(out)) {
        console.log('[heic] success:', absPath)
        resolve(out)
      } else {
        console.error('[heic] failed:', absPath, 'code:', code, 'stderr:', stderrBuf)
        try { await fsp.unlink(out) } catch {}
        resolve(null)
      }
    })
    ex.on('error', async (err) => {
      console.error('[heic] spawn error:', absPath, err.message)
      try { await fsp.unlink(out) } catch {}
      resolve(null)
    })
  })
}

/**
 * Decode problematic image files (like corrupted JPEGs) using ffmpeg to a lossless/displayable JPEG for downstream processing.
 */
async function ensureFfmpegImagePreview(absPath) {
  const h = hashPath(absPath)
  const out = path.join(RAW_PREVIEWS_DIR, `${h}_ffmpeg.jpg`)
  if (await fileExists(out)) return out
  return new Promise((resolve) => {
    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-i', absPath,
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', // Ensure even dimensions
      '-q:v', '2', // High quality
      '-y', out
    ]
    console.log('[ffmpeg] converting problematic image:', absPath, '->', out)
    const ex = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderrBuf = ''
    ex.stderr.on('data', (d) => { stderrBuf += String(d) })
    ex.on('close', async (code) => {
      if (code === 0 && await fileExists(out)) {
        console.log('[ffmpeg] success:', absPath)
        resolve(out)
      } else {
        console.error('[ffmpeg] failed:', absPath, 'code:', code, 'stderr:', stderrBuf)
        try { await fsp.unlink(out) } catch {}
        resolve(null)
      }
    })
    ex.on('error', async (err) => {
      console.error('[ffmpeg] spawn error:', absPath, err.message)
      try { await fsp.unlink(out) } catch {}
      resolve(null)
    })
  })
}

async function scanAndIndex(job = currentIndexJob) {
  console.log('[index] scanning…')
  const t0 = Date.now()
  const entries = await fg(['**/*'], {
    cwd: PHOTOS_ROOT, dot: false, onlyFiles: true,
    unique: true, absolute: true, suppressErrors: true
  })
  let count = 0
  const tx = db.transaction((batch) => { for (const b of batch) b() })
  const ops = []
  const scannedPaths = new Set()
  for (const abs of entries) {
    if (job?.cancel) break
    const ext = path.extname(abs).toLowerCase()
    const isImage = IMG_EXT.has(ext)
    const isVideo = VIDEO_EXT.has(ext)
    if (!isImage && !isVideo) continue
    try {
      const st = await fsp.stat(abs)
      const r = rel(abs)
      const folder = toPosix(path.dirname(r))
      const fname = path.basename(abs)
      let durationMs = 0
      if (isVideo) {
        try {
          const meta = await probeVideoMeta(abs)
          durationMs = Math.floor(Number(meta?.duration || 0))
        } catch {}
      }
      const kind = isVideo ? 'video' : 'image'
      ops.push(() => insertStmt.run(r, fname, folder, Math.floor(st.ctimeMs), Math.floor(st.mtimeMs), st.size, kind, Math.floor(durationMs)))
      scannedPaths.add(r)
      count++
    } catch {}
  }
  tx(ops)

  // Remove stale rows (files that no longer exist after renames/deletes)
  try {
    const delStmt = db.prepare('DELETE FROM images WHERE path = ?')
    const existing = db.prepare('SELECT path FROM images').all()
    const delOps = []
    for (const row of existing) {
      if (!scannedPaths.has(row.path)) delOps.push(() => delStmt.run(row.path))
    }
    if (delOps.length) tx(delOps)
  } catch {}

  console.log(`[index] done: ${count.toLocaleString()} files in ${((Date.now()-t0)/1000).toFixed(1)}s${job?.cancel ? ' (canceled)' : ''}`)
}

async function scanAndIndexUnder(relPrefix, job = currentIndexJob) {
  const prefix = normalizeScopeInput(relPrefix || '')
  if (!prefix) return scanAndIndex()

  // If the requested prefix no longer exists (e.g., folder was renamed),
  // fall back to the closest existing parent directory so we discover the new name
  // and prune the old one.
  let effective = prefix
  async function dirExists(p) {
    try { const st = await fsp.stat(path.join(PHOTOS_ROOT, p)); return st.isDirectory() } catch { return false }
  }
  if (!(await dirExists(effective))) {
    const idx = effective.lastIndexOf('/')
    const parent = idx >= 0 ? effective.slice(0, idx) : ''
    if (parent && await dirExists(parent)) effective = parent
    else if (!parent) effective = ''
  }
  if (!effective) {
    // as a last resort, do a full scan
    return scanAndIndex()
  }

  console.log(`[index] scanning path '${effective}'…`)
  const t0 = Date.now()
  const entries = await fg([`${effective}/**/*`], {
    cwd: PHOTOS_ROOT, dot: false, onlyFiles: true,
    unique: true, absolute: true, suppressErrors: true
  })
  let count = 0
  const tx = db.transaction((batch) => { for (const b of batch) b() })
  const ops = []
  const scannedPaths = new Set()
  for (const abs of entries) {
    if (job?.cancel) break
    const ext = path.extname(abs).toLowerCase()
    const isImage = IMG_EXT.has(ext)
    const isVideo = VIDEO_EXT.has(ext)
    if (!isImage && !isVideo) continue
    try {
      const st = await fsp.stat(abs)
      const r = rel(abs)
      const folder = toPosix(path.dirname(r))
      const fname = path.basename(abs)
      let durationMs = 0
      if (isVideo) {
        try {
          const meta = await probeVideoMeta(abs)
          durationMs = Math.floor(Number(meta?.duration || 0))
        } catch {}
      }
      const kind = isVideo ? 'video' : 'image'
      ops.push(() => insertStmt.run(r, fname, folder, Math.floor(st.ctimeMs), Math.floor(st.mtimeMs), st.size, kind, Math.floor(durationMs)))
      scannedPaths.add(r)
      count++
    } catch {}
  }
  tx(ops)

  // Remove stale rows under the effective prefix only
  try {
    const lower = effective
    const upper = effective + '\uFFFF'
    const rows = db.prepare('SELECT path FROM images WHERE folder >= ? AND folder < ?').all(lower, upper)
    const delStmt = db.prepare('DELETE FROM images WHERE path = ?')
    const delOps = []
    for (const row of rows) {
      if (!scannedPaths.has(row.path)) delOps.push(() => delStmt.run(row.path))
    }
    if (delOps.length) tx(delOps)
  } catch {}

  console.log(`[index] path done: ${count.toLocaleString()} files in ${((Date.now()-t0)/1000).toFixed(1)}s${job?.cancel ? ' (canceled)' : ''}`)
}

async function ensureThumb(absPath) {
  const h = hashPath(absPath)
  const out = path.join(THUMBS_DIR, `${h}.webp`)
  try { await fsp.access(out); return out } catch {}
  try {
    if (isVideoExt(absPath)) {
      await ensureVideoThumb(absPath, out)
    } else {
      try {
        await sharp(absPath).rotate().resize({ width: THUMB_WIDTH, withoutEnlargement: true }).webp({ quality: 82 }).toFile(out)
      } catch (e) {
        if (isRawExt(absPath)) {
          const prev = await ensureRawEmbeddedPreview(absPath)
          if (!prev) throw e
          await sharp(prev).rotate().resize({ width: THUMB_WIDTH, withoutEnlargement: true }).webp({ quality: 82 }).toFile(out)
        } else if (isHeicExt(absPath)) {
          console.log('[thumb] processing HEIC:', absPath)
          // Try Sharp first (if it has HEIC support)
          try {
            await sharp(absPath).rotate().resize({ width: THUMB_WIDTH, withoutEnlargement: true }).webp({ quality: 82 }).toFile(out)
            console.log('[thumb] HEIC processed with Sharp:', absPath)
          } catch (sharpError) {
            console.log('[thumb] Sharp failed for HEIC, trying heif-convert:', absPath, sharpError.message)
            // Fall back to heif-convert
            const prev = await ensureHeicDecodedPreview(absPath)
            if (!prev) {
              console.error('[thumb] HEIC preview failed:', absPath)
              throw e
            }
            await sharp(prev).rotate().resize({ width: THUMB_WIDTH, withoutEnlargement: true }).webp({ quality: 82 }).toFile(out)
          }
        } else {
          // Try ffmpeg fallback for problematic JPEG files
          console.log('[thumb] Sharp failed, trying ffmpeg fallback:', absPath, e.message)
          const prev = await ensureFfmpegImagePreview(absPath)
          if (!prev) {
            throw e
          }
          await sharp(prev).rotate().resize({ width: THUMB_WIDTH, withoutEnlargement: true }).webp({ quality: 82 }).toFile(out)
        }
      }
    }
    return out
  } catch (e) {
    console.warn('thumb failed', absPath, e.message)
    // As a last resort, try to serve the original file directly
    // This allows users to at least download the problematic image
    return absPath
  }
}

async function ensureView(absPath) {
  const h = hashPath(absPath)
  const out = path.join(VIEWS_DIR, `${h}.webp`)
  try { await fsp.access(out); return out } catch {}
  try {
    if (isVideoExt(absPath)) {
      // For videos, we do not generate a view image; the frontend will stream the video
      // Still, generate and return a large thumbnail as a fallback poster
      const thumb = await ensureThumb(absPath)
      if (!thumb) throw new Error('view for video failed')
      return thumb
    } else {
      try {
        await sharp(absPath).rotate().resize({ width: VIEW_WIDTH, withoutEnlargement: true }).webp({ quality: 85 }).toFile(out)
      } catch (e) {
        if (isRawExt(absPath)) {
          const prev = await ensureRawEmbeddedPreview(absPath)
          if (!prev) throw e
          await sharp(prev).rotate().resize({ width: VIEW_WIDTH, withoutEnlargement: true }).webp({ quality: 85 }).toFile(out)
        } else if (isHeicExt(absPath)) {
          console.log('[view] processing HEIC:', absPath)
          // Try Sharp first (if it has HEIC support)
          try {
            await sharp(absPath).rotate().resize({ width: VIEW_WIDTH, withoutEnlargement: true }).webp({ quality: 85 }).toFile(out)
            console.log('[view] HEIC processed with Sharp:', absPath)
          } catch (sharpError) {
            console.log('[view] Sharp failed for HEIC, trying heif-convert:', absPath, sharpError.message)
            // Fall back to heif-convert
            const prev = await ensureHeicDecodedPreview(absPath)
            if (!prev) {
              console.error('[view] HEIC preview failed:', absPath)
              throw e
            }
            await sharp(prev).rotate().resize({ width: VIEW_WIDTH, withoutEnlargement: true }).webp({ quality: 85 }).toFile(out)
          }
        } else {
          // Try ffmpeg fallback for problematic JPEG files
          console.log('[view] Sharp failed, trying ffmpeg fallback:', absPath, e.message)
          const prev = await ensureFfmpegImagePreview(absPath)
          if (!prev) {
            throw e
          }
          await sharp(prev).rotate().resize({ width: VIEW_WIDTH, withoutEnlargement: true }).webp({ quality: 85 }).toFile(out)
        }
      }
      return out
    }
  } catch (e) {
    console.warn('view failed', absPath, e.message)
    // As a last resort, try to serve the original file directly
    // This allows users to at least download the problematic image
    return absPath
  }
}

// removed probeVideoDuration in favor of probeVideoMeta

/**
 * Generate a thumbnail image for a video using ffmpeg.
 */
async function ensureVideoThumb(absPath, outWebp) {
  const h = hashPath(absPath)
  const tmpJpg = path.join(THUMBS_DIR, `${h}.jpg.tmp`)
  async function run(args) {
    return new Promise((resolve) => {
      let stderrBuf = ''
      const ex = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] })
      ex.stderr.on('data', d => { stderrBuf += String(d) })
      ex.on('close', async (code) => {
        resolve({ ok: code === 0, stderr: stderrBuf })
      })
      ex.on('error', () => resolve({ ok: false, stderr: 'spawn error' }))
    })
  }
  // Variant A: input seek, thumbnail filter
  const argsA = [
    '-hide_banner', '-loglevel', 'error',
    '-ss', '1', '-i', absPath,
    '-frames:v', '1',
    '-vf', `thumbnail,scale=${THUMB_WIDTH}:-2:flags=lanczos`,
    '-q:v', '2', '-y', tmpJpg
  ]
  let r = await run(argsA)
  if (!(await fileExists(tmpJpg))) {
    // Variant B: input seek, no thumbnail filter
    const argsB = [
      '-hide_banner', '-loglevel', 'error',
      '-ss', '1', '-i', absPath,
      '-vframes', '1',
      '-vf', `scale=${THUMB_WIDTH}:-2:flags=lanczos`,
      '-q:v', '2', '-y', tmpJpg
    ]
    r = await run(argsB)
  }
  if (!(await fileExists(tmpJpg))) {
    // Variant C: output seek (can be more accurate for some containers)
    const argsC = [
      '-hide_banner', '-loglevel', 'error',
      '-i', absPath, '-ss', '00:00:01.000',
      '-vframes', '1',
      '-vf', `scale=${THUMB_WIDTH}:-2:flags=lanczos`,
      '-q:v', '2', '-y', tmpJpg
    ]
    r = await run(argsC)
  }
  if (!(await fileExists(tmpJpg))) {
    // Variant D: write webp directly
    const argsD = [
      '-hide_banner', '-loglevel', 'error',
      '-ss', '1', '-i', absPath,
      '-vframes', '1',
      '-vf', `scale=${THUMB_WIDTH}:-2:flags=lanczos`,
      '-y', outWebp
    ]
    const d = await run(argsD)
    if (await fileExists(outWebp)) return
    console.warn('ffmpeg thumbnail stderr:', d.stderr?.slice(0, 500))
    throw new Error('ffmpeg failed to create thumbnail')
  }
  try {
    await sharp(tmpJpg).webp({ quality: 82 }).toFile(outWebp)
  } finally {
    try { await fsp.unlink(tmpJpg) } catch {}
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
function buildTreeForScope(scopePath, filter = 'all') {
  const lower = scopePath
  const upper = scopePath + '\uFFFF'
  const kindWhere = filter === 'images' ? " AND kind = 'image'" : (filter === 'videos' ? " AND kind = 'video'" : '')
  const rows = db.prepare(`SELECT DISTINCT folder FROM images WHERE folder >= ? AND folder < ?${kindWhere}`).all(lower, upper)

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

  const prefixCountSql = `SELECT COUNT(*) as c FROM images WHERE folder >= ? AND folder < ?${kindWhere}`
  const prefixCount = db.prepare(prefixCountSql)
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
  
  // Clean up empty nodes
  const cleanupEmpty = (node) => {
    if (!node.children) return
    node.children = node.children.filter(child => {
      cleanupEmpty(child)
      return child.count > 0 || (child.children && child.children.length > 0)
    })
  }
  cleanupEmpty(root)
  
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
      const ext = path.extname(abs).toLowerCase(); if (!IMG_EXT.has(ext) && !VIDEO_EXT.has(ext)) return
      const st = await fsp.stat(abs).catch(() => null); if (!st) return
      const r = rel(abs); const folder = toPosix(path.dirname(r)); const fname = path.basename(abs)
      let durationMs = 0
      if (VIDEO_EXT.has(ext)) {
        try {
          const meta = await probeVideoMeta(abs)
          durationMs = Math.floor(Number(meta?.duration || 0))
        } catch {}
      }
      const kind = VIDEO_EXT.has(ext) ? 'video' : 'image'
      insertStmt.run(r, fname, folder, Math.floor(st.ctimeMs), Math.floor(st.mtimeMs), st.size, kind, Math.floor(durationMs))
    })
    .on('change', async (abs) => {
      const st = await fsp.stat(abs).catch(() => null); if (!st) return
      const r = rel(abs); const ext = path.extname(abs).toLowerCase()
      let kind = 'image'; let durationMs = 0
      if (VIDEO_EXT.has(ext)) {
        kind = 'video'
        try { const meta = await probeVideoMeta(abs); durationMs = Math.floor(Number(meta?.duration || 0)) } catch {}
      }
      // Update times/size always; update kind/duration when available
      try { db.prepare('UPDATE images SET ctime=?, mtime=?, size=?, kind=?, duration=? WHERE path=?')
        .run(Math.floor(st.ctimeMs), Math.floor(st.mtimeMs), st.size, kind, durationMs, r) }
      catch { updateStmt.run(Math.floor(st.ctimeMs), Math.floor(st.mtimeMs), st.size, r) }
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
const insertShare = db.prepare(`INSERT INTO shares(token, user_id, folder, name, created_at) VALUES(?,?,?,?,?)`)
const insertShareItem = db.prepare(`INSERT OR IGNORE INTO share_items(share_id, image_id) VALUES(?, ?)`)
const countShareItems = db.prepare(`SELECT COUNT(1) AS c FROM share_items WHERE share_id = ?`)
const deleteShareStmt = db.prepare(`DELETE FROM shares WHERE id = ?`)
const getShareById = db.prepare(`SELECT id, token, user_id, folder, name, created_at FROM shares WHERE id = ?`)
const getShareByToken = db.prepare(`SELECT id, token, user_id, folder, name, created_at FROM shares WHERE token = ?`)
const listSharesByUser = db.prepare(`SELECT id, token, user_id, folder, name, created_at FROM shares WHERE user_id = ? ORDER BY created_at DESC`)
const listSharesWithUsers = db.prepare(`
  SELECT s.id, s.token, s.user_id, s.folder, s.name, s.created_at, u.username
  FROM shares s JOIN users u ON u.id = s.user_id
  ORDER BY s.created_at DESC
`)
const insertFavorite = db.prepare(`INSERT OR IGNORE INTO favorites(user_id, image_id, created_at) VALUES(?,?,?)`)
const deleteFavorite = db.prepare(`DELETE FROM favorites WHERE user_id = ? AND image_id = ?`)
const listFavoriteIds = db.prepare(`SELECT image_id FROM favorites WHERE user_id = ? ORDER BY created_at DESC`)
const listFavoriteItems = db.prepare(`
  SELECT i.id, i.fname, i.folder, i.mtime, i.size, i.kind, i.duration
  FROM favorites f JOIN images i ON i.id = f.image_id
  WHERE f.user_id = ?
  ORDER BY i.mtime DESC, i.id DESC
  LIMIT ? OFFSET ?
`)
const countFavorites = db.prepare(`SELECT COUNT(1) as c FROM favorites WHERE user_id = ?`)

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
const DEFAULT_ADMIN_USERNAME = (process.env.ADMIN_USER || 'admin').trim()
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
  const items = rows.map(r => ({ ...r, is_protected: r.username === DEFAULT_ADMIN_USERNAME }))
  res.json({ items })
})
app.post('/api/admin/users', requireAdmin, (req, res) => {
  const { username, password, root_path } = req.body || {}
  if (!username || !password) return res.status(400).json({ error: 'username & password required' })
  let scoped = ''
  try { scoped = normalizeScopeInput(root_path || '') } catch (e) { return res.status(400).json({ error: e.message }) }
  const pass_hash = hashPassword(String(password))
  try {
    const is_admin = req.body && req.body.is_admin ? 1 : 0
    const info = insertUser.run(String(username).trim(), pass_hash, is_admin, scoped || null, nowMs())
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

function buildDateTreeForScope(scopePath, filter = 'all') {
  const lower = scopePath || ''
  const upper = lower + '\uFFFF'
  const kindWhere = filter === 'images' ? " AND kind = 'image'" : (filter === 'videos' ? " AND kind = 'video'" : '')
  const rows = db.prepare(`
    SELECT
      CAST(strftime('%Y', mtime/1000, 'unixepoch') AS INTEGER) AS y,
      CAST(strftime('%m', mtime/1000, 'unixepoch') AS INTEGER) AS m,
      CAST(strftime('%d', mtime/1000, 'unixepoch') AS INTEGER) AS d,
      COUNT(*) AS c
    FROM images
    WHERE folder >= ? AND folder < ?${kindWhere}
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
  
  // Clean up empty nodes
  const cleanupEmpty = (node) => {
    if (!node.children) return
    node.children = node.children.filter(child => {
      cleanupEmpty(child)
      return child.count > 0 || (child.children && child.children.length > 0)
    })
  }
  cleanupEmpty(root)
  
  root.count = root.children.reduce((a, y) => a + (y.count || 0), 0)
  return root
}

app.get('/api/tree', requireAuth, (req, res) => {
  try {
    const mode = String(req.query.mode || 'folders')
    const filterRaw = String(req.query.filter || 'all')
    const filter = (filterRaw === 'images' || filterRaw === 'videos') ? filterRaw : 'all'
    if (mode === 'dates') {
      res.json(buildDateTreeForScope(req.user.root_path || '', filter))
    } else {
      res.json(buildTreeForScope(req.user.root_path || '', filter))
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
  const filter = (req.query.filter || 'all').toString() // all | images | videos

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
    let kindWhere = ''
    if (filter === 'images') kindWhere = " AND i.kind = 'image'"
    else if (filter === 'videos') kindWhere = " AND i.kind = 'video'"

    if (q) {
      const term = q.replace(/\s+/g, ' ')
      if (useDateRange) {
        rows = db.prepare(`
          SELECT i.id, i.fname, i.folder, i.mtime, i.size, i.kind, i.duration
          FROM images i
          JOIN images_fts f ON f.rowid = i.id
          WHERE f MATCH ?
            AND i.folder >= ?
            AND i.folder < ?
            AND i.mtime >= ? AND i.mtime < ?${kindWhere}
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
            AND i.mtime >= ? AND i.mtime < ?${kindWhere}
        `).get(term, userScope, userScope + '\uFFFF', fromMs, toMs).c
      } else {
        rows = db.prepare(`
        SELECT i.id, i.fname, i.folder, i.mtime, i.size, i.kind, i.duration
        FROM images i
        JOIN images_fts f ON f.rowid = i.id
        WHERE f MATCH ?
          AND i.folder >= ?
          AND i.folder < ?${kindWhere}
        ORDER BY i.mtime DESC, i.id DESC
        LIMIT ? OFFSET ?
        `).all(term, lower, upper, pageSize, offset)

        total = db.prepare(`
        SELECT COUNT(*) AS c
        FROM images i
        JOIN images_fts f ON f.rowid = i.id
        WHERE f MATCH ?
          AND i.folder >= ?
          AND i.folder < ?${kindWhere}
        `).get(term, lower, upper).c
      }
    } else {
      if (useDateRange) {
        rows = db.prepare(`
          SELECT i.id, i.fname, i.folder, i.mtime, i.size, i.kind, i.duration
          FROM images i
          WHERE i.folder >= ?
            AND i.folder < ?
            AND i.mtime >= ? AND i.mtime < ?${kindWhere}
          ORDER BY i.mtime DESC, i.id DESC
          LIMIT ? OFFSET ?
        `).all(userScope, userScope + '\uFFFF', fromMs, toMs, pageSize, offset)

        total = db.prepare(`
          SELECT COUNT(*) AS c
          FROM images i
          WHERE i.folder >= ?
            AND i.folder < ?
            AND i.mtime >= ? AND i.mtime < ?${kindWhere}
        `).get(userScope, userScope + '\uFFFF', fromMs, toMs).c
      } else {
        rows = db.prepare(`
        SELECT i.id, i.fname, i.folder, i.mtime, i.size, i.kind, i.duration
        FROM images i
        WHERE i.folder >= ?
          AND i.folder < ?${kindWhere}
        ORDER BY i.mtime DESC, i.id DESC
        LIMIT ? OFFSET ?
        `).all(lower, upper, pageSize, offset)

        total = db.prepare(`
        SELECT COUNT(*) AS c
        FROM images i
        WHERE i.folder >= ?
          AND i.folder < ?${kindWhere}
        `).get(lower, upper).c
      }
    }

    res.json({ items: rows, total })
  } catch (e) {
    console.error('/api/photos error', e)
    res.status(500).json({ error: e.message })
  }
})

/* ---------- favorites endpoints ---------- */
app.get('/api/favorites', requireAuth, (req, res) => {
  try {
    const rows = listFavoriteIds.all(req.user.id)
    res.json({ items: rows.map(r => r.image_id) })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.post('/api/favorites/:id', requireAuth, (req, res) => {
  try {
    const id = Number(req.params.id)
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' })
    const row = db.prepare('SELECT id, folder FROM images WHERE id = ?').get(id)
    if (!row) return res.status(404).json({ error: 'not found' })
    if (!inScope(req.user.root_path || '', row.folder)) return res.status(403).json({ error: 'forbidden' })
    insertFavorite.run(req.user.id, id, nowMs())
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.delete('/api/favorites/:id', requireAuth, (req, res) => {
  try {
    const id = Number(req.params.id)
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' })
    deleteFavorite.run(req.user.id, id)
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.get('/api/favorites/photos', requireAuth, (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page || '1', 10))
    const pageSize = Math.max(1, Math.min(500, parseInt(req.query.pageSize || '200', 10)))
    const offset = (page - 1) * pageSize
    const items = listFavoriteItems.all(req.user.id, pageSize, offset)
    const total = countFavorites.get(req.user.id).c
    res.json({ items, total })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

/* ---------- share endpoints (create/list/delete) ---------- */
app.post('/api/shares', requireAuth, (req, res) => {
  try {
    const relFolder = String(req.body?.folder || '').trim()
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(x => parseInt(x, 10)).filter(Number.isFinite) : []
    
    let folder, name, shareId
    
    if (relFolder && !relFolder.startsWith('date:')) {
      // Traditional folder-based sharing
      folder = scopeJoin(req.user.root_path || '', normalizeScopeInput(relFolder))
      // Must be a prefix that exists in DB (optional check)
      const lower = folder
      const upper = folder + '\uFFFF'
      const count = db.prepare('SELECT COUNT(1) as c FROM images WHERE folder >= ? AND folder < ?').get(lower, upper).c
      if (count === 0) return res.status(404).json({ error: 'folder is empty or not found' })
      
      name = String(req.body?.name || path.basename(folder) || 'Shared').trim()
    } else if (ids.length > 0) {
      // Selected photos sharing (no folder required)
      // Use a special folder path for selected items
      folder = 'selected'
      
      // Generate name with current date and time
      const now = new Date()
      const day = now.getDate()
      const month = now.toLocaleString('en-US', { month: 'short' })
      const year = now.getFullYear().toString().slice(-2)
      const time = now.toLocaleString('en-US', { 
        hour: 'numeric', 
        minute: '2-digit',
        hour12: true 
      })
      name = `Shared, ${day} ${month} '${year}, ${time}`
    } else {
      return res.status(400).json({ error: 'either folder or selected ids required' })
    }

    const token = crypto.randomBytes(20).toString('hex')
    const info = insertShare.run(token, req.user.id, folder, name, nowMs())
    shareId = info.lastInsertRowid

    if (ids.length > 0) {
      if (relFolder && !relFolder.startsWith('date:')) {
        // Only allow ids within the folder scope for folder-based shares
        const lower = folder
        const upper = folder + '\uFFFF'
        const rows = db.prepare(`SELECT id FROM images WHERE id IN (${ids.map(()=>'?').join(',')}) AND folder >= ? AND folder < ?`).all(...ids, lower, upper)
        const allowed = new Set(rows.map(r => r.id))
        for (const id of ids) {
          if (allowed.has(id)) insertShareItem.run(shareId, id)
        }
      } else {
        // For selected-only shares, verify ids are within user's scope
        const userScope = req.user.root_path || ''
        const lower = userScope
        const upper = userScope + '\uFFFF'
        const rows = db.prepare(`SELECT id FROM images WHERE id IN (${ids.map(()=>'?').join(',')}) AND folder >= ? AND folder < ?`).all(...ids, lower, upper)
        const allowed = new Set(rows.map(r => r.id))
        for (const id of ids) {
          if (allowed.has(id)) insertShareItem.run(shareId, id)
        }
      }
    }

    const urlPath = `/s/${token}`
    res.json({ ok: true, token, name, folder, urlPath })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.get('/api/shares', requireAuth, (req, res) => {
  try {
    const includeAll = String(req.query.all || '0') === '1'
    if (includeAll) {
      if (!req.user?.is_admin) return res.status(403).json({ error: 'admin only' })
      const rows = listSharesWithUsers.all()
      const items = rows.map(r => ({ ...r, urlPath: `/s/${r.token}`, selected: countShareItems.get(r.id).c > 0 }))
      return res.json({ items })
    } else {
      const rows = listSharesByUser.all(req.user.id)
      const items = rows.map(r => ({ ...r, urlPath: `/s/${r.token}`, selected: countShareItems.get(r.id).c > 0 }))
      return res.json({ items })
    }
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.delete('/api/shares/:id', requireAuth, (req, res) => {
  try {
    const id = Number(req.params.id)
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' })
    const found = getShareById.get(id)
    if (!found) return res.status(404).json({ error: 'not found' })
    if (found.user_id !== req.user.id && !req.user.is_admin) return res.status(403).json({ error: 'forbidden' })
    deleteShareStmt.run(id)
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

/* ---------- public share consumption ---------- */
function getShare(req, res) {
  const token = String(req.params.token || '').trim()
  if (!token) { res.status(400).end(); return null }
  const share = getShareByToken.get(token)
  if (!share) { res.status(404).end(); return null }
  return share
}

// Public info
app.get('/s/:token/info', (req, res) => {
  try {
    const share = getShare(req, res); if (!share) return
    const selectedCount = countShareItems.get(share.id).c
    let total
    if (share.folder === 'selected' || selectedCount > 0) {
      // Selected-only share
      total = selectedCount
    } else {
      // Folder-based share
      const lower = share.folder
      const upper = lower + '\uFFFF'
      total = db.prepare('SELECT COUNT(1) as c FROM images WHERE folder >= ? AND folder < ?').get(lower, upper).c
    }
    res.json({ token: share.token, name: share.name, folder: share.folder, created_at: share.created_at, total, selected: selectedCount > 0 })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// Public photos under shared folder
app.get('/s/:token/photos', (req, res) => {
  try {
    const share = getShare(req, res); if (!share) return
    const page = Math.max(1, parseInt(req.query.page || '1', 10))
    const pageSize = Math.max(1, Math.min(500, parseInt(req.query.pageSize || '200', 10)))
    const offset = (page - 1) * pageSize
    const filter = (req.query.filter || 'all').toString()
    let kindWhere = ''
    if (filter === 'images') kindWhere = " AND kind = 'image'"
    else if (filter === 'videos') kindWhere = " AND kind = 'video'"

    const selectedCount = countShareItems.get(share.id).c
    let rows, total
    if (share.folder === 'selected' || selectedCount > 0) {
      // Selected-only share
      rows = db.prepare(`
        SELECT i.id, i.fname, i.folder, i.mtime, i.size, i.kind, i.duration
        FROM images i
        JOIN share_items si ON si.image_id = i.id
        WHERE si.share_id = ?${kindWhere}
        ORDER BY i.mtime DESC, i.id DESC
        LIMIT ? OFFSET ?
      `).all(share.id, pageSize, offset)
      total = selectedCount
    } else {
      // Folder-based share
      const lower = share.folder
      const upper = lower + '\uFFFF'
      rows = db.prepare(`
        SELECT id, fname, folder, mtime, size, kind, duration
        FROM images
        WHERE folder >= ? AND folder < ?${kindWhere}
        ORDER BY mtime DESC, id DESC
        LIMIT ? OFFSET ?
      `).all(lower, upper, pageSize, offset)
      total = db.prepare(`
        SELECT COUNT(1) as c FROM images WHERE folder >= ? AND folder < ?${kindWhere}
      `).get(lower, upper).c
    }
    res.json({ items: rows, total })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

function assertShareOwnsId(share, id) {
  const row = db.prepare('SELECT id, path, fname, folder, kind FROM images WHERE id = ?').get(Number(id))
  if (!row) return null
  const selectedCount = countShareItems.get(share.id).c
  if (share.folder === 'selected' || selectedCount > 0) {
    // Selected-only share - check if image is in the selected items
    const owns = db.prepare('SELECT 1 AS ok FROM share_items WHERE share_id = ? AND image_id = ?').get(share.id, row.id)
    if (!owns) return null
  } else {
    // Folder-based share - check if image is within the folder scope
    const lower = share.folder
    const upper = lower + '\uFFFF'
    if (!(row.folder >= lower && row.folder < upper)) return null
  }
  return row
}

app.get('/s/:token/thumb/:id', async (req, res) => {
  try {
    const share = getShare(req, res); if (!share) return
    const row = assertShareOwnsId(share, req.params.id)
    if (!row) return res.status(404).end()
    const abs = path.join(PHOTOS_ROOT, row.path)
    const thumb = await ensureThumb(abs)
    if (!thumb) return res.status(500).end()
    
    // Check if thumb is the original file (fallback case)
    if (thumb === abs) {
      const contentType = mime.lookup(abs) || 'image/jpeg'
      res.setHeader('content-type', contentType)
      res.setHeader('Cache-Control', 'public, max-age=31536000')
      fs.createReadStream(thumb).pipe(res)
    } else {
      res.setHeader('content-type', 'image/webp')
      res.setHeader('Cache-Control', 'public, max-age=31536000')
      fs.createReadStream(thumb).pipe(res)
    }
  } catch { res.status(500).end() }
})

app.get('/s/:token/view/:id', async (req, res) => {
  try {
    const share = getShare(req, res); if (!share) return
    const row = assertShareOwnsId(share, req.params.id)
    if (!row) return res.status(404).end()
    const abs = path.join(PHOTOS_ROOT, row.path)
    if (row.kind === 'video') {
      const thumb = await ensureThumb(abs)
      if (!thumb) return res.status(500).end()
      
      // Check if thumb is the original file (fallback case)
      if (thumb === abs) {
        const contentType = mime.lookup(abs) || 'image/jpeg'
        res.setHeader('content-type', contentType)
        res.setHeader('Cache-Control', 'public, max-age=31536000')
        fs.createReadStream(thumb).pipe(res)
      } else {
        res.setHeader('content-type', 'image/webp')
        res.setHeader('Cache-Control', 'public, max-age=31536000')
        fs.createReadStream(thumb).pipe(res)
      }
    } else {
      const view = await ensureView(abs)
      if (!view) return res.status(500).end()
      
      // Check if view is the original file (fallback case)
      if (view === abs) {
        const contentType = mime.lookup(abs) || 'image/jpeg'
        res.setHeader('content-type', contentType)
        res.setHeader('Cache-Control', 'public, max-age=31536000')
        fs.createReadStream(view).pipe(res)
      } else {
        res.setHeader('content-type', 'image/webp')
        res.setHeader('Cache-Control', 'public, max-age=31536000')
        fs.createReadStream(view).pipe(res)
      }
    }
  } catch { res.status(500).end() }
})

app.get('/s/:token/media/:id', async (req, res) => {
  try {
    const share = getShare(req, res); if (!share) return
    const row = assertShareOwnsId(share, req.params.id)
    if (!row) return res.status(404).end()
    const abs = path.join(PHOTOS_ROOT, row.path)
    if (row.kind === 'video') {
      const stat = await fsp.stat(abs).catch(() => null)
      if (!stat) return res.status(404).end()
      const range = req.headers.range
      const contentType = mime.lookup(abs) || 'video/mp4'
      if (!range) {
        res.writeHead(200, { 'Content-Length': stat.size, 'Content-Type': contentType, 'Accept-Ranges': 'bytes' })
        return fs.createReadStream(abs).pipe(res)
      }
      const m = /bytes=(\d+)-(\d+)?/.exec(range)
      if (!m) return res.status(416).end()
      const start = parseInt(m[1], 10)
      const end = m[2] ? parseInt(m[2], 10) : (stat.size - 1)
      if (start >= stat.size || end >= stat.size) return res.status(416).end()
      const chunkSize = (end - start) + 1
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': contentType
      })
      return fs.createReadStream(abs, { start, end }).pipe(res)
    } else {
      const disp = await ensureDisplayableMedia(abs)
      res.setHeader('content-type', disp.contentType)
      if (disp.contentType && disp.contentType.startsWith('image/')) {
        res.setHeader('Cache-Control', 'public, max-age=31536000')
      }
      fs.createReadStream(disp.path).pipe(res)
    }
  } catch { res.status(500).end() }
})

app.get('/s/:token/transcode/:id', async (req, res) => {
  try {
    const share = getShare(req, res); if (!share) return
    const row = assertShareOwnsId(share, req.params.id)
    if (!row || row.kind !== 'video') return res.status(404).end()
    const abs = path.join(PHOTOS_ROOT, row.path)
    const q = String(req.query.q || 'low')
    const maxw = Math.max(160, Math.min(3840, parseInt(req.query.maxw || '0', 10) || 0))
    const brParam = String(req.query.br || '')
    function pickPreset() {
      if (maxw || brParam) {
        const vmax = brParam || '10000k'
        const vbuf = (/\d+k$/i.test(vmax) ? `${parseInt(vmax,10)*2}k` : '20M')
        return { height: 720, vcrf: 16, vmax, vbuf, abitrate: '192k', fps: 30 }
      }
      if (q === 'high') return { height: 1080, vcrf: 18, vmax: '14000k', vbuf: '28M', abitrate: '192k', fps: 30 }
      if (q === 'medium' || q === '720') return { height: 720, vcrf: 21, vmax: '2000k', vbuf: '4M', abitrate: '96k', fps: 24 }
      return { height: 540, vcrf: 23, vmax: '1000k', vbuf: '2M', abitrate: '64k', fps: 24 }
    }
    const preset = pickPreset()
    let videoCodec = 'libx264'
    let videoProfile = 'main'
    let videoLevel = '4.1'
    let crfValue = preset.vcrf
    try {
      const meta = await probeVideoMeta(abs)
      if (meta && meta.codec === 'hevc') {
        videoCodec = 'libx265'
        videoProfile = 'main'
        videoLevel = '4.1'
        crfValue = Math.max(20, preset.vcrf - 6)
      }
    } catch {}
    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-i', abs,
      '-vf', `scale=-2:${preset.height}:flags=lanczos,format=yuv420p`,
      '-r', String(preset.fps),
      '-c:v', videoCodec, '-preset', 'medium', '-crf', String(crfValue),
      '-profile:v', videoProfile, '-level', videoLevel, '-pix_fmt', 'yuv420p',
      '-g', '60', '-keyint_min', '60', '-sc_threshold', '0',
      '-maxrate', preset.vmax, '-bufsize', preset.vbuf,
      '-c:a', 'aac', '-ac', '2', '-b:a', preset.abitrate,
      '-movflags', 'frag_keyframe+empty_moov+faststart', '-f', 'mp4', 'pipe:1'
    ]
    res.setHeader('Content-Type', 'video/mp4')
    res.setHeader('Cache-Control', 'no-store')
    const ex = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    ex.stdout.pipe(res)
    ex.on('error', () => { try { res.status(500).end() } catch {} })
  } catch { res.status(500).end() }
})

app.get('/s/:token/download/:id', (req, res) => {
  try {
    const share = getShare(req, res); if (!share) return
    const row = assertShareOwnsId(share, req.params.id)
    if (!row) return res.status(404).end()
    const abs = path.join(PHOTOS_ROOT, row.path)
    const type = mime.lookup(abs) || 'application/octet-stream'
    const name = row.fname || path.basename(abs)
    res.setHeader('content-type', type)
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`)
    fs.createReadStream(abs).pipe(res)
  } catch { res.status(500).end() }
})

app.post('/s/:token/download/batch', async (req, res) => {
  try {
    const share = getShare(req, res); if (!share) return
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(x => parseInt(x, 10)).filter(Number.isFinite) : []
    if (ids.length === 0) return res.status(400).json({ error: 'no ids' })
    const rows = ids.map(id => assertShareOwnsId(share, id)).filter(Boolean)
    if (rows.length === 0) return res.status(404).json({ error: 'not found' })
    const ts = new Date().toISOString().slice(0,19).replace(/[:T]/g,'')
    const zipName = `photos-${ts}.zip`
    res.setHeader('Content-Type', 'application/zip')
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(zipName)}`)
    const archive = archiver('zip', { zlib: { level: 9 } })
    archive.on('error', () => { try { res.status(500).end() } catch {} })
    archive.pipe(res)
    for (const r of rows) {
      const abs = path.join(PHOTOS_ROOT, r.path)
      try { await fsp.access(abs); archive.file(abs, { name: r.fname || path.basename(abs) }) } catch {}
    }
    await archive.finalize()
  } catch { res.status(500).end() }
})

// Public HLS endpoints
app.get('/s/:token/hls/:id/master.m3u8', (req, res) => {
  try {
    const share = getShare(req, res); if (!share) return
    const row = assertShareOwnsId(share, req.params.id)
    if (!row || row.kind !== 'video') return res.status(404).end()
    const lines = ['#EXTM3U', '#EXT-X-VERSION:3']
    const set = [
      { name: '360p', height: 360, bw: 700000 },
      { name: '540p', height: 540, bw: 1200000 },
      { name: '720p', height: 720, bw: 2500000 }
    ]
    for (const v of set) {
      lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${v.bw},RESOLUTION=1280x${v.height}`)
      lines.push(`/s/${share.token}/hls/${row.id}/${v.height}.m3u8`)
    }
    res.setHeader('Content-Type', 'application/x-mpegURL')
    res.send(lines.join('\n'))
  } catch { res.status(500).end() }
})

app.get('/s/:token/hls/:id/:height.m3u8', async (req, res) => {
  try {
    const share = getShare(req, res); if (!share) return
    const row = assertShareOwnsId(share, req.params.id)
    if (!row || row.kind !== 'video') return res.status(404).end()
    const height = Math.max(144, Math.min(2160, parseInt(req.params.height || '720', 10)))
    const abs = path.join(PHOTOS_ROOT, db.prepare('SELECT path FROM images WHERE id=?').get(row.id).path)

    const key = `${hashPath(abs)}_${height}`
    const outDir = path.join(HLS_DIR, key)
    const indexPath = path.join(outDir, 'index.m3u8')
    if (await fileExists(indexPath)) {
      res.setHeader('Content-Type', 'application/x-mpegURL')
      return fs.createReadStream(indexPath).pipe(res)
    }

    await fsp.mkdir(outDir, { recursive: true })

    let videoCodec = 'libx264'
    let videoProfile = 'main'
    let videoLevel = '4.1'
    let crfValue = 20
    try { const meta = await probeVideoMeta(abs); if (meta) { videoCodec = 'libx264'; videoProfile = 'main'; videoLevel = '4.1'; crfValue = 20 } } catch {}

    const cfg = height <= 360
      ? { maxrate: '700k', buf: '1400k', abr: '64k' }
      : (height <= 540 ? { maxrate: '1200k', buf: '2400k', abr: '96k' } : { maxrate: '2500k', buf: '5000k', abr: '128k' })

    const args = [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', abs,
      '-vf', `scale=-2:${height}:flags=lanczos,format=yuv420p`,
      '-c:v', videoCodec, '-preset', 'veryfast', '-profile:v', videoProfile, '-level', videoLevel, '-crf', String(crfValue),
      '-maxrate', cfg.maxrate, '-bufsize', cfg.buf,
      '-c:a', 'aac', '-ac', '2', '-b:a', cfg.abr,
      '-f', 'hls',
      '-hls_time', '4', '-hls_playlist_type', 'event', '-hls_segment_type', 'mpegts',
      '-hls_base_url', `/s/hls/seg/${key}/`,
      '-hls_segment_filename', path.join(outDir, 'seg%04d.ts'),
      path.join(outDir, 'index.m3u8')
    ]

    const ex = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderrBuf = ''
    ex.stderr.on('data', (d) => { stderrBuf += String(d) })
    const start = Date.now()
    const poll = setInterval(async () => {
      if (await fileExists(indexPath)) {
        clearInterval(poll)
        res.setHeader('Content-Type', 'application/x-mpegURL')
        fs.createReadStream(indexPath).pipe(res)
      } else if (Date.now() - start > 8000) {
        clearInterval(poll)
        try { ex.kill('SIGKILL') } catch {}
        res.status(500).end()
      }
    }, 200)
  } catch { res.status(500).end() }
})

app.get('/s/hls/seg/:key/:file', async (req, res) => {
  try {
    const key = String(req.params.key)
    const file = String(req.params.file)
    const segPath = path.join(HLS_DIR, key, file)
    if (!(await fileExists(segPath))) return res.status(404).end()
    res.setHeader('Content-Type', 'video/MP2T')
    fs.createReadStream(segPath).pipe(res)
  } catch { res.status(500).end() }
})

/* rescan: admin only */
app.post('/api/index', requireAdmin, async (req, res) => {
  if (currentIndexJob.running) return res.status(409).json({ error: 'index already running' })
  const job = beginIndexJob()
  if (!job) return res.status(409).json({ error: 'index already running' })
  try {
    const p = (req.body && typeof req.body.path === 'string') ? req.body.path : ''
    if (p) { await scanAndIndexUnder(p, job) } else { await scanAndIndex(job) }
    res.json({ ok: true, canceled: !!job.cancel })
  } catch (e) {
    res.status(500).json({ error: e.message })
  } finally {
    endIndexJob(job)
  }
})

/* cancel index: admin only */
app.post('/api/index/cancel', requireAdmin, (_req, res) => {
  if (!currentIndexJob.running) return res.json({ ok: true, running: false })
  currentIndexJob.cancel = true
  res.json({ ok: true, running: true, canceled: true })
})

/* index status: admin only */
app.get('/api/index/status', requireAdmin, (_req, res) => {
  res.json({ 
    running: currentIndexJob.running, 
    canceled: currentIndexJob.cancel,
    token: currentIndexJob.token 
  })
})

/* media endpoints: auth + scope check */
app.get('/thumb/:id', requireAuth, async (req, res) => {
  const id = Number(req.params.id)
  const row = db.prepare('SELECT path, folder FROM images WHERE id=?').get(id)
  if (!row) return res.status(404).end()
  if (!inScope(req.user.root_path || '', row.folder)) return res.status(403).end()
  const abs = path.join(PHOTOS_ROOT, row.path)
  console.log('[thumb] request for id:', id, 'path:', row.path)
  const thumb = await ensureThumb(abs)
  if (!thumb) {
    console.error('[thumb] thumb failed for:', abs)
    return res.status(500).end()
  }
  
  // Check if thumb is the original file (fallback case)
  if (thumb === abs) {
    const contentType = mime.lookup(abs) || 'image/jpeg'
    res.setHeader('content-type', contentType)
    res.setHeader('Cache-Control', 'public, max-age=31536000') // Cache for 1 year
    fs.createReadStream(thumb).pipe(res)
  } else {
    res.setHeader('content-type', 'image/webp')
    res.setHeader('Cache-Control', 'public, max-age=31536000') // Cache for 1 year
    fs.createReadStream(thumb).pipe(res)
  }
})

app.get('/view/:id', requireAuth, async (req, res) => {
  const id = Number(req.params.id)
  const row = db.prepare('SELECT path, folder, kind FROM images WHERE id=?').get(id)
  if (!row) return res.status(404).end()
  if (!inScope(req.user.root_path || '', row.folder)) return res.status(403).end()
  const abs = path.join(PHOTOS_ROOT, row.path)
  console.log('[view] request for id:', id, 'path:', row.path, 'kind:', row.kind)
  
  if (row.kind === 'video') {
    // For videos, return poster image (thumb) as a view placeholder
    const thumb = await ensureThumb(abs)
    if (!thumb) {
      console.error('[view] thumb failed for video:', abs)
      return res.status(500).end()
    }
    
    // Check if thumb is the original file (fallback case)
    if (thumb === abs) {
      const contentType = mime.lookup(abs) || 'image/jpeg'
      res.setHeader('content-type', contentType)
      res.setHeader('Cache-Control', 'public, max-age=31536000') // Cache for 1 year
      fs.createReadStream(thumb).pipe(res)
    } else {
      res.setHeader('content-type', 'image/webp')
      res.setHeader('Cache-Control', 'public, max-age=31536000') // Cache for 1 year
      fs.createReadStream(thumb).pipe(res)
    }
  } else {
    const view = await ensureView(abs)
    if (!view) {
      console.error('[view] view failed for image:', abs)
      return res.status(500).end()
    }
    
    // Check if view is the original file (fallback case)
    if (view === abs) {
      const contentType = mime.lookup(abs) || 'image/jpeg'
      res.setHeader('content-type', contentType)
      res.setHeader('Cache-Control', 'public, max-age=31536000') // Cache for 1 year
      fs.createReadStream(view).pipe(res)
    } else {
      res.setHeader('content-type', 'image/webp')
      res.setHeader('Cache-Control', 'public, max-age=31536000') // Cache for 1 year
      fs.createReadStream(view).pipe(res)
    }
  }
})

app.get('/media/:id', requireAuth, async (req, res) => {
  const id = Number(req.params.id)
  const row = db.prepare('SELECT path, folder, kind FROM images WHERE id=?').get(id)
  if (!row) return res.status(404).end()
  if (!inScope(req.user.root_path || '', row.folder)) return res.status(403).end()
  const abs = path.join(PHOTOS_ROOT, row.path)
  try {
    if (row.kind === 'video') {
      // Support Range requests for video streaming
      const stat = await fsp.stat(abs).catch(() => null)
      if (!stat) return res.status(404).end()
      const range = req.headers.range
      const contentType = mime.lookup(abs) || 'video/mp4'
      if (!range) {
        res.writeHead(200, {
          'Content-Length': stat.size,
          'Content-Type': contentType,
          'Accept-Ranges': 'bytes'
        })
        return fs.createReadStream(abs).pipe(res)
      }
      const m = /bytes=(\d+)-(\d+)?/.exec(range)
      if (!m) return res.status(416).end()
      const start = parseInt(m[1], 10)
      const end = m[2] ? parseInt(m[2], 10) : (stat.size - 1)
      if (start >= stat.size || end >= stat.size) return res.status(416).end()
      const chunkSize = (end - start) + 1
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': contentType
      })
      return fs.createReadStream(abs, { start, end }).pipe(res)
    } else {
      const disp = await ensureDisplayableMedia(abs)
      res.setHeader('content-type', disp.contentType)
      // Enable caching for full-resolution images served via /media
      if (disp.contentType && disp.contentType.startsWith('image/')) {
        res.setHeader('Cache-Control', 'public, max-age=31536000') // Cache for 1 year
      }
      fs.createReadStream(disp.path).pipe(res)
    }
  } catch (e) {
    const type = mime.lookup(abs) || 'application/octet-stream'
    res.setHeader('content-type', type)
    if (String(type).startsWith('image/')) {
      res.setHeader('Cache-Control', 'public, max-age=31536000') // Cache for 1 year
    }
    fs.createReadStream(abs).pipe(res)
  }
})

/* On-the-fly video transcode for reduced buffering */
app.get('/transcode/:id', requireAuth, async (req, res) => {
  const id = Number(req.params.id)
  const row = db.prepare('SELECT path, folder, kind FROM images WHERE id=?').get(id)
  if (!row) return res.status(404).end()
  if (!inScope(req.user.root_path || '', row.folder)) return res.status(403).end()
  if (row.kind !== 'video') return res.status(400).json({ error: 'not a video' })
  const abs = path.join(PHOTOS_ROOT, row.path)

  // Presets: low/medium/high or custom maxw/bitrate
  const q = String(req.query.q || 'low')
  const maxw = Math.max(160, Math.min(3840, parseInt(req.query.maxw || '0', 10) || 0))
  const brParam = String(req.query.br || '')
  function pickPreset() {
    if (maxw || brParam) {
      const vmax = brParam || '10000k'
      const vbuf = (/\d+k$/i.test(vmax) ? `${parseInt(vmax,10)*2}k` : '20M')
      return { height: 720, vcrf: 16, vmax, vbuf, abitrate: '192k', fps: 30 }
    }
    if (q === 'high') return { height: 1080, vcrf: 18, vmax: '14000k', vbuf: '28M', abitrate: '192k', fps: 30 }
    if (q === 'medium' || q === '720') return { height: 720, vcrf: 21, vmax: '2000k', vbuf: '4M', abitrate: '96k', fps: 24 }
    // low bandwidth preset: ~1 Mbps video @ 540p, 24fps
    return { height: 540, vcrf: 23, vmax: '1000k', vbuf: '2M', abitrate: '64k', fps: 24 }
  }
  const preset = pickPreset()

  // Check if source video is HEVC/H.265 and use appropriate codec
  let videoCodec = 'libx264'
  let videoProfile = 'main' // Use main profile for better compatibility
  let videoLevel = '4.1'
  let crfValue = preset.vcrf
  
  try {
    const meta = await probeVideoMeta(abs)
    console.log('[transcode] Video codec detection for:', abs, '->', meta?.codec || 'unknown')
    if (meta && meta.codec === 'hevc') {
      // Use HEVC/H.265 for better quality and compatibility with iPhone videos
      videoCodec = 'libx265'
      videoProfile = 'main'
      videoLevel = '4.1'
      // Adjust CRF for HEVC (HEVC CRF values are different from H.264)
      crfValue = Math.max(20, preset.vcrf - 6) // HEVC typically needs lower CRF for same quality
      console.log('[transcode] Using HEVC encoding with libx265, CRF:', crfValue)
    } else {
      console.log('[transcode] Using H.264 encoding with libx264, CRF:', crfValue)
    }
  } catch (e) {
    console.warn('[transcode] Failed to detect video codec, using H.264:', e.message)
  }

  // ffmpeg args for fragmented MP4 for progressive playback
  const args = [
    '-hide_banner', '-loglevel', 'error',
    '-i', abs,
    // Force target height (e.g. 720p) with sharp downscaling and ensure 8-bit output
    '-vf', `scale=-2:${preset.height}:flags=lanczos,format=yuv420p`,
    '-r', String(preset.fps),
    '-c:v', videoCodec, '-preset', 'medium', '-crf', String(crfValue),
    '-profile:v', videoProfile, '-level', videoLevel, '-pix_fmt', 'yuv420p',
    '-g', '60', '-keyint_min', '60', '-sc_threshold', '0',
    '-maxrate', preset.vmax, '-bufsize', preset.vbuf,
    '-c:a', 'aac', '-ac', '2', '-b:a', preset.abitrate,
    '-movflags', 'frag_keyframe+empty_moov+faststart', '-f', 'mp4', 'pipe:1'
  ]

  res.setHeader('Content-Type', 'video/mp4')
  // Disable caching for dynamic transcode
  res.setHeader('Cache-Control', 'no-store')
  const ex = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] })
  ex.stdout.pipe(res)
  let stderrBuf = ''
  ex.stderr.on('data', (d) => { stderrBuf += String(d) })
  const cleanup = () => { try { ex.kill('SIGKILL') } catch {} }
  res.on('close', cleanup)
  res.on('finish', cleanup)
  ex.on('close', (code) => {
    if (code !== 0) {
      // If HEVC encoding failed, try fallback to H.264
      if (videoCodec === 'libx265' && !res.headersSent) {
        console.warn('[transcode] HEVC encoding failed, trying H.264 fallback for:', abs)
        try {
          // Retry with H.264
          const fallbackArgs = [
            '-hide_banner', '-loglevel', 'error',
            '-i', abs,
            '-vf', `scale=-2:${preset.height}:flags=lanczos`,
            '-r', String(preset.fps),
            '-c:v', 'libx264', '-preset', 'medium', '-crf', String(preset.vcrf),
            '-profile:v', 'high', '-level', '4.1', '-pix_fmt', 'yuv420p',
            '-g', '60', '-keyint_min', '60', '-sc_threshold', '0',
            '-maxrate', preset.vmax, '-bufsize', preset.vbuf,
            '-c:a', 'aac', '-ac', '2', '-b:a', preset.abitrate,
            '-movflags', 'frag_keyframe+empty_moov+faststart', '-f', 'mp4', 'pipe:1'
          ]
          
          const fallbackEx = spawn('ffmpeg', fallbackArgs, { stdio: ['ignore', 'pipe', 'pipe'] })
          fallbackEx.stdout.pipe(res)
          fallbackEx.stderr.on('data', () => {})
          const fallbackCleanup = () => { try { fallbackEx.kill('SIGKILL') } catch {} }
          res.on('close', fallbackCleanup)
          res.on('finish', fallbackCleanup)
          fallbackEx.on('close', (fallbackCode) => {
            if (fallbackCode !== 0) {
              try { if (!res.headersSent) res.status(500).end() } catch {}
            }
          })
          fallbackEx.on('error', () => { try { if (!res.headersSent) res.status(500).end() } catch {} })
        } catch (fallbackError) {
          console.error('[transcode] H.264 fallback also failed:', fallbackError.message)
          try { if (!res.headersSent) res.status(500).end() } catch {}
        }
      } else {
        try { if (!res.headersSent) res.status(500).end() } catch {}
      }
    }
  })
  ex.on('error', () => { try { res.status(500).end() } catch {} })
})

/* HLS adaptive streaming: master and variants */
app.get('/hls/:id/master.m3u8', requireAuth, async (req, res) => {
  const id = Number(req.params.id)
  const row = db.prepare('SELECT path, folder, kind FROM images WHERE id=?').get(id)
  if (!row) return res.status(404).end()
  if (!inScope(req.user.root_path || '', row.folder)) return res.status(403).end()
  if (row.kind !== 'video') return res.status(400).json({ error: 'not a video' })

  const set = [
    { name: '360p', height: 360, bw: 700000 },
    { name: '540p', height: 540, bw: 1200000 },
    { name: '720p', height: 720, bw: 2500000 }
  ]
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3']
  for (const v of set) {
    lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${v.bw},RESOLUTION=1280x${v.height}`)
    lines.push(`/hls/${id}/${v.height}.m3u8`)
  }
  res.setHeader('Content-Type', 'application/x-mpegURL')
  res.send(lines.join('\n'))
})

app.get('/hls/:id/:height.m3u8', requireAuth, async (req, res) => {
  const id = Number(req.params.id)
  const height = Math.max(144, Math.min(2160, parseInt(req.params.height || '720', 10)))
  const row = db.prepare('SELECT path, folder, kind FROM images WHERE id=?').get(id)
  if (!row) return res.status(404).end()
  if (!inScope(req.user.root_path || '', row.folder)) return res.status(403).end()
  if (row.kind !== 'video') return res.status(400).end()
  const abs = path.join(PHOTOS_ROOT, row.path)

  const key = `${hashPath(abs)}_${height}`
  const outDir = path.join(HLS_DIR, key)
  const indexPath = path.join(outDir, 'index.m3u8')
  // If already generated, serve playlist
  if (await fileExists(indexPath)) {
    res.setHeader('Content-Type', 'application/x-mpegURL')
    return fs.createReadStream(indexPath).pipe(res)
  }

  // Prepare directory
  await fsp.mkdir(outDir, { recursive: true })

  // Check if source video is HEVC/H.265 and use appropriate codec
  let videoCodec = 'libx264'
  let videoProfile = 'high'
  let videoLevel = '4.1'
  let crfValue = 20
  
  try {
    const meta = await probeVideoMeta(abs)
    console.log('[hls] Video codec detection for:', abs, '->', meta?.codec || 'unknown')
    // For HLS, always use H.264 for better compatibility and faster encoding
    // HEVC will be used in the transcode endpoint for direct playback
    videoCodec = 'libx264'
    // Use main profile for better compatibility with 10-bit sources
    videoProfile = 'main'
    videoLevel = '4.1'
    crfValue = 20
    console.log('[hls] Using H.264 encoding with libx264 for HLS compatibility, CRF:', crfValue)
  } catch (e) {
    console.warn('[hls] Failed to detect video codec, using H.264:', e.message)
  }

  // Bitrate ladder approximation
  const cfg = height <= 360
    ? { maxrate: '700k', buf: '1400k', abr: '64k' }
    : (height <= 540 ? { maxrate: '1200k', buf: '2400k', abr: '96k' } : { maxrate: '2500k', buf: '5000k', abr: '128k' })

  // Segment duration target ~4s
  const args = [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', abs,
    '-vf', `scale=-2:${height}:flags=lanczos,format=yuv420p`,
    '-c:v', videoCodec, '-preset', 'veryfast', '-profile:v', videoProfile, '-level', videoLevel, '-crf', String(crfValue),

    '-maxrate', cfg.maxrate, '-bufsize', cfg.buf,
    '-c:a', 'aac', '-ac', '2', '-b:a', cfg.abr,
    '-f', 'hls',
    '-hls_time', '4', '-hls_playlist_type', 'event', '-hls_segment_type', 'mpegts',
    '-hls_base_url', `/hls/seg/${key}/`,
    '-hls_segment_filename', path.join(outDir, 'seg%04d.ts'),
    path.join(outDir, 'index.m3u8')
  ]

  // Launch ffmpeg and immediately tail the playlist when it appears
  const ex = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] })
  let stderrBuf = ''
  ex.stderr.on('data', (d) => { stderrBuf += String(d) })
  ex.on('error', (err) => {
    console.error('[hls] FFmpeg spawn error:', err.message)
  })

  // Poll for playlist existence, then stream it
  const start = Date.now()
  const poll = setInterval(async () => {
    if (await fileExists(indexPath)) {
      clearInterval(poll)
      console.log('[hls] HLS playlist generated successfully for:', abs)
      res.setHeader('Content-Type', 'application/x-mpegURL')
      fs.createReadStream(indexPath).pipe(res)
    } else if (Date.now() - start > 8000) {
      clearInterval(poll)
      try { ex.kill('SIGKILL') } catch {}
      
      // Log the error and return 500
      console.error('[hls] HLS generation failed for:', abs)
      console.error('[hls] FFmpeg stderr output:', stderrBuf.slice(-500))
      res.status(500).end()
    }
  }, 200)
})

// HLS segment serving (ts files)
app.get('/hls/seg/:key/:file', requireAuth, async (req, res) => {
  try {
    const key = String(req.params.key)
    const file = String(req.params.file)
    const segPath = path.join(HLS_DIR, key, file)
    if (!(await fileExists(segPath))) return res.status(404).end()
    res.setHeader('Content-Type', 'video/MP2T')
    fs.createReadStream(segPath).pipe(res)
  } catch (e) {
    res.status(500).end()
  }
})

// Back-compat segment handler when playlist used relative paths (/hls/:id/segXXXX.ts)
app.get('/hls/:id/:file(seg\\d+\\.ts)', requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id)
    const file = String(req.params.file)
    const row = db.prepare('SELECT path, folder, kind FROM images WHERE id=?').get(id)
    if (!row) return res.status(404).end()
    if (!inScope(req.user.root_path || '', row.folder)) return res.status(403).end()
    const abs = path.join(PHOTOS_ROOT, row.path)
    const hash = hashPath(abs)
    // Find a variant dir that contains this segment
    const entries = await fsp.readdir(HLS_DIR).catch(()=>[])
    for (const d of entries) {
      if (!String(d).startsWith(`${hash}_`)) continue
      const segPath = path.join(HLS_DIR, d, file)
      if (await fileExists(segPath)) {
        res.setHeader('Content-Type', 'video/MP2T')
        return fs.createReadStream(segPath).pipe(res)
      }
    }
    return res.status(404).end()
  } catch {
    res.status(500).end()
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

/* metadata: image or video */
app.get('/api/meta/:id', requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id)
    const row = db.prepare('SELECT id, path, fname, folder, size, kind, duration FROM images WHERE id = ?').get(id)
    if (!row) return res.status(404).json({ error: 'not found' })
    if (!inScope(req.user.root_path || '', row.folder)) return res.status(403).json({ error: 'forbidden' })
    const abs = path.join(PHOTOS_ROOT, row.path)
    const base = { id: row.id, fname: row.fname, folder: row.folder, size: row.size, kind: row.kind, duration: row.duration }
    if (row.kind === 'video') {
      // Basic metadata via ffprobe
      const meta = await probeVideoMeta(abs)
      return res.json({ ...base, format: meta?.format || 'video', width: meta?.width || 0, height: meta?.height || 0 })
    } else {
      try {
        const md = await sharp(abs).metadata()
        // Extract EXIF data using exifr
        let exifData = {}
        try {
          exifData = await exifr.parse(abs, {
            tiff: true,
            xmp: true,
            icc: true,
            iptc: true,
            jfif: true,
            ihdr: true,
            exif: true,
            gps: true,
            interop: true,
            translateValues: true,
            translateTags: true,
            reviveValues: true
          }) || {}
          console.log('EXIF data extracted for', abs, ':', Object.keys(exifData))
        } catch (exifError) {
          console.warn('EXIF extraction failed for', abs, exifError.message)
        }
        
        return res.json({ 
          ...base, 
          format: md?.format || '', 
          width: md?.width || 0, 
          height: md?.height || 0, 
          exif: exifData 
        })
      } catch {
        return res.json({ ...base })
      }
    }
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

async function probeVideoMeta(absPath) {
  return new Promise((resolve) => {
    const args = [
      '-v', 'error',
      '-show_entries', 'stream=codec_type,width,height,nb_frames,avg_frame_rate,duration,codec_name:format=duration',
      '-of', 'json',
      absPath
    ]
    const ex = spawn('ffprobe', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    ex.stdout.on('data', d => { out += String(d) })
    ex.on('close', () => {
      try {
        const j = JSON.parse(out || '{}')
        const streams = Array.isArray(j.streams) ? j.streams : []
        const vstream = streams.find(s => (s.codec_type || '') === 'video') || streams[0] || {}
        const fmt = j.format || {}
        let durationSec = 0
        if (fmt.duration != null) {
          const d = Number(fmt.duration)
          if (Number.isFinite(d) && d > 0) durationSec = d
        }
        if (durationSec === 0) {
          const sd = Number(vstream.duration)
          if (Number.isFinite(sd) && sd > 0) durationSec = sd
        }
        if (durationSec === 0 && vstream?.tags?.DURATION) {
          const sex = String(vstream.tags.DURATION)
          const m = /(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)/.exec(sex)
          if (m) {
            const hh = Number(m[1] || 0), mm = Number(m[2] || 0), ss = Number(m[3] || 0)
            durationSec = hh * 3600 + mm * 60 + ss
          }
        }
        if (durationSec === 0 && vstream.nb_frames && vstream.avg_frame_rate) {
          const [num, den] = String(vstream.avg_frame_rate).split('/').map(x => Number(x))
          if (num > 0 && den > 0) {
            const fps = num / den
            const nf = Number(vstream.nb_frames)
            if (fps > 0 && nf > 0) durationSec = nf / fps
          }
        }
        const width = Number(vstream.width || 0)
        const height = Number(vstream.height || 0)
        const codec = String(vstream.codec_name || '').toLowerCase()
        resolve({ width, height, format: 'video', duration: Math.floor(durationSec * 1000), codec })
      } catch {
        resolve(null)
      }
    })
    ex.on('error', () => resolve(null))
  })
}

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
  const found = db.prepare('SELECT id, username FROM users WHERE id = ?').get(id)
  if (!found) return res.status(404).json({ error: 'not found' })
  if (found.username === DEFAULT_ADMIN_USERNAME) return res.status(400).json({ error: 'cannot delete the default admin' })
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
      req.path.startsWith('/download/') ||
      req.path.startsWith('/hls/')
    ) return next()
    res.sendFile(path.join(DIST_DIR, 'index.html'))
  })
}

/* Debug endpoint for testing video codec detection */
app.get('/api/debug/video/:id', requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id)
    const row = db.prepare('SELECT path, folder, kind FROM images WHERE id=?').get(id)
    if (!row) return res.status(404).json({ error: 'not found' })
    if (!inScope(req.user.root_path || '', row.folder)) return res.status(403).json({ error: 'forbidden' })
    if (row.kind !== 'video') return res.status(400).json({ error: 'not a video' })
    
    const abs = path.join(PHOTOS_ROOT, row.path)
    const meta = await probeVideoMeta(abs)
    
    res.json({
      id,
      path: row.path,
      meta,
      hevcSupported: meta?.codec === 'hevc',
      recommendedCodec: meta?.codec === 'hevc' ? 'libx265' : 'libx264'
    })
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
  const cookieMode = (process.env.COOKIE_SECURE !== undefined)
    ? (process.env.COOKIE_SECURE !== '0' ? 'Secure cookies (forced)' : 'Non-secure cookies (forced)')
    : 'Auto: Secure on HTTPS, non-secure on HTTP'
  console.log(`API+Web on http://${HOST}:${PORT}`)
  console.log(`Photos root: ${PHOTOS_ROOT}`)
  console.log(`Cookie mode: ${cookieMode}`)
})
