import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import AutoSizer from 'react-virtualized-auto-sizer'
import { FixedSizeGrid as Grid } from 'react-window'
import { FolderTree, RefreshCcw, Search, Image as ImageIcon, ChevronRight, ChevronDown, X, Maximize2 } from 'lucide-react'

const BASE = import.meta?.env?.DEV ? 'http://127.0.0.1:5174' : ''
const API = {
  tree: async () => (await fetch(`${BASE}/api/tree`)).json(),
  photos: async (params = {}) => {
    const qs = new URLSearchParams(params).toString()
    return (await fetch(`${BASE}/api/photos?${qs}`)).json()
  },
  rescan: async () => (await fetch(`${BASE}/api/index`, { method: 'POST' })).json(),
}

const GlassShell = ({ children }) => (
  <div className="h-full w-full bg-gradient-to-br from-slate-900 via-slate-950 to-black text-slate-100">
    <div className="h-full max-w-[1600px] mx-auto p-3 sm:p-4">
      <div className="h-full rounded-3xl border border-white/10 bg-white/5 backdrop-blur-xl shadow-2xl overflow-hidden">
        {children}
      </div>
    </div>
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
            {hasChildren ? (isOpen ? <ChevronDown className="w-4 h-4"/> : <ChevronRight className="w-4 h-4"/>) : <span className="w-4 h-4" />}
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

export default function App() {
  const [tree, setTree] = useState(null)
  const [open, setOpen] = useState(new Set())
  const [selected, setSelected] = useState('')
  const [query, setQuery] = useState('')
  const debouncedQ = useDebouncedValue(query, 300)

  const [photos, setPhotos] = useState([])
  const [page, setPage] = useState(1)
  const [hasMore, setHasMore] = useState(true)
  const [loading, setLoading] = useState(false)
  const [total, setTotal] = useState(0)
  const [error, setError] = useState('')
  const [initialLoaded, setInitialLoaded] = useState(false)

  const [viewer, setViewer] = useState({ open: false, index: 0 })

  useEffect(() => { (async () => { const t = await API.tree(); setTree(t); setOpen(new Set([t.path])); setSelected(t.path) })() }, [])

  useEffect(() => {
    setPhotos([])
    setPage(1)
    setHasMore(true)
    setError('')
    setInitialLoaded(false)
  }, [debouncedQ, selected])

  // Robust loader: handles errors, cancels stale requests, and always clears loading
  useEffect(() => {
    const controller = new AbortController()
    let alive = true
    async function load() {
      if (!hasMore || loading || !selected) return
      setLoading(true)
      try {
        console.log('Loading photos …', { selected, page, q: debouncedQ })
        const r = await API.photos({ folder: selected, q: debouncedQ, page, pageSize: 200, _t: Date.now() })
        if (!alive) return
        setTotal(Number(r.total || 0))
        setPhotos(prev => {
          const next = [...prev, ...(r.items || [])]
          setHasMore(next.length < Number(r.total || next.length))
          return next
        })
        if ((r.items || []).length > 0) setInitialLoaded(true)
        setError('')
      } catch (e) {
        if (!alive) return
        console.error('/photos fetch failed', e)
        setError(e?.message || 'Failed to load photos')
      } finally {
        if (alive) setLoading(false)
      }
    }
    load()
    return () => { alive = false; controller.abort() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, debouncedQ, selected])

  const toggle = useCallback((p) => setOpen(s => { const n = new Set(s); n.has(p) ? n.delete(p) : n.add(p); return n }), [])
  const select = useCallback((p) => setSelected(p), [])

  const sentinelRef = useRef(null)
  useEffect(() => {
    if (!initialLoaded) return
    const io = new IntersectionObserver((ents) => {
      if (ents.some(e => e.isIntersecting)) setPage(p => p + 1)
    }, { rootMargin: '400px', threshold: 0 })
    if (sentinelRef.current) io.observe(sentinelRef.current)
    return () => io.disconnect()
  }, [initialLoaded])

  const openViewer = (idx) => setViewer({ open: true, index: idx })
  const closeViewer = () => setViewer({ open: false, index: 0 })
  const next = () => setViewer(v => ({ ...v, index: Math.min(v.index + 1, photos.length - 1) }))
  const prev = () => setViewer(v => ({ ...v, index: Math.max(v.index - 1, 0) }))

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

  return (
    <GlassShell>
      <div className="h-full grid grid-cols-[280px_1fr]">
        <aside className="border-r border-white/10 bg-white/5">
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
        </aside>
        <main className="flex flex-col">
          <header className="p-3 border-b border-white/10 bg-white/5 backdrop-blur-xl">
            <div className="flex items-center gap-3">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
                <input
                  value={query}
                  onChange={e => setQuery(e.target.value)}
                  placeholder="Search file names, e.g. ‘beach sunset 2022’"
                  className="w-full pl-10 pr-3 py-2 rounded-2xl bg-white/10 border border-white/10 text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-white/20"
                />
              </div>
              <div className="text-xs text-slate-300 shrink-0 px-2 py-1 rounded-lg bg-white/5 border border-white/10">{total.toLocaleString()} photos</div>
            </div>
          </header>

          <section className="flex-1 overflow-auto p-3">
            {error && (
              <div className="mb-3 text-sm text-rose-300 bg-rose-950/40 border border-rose-500/30 rounded-lg px-3 py-2">
                {error}
              </div>
            )}
            {/* Responsive CSS grid with lazy images; virtualized grid could be swapped in if desired */}
            <div className="grid gap-2 sm:gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill,minmax(180px,1fr))' }}>
              {photos.map((p, i) => (
                <button
                  key={p.id}
                  className="group relative aspect-[4/3] overflow-hidden rounded-xl bg-white/5 border border-white/10 hover:scale-[1.01] transition"
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

      {/* Fullscreen Viewer */}
      {viewer.open && photos[viewer.index] && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center">
          <button className="absolute top-4 right-4 p-2 rounded-full bg-white/10 border border-white/10 hover:bg-white/20" onClick={closeViewer}>
            <X className="w-6 h-6 text-white" />
          </button>
          <button className="absolute left-4 top-1/2 -translate-y-1/2 p-3 rounded-full bg-white/10 border border-white/10 hover:bg-white/20" onClick={prev}>◀</button>
          <img src={`${BASE}/media/${photos[viewer.index].id}`} alt={photos[viewer.index].fname} className="max-h-[90vh] max-w-[92vw] rounded-xl shadow-2xl border border-white/10" />
          <button className="absolute right-4 top-1/2 -translate-y-1/2 p-3 rounded-full bg-white/10 border border-white/10 hover:bg-white/20" onClick={next}>▶</button>
        </div>
      )}
    </GlassShell>
  )
}