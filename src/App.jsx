import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import { FolderTree, RefreshCcw, Search, Image as ImageIcon, ChevronRight, ChevronDown, X, Maximize2, Download, Menu, Plus, Minus, Info } from 'lucide-react'

const BASE = import.meta?.env?.DEV ? 'http://127.0.0.1:5174' : ''
const API = {
  tree: async () => (await fetch(`${BASE}/api/tree`)).json(),
  photos: async (params = {}, options = {}) => {
    const qs = new URLSearchParams(params).toString()
    const r = await fetch(`${BASE}/api/photos?${qs}`, options)
    return await r.json()
  },
  meta: async (id, options = {}) => {
    const r = await fetch(`${BASE}/api/meta/${id}`, options)
    return await r.json()
  },
  rescan: async () => (await fetch(`${BASE}/api/index`, { method: 'POST' })).json(),
}

const GlassShell = ({ children }) => (
  <div className="h-full w-full bg-slate-900 text-slate-100">
    <div className="h-full">{children}</div>
  </div>
)

function useDebouncedValue(value, delay = 250) {
  const [v, setV] = useState(value)
  useEffect(() => { const t = setTimeout(() => setV(value), delay); return () => clearTimeout(t) }, [value, delay])
  return v
}

function SidebarTree({ tree, open, toggle, select, selected }) {
  if (!tree) return null
  return (
    <div className="h-full overflow-auto p-2 pr-1">
      <div className="flex items-center gap-2 text-slate-300 mb-2 px-2">
        <FolderTree className="w-5 h-5" />
        <span className="text-sm font-medium">Folders</span>
      </div>
      <TreeNode node={tree} depth={0} open={open} toggle={toggle} select={select} selected={selected} />
    </div>
  )
}

function TreeNode({ node, depth, open, toggle, select, selected }) {
  const isRoot = depth === 0
  const isOpen = open.has(node.path)
  const hasChildren = node.children && node.children.length > 0
  const pad = { paddingLeft: `${depth * 12 + (isRoot ? 0 : 8)}px` }
  return (
    <div>
      {!isRoot && (
        <div
          className={`group flex items-center gap-2 select-none cursor-pointer rounded-lg mx-1 py-1.5 pr-2 ${selected === node.path ? 'bg-white/10 text-white' : 'hover:bg-white/5 text-slate-200'}`}
          style={pad}
          onClick={() => select(node.path)}
        >
          <button
            onClick={(e) => { e.stopPropagation(); if (hasChildren) toggle(node.path) }}
            className="p-0.5 rounded hover:bg-white/10"
          >
            {hasChildren ? (isOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />) : <span className="w-4 h-4" />}
          </button>
          <span className="truncate text-sm/5">{node.name}</span>
          <span className="ml-auto text-xs text-slate-400">{node.count ?? 0}</span>
        </div>
      )}
      {hasChildren && isOpen && (
        <div>
          {node.children.map((c) => (
            <TreeNode key={c.path} node={c} depth={depth + 1} open={open} toggle={toggle} select={select} selected={selected} />
          ))}
        </div>
      )}
    </div>
  )
}

function useMediaQuery(query) {
  const [matches, setMatches] = useState(false)
  useEffect(() => {
    const m = window.matchMedia(query)
    const on = () => setMatches(m.matches)
    on()
    try { m.addEventListener('change', on) } catch { m.addListener(on) }
    return () => { try { m.removeEventListener('change', on) } catch { m.removeListener(on) } }
  }, [query])
  return matches
}

// helpers
function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return ''
  const units = ['B','KB','MB','GB','TB']
  let i = 0; let v = bytes
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`
}
function ellipsizeWords(s, maxWords = 8) {
  if (!s) return ''
  const words = s.split(/\s+/)
  return words.length > maxWords ? words.slice(0, maxWords).join(' ') + '…' : s
}

const HEADER_H = 56 // viewer header height in px (mobile & desktop)
const MOBILE_INFO_VH = 40 // bottom sheet height in vh when info is open

export default function App() {
  // Sidebar + layout
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [sidebarWidth, setSidebarWidth] = useState(280)
  const isSmall = useMediaQuery('(max-width: 640px)')

  // Search & folder
  const [tree, setTree] = useState(null)
  const [open, setOpen] = useState(new Set())
  const [selected, setSelected] = useState('') // '' → All Media
  const [query, setQuery] = useState('')
  const debouncedQ = useDebouncedValue(query, 300)

  // Photos & paging
  const [photos, setPhotos] = useState([])
  const [page, setPage] = useState(1)
  const [hasMore, setHasMore] = useState(true)
  const [loading, setLoading] = useState(false)
  const [total, setTotal] = useState(0)
  const [error, setError] = useState('')
  const [initialLoaded, setInitialLoaded] = useState(false)

  // Viewer
  const [viewer, setViewer] = useState({ open: false, index: 0 })
  const [infoOpen, setInfoOpen] = useState(false)
  const metaCacheRef = useRef(new Map())
  const [meta, setMeta] = useState(null)

  // Grid sizing
  const scrollRef = useRef(null)
  const sentinelRef = useRef(null)
  const [tileMin, setTileMin] = useState(120)
  const [gridCols, setGridCols] = useState(1)
  const [tileSize, setTileSize] = useState(120)
  const [resizeOpen, setResizeOpen] = useState(false)
  const resizeRef = useRef(null)
  const [resizing, setResizing] = useState(false)

  // Deduper & loader control
  const photoIdsRef = useRef(new Set())
  const requestKey = useMemo(() => `${selected}||${debouncedQ}`, [selected, debouncedQ])
  const lastKeyRef = useRef(null)
  const controllerRef = useRef(null)
  const inFlightRef = useRef(false)

  // Initial tree
  useEffect(() => {
    (async () => {
      const t = await API.tree()
      setTree(t)
      setOpen(new Set([t.path]))
      setSelected(t.path) // usually ''
    })()
  }, [])

  // Close drawer on large screens
  useEffect(() => { if (!isSmall && sidebarOpen) setSidebarOpen(false) }, [isSmall, sidebarOpen])

  // Close resize popover when clicking outside
  useEffect(() => {
    if (!resizeOpen) return
    const onDoc = (e) => { if (!resizeRef.current) return; if (!resizeRef.current.contains(e.target)) setResizeOpen(false) }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [resizeOpen])

  // Resize grid controls
  const adjustTile = useCallback((delta) => {
    setResizing(true)
    setTileMin(v => Math.max(60, Math.min(640, v + delta)))
  }, [])
  useEffect(() => {
    if (!resizing) return
    const t = setTimeout(() => setResizing(false), 250)
    return () => clearTimeout(t)
  }, [tileMin, resizing])

  // Compute grid columns & tile size
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const calc = () => {
      const style = getComputedStyle(el)
      const pl = parseFloat(style.paddingLeft) || 0
      const pr = parseFloat(style.paddingRight) || 0
      const width = el.clientWidth - pl - pr
      const gap = window.matchMedia('(min-width: 640px)').matches ? 6 : 4
      if (width <= 0) return
      const min = Math.max(60, tileMin)
      let cols = Math.max(1, Math.floor((width + gap) / (min + gap)))
      const inner = width - gap * (cols - 1)
      const size = Math.floor(inner / cols)
      setGridCols(cols)
      setTileSize(size)
    }
    const ro = new ResizeObserver(calc)
    ro.observe(el)
    window.addEventListener('resize', calc)
    calc()
    return () => { ro.disconnect(); window.removeEventListener('resize', calc) }
  }, [tileMin, sidebarWidth, isSmall])

  // SINGLE loader effect (first page + subsequent pages)
  useEffect(() => {
    const controller = new AbortController()
    controllerRef.current?.abort()
    controllerRef.current = controller

    const run = async () => {
      // New folder/query? reset paging & dedupe
      if (lastKeyRef.current !== requestKey) {
        lastKeyRef.current = requestKey
        photoIdsRef.current = new Set()
        setPhotos([])
        setPage(1)
        setHasMore(true)
        setError('')
        setInitialLoaded(false)
        setTotal(0)
      }

      if (inFlightRef.current) return
      if (!hasMore && page > 1) return

      inFlightRef.current = true
      setLoading(true)
      try {
        const r = await API.photos(
          { folder: selected, q: debouncedQ, page, pageSize: 200, _t: Date.now() },
          { signal: controller.signal }
        )
        setTotal(Number(r.total || 0))

        const incoming = r.items || []
        const filtered = []
        for (const it of incoming) {
          if (!photoIdsRef.current.has(it.id)) { photoIdsRef.current.add(it.id); filtered.push(it) }
        }

        setPhotos(prev => page === 1 ? filtered : [...prev, ...filtered])
        const nextLen = (page === 1 ? filtered.length : (photos.length + filtered.length))
        setHasMore(nextLen < Number(r.total || nextLen))
        if (incoming.length > 0) setInitialLoaded(true)
      } catch (e) {
        if (e?.name !== 'AbortError') {
          console.error('/api/photos failed', e)
          setError(e?.message || 'Failed to load photos')
        }
      } finally {
        inFlightRef.current = false
        setLoading(false)
      }
    }

    run()
    return () => { controller.abort(); inFlightRef.current = false; setLoading(false) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, requestKey, selected]) // avoid loops: no loading/hasMore in deps

  // Infinite scroll
  useEffect(() => {
    if (!initialLoaded) return
    const io = new IntersectionObserver((ents) => {
      if (ents.some(e => e.isIntersecting)) setPage(p => p + 1)
    }, { root: scrollRef.current || null, rootMargin: '400px', threshold: 0 })
    if (sentinelRef.current) io.observe(sentinelRef.current)
    return () => io.disconnect()
  }, [initialLoaded])

  // Sidebar expand/collapse
  const toggle = useCallback((p) => setOpen(s => { const n = new Set(s); n.has(p) ? n.delete(p) : n.add(p); return n }), [])
  const select = useCallback((p) => setSelected(p), [])
  const onResizePointerDown = useCallback((e) => {
    if (isSmall) return
    e.preventDefault()
    const startX = e.clientX
    const start = sidebarWidth
    document.body.style.cursor = 'col-resize'
    const onMove = (ev) => {
      const delta = ev.clientX - startX
      const next = Math.max(200, Math.min(560, start + delta))
      setSidebarWidth(next)
    }
    const onUp = () => {
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerup', onUp)
      document.body.style.cursor = ''
    }
    document.addEventListener('pointermove', onMove)
    document.addEventListener('pointerup', onUp)
  }, [sidebarWidth, isSmall])

  // Viewer helpers
  const openViewer = (idx) => { setViewer({ open: true, index: idx }); setInfoOpen(false) }
  const closeViewer = () => { setViewer({ open: false, index: 0 }); setInfoOpen(false) }
  const next = () => setViewer(v => ({ ...v, index: Math.min(v.index + 1, photos.length - 1) }))
  const prev = () => setViewer(v => ({ ...v, index: Math.max(v.index - 1, 0) }))

  // Ensure metadata when info opens or photo changes
  const ensureMeta = useCallback(async (id) => {
    if (!id) return null
    // cache hit
    if (metaCacheRef.current.has(id)) {
      const m = metaCacheRef.current.get(id)
      setMeta(m)
      return m
    }
    try {
      const m = await API.meta(id)
      metaCacheRef.current.set(id, m)
      setMeta(m)
      return m
    } catch (e) {
      console.error('meta fetch failed', e)
      setMeta(null)
      return null
    }
  }, [])

  useEffect(() => {
    if (!viewer.open) return
    const cur = photos[viewer.index]
    if (!cur) return
    if (infoOpen) { ensureMeta(cur.id) }
  }, [viewer.open, viewer.index, infoOpen, photos, ensureMeta])

  // Keyboard nav
  useEffect(() => {
    const onKey = (e) => {
      if (!viewer.open) return
      if (e.key === 'Escape') closeViewer()
      if (e.key === 'ArrowRight') next()
      if (e.key === 'ArrowLeft') prev()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [viewer.open, photos.length])

  // Download
  const downloadActive = useCallback(async () => {
    const current = photos[viewer.index]
    if (!current) return
    try {
      const res = await fetch(`${BASE}/media/${current.id}`)
      if (!res.ok) throw new Error(`Download failed: ${res.status}`)
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = current.fname
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    } catch (e) {
      console.error('download failed', e)
    }
  }, [photos, viewer.index])

  // Swipe (touch) for navigation
  const touchStartRef = useRef({ x: 0, y: 0, t: 0 })
  const onTouchStart = (e) => {
    const t = e.touches[0]
    touchStartRef.current = { x: t.clientX, y: t.clientY, t: Date.now() }
  }
  const onTouchMove = (e) => {
    // if mostly horizontal, prevent scrolling to feel snappy
    const t = e.touches[0]
    const dx = t.clientX - touchStartRef.current.x
    const dy = t.clientY - touchStartRef.current.y
    if (Math.abs(dx) > Math.abs(dy)) e.preventDefault()
  }
  const onTouchEnd = () => {
    const { x, y, t } = touchStartRef.current
    const dt = Date.now() - t
    // find last touch point from changedTouches? Not necessary; use the last stored deltas via touchStart+move
    // We'll rely on a small threshold; since we prevented scroll on horizontal move, gesture is clean.
    // To decide direction, we can read from a temp variable; instead compute from last known event via closure—keep it simple:
    // we can't access last move deltas here, so read from element? Simpler: re-use start vs. end via PointerEvents would be better,
    // but we'll approximate via touchend's changedTouches[0].
    try {
      const endTouch = (event) => event.changedTouches && event.changedTouches[0]
      // This function exists only to clarify—but we don't have the event here.
    } catch {}
  }
  // We'll implement using onTouchStart and onTouchEnd with event param:
  const onTouchEndWithEvt = (e) => {
    const start = touchStartRef.current
    const end = e.changedTouches[0]
    const dx = end.clientX - start.x
    const dy = end.clientY - start.y
    const adx = Math.abs(dx)
    const ady = Math.abs(dy)
    const dt = Date.now() - start.t
    const THRESH = 50 // px
    const MAX_ANGLE = 0.57 // ~33 degrees: ady/adx < tan(33°) ≈ 0.65 -> use stricter (0.57)
    if (adx > THRESH && (ady / (adx || 1)) < MAX_ANGLE && dt < 800) {
      if (dx < 0) next(); else prev()
    }
  }

  const truncatedName = (viewer.open && photos[viewer.index]) ? ellipsizeWords(photos[viewer.index].fname || '', 8) : ''
  const currentPhoto = viewer.open ? photos[viewer.index] : null

  // Compute image max-height (avoid overlap with header and optional bottom sheet on mobile)
  const imgMaxHeight = isSmall && infoOpen
    ? `calc(100vh - ${HEADER_H}px - ${MOBILE_INFO_VH}vh - 24px)`
    : `calc(100vh - ${HEADER_H}px - 24px)`

  return (
    <GlassShell>
      <div className="h-full min-h-0 grid" style={{ gridTemplateColumns: isSmall ? '1fr' : `${Math.round(sidebarWidth)}px 1fr` }}>
        {/* Sidebar (desktop) */}
        <aside className="hidden sm:block relative border-r border-white/10 bg-slate-900">
          <div className="flex items-center gap-2 p-3 border-b border-white/10">
            <ImageIcon className="w-5 h-5 text-slate-200" />
            <div className="text-sm font-semibold text-slate-100">Liquid Photos</div>
            <button
              className="ml-auto inline-flex items-center gap-2 text-xs px-2 py-1 rounded-lg bg-white/10 hover:bg-white/15 border border-white/10"
              onClick={() => API.rescan().then(() => API.tree().then(setTree))}
              title="Rescan Library"
            >
              <RefreshCcw className="w-4 h-4" /> Rescan
            </button>
          </div>
          <SidebarTree tree={tree} open={open} toggle={toggle} select={select} selected={selected} />
          {/* Resize handle */}
          <div
            className="absolute top-0 right-0 h-full w-1 cursor-col-resize hover:bg-white/10"
            onPointerDown={(e) => {
              if (isSmall) return
              e.preventDefault()
              const startX = e.clientX
              const start = sidebarWidth
              document.body.style.cursor = 'col-resize'
              const onMove = (ev) => {
                const delta = ev.clientX - startX
                const next = Math.max(200, Math.min(560, start + delta))
                setSidebarWidth(next)
              }
              const onUp = () => {
                document.removeEventListener('pointermove', onMove)
                document.removeEventListener('pointerup', onUp)
                document.body.style.cursor = ''
              }
              document.addEventListener('pointermove', onMove)
              document.addEventListener('pointerup', onUp)
            }}
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize sidebar"
          />
        </aside>

        {/* Main */}
        <main className="flex flex-col min-h-0">
          <header className="relative z-20 p-3 border-b border-white/10 bg-slate-900">
            <div className="flex items-center gap-3">
              <button
                className="sm:hidden inline-flex items-center justify-center p-2 rounded bg-white/10 border border-white/10"
                onClick={() => setSidebarOpen(true)}
                aria-label="Open sidebar"
              >
                <Menu className="w-5 h-5 text-slate-200" />
              </button>
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
                <input
                  value={query}
                  onChange={e => setQuery(e.target.value)}
                  placeholder="Search file names, e.g. ‘beach sunset 2022’"
                  className="w-full pl-10 pr-3 py-2 rounded bg-white/10 border border-white/10 text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-white/20"
                />
              </div>
              <div ref={resizeRef} className="relative">
                <button
                  className="inline-flex items-center gap-2 px-2 py-1 rounded bg-white/10 border border-white/10 hover:bg-white/15"
                  onClick={() => setResizeOpen(v => !v)}
                  title="Resize grid"
                  aria-haspopup="menu"
                  aria-expanded={resizeOpen}
                >
                  <Maximize2 className="w-4 h-4" />
                </button>
                {resizeOpen && (
                  <div className="absolute right-0 top-full mt-2 z-30 w-40 rounded border border-white/10 bg-slate-900 shadow-xl p-2">
                    <div className="text-xs text-slate-300 mb-2">Resize grid</div>
                    <div className="flex items-center gap-2">
                      <button
                        className="flex-1 inline-flex items-center justify-center gap-1 px-2 py-1 rounded bg-white/10 border border-white/10 hover:bg-white/15"
                        onClick={() => setTileMin(v => Math.min(640, v + 20))}
                        title="Larger"
                      >
                        <Plus className="w-4 h-4" />
                      </button>
                      <button
                        className="flex-1 inline-flex items-center justify-center gap-1 px-2 py-1 rounded bg-white/10 border border-white/10 hover:bg-white/15"
                        onClick={() => setTileMin(v => Math.max(60, v - 20))}
                        title="Smaller"
                      >
                        <Minus className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                )}
              </div>
              <div className="text-xs text-slate-300 shrink-0 px-2 py-1 rounded bg-white/5 border border-white/10">
                {total.toLocaleString()} photos
              </div>
            </div>
          </header>

          <section ref={scrollRef} className="relative flex-1 overflow-auto p-3">
            {resizing && (
              <div className="absolute inset-0 z-10 bg-black/30 flex items-center justify-center">
                <div className="h-10 w-10 rounded-full border-2 border-white/30 border-t-white animate-spin" />
              </div>
            )}
            {error && (
              <div className="mb-3 text-sm text-rose-300 bg-rose-950/40 border border-rose-500/30 rounded-lg px-3 py-2">
                {error}
              </div>
            )}

            {/* Grid */}
            <div className="grid gap-1 sm:gap-1.5" style={{ gridTemplateColumns: `repeat(${gridCols}, ${tileSize}px)` }}>
              {photos.map((p, i) => (
                <button
                  key={p.id}
                  className="group relative aspect-[4/3] overflow-hidden bg-white/5 border border-white/10 hover:scale-[1.01] transition"
                  onClick={() => openViewer(i)}
                >
                  <img
                    src={`${BASE}/thumb/${p.id}`}
                    alt={p.fname}
                    loading="lazy"
                    className="h-full w-full object-cover"
                  />
                  <div className="absolute inset-0 bg-black/0 group-hover:bg-black/10 transition" />
                </button>
              ))}
            </div>

            <div ref={sentinelRef} className="h-20" />
            {loading && <div className="text-center text-slate-400 py-4">Loading…</div>}
          </section>
        </main>
      </div>

      {/* Mobile sidebar drawer */}
      {sidebarOpen && (
        <div className="fixed inset-0 z-50 sm:hidden">
          <button className="absolute inset-0 bg-black/60" onClick={() => setSidebarOpen(false)} aria-label="Close sidebar overlay" />
          <aside className="absolute inset-y-0 left-0 w-[82vw] max-w-[320px] bg-slate-900 border-r border-white/10 shadow-xl">
            <div className="h-full overflow-auto p-2 pr-1">
              <SidebarTree
                tree={tree}
                open={open}
                toggle={toggle}
                select={(p) => { setSelected(p); setSidebarOpen(false) }}
                selected={selected}
              />
            </div>
          </aside>
        </div>
      )}

      {/* Fullscreen Viewer */}
      {viewer.open && currentPhoto && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex">
          {/* Desktop: image area + optional right sidebar. Mobile: bottom sheet replaces sidebar. */}
          <div className="flex-1 flex flex-col">
            {/* Viewer Header (no overlap with image) */}
            <div
              className="flex items-center gap-3 px-4"
              style={{ height: HEADER_H }}
            >
              {/* Mobile left-aligned truncating title; desktop can naturally truncate too */}
              <div className="flex-1 min-w-0">
                <div className="text-sm text-white sm:text-center sm:mx-auto sm:max-w-[60vw] truncate">
                  {truncatedName}
                </div>
              </div>

              {/* Controls */}
              <div className="flex items-center gap-2">
                <button
                  className="p-2 rounded-full bg-white/10 border border-white/10 hover:bg-white/20"
                  onClick={async () => { setInfoOpen(v => !v); if (!infoOpen) await ensureMeta(currentPhoto.id) }}
                  title="Info"
                >
                  <Info className="w-6 h-6 text-white" />
                </button>
                <button
                  className="p-2 rounded-full bg-white/10 border border-white/10 hover:bg-white/20"
                  onClick={downloadActive}
                  title="Download"
                >
                  <Download className="w-6 h-6 text-white" />
                </button>
                <button
                  className="p-2 rounded-full bg-white/10 border border-white/10 hover:bg-white/20"
                  onClick={closeViewer}
                  title="Close"
                >
                  <X className="w-6 h-6 text-white" />
                </button>
              </div>
            </div>

            {/* Image/body area */}
            <div className="relative flex-1 flex items-center justify-center px-3 pb-3">
              {/* Nav buttons */}
              <button className="absolute left-4 top-1/2 -translate-y-1/2 p-3 rounded-full bg-white/10 border border-white/10 hover:bg-white/20" onClick={prev}>◀</button>

              {/* Image with swipe handlers */}
              <img
                src={`${BASE}/media/${currentPhoto.id}`}
                alt={currentPhoto.fname}
                className="rounded-xl shadow-2xl border border-white/10"
                style={{ maxHeight: imgMaxHeight, maxWidth: isSmall && infoOpen ? '94vw' : '92vw' }}
                onTouchStart={onTouchStart}
                onTouchMove={onTouchMove}
                onTouchEnd={onTouchEndWithEvt}
              />

              <button className="absolute right-4 top-1/2 -translate-y-1/2 p-3 rounded-full bg-white/10 border border-white/10 hover:bg-white/20" onClick={next}>▶</button>
            </div>
          </div>

          {/* Desktop right info panel */}
          {!isSmall && infoOpen && (
            <aside className="w-[340px] max-w-[80vw] border-l border-white/10 bg-slate-900/95 backdrop-blur px-4 py-4 overflow-auto">
              <div className="text-sm text-slate-200 font-semibold break-words">{meta?.fname || currentPhoto.fname}</div>
              <div className="mt-1 text-xs text-slate-400 break-all">{meta?.folder}</div>
              <div className="mt-2 text-xs text-slate-300">
                <div>Size: <span className="text-slate-100">{formatBytes(meta?.size ?? currentPhoto.size)}</span></div>
                {meta?.width && meta?.height && (
                  <div>Dimensions: <span className="text-slate-100">{meta.width} × {meta.height}</span></div>
                )}
                {meta?.format && (
                  <div>Format: <span className="text-slate-100 uppercase">{meta.format}</span></div>
                )}
              </div>

              <div className="mt-4">
                <div className="text-xs font-semibold text-slate-300 mb-2">EXIF</div>
                {meta?.exif ? (
                  <div className="space-y-1 text-xs text-slate-300">
                    {meta.exif.DateTimeOriginal && <div>Date Taken: <span className="text-slate-100">{meta.exif.DateTimeOriginal}</span></div>}
                    {(meta.exif.Make || meta.exif.Model) && <div>Camera: <span className="text-slate-100">{[meta.exif.Make, meta.exif.Model].filter(Boolean).join(' ')}</span></div>}
                    {meta.exif.LensModel && <div>Lens: <span className="text-slate-100">{meta.exif.LensModel}</span></div>}
                    {meta.exif.FNumber && <div>Aperture: <span className="text-slate-100">f/{meta.exif.FNumber}</span></div>}
                    {meta.exif.ExposureTime && <div>Shutter: <span className="text-slate-100">{meta.exif.ExposureTime}s</span></div>}
                    {meta.exif.ISO && <div>ISO: <span className="text-slate-100">{meta.exif.ISO}</span></div>}
                    {meta.exif.FocalLength && <div>Focal: <span className="text-slate-100">{meta.exif.FocalLength}mm</span></div>}
                    {(meta.exif.GPSLatitude != null && meta.exif.GPSLongitude != null) && (
                      <div>GPS: <span className="text-slate-100">{meta.exif.GPSLatitude}, {meta.exif.GPSLongitude}</span></div>
                    )}
                  </div>
                ) : (
                  <div className="text-xs text-slate-400">No EXIF available.</div>
                )}
              </div>
            </aside>
          )}

          {/* Mobile bottom sheet info panel */}
          {isSmall && infoOpen && (
            <aside
              className="fixed bottom-0 left-0 right-0 z-[60] border-t border-white/10 bg-slate-900/95 backdrop-blur px-4 py-3 overflow-auto"
              style={{ height: `${MOBILE_INFO_VH}vh` }}
            >
              <div className="text-sm text-slate-200 font-semibold break-words">{meta?.fname || currentPhoto.fname}</div>
              <div className="mt-1 text-xs text-slate-400 break-all">{meta?.folder}</div>
              <div className="mt-2 text-xs text-slate-300">
                <div>Size: <span className="text-slate-100">{formatBytes(meta?.size ?? currentPhoto.size)}</span></div>
                {meta?.width && meta?.height && (
                  <div>Dimensions: <span className="text-slate-100">{meta.width} × {meta.height}</span></div>
                )}
                {meta?.format && (
                  <div>Format: <span className="text-slate-100 uppercase">{meta.format}</span></div>
                )}
              </div>

              <div className="mt-3">
                <div className="text-xs font-semibold text-slate-300 mb-2">EXIF</div>
                {meta?.exif ? (
                  <div className="space-y-1 text-xs text-slate-300">
                    {meta.exif.DateTimeOriginal && <div>Date Taken: <span className="text-slate-100">{meta.exif.DateTimeOriginal}</span></div>}
                    {(meta.exif.Make || meta.exif.Model) && <div>Camera: <span className="text-slate-100">{[meta.exif.Make, meta.exif.Model].filter(Boolean).join(' ')}</span></div>}
                    {meta.exif.LensModel && <div>Lens: <span className="text-slate-100">{meta.exif.LensModel}</span></div>}
                    {meta.exif.FNumber && <div>Aperture: <span className="text-slate-100">f/{meta.exif.FNumber}</span></div>}
                    {meta.exif.ExposureTime && <div>Shutter: <span className="text-slate-100">{meta.exif.ExposureTime}s</span></div>}
                    {meta.exif.ISO && <div>ISO: <span className="text-slate-100">{meta.exif.ISO}</span></div>}
                    {meta.exif.FocalLength && <div>Focal: <span className="text-slate-100">{meta.exif.FocalLength}mm</span></div>}
                    {(meta.exif.GPSLatitude != null && meta.exif.GPSLongitude != null) && (
                      <div>GPS: <span className="text-slate-100">{meta.exif.GPSLatitude}, {meta.exif.GPSLongitude}</span></div>
                    )}
                  </div>
                ) : (
                  <div className="text-xs text-slate-400">No EXIF available.</div>
                )}
              </div>
            </aside>
          )}
        </div>
      )}

      {/* Mobile sidebar drawer */}
      {sidebarOpen && (
        <div className="fixed inset-0 z-50 sm:hidden">
          <button className="absolute inset-0 bg-black/60" onClick={() => setSidebarOpen(false)} aria-label="Close sidebar overlay" />
          <aside className="absolute inset-y-0 left-0 w-[82vw] max-w-[320px] bg-slate-900 border-r border-white/10 shadow-xl">
            <div className="h-full overflow-auto p-2 pr-1">
              <SidebarTree
                tree={tree}
                open={open}
                toggle={toggle}
                select={(p) => { setSelected(p); setSidebarOpen(false) }}
                selected={selected}
              />
            </div>
          </aside>
        </div>
      )}
    </GlassShell>
  )
}
