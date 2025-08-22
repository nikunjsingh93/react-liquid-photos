import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import Hls from 'hls.js'
import {
  FolderTree, RefreshCcw, Image as ImageIcon, ChevronRight, ChevronDown, X,
  Maximize2, Download, Menu, Plus, Minus, Info, CheckSquare, LogOut, Shield, Trash2, Play, Monitor, Share, Heart
} from 'lucide-react'

/* Same-origin base (Vite proxy handles /api, /thumb, /view, /media, /download) */
const API_BASE = window.location.origin
const apiUrl = (path) => `${API_BASE}${path.startsWith('/') ? path : `/${path}`}`

// Removed LAST_VIEWER_URL as it's no longer needed with simplified image loading

/* ----- API ----- */
const API = {
  /* auth */
  me: async () => (await fetch(apiUrl('/api/auth/me'), { credentials: 'include' })).json(),
  login: async (username, password) =>
    (await fetch(apiUrl('/api/auth/login'), {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    })).json(),
  logout: async () =>
    (await fetch(apiUrl('/api/auth/logout'), { method: 'POST', credentials: 'include' })).json(),

  /* admin */
  adminUsers: async () => (await fetch(apiUrl('/api/admin/users'), { credentials: 'include' })).json(),
  adminCreateUser: async (payload) =>
    (await fetch(apiUrl('/api/admin/users'), {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })).json(),
  adminDeleteUser: async (id) =>
    (await fetch(apiUrl(`/api/admin/users/${id}`), {
      method: 'DELETE',
      credentials: 'include'
    })).json(),

  /* photos */
  tree: async (mode = 'folders', filter = 'all') => (await fetch(apiUrl(`/api/tree?mode=${encodeURIComponent(mode)}&filter=${encodeURIComponent(filter)}`), { credentials: 'include' })).json(),
  photos: async (params = {}, options = {}) => {
    const qs = new URLSearchParams(params).toString()
    const r = await fetch(apiUrl(`/api/photos?${qs}`), { credentials: 'include', ...options })
    return await r.json()
  },
  meta: async (id, options = {}) =>
    (await fetch(apiUrl(`/api/meta/${id}`), { credentials: 'include', ...options })).json(),
  rescan: async () =>
    (await fetch(apiUrl('/api/index'), { method: 'POST', credentials: 'include' })).json(),
  rescanPath: async (path) =>
    (await fetch(apiUrl('/api/index'), { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path }) })).json(),
  cancelScan: async () =>
    (await fetch(apiUrl('/api/index/cancel'), { method: 'POST', credentials: 'include' })).json(),
  scanStatus: async () =>
    (await fetch(apiUrl('/api/index/status'), { credentials: 'include' })).json(),
  /* shares (auth) */
  sharesList: async (all = false) => (await fetch(apiUrl(`/api/shares${all ? '?all=1' : ''}`), { credentials: 'include' })).json(),
  shareCreate: async (folder, name, ids = []) => (await fetch(apiUrl('/api/shares'), {
    method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ folder, name, ids })
  })).json(),
  shareDelete: async (id) => (await fetch(apiUrl(`/api/shares/${id}`), { method: 'DELETE', credentials: 'include' })).json(),
  /* public shares */
  shareInfo: async (token) => (await fetch(apiUrl(`/s/${token}/info`))).json(),
  sharePhotos: async (token, params = {}) => {
    const qs = new URLSearchParams(params).toString()
    const r = await fetch(apiUrl(`/s/${token}/photos?${qs}`))
    return await r.json()
  },
}

/* ----- UI helpers ----- */
const GlassShell = ({ children }) => (
  <div className="h-full w-full bg-zinc-950 text-slate-100">
    <div className="h-full">{children}</div>
  </div>
)

// RAW helpers (match server RAW_EXT)
const RAW_EXTS = new Set(['.dng', '.arw', '.cr2', '.raf', '.nef', '.rw2'])
function isRawName(name) {
  if (!name) return false
  const i = String(name).lastIndexOf('.')
  if (i === -1) return false
  const ext = String(name).slice(i).toLowerCase()
  return RAW_EXTS.has(ext)
}

/* Scrollable tree ONLY (header label + tree) */
function SidebarTreeContent({ tree, open, toggle, select, selected, mode = 'folders', onToggleMode, showHeader = true, loading = false }) {
  if (!tree && !loading) return null
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-2 pr-1" style={{ WebkitOverflowScrolling: 'touch' }}>
      {showHeader && (
        <div className="flex items-center gap-2 text-slate-300 mb-2 px-2 shrink-0">
          <FolderTree className="w-5 h-5" />
          <span className="text-sm font-medium">{mode === 'dates' ? 'Dates' : 'Folders'}</span>
          <div className="ml-auto flex items-center gap-1">
            <button
              className={`text-xs px-2 py-0.5 rounded-full ${mode === 'folders' ? 'bg-white/20' : 'bg-white/10'} border border-white/10 hover:bg-white/20`}
              onClick={() => onToggleMode && onToggleMode('folders')}
              title="Browse by folders"
              disabled={loading}
            >Folders</button>
            <button
              className={`text-xs px-2 py-0.5 rounded-full ${mode === 'dates' ? 'bg-white/20' : 'bg-white/10'} border border-white/10 hover:bg-white/20`}
              onClick={() => onToggleMode && onToggleMode('dates')}
              title="Browse by dates"
              disabled={loading}
            >Dates</button>
          </div>
        </div>
      )}
      <div className="overflow-y-auto" style={{ height: showHeader ? 'calc(100% - 40px)' : '100%' }}>
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <div className="flex items-center gap-2 text-slate-400">
              <div className="w-4 h-4 border-2 border-slate-400 border-t-transparent rounded-full animate-spin"></div>
              <span className="text-sm">Loading tree...</span>
            </div>
          </div>
        ) : (
          <TreeNode node={tree} depth={0} open={open} toggle={toggle} select={select} selected={selected} />
        )}
      </div>
    </div>
  )
}

/* Pinned footer */
function SidebarFooter({ onSignOut, user, onGoAdmin }) {
  return (
    <div className="shrink-0 border-t border-white/10 p-2 flex items-center gap-2 bg-zinc-950">
      {user?.is_admin && (
        <button
          className="inline-flex items-center gap-2 px-2 py-1 rounded-full bg-white/10 border border-white/10 hover:bg-white/20"
          onClick={onGoAdmin}
          title="Admin panel"
        >
          <Shield className="w-4 h-4" /> Admin
        </button>
      )}
      <button
        className="ml-auto inline-flex items-center gap-2 px-2 py-1 rounded-full bg-white/10 border border-white/10 hover:bg-white/20"
        onClick={onSignOut}
        title="Sign out"
      >
        <LogOut className="w-4 h-4" /> Sign out
      </button>
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

/* helpers */
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
function parseZipFilenameFromCD(cd) {
  if (!cd) return null
  let m = /filename\*=UTF-8''([^;]+)/i.exec(cd)
  if (m) return decodeURIComponent(m[1])
  m = /filename="?([^"]+)"?/i.exec(cd)
  return m ? m[1] : null
}
function formatDuration(ms) {
  const total = Math.max(0, Math.round(Number(ms || 0) / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}.${String(s).padStart(2, '0')}`
}
function formatDayHeader(mtime) {
  if (!mtime && mtime !== 0) return ''
  const d = new Date(Number(mtime))
  try {
    return d.toLocaleDateString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      timeZone: 'UTC'
    })
  } catch {
    // Fallback if locale formatting fails
    return d.toDateString()
  }
}

function formatExifDate(dateString) {
  if (!dateString) return ''
  
  try {
    // Handle different EXIF date formats
    let date
    
    // Format: "YYYY:MM:DD HH:MM:SS" (most common EXIF format)
    if (dateString.includes(':') && dateString.includes(' ') && !dateString.includes('T')) {
      const [datePart, timePart] = dateString.split(' ')
      if (datePart && datePart.includes(':')) {
        const [year, month, day] = datePart.split(':').map(Number)
        if (year && month && day) {
          date = new Date(year, month - 1, day)
        }
      }
    }
    // Format: ISO string (2025-08-19T16:22:06.000Z) - most common now
    else if (dateString.includes('T') || dateString.includes('Z')) {
      date = new Date(dateString)
    }
    // Format: "YYYY-MM-DD" or "YYYY-MM-DD HH:MM:SS"
    else if (dateString.includes('-')) {
      date = new Date(dateString)
    }
    // Other standard formats
    else {
      date = new Date(dateString)
    }
    
    // Check if the date is valid
    if (!date || isNaN(date.getTime())) {
      // For debugging in development
      if (process.env.NODE_ENV === 'development') {
        console.log('Failed to parse EXIF date:', dateString)
      }
      return dateString // Return original if invalid
    }
    
    // Format as "6 August, 2025"
    return date.toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'long',
      year: 'numeric'
    })
  } catch (error) {
    // For debugging in development
    if (process.env.NODE_ENV === 'development') {
      console.log('Error parsing EXIF date:', dateString, error)
    }
    // Fallback to original string if parsing fails
    return dateString
  }
}
const HEADER_H = 56
const MOBILE_INFO_VH = 40

/* ----- Thumbnail Component ----- */
function Thumbnail({ id, fname, loadedThumbnails, setLoadedThumbnails, shareToken = '' }) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  
  const handleLoad = () => {
    setLoading(false)
    setLoadedThumbnails(prev => new Set(prev).add(id))
  }
  
  const handleError = () => {
    setLoading(false)
    setError(true)
  }
  
  return (
    <div className="relative h-full w-full">
      {loading && (
        <div className="absolute inset-0 bg-zinc-800 animate-pulse flex items-center justify-center">
          <div className="w-6 h-6 border-2 border-slate-400 border-t-transparent rounded-full animate-spin"></div>
        </div>
      )}
      {error && (
        <div className="absolute inset-0 bg-zinc-800 flex items-center justify-center">
          <div className="text-slate-400 text-xs">Failed to load</div>
        </div>
      )}
      <img
        src={shareToken ? apiUrl(`/s/${shareToken}/thumb/${id}`) : apiUrl(`/thumb/${id}`)}
        alt={fname}
        loading="lazy"
        className={`h-full w-full object-cover transition-opacity duration-200 ${loading ? 'opacity-0' : 'opacity-100'}`}
        onLoad={handleLoad}
        onError={handleError}
      />
      {/* Overlay click blocker for viewer buttons placed above */}
      <div className="pointer-events-none absolute inset-0" />
    </div>
  )
}

/* ----- App ----- */
export default function App() {
  // media first (used to set initial sidebar state)
  const isSmall = useMediaQuery('(max-width: 780px)')
  const isVerySmall = useMediaQuery('(max-width: 640px)') // For optimized button visibility

  // auth
  const [user, setUser] = useState(null)
  const [authChecked, setAuthChecked] = useState(false)

  // app view
  const [view, setView] = useState('photos')
  // share mode detection
  const initialShareToken = useMemo(() => {
    try {
      const url = new URL(window.location.href)
      const q = url.searchParams.get('share')
      if (q) return q
      const parts = url.pathname.split('/').filter(Boolean)
      if (parts[0] === 's' && parts[1]) return parts[1]
    } catch {}
    return ''
  }, [])
  const [shareToken, setShareToken] = useState(initialShareToken)
  const isShareMode = !!shareToken
  const [shareInfo, setShareInfo] = useState(null)

  // Sidebar + layout
  // OPEN on desktop, COLLAPSED on mobile by default
  const [sidebarOpen, setSidebarOpen] = useState(() => {
    try { return !window.matchMedia('(max-width: 780px)').matches } catch { return true }
  })
  const [sidebarWidth, setSidebarWidth] = useState(280)

  // Folder/tree
  const [tree, setTree] = useState(null)
  const [open, setOpen] = useState(new Set())
  const [selected, setSelected] = useState('')
  const [treeMode, setTreeMode] = useState('folders')
  const [dateRange, setDateRange] = useState({ from: 0, to: 0 })
  const [treeLoading, setTreeLoading] = useState(false)

  // Photos & paging
  const [photos, setPhotos] = useState([])
  const [page, setPage] = useState(1)
  const [hasMore, setHasMore] = useState(true)
  const [loading, setLoading] = useState(false)
  const [total, setTotal] = useState(0)
  const [error, setError] = useState('')
  const [initialLoaded, setInitialLoaded] = useState(false)
  // filter for media type
  const [mediaFilter, setMediaFilter] = useState('all')

  // Favorites (server-backed per-user)
  const [favoriteIds, setFavoriteIds] = useState(new Set())
  const [favoriteItems, setFavoriteItems] = useState(new Map())
  const [showFavorites, setShowFavorites] = useState(false)

  // Load favorites on login
  useEffect(() => {
    (async () => {
      if (!user) { setFavoriteIds(new Set()); setFavoriteItems(new Map()); return }
      try {
        const r = await fetch(apiUrl('/api/favorites'), { credentials: 'include' }).then(res => res.json())
        const ids = Array.isArray(r?.items) ? r.items : []
        setFavoriteIds(new Set(ids))
        // Lazy-load favorite items page 1 for quick count/sorting
        const fp = await fetch(apiUrl('/api/favorites/photos?page=1&pageSize=200'), { credentials: 'include' }).then(res => res.json())
        const map = new Map()
        for (const it of (fp?.items || [])) { map.set(it.id, it) }
        setFavoriteItems(map)
      } catch {
        setFavoriteIds(new Set())
        setFavoriteItems(new Map())
      }
    })()
  }, [user])

  const isFavorite = useCallback((id) => favoriteIds.has(id), [favoriteIds])
  const toggleFavorite = useCallback(async (photo) => {
    if (!photo || !photo.id || !user) return
    const id = photo.id
    const adding = !favoriteIds.has(id)
    // optimistic update
    setFavoriteIds(prev => { const n = new Set(prev); if (adding) n.add(id); else n.delete(id); return n })
    setFavoriteItems(prev => { const n = new Map(prev); if (adding) n.set(id, photo); else n.delete(id); return n })
    try {
      const url = apiUrl(`/api/favorites/${id}`)
      const res = await fetch(url, { method: adding ? 'POST' : 'DELETE', credentials: 'include' })
      if (!res.ok) throw new Error('failed')
    } catch {
      // rollback
      setFavoriteIds(prev => { const n = new Set(prev); if (adding) n.delete(id); else n.add(id); return n })
      setFavoriteItems(prev => { const n = new Map(prev); if (adding) n.delete(id); else n.set(id, photo); return n })
    }
  }, [favoriteIds, user])

  const favoritesList = useMemo(() => {
    const arr = Array.from(favoriteItems.values())
    arr.sort((a, b) => Number(b.mtime || 0) - Number(a.mtime || 0))
    return arr
  }, [favoriteItems])

  const visiblePhotos = useMemo(() => showFavorites ? favoritesList : photos, [showFavorites, favoritesList, photos])

  // Viewer & meta
  const [viewer, setViewer] = useState({ open: false, index: 0 })
  const [infoOpen, setInfoOpen] = useState(false)
  const metaCacheRef = useRef(new Map())
  const [meta, setMeta] = useState(null)

  // Multi-select
  const [selectMode, setSelectMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState(new Set())

  // Grid sizing
  const scrollRef = useRef(null)
  const sentinelRef = useRef(null)
  const [tileMin, setTileMin] = useState(120)
  const [resizeOpen, setResizeOpen] = useState(false)
  const resizeRef = useRef(null)
  // Share menu/modal
  const [shareOpen, setShareOpen] = useState(false)
  const shareRef = useRef(null)
  const [shareModalOpen, setShareModalOpen] = useState(false)
  const [shares, setShares] = useState([])
  const [loadingShares, setLoadingShares] = useState(false)
  const [resizing, setResizing] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [scanMenuOpen, setScanMenuOpen] = useState(false)
  const [scanSelectedPath, setScanSelectedPath] = useState('')
  const [scanMenuAnchor, setScanMenuAnchor] = useState('') // 'sidebar' | 'header' | ''
  const [scanTree, setScanTree] = useState(null)
  const [scanJobToken, setScanJobToken] = useState(null)

  // Thumbnail loading states
  const [loadedThumbnails, setLoadedThumbnails] = useState(new Set())

  // Inline toast
  const [toast, setToast] = useState({ message: '', visible: false })
  const showToast = useCallback((message) => {
    setToast({ message, visible: true })
    window.clearTimeout(showToast._t)
    showToast._t = window.setTimeout(() => setToast({ message: '', visible: false }), 1800)
  }, [])

  const loadScanTree = useCallback(async () => {
    try {
      const t = await API.tree('folders', mediaFilter)
      setScanTree(t)
    } catch {}
  }, [mediaFilter])

  // loader control
  const photoIdsRef = useRef(new Set())
  const requestKey = useMemo(() => isShareMode
    ? `share::${shareToken}::${dateRange.from}-${dateRange.to}::${mediaFilter}`
    : `${user?.id || 0}::${selected}::${treeMode}::${dateRange.from}-${dateRange.to}::${mediaFilter}`
  ,[isShareMode, shareToken, user?.id, selected, treeMode, dateRange.from, dateRange.to, mediaFilter])
  const lastKeyRef = useRef(null)
  const controllerRef = useRef(null)
  const inFlightRef = useRef(false)

  // session check
  useEffect(() => {
    (async () => {
      if (isShareMode) {
        setAuthChecked(true)
        try {
          const info = await API.shareInfo(shareToken)
          if (info?.token) setShareInfo(info)
        } catch {}
        return
      }
      try {
        const r = await API.me()
        if (r?.user?.id) {
          setUser(r.user)
          const t = await API.tree('folders', mediaFilter)
          setTree(t)
          setOpen(new Set([t.path]))
          setSelected(t.path)
          // keep sidebar default state (don't force-open on mobile)
        } else {
          setUser(null)
        }
      } catch {
        setUser(null)
      } finally {
        setAuthChecked(true)
      }
    })()
  }, [])

  // Poll scan status when we have a job token
  useEffect(() => {
    if (!scanJobToken || !user?.is_admin) return
    
    const interval = setInterval(async () => {
      try {
        const status = await API.scanStatus()
        if (!status.running) {
          setScanning(false)
          setScanJobToken(null)
          // Force complete refresh of tree after scan completes
          try {
            const t = await API.tree(treeMode, mediaFilter)
            setTree(t)
            // Reset selection to root and clear any cached state
            setOpen(new Set([t.path]))
            setSelected(t.path)
            // Clear photo cache to force fresh load
            photoIdsRef.current = new Set()
            setPhotos([])
            setPage(1)
            setHasMore(true)
            setTotal(0)
            setInitialLoaded(false)
            setLoadedThumbnails(new Set())
          } catch (e) {
            console.error('Failed to refresh tree after scan:', e)
          }
        }
      } catch {
        // If status check fails, assume scan is done
        setScanning(false)
        setScanJobToken(null)
      }
    }, 2000) // Check every 2 seconds
    
    return () => clearInterval(interval)
  }, [scanJobToken, user?.is_admin, treeMode, mediaFilter])

  const toggle = useCallback((p) => {
    setOpen(prev => {
      const n = new Set(prev)
      n.has(p) ? n.delete(p) : n.add(p)
      return n
    })
  }, [])

  // popover outside click
  useEffect(() => {
    if (!resizeOpen) return
    const onDoc = (e) => { if (!resizeRef.current) return; if (!resizeRef.current.contains(e.target)) setResizeOpen(false) }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [resizeOpen])

  useEffect(() => {
    if (!shareOpen) return
    const onDoc = (e) => { if (!shareRef.current) return; if (!shareRef.current.contains(e.target)) setShareOpen(false) }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [shareOpen])

  // resize indicator debounce
  useEffect(() => {
    if (!resizing) return
    const t = setTimeout(() => setResizing(false), 250)
    return () => clearTimeout(t)
  }, [tileMin, resizing])

  // Loader
  useEffect(() => {
    if (!isShareMode && !user) return
    const controller = new AbortController()
    controllerRef.current?.abort()
    controllerRef.current = controller

    const run = async () => {
      if (lastKeyRef.current !== requestKey) {
        lastKeyRef.current = requestKey
        photoIdsRef.current = new Set()
        setPhotos([])
        setPage(1)
        setHasMore(true)
        setError('')
        setInitialLoaded(false)
        setTotal(0)
        setSelectMode(false)
        setSelectedIds(new Set())
        setLoadedThumbnails(new Set())
      }

      if (inFlightRef.current) return
      if (!hasMore && page > 1) return

      inFlightRef.current = true
      setLoading(true)
      try {
        let r
        if (isShareMode) {
          const params = { page, pageSize: 200, _t: Date.now(), filter: mediaFilter }
          r = await API.sharePhotos(shareToken, params)
        } else {
          const params = (treeMode === 'dates' && String(selected).startsWith('date:'))
            ? (() => {
                const p = { q: '', page, pageSize: 200, _t: Date.now(), filter: mediaFilter }
                if (dateRange.from && dateRange.to) {
                  p.from = dateRange.from; p.to = dateRange.to
                } else {
                  p.from = 0; p.to = Date.now() + 24*60*60*1000
                }
                return p
              })()
            : { folder: selected, q: '', page, pageSize: 200, _t: Date.now(), filter: mediaFilter }
          r = await API.photos(params, { signal: controller.signal })
        }
        if (r?.error) throw new Error(r.error)
        setTotal(Number(r.total || 0))

        const incoming = r.items || []
        const filtered = []
        for (const it of incoming) {
          if (!photoIdsRef.current.has(it.id)) { photoIdsRef.current.add(it.id); filtered.push(it) }
        }

        setPhotos(prev => page === 1 ? filtered : [...prev, ...filtered])
        const nextLen = (page === 1 ? filtered.length : (prevLen(prev) + filtered.length))
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
  }, [page, requestKey, selected, user, isShareMode, shareToken])

  // Infinite scroll
  useEffect(() => {
    if (!initialLoaded) return
    const io = new IntersectionObserver((ents) => {
      if (ents.some(e => e.isIntersecting)) setPage(p => p + 1)
    }, { root: scrollRef.current || null, rootMargin: '400px', threshold: 0 })
    const el = sentinelRef.current
    if (el) io.observe(el)
    return () => io.disconnect()
  }, [initialLoaded])

  // Viewer helpers
  const openViewer = (idx) => { 
    if (!selectMode) { 
      setViewer({ open: true, index: idx }); 
      setInfoOpen(false) 
    } 
  }
  const closeViewer = () => { setViewer({ open: false, index: 0 }); setInfoOpen(false) }
  const next = () => setViewer(v => ({ ...v, index: Math.min(v.index + 1, visiblePhotos.length - 1) }))
  const prev = () => setViewer(v => ({ ...v, index: Math.max(v.index - 1, 0) }))

  // Full screen helpers
  const openFullscreen = (idx) => {
    if (!selectMode) {
      setViewer({ open: true, index: idx })
      setInfoOpen(false)
      // Request browser fullscreen
      if (document.documentElement.requestFullscreen) {
        document.documentElement.requestFullscreen()
      } else if (document.documentElement.webkitRequestFullscreen) {
        document.documentElement.webkitRequestFullscreen()
      } else if (document.documentElement.msRequestFullscreen) {
        document.documentElement.msRequestFullscreen()
      }
    }
  }
  const closeFullscreen = () => { 
    setViewer({ open: false, index: 0 })
    // Exit browser fullscreen
    if (document.exitFullscreen) {
      document.exitFullscreen()
    } else if (document.webkitExitFullscreen) {
      document.webkitExitFullscreen()
    } else if (document.msExitFullscreen) {
      document.msExitFullscreen()
    }
  }
  const exitBrowserFullscreen = () => {
    // Only exit browser fullscreen, keep viewer open
    if (document.exitFullscreen) {
      document.exitFullscreen()
    } else if (document.webkitExitFullscreen) {
      document.webkitExitFullscreen()
    } else if (document.msExitFullscreen) {
      document.msExitFullscreen()
    }
  }
  const nextFullscreen = () => setViewer(v => ({ ...v, index: Math.min(v.index + 1, visiblePhotos.length - 1) }))
  const prevFullscreen = () => setViewer(v => ({ ...v, index: Math.max(v.index - 1, 0) }))

  // meta
  const ensureMeta = useCallback(async (id) => {
    if (!id) return null
    if (metaCacheRef.current.has(id)) {
      const m = metaCacheRef.current.get(id)
      setMeta(m)
      return m
    }
    try {
      const m = await API.meta(id)
      if (m?.error) throw new Error(m.error)
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
    const cur = visiblePhotos[viewer.index]
    if (!cur) return
    if (infoOpen) { ensureMeta(cur.id) }
  }, [viewer.open, viewer.index, infoOpen, visiblePhotos, ensureMeta])

  // keys
  useEffect(() => {
    const onKey = (e) => {
      if (viewer.open) {
        if (e.key === 'Escape') {
          // Check if we're in browser fullscreen mode
          const isBrowserFullscreen = !!(document.fullscreenElement || document.webkitFullscreenElement || document.msFullscreenElement)
          if (isBrowserFullscreen) {
            exitBrowserFullscreen()
          } else {
            closeViewer()
          }
        }
        if (e.key === 'ArrowRight') next()
        if (e.key === 'ArrowLeft') prev()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [viewer.open, photos.length])

  // Handle fullscreen change events
  useEffect(() => {
    const handleFullscreenChange = () => {
      if (!document.fullscreenElement && !document.webkitFullscreenElement && !document.msFullscreenElement) {
        // User exited browser fullscreen, viewer stays open with UI
      }
    }

    document.addEventListener('fullscreenchange', handleFullscreenChange)
    document.addEventListener('webkitfullscreenchange', handleFullscreenChange)
    document.addEventListener('msfullscreenchange', handleFullscreenChange)

    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange)
      document.removeEventListener('webkitfullscreenchange', handleFullscreenChange)
      document.removeEventListener('msfullscreenchange', handleFullscreenChange)
    }
  }, [])

  // download single
  const downloadActive = useCallback(() => {
    const current = visiblePhotos[viewer.index]
    if (!current) return
    const a = document.createElement('a')
    a.href = isShareMode ? apiUrl(`/s/${shareToken}/download/${current.id}`) : apiUrl(`/download/${current.id}`)
    a.download = current.fname
    document.body.appendChild(a)
    a.click()
    a.remove()
  }, [visiblePhotos, viewer.index, isShareMode, shareToken])

  // touch swipe
  const touchStartRef = useRef({ x: 0, y: 0, t: 0 })
  const onTouchStart = (e) => {
    const t = e.touches[0]
    touchStartRef.current = { x: t.clientX, y: t.clientY, t: Date.now() }
  }
  const onTouchMove = (e) => {
    const t = e.touches[0]
    const dx = t.clientX - touchStartRef.current.x
    const dy = t.clientY - touchStartRef.current.y
    // Prevent default for horizontal swipes to avoid page scrolling
    if (Math.abs(dx) > Math.abs(dy)) e.preventDefault()
  }
  const onTouchEnd = (e) => {
    const start = touchStartRef.current
    const end = e.changedTouches[0]
    const dx = end.clientX - start.x
    const dy = end.clientY - start.y
    const adx = Math.abs(dx)
    const ady = Math.abs(dy)
    const dt = Date.now() - start.t
    const THRESH = 20
    const MAX_ANGLE = 0.57
    const MIN_SWIPE_TIME = 100
    const MAX_SWIPE_TIME = 800
    
    // Only process if swipe is fast enough and not too slow
    if (dt < MIN_SWIPE_TIME || dt > MAX_SWIPE_TIME) return
    
    // Check if we're in browser fullscreen mode
    const isBrowserFullscreen = !!(document.fullscreenElement || document.webkitFullscreenElement || document.msFullscreenElement)
    
    // Horizontal swipe (left/right) - change photo
    if (adx > THRESH && (ady / (adx || 1)) < MAX_ANGLE) {
      if (dx < 0) next(); else prev()
    }
    // Vertical swipe (up/down) - info panel and close
    else if (ady > THRESH && (adx / (ady || 1)) < MAX_ANGLE) {
      if (dy < 0) {
        // Swipe up - open info panel (disabled on mobile)
        if (!isSmall) {
          setInfoOpen(true)
        }
      } else {
        // Swipe down - close info panel or close viewer
        if (infoOpen) {
          setInfoOpen(false)
        } else if (isBrowserFullscreen) {
          // Exit browser fullscreen if in fullscreen mode
          exitBrowserFullscreen()
        } else {
          closeViewer()
        }
      }
    }
  }

  // multi-select
  const toggleSelectId = (id) => {
    setSelectedIds(prev => {
      const n = new Set(prev)
      if (n.has(id)) n.delete(id); else n.add(id)
      return n
    })
  }
  const onTileClick = (id, idx) => {
    if (selectMode) toggleSelectId(id)
    else openViewer(idx)
  }
  const [downloadLoading, setDownloadLoading] = useState(false)
  
  const downloadZip = async () => {
    const ids = Array.from(selectedIds)
    if (ids.length === 0) return
    
    setDownloadLoading(true)
    try {
      const url = isShareMode ? apiUrl(`/s/${shareToken}/download/batch`) : apiUrl('/download/batch')
      const res = await fetch(url, {
        method: 'POST',
        credentials: isShareMode ? 'omit' : 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids })
      })
      if (!res.ok) throw new Error(`Zip failed: ${res.status}`)
      const blob = await res.blob()
      const dlUrl = URL.createObjectURL(blob)
      const cd = res.headers.get('content-disposition')
      const name = parseZipFilenameFromCD(cd) || `photos-${new Date().toISOString().slice(0,19).replace(/[:T]/g,'')}.zip`
      const a = document.createElement('a')
      a.href = dlUrl
      a.download = name
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(dlUrl)
    } catch (e) {
      console.error('zip download failed', e)
    } finally {
      setDownloadLoading(false)
    }
  }



  // Override viewer/media URLs for share mode (define before any early returns to keep hook order consistent)
  const buildImageUrl = useCallback((id, type) => {
    if (!id) return ''
    if (isShareMode) {
      if (type === 'view') return apiUrl(`/s/${shareToken}/view/${id}`)
      if (type === 'media') return apiUrl(`/s/${shareToken}/media/${id}`)
      if (type === 'hlsMaster') return apiUrl(`/s/${shareToken}/hls/${id}/master.m3u8`)
      if (type === 'transcode720') return apiUrl(`/s/${shareToken}/transcode/${id}?q=720`)
    }
    if (type === 'view') return apiUrl(`/view/${id}`)
    if (type === 'media') return apiUrl(`/media/${id}`)
    if (type === 'hlsMaster') return apiUrl(`/hls/${id}/master.m3u8`)
    if (type === 'transcode720') return apiUrl(`/transcode/${id}?q=720`)
    return ''
  }, [isShareMode, shareToken])

  /* auth view switching */
  if (!authChecked) {
    return (
      <GlassShell>
        <div className="h-full grid place-items-center">
          <div className="text-slate-300">Loading…</div>
        </div>
      </GlassShell>
    )
  }
  if (!user && !isShareMode) {
    return (
      <LoginScreen
        onLoggedIn={async () => {
          const r = await API.me().catch(() => null)
          if (r?.user?.id) {
            setUser(r.user)
            const t = await API.tree()
            setTree(t)
            setOpen(new Set([t.path]))
            setSelected(t.path)
          }
        }}
      />
    )
  }

  const currentPhoto = viewer.open ? visiblePhotos[viewer.index] : null
  const truncatedName = currentPhoto ? ellipsizeWords(currentPhoto.fname || '', 8) : ''
  const imgMaxHeight = isSmall && infoOpen
    ? `calc(100vh - ${HEADER_H}px - ${MOBILE_INFO_VH}vh - 24px)`
    : `calc(100vh - ${HEADER_H}px - 24px)`


  return (
    <GlassShell>
      {/* Inline toast */}
      {toast.visible && (
        <div className="fixed top-3 left-1/2 -translate-x-1/2 z-[10000] px-3 py-1.5 rounded bg-white/10 border border-white/10 text-xs text-slate-100 shadow">
          {toast.message}
        </div>
      )}
      {!isShareMode && view === 'admin' ? (
        <AdminPanel user={user} onClose={() => setView('photos')} />
      ) : (
        <div
          className="h-full min-h-0 grid"
          style={{ gridTemplateColumns: (!isShareMode && !isSmall && sidebarOpen) ? `${Math.round(sidebarWidth)}px 1fr` : '1fr' }}
        >
                     {/* Desktop Sidebar */}
           {!isShareMode && !isSmall && sidebarOpen && (
             <aside className="relative h-full flex flex-col border-r border-white/10 bg-zinc-950 overflow-hidden">
               {/* Top bar inside sidebar */}
               <div className="shrink-0 flex items-center gap-2 p-3 border-b border-white/10">
                 <img src="/logo.svg" alt="Liquid Photos" className="w-5 h-5" />
                 <div className="text-sm font-semibold text-slate-100">Liquid Photos</div>
                 {user?.is_admin && (
                 <>
                   <button
                     className="ml-auto inline-flex items-center gap-2 text-xs px-2 py-1 rounded-lg border border-white/10 bg-white/10 hover:bg-white/15"
                     title="Scan Media"
                     onClick={async () => { setScanMenuAnchor('sidebar'); setScanMenuOpen(v => !v); if (!scanTree) await loadScanTree() }}
                   >
                     Scan Media
                   </button>
                   {scanMenuOpen && scanMenuAnchor === 'sidebar' && (
                    <div className="fixed left-1/2 -translate-x-1/2 top-[72px] z-[1000] w-[90vw] max-w-[520px] max-h-[70vh] rounded-lg border border-white/10 bg-zinc-950 shadow-2xl">
                      <div className="p-3 flex items-center gap-2">
                        <button
                          className={`inline-flex items-center gap-2 text-xs px-2 py-1 rounded-lg border border-white/10 ${scanning ? 'bg-white/20' : 'bg-white/10 hover:bg-white/15'}`}
                          disabled={scanning}
                          onClick={async () => {
                            if (scanning) return
                            setScanning(true)
                            try {
                              const result = await API.rescan()
                              if (result?.ok) {
                                // Start polling for status
                                setScanJobToken(Date.now())
                              } else {
                                setScanning(false)
                              }
                            } catch {
                              setScanning(false)
                            }
                          }}
                          title="Full Rescan"
                        >
                          <RefreshCcw className={`w-4 h-4 ${scanning ? 'animate-spin' : ''}`} /> {scanning ? 'Scanning' : 'Full Rescan'}
                        </button>
                        {scanning && (
                          <button
                            className="ml-2 inline-flex items-center gap-2 text-xs px-2 py-1 rounded-lg border border-rose-500/40 bg-rose-500/10 hover:bg-rose-500/15 text-rose-300"
                            onClick={async () => { try { await API.cancelScan() } catch {} }}
                            title="Cancel Scanning"
                          >
                            Cancel Scanning
                          </button>
                        )}
                      </div>
                      <div className="border-t border-white/10" />
                      <div className="p-2">
                        <div className="text-xs text-slate-300 font-semibold mb-2">Scan Path</div>
                        {treeMode === 'dates' && (
                          <div className="mb-2 text-xs text-amber-300 bg-amber-900/30 border border-amber-500/30 rounded px-2 py-1">
                            Please move to Folders view to Scan by Path
                          </div>
                        )}
                        <div className="h-64 overflow-auto rounded border border-white/10 p-2">
                          <SidebarTreeContent
                            tree={scanTree || tree}
                            open={open}
                            toggle={(p) => toggle(p)}
                            selected={scanSelectedPath}
                            select={(p) => {
                              if (String(p).startsWith('date:')) return
                              setScanSelectedPath(p)
                            }}
                            showHeader={false}
                          />
                        </div>
                        <div className="mt-3 flex items-center justify-end gap-2">
                          <button
                            className="text-xs px-3 py-1.5 rounded bg-white/10 border border-white/10 hover:bg-white/15"
                            onClick={() => { setScanMenuOpen(false); setScanSelectedPath('') }}
                          >
                            Cancel
                          </button>
                          <button
                            className={`text-xs px-3 py-1.5 rounded ${scanSelectedPath ? 'bg-emerald-500/20 hover:bg-emerald-500/25 border-emerald-500/40 text-emerald-300' : 'bg-white/10 border-white/10 opacity-50 cursor-not-allowed'} border`}
                            disabled={!scanSelectedPath || scanning}
                            onClick={async () => {
                              if (!scanSelectedPath) return
                              setScanning(true)
                              setError('')
                              try {
                                const r = await API.rescanPath(scanSelectedPath)
                                if (!r?.ok) throw new Error(r?.error || 'Scan failed')
                                
                                // Start polling for status
                                setScanJobToken(Date.now())
                                
                                // Clear photo cache to force fresh load
                                photoIdsRef.current = new Set()
                                setPhotos([])
                                setPage(1)
                                setHasMore(true)
                                setTotal(0)
                                setInitialLoaded(false)
                                setLoadedThumbnails(new Set())
                                
                                // Force complete refresh of tree after path scan
                                const t = await API.tree(treeMode, mediaFilter)
                                if (!t) throw new Error('Failed to refresh tree')
                                setTree(t)
                                setSelected(scanSelectedPath)
                                setOpen(prev => new Set(prev).add(scanSelectedPath))
                                
                              } catch (e) {
                                console.error('Scan path failed:', e)
                                setError('Failed to scan path. Please try again.')
                              } finally {
                                setScanning(false)
                                setScanMenuOpen(false)
                              }
                            }}
                          >
                            Scan Now
                          </button>
                        </div>
                      </div>
                    </div>
                  )}
                 </>
                )}
               </div>

               {/* Scrollable tree in the middle */}
               <SidebarTreeContent
                 tree={tree}
                 open={open}
                 toggle={toggle}
                 select={(p) => {
                   if (treeMode === 'dates' && String(p).startsWith('date:')) {
                     const parts = String(p).split(':')[1]
                     if (parts.startsWith('D-')) {
                       const [y, m, d] = parts.slice(2).split('-').map(n => parseInt(n, 10))
                       const from = Date.UTC(y, m - 1, d)
                       const to = Date.UTC(y, m - 1, d + 1)
                       setDateRange({ from, to })
                     } else if (parts.startsWith('M-')) {
                       const [y, m] = parts.slice(2).split('-').map(n => parseInt(n, 10))
                       const from = Date.UTC(y, m - 1, 1)
                       const to = Date.UTC(y, m, 1)
                       setDateRange({ from, to })
                     } else if (parts.startsWith('Y-')) {
                       const y = parseInt(parts.slice(2), 10)
                       const from = Date.UTC(y, 0, 1)
                       const to = Date.UTC(y + 1, 0, 1)
                       setDateRange({ from, to })
                     }
                   }
                   setSelected(p)
                 }}
                 selected={selected}
                 mode={treeMode}
                 loading={treeLoading}
                 onToggleMode={async (nextMode) => {
                   if (nextMode === treeMode) return
                   
                   // Set loading states to prevent race conditions
                   setTreeLoading(true)
                   setLoading(true)
                   setError('')
                   
                   // Add timeout to prevent stuck loading state
                   const timeoutId = setTimeout(() => {
                     setTreeLoading(false)
                     setLoading(false)
                     setError('Request timed out. Please try again.')
                   }, 30000) // 30 second timeout
                   
                   try {
                     // Update tree mode first
                     setTreeMode(nextMode)
                     
                     // Clear all cached state immediately to prevent stale data
                     photoIdsRef.current = new Set()
                     setPhotos([])
                     setPage(1)
                     setHasMore(true)
                     setTotal(0)
                     setInitialLoaded(false)
                     setLoadedThumbnails(new Set())
                     setSelectMode(false)
                     setSelectedIds(new Set())
                     setDateRange({ from: 0, to: 0 })
                     
                     // Refresh tree with new mode
                     const t = await API.tree(nextMode, mediaFilter)
                     if (!t) throw new Error('Failed to load tree')
                     
                     // Update tree and reset selection
                     setTree(t)
                     setOpen(new Set([t.path]))
                     setSelected(t.path)
                     
                   } catch (e) {
                     console.error('Failed to refresh tree when switching modes:', e)
                     setError('Failed to switch view mode. Please try again.')
                     // Revert tree mode on error
                     setTreeMode(treeMode)
                   } finally {
                     clearTimeout(timeoutId)
                     setTreeLoading(false)
                     setLoading(false)
                   }
                 }}
               />

               {/* Pinned footer */}
               <SidebarFooter
                 user={user}
                 onGoAdmin={() => setView('admin')}
                 onSignOut={async () => { await API.logout(); setUser(null) }}
               />

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
          )}

          {/* Main */}
          <main className="flex flex-col min-h-0">
            {/* Header */}
            <header className="relative z-20 p-3 border-b border-white/10 bg-zinc-950">
              <div className="flex items-center gap-3">
                {/* Toggle */}
                {!isShareMode && (
                <button
                  className="inline-flex items-center justify-center p-2 rounded-full bg-white/10 border border-white/10 hover:bg-white/20"
                  onClick={() => setSidebarOpen(v => !v)}
                  aria-label="Toggle sidebar"
                >
                  <Menu className="w-5 h-5 text-slate-200" />
                </button>
                )}

                {/* Brand when sidebar closed (desktop) */}
                {!isShareMode && !isSmall && !sidebarOpen && (
                  <div className="flex items-center gap-2">
                    <img src="/logo.svg" alt="Liquid Photos" className="w-5 h-5" />
                    <div className="text-sm font-semibold text-slate-100">Liquid Photos</div>
                  </div>
                )}

                {/* Multiselect toggle + shared album name */}
                <div className="flex items-center gap-2">
                  <button
                    className={`inline-flex items-center gap-2 px-2 py-1 rounded-full border ${selectMode ? 'bg-white/20 border-white/20' : 'bg-white/10 border-white/10 hover:bg-white/20'}`}
                    onClick={() => setSelectMode(v => { const nv = !v; if (!nv) setSelectedIds(new Set()); return nv })}
                    title="Multi-select"
                  >
                    <CheckSquare className="w-4 h-4" />
                    <span className="text-xs hidden sm:block">Select</span>
                  </button>
                  {isShareMode && shareInfo?.name && (
                    <div className="max-w-[40vw] truncate text-xs text-slate-200" title={shareInfo.name}>
                      {shareInfo.name}{shareInfo.selected && !shareInfo.name.includes("'") ? ' (selected)' : ''}
                    </div>
                  )}
                </div>

                {/* Filter: Photos/Videos */}
                {!isShareMode && (
                <div>
                  <select
                    className={`text-xs px-2 py-1 rounded-full border ${loading ? 'bg-white/5 border-white/5 opacity-50 cursor-not-allowed' : 'bg-white/10 border-white/10 hover:bg-white/20'}`}
                    value={mediaFilter}
                    disabled={loading}
                    onChange={async (e) => {
                      const val = e.target.value
                      if (val === mediaFilter) return // No change needed
                      
                      // Set loading state to prevent race conditions
                      setLoading(true)
                      setError('')
                      
                      // Add timeout to prevent stuck loading state
                      const timeoutId = setTimeout(() => {
                        setLoading(false)
                        setError('Request timed out. Please try again.')
                      }, 30000) // 30 second timeout
                      
                      try {
                        // Update media filter first
                        setMediaFilter(val)
                        
                        // Clear all cached state immediately to prevent stale data
                        photoIdsRef.current = new Set()
                        setPhotos([])
                        setPage(1)
                        setHasMore(true)
                        setTotal(0)
                        setInitialLoaded(false)
                        setLoadedThumbnails(new Set())
                        setSelectMode(false)
                        setSelectedIds(new Set())
                        
                        // Refresh tree with new filter
                        const t = await API.tree(treeMode, val)
                        if (!t) throw new Error('Failed to load tree')
                        
                        // Update tree and reset selection
                        setTree(t)
                        setOpen(new Set([t.path]))
                        setSelected(t.path)
                        
                      } catch (e) {
                        console.error('Failed to refresh tree when changing media filter:', e)
                        setError('Failed to update media filter. Please try again.')
                        // Revert media filter on error
                        setMediaFilter(mediaFilter)
                      } finally {
                        clearTimeout(timeoutId)
                        setLoading(false)
                      }
                    }}
                    title="Filter media type"
                  >
                    <option value="all">Photos & Videos</option>
                    <option value="images">Photos</option>
                    <option value="videos">Videos</option>
                  </select>
                </div>
                )}

                
                {/* Right side controls */}
                <div className="ml-auto flex items-center gap-2">
                  {/* Favorites button */}
                  {!isShareMode && (
                    <button
                      className={`inline-flex items-center gap-2 px-2 py-1 rounded-full border ${showFavorites ? 'bg-rose-500/20 border-rose-500/30 text-rose-300' : 'bg-white/10 border-white/10 hover:bg-white/20'}`}
                      onClick={() => setShowFavorites(v => !v)}
                      title={showFavorites ? 'Show all items' : 'Show favorites'}
                      aria-pressed={showFavorites}
                    >
                      <Heart className={`w-4 h-4 ${showFavorites ? 'fill-rose-400 text-rose-400' : ''}`} />
                    </button>
                  )}
                  {/* Share button (now shown in all views) */}
                  {!isShareMode && (
                    <div ref={shareRef} className="relative">
                      <button
                        className="inline-flex items-center gap-2 px-2 py-1 rounded-full bg-white/10 border border-white/10 hover:bg-white/20"
                        onClick={() => setShareOpen(v => !v)}
                        title="Share"
                        aria-haspopup="menu"
                        aria-expanded={shareOpen}
                      >
                        <Share className="w-4 h-4" />
                      </button>
                      {shareOpen && (
                        <div className="fixed z-50 w-64 rounded border border-white/10 bg-zinc-950 shadow-xl p-2" style={{
                          top: shareRef.current ? shareRef.current.getBoundingClientRect().bottom + 8 : 0,
                          right: shareRef.current ? window.innerWidth - shareRef.current.getBoundingClientRect().right : 0
                        }}>
                          <div className="text-xs text-slate-300 mb-2">Share options</div>
                          
                          {/* Share selected photos (first option when photos are selected) */}
                          {selectedIds.size > 0 && (
                            <button
                              className="w-full text-left inline-flex items-center gap-2 px-2 py-1 rounded-full bg-white/10 border border-white/10 hover:bg-white/20 mb-2"
                              onClick={async () => {
                                try {
                                  const ids = Array.from(selectedIds)
                                  const r = await API.shareCreate('', '', ids)
                                  if (!r?.token) throw new Error(r?.error || 'Share failed')
                                  const full = `${window.location.origin}${r.urlPath}`
                                  try { await navigator.clipboard.writeText(full); showToast('Link copied to clipboard') } catch { showToast('Copy failed; please copy from modal') }
                                  setShareOpen(false)
                                  setSelectMode(false)
                                  setSelectedIds(new Set())
                                } catch (e) {
                                  alert(e?.message || 'Failed to create share')
                                }
                              }}
                            >
                              Share Selected ({selectedIds.size} items)
                            </button>
                          )}
                          
                          {/* Folder-based sharing (only in folders view) */}
                          {treeMode === 'folders' && selected && !String(selected).startsWith('date:') && (
                            <button
                              className="w-full text-left inline-flex items-center gap-2 px-2 py-1 rounded-full bg-white/10 border border-white/10 hover:bg-white/20 mb-2"
                              onClick={async () => {
                                try {
                                  const folderName = String(selected).split('/').filter(Boolean).slice(-1)[0] || 'Folder'
                                  const r = await API.shareCreate(selected, folderName)
                                  if (!r?.token) throw new Error(r?.error || 'Share failed')
                                  const full = `${window.location.origin}${r.urlPath}`
                                  try { await navigator.clipboard.writeText(full); showToast('Link copied to clipboard') } catch { showToast('Copy failed; please copy from modal') }
                                  setShareOpen(false)
                                  setSelectMode(false)
                                  setSelectedIds(new Set())
                                } catch (e) {
                                  alert(e?.message || 'Failed to create share')
                                }
                              }}
                            >
                              Share "{(String(selected).split('/').filter(Boolean).slice(-1)[0] || 'Folder')}" Folder
                            </button>
                          )}
                          
                          {/* Share selected from folder (only in folders view) */}
                          {treeMode === 'folders' && selected && !String(selected).startsWith('date:') && selectedIds.size > 0 && (
                            <button
                              className="w-full text-left inline-flex items-center gap-2 px-2 py-1 rounded-full bg-white/10 border border-white/10 hover:bg-white/20 mb-2"
                              onClick={async () => {
                                try {
                                  const folderName = (String(selected).split('/').filter(Boolean).slice(-1)[0] || 'Folder')
                                  const ids = Array.from(selectedIds)
                                  const r = await API.shareCreate(selected, `${folderName}`, ids)
                                  if (!r?.token) throw new Error(r?.error || 'Share failed')
                                  const full = `${window.location.origin}${r.urlPath}`
                                  try { await navigator.clipboard.writeText(full); showToast('Link copied to clipboard') } catch { showToast('Copy failed; please copy from modal') }
                                  setShareOpen(false)
                                  setSelectMode(false)
                                  setSelectedIds(new Set())
                                } catch (e) {
                                  alert(e?.message || 'Failed to create share')
                                }
                              }}
                            >
                              Share Selected from "{(String(selected).split('/').filter(Boolean).slice(-1)[0] || 'Folder')}"
                            </button>
                          )}
                          
                          {/* Instructions when no options available */}
                          {selectedIds.size === 0 && !(treeMode === 'folders' && selected && !String(selected).startsWith('date:')) && (
                            <div className="mb-2 text-xs text-amber-300 bg-amber-900/30 border border-amber-500/30 rounded px-2 py-1">
                              Multiselect/Select Folder to Share
                            </div>
                          )}
                          
                          <button
                            className="w-full text-left inline-flex items-center gap-2 px-2 py-1 rounded-full bg-white/10 border border-white/10 hover:bg-white/20"
                            onClick={async () => {
                              setShareOpen(false)
                              setShareModalOpen(true)
                              setLoadingShares(true)
                              try { const r = await API.sharesList(); setShares(r?.items || []) } catch { setShares([]) }
                              setLoadingShares(false)
                            }}
                          >
                            All shares
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                  <div ref={resizeRef} className="relative">
                    <button
                      className="inline-flex items-center gap-2 px-2 py-1 rounded-full bg-white/10 border border-white/10 hover:bg-white/20"
                      onClick={() => setResizeOpen(v => !v)}
                      title="Resize grid"
                      aria-haspopup="menu"
                      aria-expanded={resizeOpen}
                    >
                      <Maximize2 className="w-4 h-4" />
                    </button>
                    {resizeOpen && (
                      <div className="fixed z-50 w-40 rounded border border-white/10 bg-zinc-950 shadow-xl p-2" style={{
                        top: resizeRef.current ? resizeRef.current.getBoundingClientRect().bottom + 8 : 0,
                        right: resizeRef.current ? window.innerWidth - resizeRef.current.getBoundingClientRect().right : 0
                      }}>
                        <div className="text-xs text-slate-300 mb-2">Resize grid</div>
                        <div className="flex items-center gap-2">
                          <button
                            className="flex-1 inline-flex items-center justify-center gap-1 px-2 py-1 rounded-full bg-white/10 border border-white/10 hover:bg-white/20"
                            onClick={() => { setResizing(true); setTileMin(v => Math.min(640, v + 20)) }}
                            title="Larger"
                          >
                            <Plus className="w-4 h-4" />
                          </button>
                          <button
                            className="flex-1 inline-flex items-center justify-center gap-1 px-2 py-1 rounded-full bg-white/10 border border-white/10 hover:bg-white/20"
                            onClick={() => { setResizing(true); setTileMin(v => Math.max(60, v - 20)) }}
                            title="Smaller"
                          >
                            <Minus className="w-4 h-4" />
                          </button>
                        </div>
                      </div>
                    )}
                  </div>

                  <div className="hidden sm:block text-xs text-slate-300 shrink-0 px-2 py-1 rounded-full bg-white/10 border border-white/10">
                    {loading ? (
                      <div className="flex items-center gap-2">
                        <div className="w-3 h-3 border border-slate-400 border-t-transparent rounded-full animate-spin"></div>
                        <span>Loading...</span>
                      </div>
                    ) : (
                      `${(showFavorites ? favoritesList.length : total).toLocaleString()} items`
                    )}
                  </div>
                </div>
              </div>
            </header>

            {/* Multi-select toolbar overlay */}
            {selectMode && (
              <div className="z-10 sticky top-0 bg-zinc-950/95 border-b border-white/10 shadow flex items-center justify-between px-3 py-2">
                <div className="text-sm">{selectedIds.size} selected</div>
                <div className="flex items-center gap-2">
                  <button
                    className="inline-flex items-center gap-2 px-2 py-1 rounded-full bg-white/10 border border-white/10 hover:bg-white/20 disabled:opacity-50 disabled:cursor-not-allowed"
                    onClick={downloadZip}
                    disabled={downloadLoading}
                    title="Download .zip"
                  >
                    {downloadLoading ? (
                      <div className="w-4 h-4 border-2 border-slate-400 border-t-transparent rounded-full animate-spin"></div>
                    ) : (
                      <Download className="w-4 h-4" />
                    )}
                    .zip
                  </button>
                  <button
                    className="inline-flex items-center justify-center p-2 rounded-full bg-white/10 border border-white/10 hover:bg-white/20"
                    onClick={() => { setSelectMode(false); setSelectedIds(new Set()) }}
                    title="Exit select"
                  >
                    <X className="w-5 h-5" />
                  </button>
                </div>
              </div>
            )}

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
              {initialLoaded && photos.length === 0 && !showFavorites ? (
                <div className="flex items-center justify-center py-16">
                  <div className="text-center">
                    <div className="text-slate-400 text-lg mb-2">There are no Items in this selection</div>
                    <div className="text-slate-500 text-sm">Try selecting a different folder or adjusting your filters</div>
                  </div>
                </div>
              ) : initialLoaded && showFavorites && favoritesList.length === 0 ? (
                <div className="flex items-center justify-center py-16">
                  <div className="text-center">
                    <div className="text-slate-400 text-lg mb-2">No photos in Favorites</div>
                    <div className="text-slate-500 text-sm">Tap the heart on photos to add them</div>
                  </div>
                </div>
              ) : (
                <div
                  className="grid"
                  style={{
                    gridTemplateColumns: `repeat(auto-fill, minmax(${Math.max(60, tileMin)}px, 1fr))`,
                    gap: isSmall ? '2px' : '3px'
                  }}
                >
                  {(() => {
                    const nodes = []
                    let lastDateKey = ''
                    const list = visiblePhotos
                    for (let i = 0; i < list.length; i++) {
                      const p = list[i]
                      const dateKey = new Date(Number(p.mtime)).toLocaleDateString('en-US', { timeZone: 'UTC' })
                      if (dateKey !== lastDateKey) {
                        nodes.push(
                          <div
                            key={`hdr-${dateKey}-${i}`}
                            style={{ gridColumn: '1 / -1' }}
                            className="mt-3 mb-1 px-1 py-1 text-xs sm:text-sm font-medium text-slate-200"
                          >
                            {formatDayHeader(p.mtime)}
                          </div>
                        )
                        lastDateKey = dateKey
                      }
                      const isSel = selectedIds.has(p.id)
                      const isRaw = isRawName(p.fname)
                      const isVideo = String(p.kind) === 'video'
                      nodes.push(
                        <button
                          key={p.id}
                          className={`group relative aspect-[4/3] overflow-hidden bg-white/5 ${isSel ? 'ring-2 ring-sky-400/60' : ''} hover:scale-[1.01] transition`}
                          onClick={() => onTileClick(p.id, i)}
                        >
                          <Thumbnail
                            id={p.id}
                            fname={p.fname}
                            loadedThumbnails={loadedThumbnails}
                            setLoadedThumbnails={setLoadedThumbnails}
                            shareToken={isShareMode ? shareToken : ''}
                          />
                          {isFavorite(p.id) && (
                            <div className="absolute right-1 top-1 bg-black/50 rounded p-0.5">
                              <Heart className="w-3 h-3 text-rose-400 fill-rose-400" />
                            </div>
                          )}
                          {isRaw && (
                            <div className="absolute left-1 top-1 bg-black/60 text-white text-[7px] px-1.5 py-0.5 rounded">
                              RAW
                            </div>
                          )}
                          {isVideo && (
                            <div className="absolute left-1 top-1 bg-black/60 text-white px-1.5 py-0.5 rounded">
                              <Play className="w-3 h-3" />
                            </div>
                          )}
                          {selectMode && (
                            <div className={`absolute left-1 ${(isRaw || isVideo) ? 'top-6' : 'top-1'} bg-black/50 text-white text-[10px] px-1.5 py-0.5 rounded`}>
                              {isSel ? '✓ Selected' : 'Tap to select'}
                            </div>
                          )}
                          <div className="absolute inset-0 bg-black/0 group-hover:bg-black/10 transition" />
                        </button>
                      )
                    }
                    return nodes
                  })()}
                </div>
              )}

              <div ref={sentinelRef} className="h-20" />
              {loading && <div className="text-center text-slate-400 py-4">Loading…</div>}
            </section>
          </main>
        </div>
      )}

      {/* Mobile sidebar drawer */}
      {!isShareMode && isSmall && sidebarOpen && (
        <div className="fixed inset-0 z-50">
          <button
            className="absolute inset-0 bg-black/60"
            onClick={() => setSidebarOpen(false)}
            aria-label="Close sidebar overlay"
          />
          <aside className="absolute inset-y-0 left-0 w-[82vw] max-w-[320px] bg-zinc-950 border-r border-white/10 shadow-xl flex flex-col">
            <div className="flex items-center gap-2 p-3 border-b border-white/10">
              <button
                className="inline-flex items-center justify-center p-2 rounded bg-white/10 border border-white/10"
                onClick={() => setSidebarOpen(false)}
                aria-label="Close sidebar"
                title="Close"
              >
                <Menu className="w-5 h-5 text-slate-200" />
              </button>
              <img src="/logo.svg" alt="Liquid Photos" className="w-5 h-5" />
              <div className="text-sm font-semibold text-slate-100">Liquid Photos</div>
              {user?.is_admin && (
                <div className="relative ml-auto">
                  <button
                    className="inline-flex items-center gap-2 text-xs px-2 py-1 rounded-lg border border-white/10 bg-white/10 hover:bg-white/15"
                    title="Scan Media"
                    onClick={async () => { setScanMenuAnchor('sidebar'); setScanMenuOpen(v => !v); if (!scanTree) await loadScanTree() }}
                  >
                    Scan Media
                  </button>
                  {scanMenuOpen && scanMenuAnchor === 'sidebar' && (
                    <div className="fixed left-1/2 -translate-x-1/2 top-[64px] z-[1000] w-[90vw] max-w-[340px] max-h-[70vh] rounded-lg border border-white/10 bg-zinc-950 shadow-2xl">
                      <div className="p-3 border-b border-white/10 flex items-center gap-2">
                        <button
                          className={`inline-flex items-center gap-2 text-xs px-2 py-1 rounded-lg border border-white/10 ${scanning ? 'bg-white/20' : 'bg-white/10 hover:bg-white/15'}`}
                          disabled={scanning}
                          onClick={async () => {
                            if (scanning) return
                            setScanning(true)
                            try {
                              const result = await API.rescan()
                              if (result?.ok) {
                                // Start polling for status
                                setScanJobToken(Date.now())
                              } else {
                                setScanning(false)
                              }
                            } catch {
                              setScanning(false)
                            }
                          }}
                          title="Full Rescan"
                        >
                          <RefreshCcw className={`w-4 h-4 ${scanning ? 'animate-spin' : ''}`} /> {scanning ? 'Scanning' : 'Full Rescan'}
                        </button>
                        {scanning && (
                          <button
                            className="ml-2 inline-flex items-center gap-2 text-xs px-2 py-1 rounded-lg border border-rose-500/40 bg-rose-500/10 hover:bg-rose-500/15 text-rose-300"
                            onClick={async () => { try { await API.cancelScan() } catch {} }}
                            title="Cancel Scanning"
                          >
                            Cancel Scanning
                          </button>
                        )}
                      </div>
                      <div className="border-b border-white/10" />
                      <div className="p-2">
                        <div className="text-xs text-slate-300 font-semibold mb-2">Scan Path</div>
                        {treeMode === 'dates' && (
                          <div className="mb-2 text-xs text-amber-300 bg-amber-900/30 border border-amber-500/30 rounded px-2 py-1">
                            Please move to Folders view to Scan by Path
                          </div>
                        )}
                        <div className="h-56 overflow-auto rounded border border-white/10 p-2">
                          <SidebarTreeContent
                            tree={scanTree || tree}
                            open={open}
                            toggle={(p) => toggle(p)}
                            selected={scanSelectedPath}
                            select={(p) => {
                              if (String(p).startsWith('date:')) return
                              setScanSelectedPath(p)
                            }}
                            showHeader={false}
                          />
                        </div>
                        <div className="mt-3 flex items-center justify-end gap-2">
                          <button
                            className="text-xs px-3 py-1.5 rounded bg-white/10 border border-white/10 hover:bg-white/15"
                            onClick={() => { setScanMenuOpen(false); setScanSelectedPath('') }}
                          >
                            Cancel
                          </button>
                          <button
                            className={`text-xs px-3 py-1.5 rounded ${scanSelectedPath ? 'bg-emerald-500/20 hover:bg-emerald-500/25 border-emerald-500/40 text-emerald-300' : 'bg-white/10 border-white/10 opacity-50 cursor-not-allowed'} border`}
                            disabled={!scanSelectedPath || scanning}
                            onClick={async () => {
                              if (!scanSelectedPath) return
                              setScanning(true)
                              try {
                                const r = await API.rescanPath(scanSelectedPath)
                                if (r?.ok) {
                                  // Start polling for status
                                  setScanJobToken(Date.now())
                                  // Clear photo cache to force fresh load after scan
                                  photoIdsRef.current = new Set()
                                  setPhotos([])
                                  setPage(1)
                                  setHasMore(true)
                                  setTotal(0)
                                  setInitialLoaded(false)
                                  setLoadedThumbnails(new Set())
                                } else {
                                  setScanning(false)
                                  setScanMenuOpen(false)
                                }
                              } catch {
                                setScanning(false)
                                setScanMenuOpen(false)
                              }
                            }}
                          >
                            Scan Now
                          </button>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Scrollable middle on mobile too (unchanged) */}
            <SidebarTreeContent
              tree={tree}
              open={open}
              toggle={toggle}
              select={(p) => {
                if (treeMode === 'dates' && String(p).startsWith('date:')) {
                  const parts = String(p).split(':')[1]
                  if (parts.startsWith('D-')) {
                    const [y, m, d] = parts.slice(2).split('-').map(n => parseInt(n, 10))
                    const from = Date.UTC(y, m - 1, d)
                    const to = Date.UTC(y, m - 1, d + 1)
                    setDateRange({ from, to })
                  } else if (parts.startsWith('M-')) {
                    const [y, m] = parts.slice(2).split('-').map(n => parseInt(n, 10))
                    const from = Date.UTC(y, m - 1, 1)
                    const to = Date.UTC(y, m, 1)
                    setDateRange({ from, to })
                  } else if (parts.startsWith('Y-')) {
                    const y = parseInt(parts.slice(2), 10)
                    const from = Date.UTC(y, 0, 1)
                    const to = Date.UTC(y + 1, 0, 1)
                    setDateRange({ from, to })
                  }
                }
                setSelected(p)
                setSidebarOpen(false)
              }}
              selected={selected}
              mode={treeMode}
              loading={treeLoading}
              onToggleMode={async (nextMode) => {
                if (nextMode === treeMode) return
                // Set loading states to prevent race conditions
                setTreeLoading(true)
                setLoading(true)
                setError('')
                // Add timeout to prevent stuck loading state
                const timeoutId = setTimeout(() => {
                  setTreeLoading(false)
                  setLoading(false)
                  setError('Request timed out. Please try again.')
                }, 30000) // 30 second timeout
                try {
                  // Update tree mode first
                  setTreeMode(nextMode)
                  // Clear all cached state immediately to prevent stale data
                  photoIdsRef.current = new Set()
                  setPhotos([])
                  setPage(1)
                  setHasMore(true)
                  setTotal(0)
                  setInitialLoaded(false)
                  setLoadedThumbnails(new Set())
                  setSelectMode(false)
                  setSelectedIds(new Set())
                  setDateRange({ from: 0, to: 0 })
                  // Refresh tree with new mode
                  const t = await API.tree(nextMode, mediaFilter)
                  if (!t) throw new Error('Failed to load tree')
                  // Update tree and reset selection
                  setTree(t)
                  setOpen(new Set([t.path]))
                  setSelected(t.path)
                } catch (e) {
                  console.error('Failed to refresh tree when switching modes:', e)
                  setError('Failed to switch view mode. Please try again.')
                  // Revert tree mode on error
                  setTreeMode(treeMode)
                } finally {
                  clearTimeout(timeoutId)
                  setTreeLoading(false)
                  setLoading(false)
                }
              }}
            />

            <SidebarFooter
              user={user}
              onGoAdmin={() => { setView('admin'); setSidebarOpen(false) }}
              onSignOut={async () => { await API.logout(); setUser(null) }}
            />
          </aside>
        </div>
      )}

      {/* All shares modal */}
      {!isShareMode && shareModalOpen && (
        <div className="fixed inset-0 z-[1000] flex items-center justify-center">
          <div className="absolute inset-0 bg-black/60" onClick={() => setShareModalOpen(false)} />
          <div className="relative w-[92vw] max-w-[560px] max-h-[80vh] overflow-auto rounded-xl border border-white/10 bg-zinc-950 p-4">
            <div className="flex items-center gap-2 mb-3">
              <Share className="w-5 h-5" />
              <div className="text-sm font-semibold">All shares</div>
              <button className="ml-auto p-2 rounded bg-white/10 border border-white/10" onClick={() => setShareModalOpen(false)}><X className="w-4 h-4" /></button>
            </div>
            {/* Always show shares list */}
            <div className="space-y-2">
              {loadingShares && (
                <div className="text-slate-400 text-sm">Loading…</div>
              )}
              {shares.map(s => (
                <div key={s.id} className="rounded border border-white/10 p-2 flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="text-sm text-slate-100 truncate">{s.name}{s.selected && !s.name.includes("'") ? ' (selected)' : ''}</div>
                    <div className="text-xs text-slate-400 leading-tight" style={{ 
                      display: '-webkit-box',
                      WebkitLineClamp: 3,
                      WebkitBoxOrient: 'vertical',
                      overflow: 'hidden',
                      wordBreak: 'break-all'
                    }}>
                      {s.folder}
                    </div>
                    <div className="text-[10px] text-slate-500">{new Date(s.created_at).toLocaleString()}</div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button className="text-xs px-2 py-1 rounded bg-white/10 border border-white/10 hover:bg-white/15" onClick={async()=>{ try { await navigator.clipboard.writeText(`${window.location.origin}${s.urlPath}`); showToast('Link copied to clipboard') } catch {} }}>Copy link</button>
                    <a className="text-xs px-2 py-1 rounded bg-white/10 border border-white/10 hover:bg-white/15" href={s.urlPath} target="_blank" rel="noreferrer">Open</a>
                    <button className="text-xs px-2 py-1 rounded bg-rose-500/10 border border-rose-500/30 text-rose-300 hover:bg-rose-500/15" onClick={async()=>{ if (!confirm('Delete this share?')) return; try { const r = await API.shareDelete(s.id); if (r?.ok) setShares(prev=>prev.filter(x=>x.id!==s.id)) } catch {} }}>Delete</button>
                  </div>
                </div>
              ))}
              {!loadingShares && shares.length === 0 && (
                <div className="text-slate-400 text-sm">No shares yet.</div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Viewer */}
      {viewer.open && currentPhoto && (
        <Viewer
          isSmall={isSmall}
          isVerySmall={isVerySmall}
          infoOpen={infoOpen}
          setInfoOpen={setInfoOpen}
          photo={currentPhoto}
          truncatedName={truncatedName}
          imgMaxHeight={imgMaxHeight}
          onPrev={prev}
          onNext={next}
          onClose={closeViewer}
          onDownload={downloadActive}
          ensureMeta={ensureMeta}
          meta={meta}
          onFullscreen={() => openFullscreen(viewer.index)}
          onTouchStart={onTouchStart}
          onTouchMove={onTouchMove}
          onTouchEnd={onTouchEnd}
          buildImageUrl={buildImageUrl}
          isFavorite={isFavorite}
          toggleFavorite={toggleFavorite}
        />
      )}
    </GlassShell>
  )
}

function prevLen(arr) { return Array.isArray(arr) ? arr.length : 0 }

/* ----- Viewer ----- */
function Viewer({
  isSmall, isVerySmall, infoOpen, setInfoOpen, photo, truncatedName, imgMaxHeight,
  onPrev, onNext, onClose, onDownload, ensureMeta, meta, onFullscreen,
  onTouchStart, onTouchMove, onTouchEnd, buildImageUrl,
  isFavorite, toggleFavorite
}) {
  // Favorite helpers available via props
  const [useFullRes, setUseFullRes] = useState(false) // Default to optimized view (false = optimized, true = original)
  const [imageLoading, setImageLoading] = useState(true)
  const isVideo = String(photo?.kind) === 'video'
  const [quality, setQuality] = useState('reduced') // 'original' | 'reduced' - default to optimized (reduced)
  const [imageUrl, setImageUrl] = useState('')
  const [isBrowserFullscreen, setIsBrowserFullscreen] = useState(false)

  // Reset loading state when photo changes
  useEffect(() => {
    setImageLoading(true)
  }, [photo.id])

  // Check if we're in browser fullscreen mode
  useEffect(() => {
    const checkFullscreen = () => {
      const isFullscreen = !!(document.fullscreenElement || document.webkitFullscreenElement || document.msFullscreenElement)
      setIsBrowserFullscreen(isFullscreen)
    }
    checkFullscreen()
    const handleFullscreenChange = () => { checkFullscreen() }
    document.addEventListener('fullscreenchange', handleFullscreenChange)
    document.addEventListener('webkitfullscreenchange', handleFullscreenChange)
    document.addEventListener('msfullscreenchange', handleFullscreenChange)
    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange)
      document.removeEventListener('webkitfullscreenchange', handleFullscreenChange)
      document.removeEventListener('msfullscreenchange', handleFullscreenChange)
    }
  }, [])

  // Image URL building
  useEffect(() => {
    if (!photo?.id || isVideo) return
    const url = useFullRes ? buildImageUrl(photo.id, 'media') : buildImageUrl(photo.id, 'view')
    setImageUrl(url)
    setImageLoading(true)
  }, [photo.id, useFullRes, isVideo, buildImageUrl])

  return (
    <div 
      className={`fixed inset-0 z-50 flex ${isBrowserFullscreen ? 'bg-black' : 'bg-black/80 backdrop-blur-sm'}`}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
    >
      <div className="flex-1 flex flex-col">
        {/* Header when not browser fullscreen */}
        {!isBrowserFullscreen && (
          <div className="relative flex items-center px-4" style={{ height: HEADER_H }}>
            <div className={`pointer-events-none min-w-0 flex-1 ${!isSmall && !infoOpen ? 'min-[1000px]:absolute min-[1000px]:left-1/2 min-[1000px]:-translate-x-1/2 min-[1000px]:text-center min-[1000px]:max-w-[60vw]' : ''}`}>
              {(isVideo || imageUrl) && (
                <div className={`truncate text-sm text-white ${!isSmall && !infoOpen ? 'text-left min-[1000px]:text-center' : 'text-left'}`}>
                  {truncatedName}
                </div>
              )}
            </div>
            <div className="ml-auto flex items-center gap-2">
              {/* Favorite toggle in viewer (left of Info) */}
              {photo && (
                <button
                  className="p-2 rounded-full bg-white/10 border border-white/10 hover:bg-white/20"
                  onClick={() => toggleFavorite && toggleFavorite(photo)}
                  title="Favorite"
                >
                  {isFavorite && isFavorite(photo.id)
                    ? <Heart className="w-6 h-6 text-rose-400 fill-rose-400" />
                    : <Heart className="w-6 h-6" />}
                </button>
              )}
              {!isVideo && (
                <>
                  {!/iPad|iPhone|iPod/.test(navigator.userAgent) && (
                    <button
                      className="p-2 rounded-full bg-white/10 border border-white/10 hover:bg-white/20"
                      onClick={onFullscreen}
                      title="Full screen"
                    >
                      <Monitor className="w-5 h-5 text-white" />
                    </button>
                  )}
                  {/* Hide optimized button on very small screens */}
                  {!isVerySmall && (
                    <button
                      className={`px-3 py-1 rounded-full border border-white/10 ${useFullRes ? 'bg-white/20' : 'bg-white/10 hover:bg-white/20'}`}
                      onClick={() => { setUseFullRes(!useFullRes); setImageLoading(true) }}
                      title={useFullRes ? 'Switch to Optimized view' : 'Switch to Original view'}
                    >
                      {useFullRes ? 'Original' : 'Optimized'}
                    </button>
                  )}
                </>
              )}
              {isVideo && !isVerySmall && (
                <button
                  className={`px-3 py-1 rounded-full border border-white/10 ${quality ? 'bg-white/20' : 'bg-white/10 hover:bg-white/20'}`}
                  onClick={() => { setQuality(q => (q === 'original' ? 'reduced' : 'original')); setImageLoading(true) }}
                  title={quality === 'original' ? 'Tap to switch to Optimized' : 'Tap to switch to Original'}
                >
                  {quality === 'original' ? 'Original' : 'Optimized'}
                </button>
              )}
              {/* Show info button on mobile, hide optimized button on mobile */}
              {isSmall ? (
                <button
                  className="p-2 rounded-full bg-white/10 border border-white/10 hover:bg-white/20"
                  onClick={async () => { setInfoOpen(v => !v); if (!infoOpen) await ensureMeta(photo.id) }}
                  title="Info"
                >
                  <Info className="w-6 h-6 text-white" />
                </button>
              ) : (
                <button
                  className="p-2 rounded-full bg-white/10 border border-white/10 hover:bg-white/20"
                  onClick={async () => { setInfoOpen(v => !v); if (!infoOpen) await ensureMeta(photo.id) }}
                  title="Info"
                >
                  <Info className="w-6 h-6 text-white" />
                </button>
              )}
              <button
                className="p-2 rounded-full bg-white/10 border border-white/10 hover:bg-white/20"
                onClick={onDownload}
                title="Download"
              >
                <Download className="w-6 h-6 text-white" />
              </button>
              <button
                className="p-2 rounded-full bg-white/10 border border-white/10 hover:bg-white/20"
                onClick={onClose}
                title="Close"
              >
                <X className="w-6 h-6 text-white" />
              </button>
            </div>
          </div>
        )}

        <div className="relative flex-1 flex items-center justify-center px-3 pb-3">
          {/* Show navigation buttons only when NOT in browser fullscreen mode */}
          {!isBrowserFullscreen && (
            <>
              <button className="absolute left-4 top-1/2 -translate-y-1/2 p-3 rounded-full bg-white/10 border border-white/10 hover:bg-white/20" onClick={onPrev}>◀</button>
              <button className="absolute right-4 top-1/2 -translate-y-1/2 p-3 rounded-full bg-white/10 border border-white/10 hover:bg-white/20" onClick={onNext}>▶</button>
            </>
          )}

          {imageLoading && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div className="w-12 h-12 border-4 border-white/30 border-t-white rounded-full animate-spin"></div>
            </div>
          )}

          {isVideo ? (
            <VideoPlayer
              srcOriginal={buildImageUrl(photo.id, 'media')}
              srcHls={buildImageUrl(photo.id, 'hlsMaster')}
              srcReduced={buildImageUrl(photo.id, 'transcode720')}
              mode={quality}
              style={{
                maxHeight: isBrowserFullscreen ? '100vh' : imgMaxHeight,
                maxWidth: isBrowserFullscreen ? '100vw' : (isSmall && infoOpen ? '94vw' : '92vw'),
                width: '100%',
                height: 'auto',
                objectFit: 'contain'
              }}
              poster={buildImageUrl(photo.id, 'view')}
              onLoad={() => setImageLoading(false)}
              onError={() => setImageLoading(false)}
            />
          ) : (
            imageUrl && (
              <img
                src={imageUrl}
                alt={photo.fname}
                style={{ 
                  maxHeight: isBrowserFullscreen ? '100vh' : imgMaxHeight, 
                  maxWidth: isBrowserFullscreen ? '100vw' : (isSmall && infoOpen ? '94vw' : '92vw'),
                  width: '100%',
                  height: '100%',
                  objectFit: 'contain'
                }}
                onLoad={() => setImageLoading(false)}
                onError={() => setImageLoading(false)}
              />
            )
          )}
        </div>
      </div>

      {/* Info panel when not browser fullscreen */}
      {!isBrowserFullscreen && !isSmall && infoOpen && (
        <aside className="w-[340px] max-w-[80vw] border-l border-white/10 bg-zinc-950/95 backdrop-blur px-4 py-4 overflow-auto relative">
          <button 
            className="absolute top-2 right-2 p-1 rounded-full bg-white/10 border border-white/10 hover:bg-white/20"
            onClick={() => setInfoOpen(false)}
            title="Close info"
          >
            <X className="w-4 h-4 text-white" />
          </button>
          <InfoPanel meta={meta} fallback={photo} />
        </aside>
      )}
      {!isBrowserFullscreen && isSmall && infoOpen && (
        <aside
          className="absolute bottom-0 left-0 right-0 z-[60] border-t border-white/10 bg-zinc-950/95 backdrop-blur px-4 py-3 overflow-auto"
          style={{ height: `${MOBILE_INFO_VH}vh` }}
        >
          <button 
            className="absolute top-2 right-2 p-1 rounded-full bg-white/10 border border-white/10 hover:bg-white/20"
            onClick={() => setInfoOpen(false)}
            title="Close info"
          >
            <X className="w-4 h-4 text-white" />
          </button>
          <InfoPanel meta={meta} fallback={photo} />
        </aside>
      )}
    </div>
  )}

/* ----- Info Panel ----- */
function InfoPanel({ meta, fallback }) {
  const d = meta || fallback || {}
  const isVideo = String(d.kind) === 'video'
  const rows = [
    { k: 'Name', v: d.fname },
    { k: 'Folder', v: d.folder },
    { k: 'Type', v: isVideo ? 'Video' : 'Image' },
    { k: isVideo ? 'Duration' : 'Size', v: isVideo ? formatDuration(d.duration) : formatBytes(d.size) },
    { k: 'Dimensions', v: (d.width && d.height) ? `${d.width} × ${d.height}` : '' },
  ]
  const exif = d.exif || {}
  function formatTakenDate(value) {
    if (!value) return ''
    try {
      const dt = value instanceof Date ? value : new Date(value)
      if (isNaN(dt.getTime())) return ''
      const day = dt.getDate()
      const month = dt.toLocaleString('en-US', { month: 'long' })
      const year = dt.getFullYear()
      return `${day} ${month}, ${year}`
    } catch { return '' }
  }
  const takenRaw = exif.DateTimeOriginal || exif.CreateDate || exif.ModifyDate || ''
  const takenFormatted = formatTakenDate(takenRaw)
  const exifRows = [
    { k: 'Camera', v: [exif.Make, exif.Model].filter(Boolean).join(' ') },
    { k: 'Lens', v: exif.LensModel || exif.Lens || '' },
    { k: 'ISO', v: exif.ISO },
    { k: 'Exposure', v: exif.ExposureTime ? `${exif.ExposureTime}s` : '' },
    { k: 'Aperture', v: exif.FNumber ? `f/${exif.FNumber}` : '' },
    { k: 'Focal length', v: exif.FocalLength ? `${exif.FocalLength}mm` : '' },
    { k: 'Taken', v: takenFormatted },
  ]
  const all = rows.concat(isVideo ? [] : exifRows)
  return (
    <div className="text-sm space-y-3">
      <div className="font-semibold text-slate-100">Details</div>
      <div className="space-y-1">
        {all.filter(r => r.v).map((r, idx) => (
          <div key={idx} className="flex items-start gap-2">
            <div className="w-28 shrink-0 text-slate-400">{r.k}</div>
            <div className="text-slate-100 break-all">{String(r.v)}</div>
          </div>
        ))}
        {!meta && (
          <div className="text-xs text-slate-400">Loading detailed metadata…</div>
        )}
      </div>
    </div>
  )
}

/* ----- HLS-capable Video Player ----- */
function VideoPlayer({ srcOriginal, srcHls, srcReduced, mode, style, poster, onLoad, onError }) {
  const videoRef = useRef(null)
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    let hls
    const wantsHls = (mode !== 'original')
    const source = (mode === 'reduced') ? srcReduced : srcOriginal

    // Use HLS for adaptive only when in reduced/low and when Hls.js is supported & source is HLS
    const useHls = wantsHls && Hls.isSupported() && srcHls
    if (useHls) {
      try {
        hls = new Hls({ maxBufferLength: 30, liveSyncDurationCount: 3 })
        hls.loadSource(srcHls)
        hls.attachMedia(video)
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          if (onLoad) onLoad()
        })
        hls.on(Hls.Events.ERROR, () => {
          if (onError) onError()
        })
      } catch {
        if (onError) onError()
      }
    } else {
      // Fallback to direct MP4 stream (transcode or original)
      video.src = source
    }
    return () => {
      try { if (hls) hls.destroy() } catch {}
    }
  }, [mode, srcOriginal, srcHls, srcReduced, onLoad, onError])

  return (
    <video
      ref={videoRef}
      controls
      autoPlay={false}
      style={style}
      poster={poster}
      onLoadedData={onLoad}
      onError={onError}
    />
  )
}

/* ----- Login Screen ----- */
function LoginScreen({ onLoggedIn }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (e) => {
    e.preventDefault()
    setBusy(true); setError('')
    try {
      const r = await API.login(username.trim(), password)
      if (r?.ok) {
        await onLoggedIn()
      } else {
        setError(r?.error || 'Login failed')
      }
    } catch {
      setError('Login failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <GlassShell>
      <div className="h-full grid place-items-center p-4">
        <form onSubmit={submit} className="w-full max-w-sm bg-white/5 border border-white/10 rounded-xl p-4">
          <div className="text-lg font-semibold text-white mb-2">Sign in</div>
          <div className="text-xs text-slate-400 mb-4">Use your account credentials.</div>
          {error && <div className="mb-3 text-xs text-rose-300 bg-rose-950/40 border border-rose-500/30 rounded px-2 py-1">{error}</div>}
          <label className="block text-sm text-slate-300 mb-1">Username</label>
          <input
            className="w-full mb-3 px-3 py-2 rounded bg-white/10 border border-white/10 text-slate-100"
            value={username} onChange={e => setUsername(e.target.value)} autoFocus
          />
          <label className="block text-sm text-slate-300 mb-1">Password</label>
          <input
            type="password"
            className="w-full mb-4 px-3 py-2 rounded bg-white/10 border border-white/10 text-slate-100"
            value={password} onChange={e => setPassword(e.target.value)}
          />
          <button
            type="submit" disabled={busy}
            className="w-full inline-flex items-center justify-center gap-2 px-3 py-2 rounded bg-white/10 border border-white/10 hover:bg-white/15"
          >
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </GlassShell>
  )
}

/* ----- Admin Panel ----- */
function AdminPanel({ user, onClose }) {
  const [list, setList] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [form, setForm] = useState({ username: '', password: '', path: '', isAdmin: false })
  const [creating, setCreating] = useState(false)
  const [deletingId, setDeletingId] = useState(0)
  const [allShares, setAllShares] = useState([])
  const [loadingShares, setLoadingShares] = useState(false)

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const r = await API.adminUsers()
      if (r?.items) setList(r.items); else throw new Error(r?.error || 'Failed to load users')
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const loadAllShares = useCallback(async () => {
    setLoadingShares(true)
    try {
      const r = await API.sharesList(true)
      setAllShares(Array.isArray(r?.items) ? r.items : [])
    } catch {
      setAllShares([])
    } finally {
      setLoadingShares(false)
    }
  }, [])

  useEffect(() => { if (user?.is_admin) { loadAllShares() } }, [user?.is_admin, loadAllShares])

  const createUser = async () => {
    if (!form.username || !form.password) { setError('Username and password required'); return }
    setCreating(true); setError('')
    try {
      const r = await API.adminCreateUser({ username: form.username, password: form.password, root_path: form.path, is_admin: !!form.isAdmin })
      if (!r?.ok) throw new Error(r?.error || 'Create failed')
      setForm({ username: '', password: '', path: '', isAdmin: false })
      await load()
      alert('User created')
    } catch (e) {
      setError(e.message)
    } finally {
      setCreating(false)
    }
  }

  const deleteUser = async (id, username) => {
    if (!window.confirm(`Delete user "${username}"? This cannot be undone.`)) return
    setDeletingId(id); setError('')
    try {
      const r = await API.adminDeleteUser(id)
      if (!r?.ok) throw new Error(r?.error || 'Delete failed')
      await load()
    } catch (e) {
      setError(e.message)
    } finally {
      setDeletingId(0)
    }
  }

  return (
    <div className="h-full grid" style={{ gridTemplateRows: 'auto 1fr' }}>
      <header className="p-3 border-b border-white/10 bg-zinc-950 flex items-center gap-2">
        <Shield className="w-5 h-5 text-slate-200" />
        <div className="text-sm font-semibold text-slate-100">Admin Panel</div>
        <div className="ml-auto" />
        <button
          className="inline-flex items-center gap-2 px-2 py-1 rounded bg-white/10 border border-white/10 hover:bg-white/15"
          onClick={onClose}
        >
          Back to Library
        </button>
      </header>
      <div className="p-3 overflow-auto">
        {error && <div className="mb-3 text-sm text-rose-300 bg-rose-950/40 border border-rose-500/30 rounded px-3 py-2">{error}</div>}

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="bg-white/5 border border-white/10 rounded-xl p-3">
            <div className="text-sm font-semibold mb-2">Create User</div>
            <div className="text-xs text-slate-400 mb-3">Leave path blank to grant full-library access.</div>
            <div className="space-y-2">
              <div>
                <label className="block text-xs text-slate-300 mb-1">Username</label>
                <input className="w-full px-2 py-1.5 rounded bg-white/10 border border-white/10" value={form.username} onChange={e=>setForm(f=>({...f, username:e.target.value}))}/>
              </div>
              <div>
                <label className="block text-xs text-slate-300 mb-1">Password</label>
                <input type="password" className="w-full px-2 py-1.5 rounded bg-white/10 border border-white/10" value={form.password} onChange={e=>setForm(f=>({...f, password:e.target.value}))}/>
              </div>
              <div className="flex items-center gap-2">
                <input id="new-user-admin" type="checkbox" className="w-4 h-4" checked={!!form.isAdmin} onChange={e=>setForm(f=>({...f, isAdmin:e.target.checked}))} />
                <label htmlFor="new-user-admin" className="text-xs text-slate-300 select-none">Admin</label>
              </div>
              <div>
                <label className="block text-xs text-slate-300 mb-1">Allowed Path (relative to library)</label>
                <input placeholder="e.g. 2024/Trips/Paris" className="w-full px-2 py-1.5 rounded bg-white/10 border border-white/10" value={form.path} onChange={e=>setForm(f=>({...f, path:e.target.value}))}/>
              </div>
              <div className="pt-2">
                <button disabled={creating} className="inline-flex items-center gap-2 px-3 py-1.5 rounded bg-white/10 border border-white/10 hover:bg-white/15" onClick={createUser}>
                  {creating ? 'Creating…' : 'Create user'}
                </button>
              </div>
            </div>
          </div>

          <div className="bg-white/5 border border-white/10 rounded-xl p-3">
            <div className="text-sm font-semibold mb-2">Users</div>
            {loading ? (
              <div className="text-slate-400 text-sm">Loading users…</div>
            ) : (
              <div className="space-y-2 text-sm">
                {list.map(u => {
                  const isSelf = u.id === user.id
                  const isProtected = !!u.is_protected
                  return (
                    <div key={u.id} className="rounded border border-white/10 p-2">
                      <div className="flex items-center gap-2">
                        <div className="font-medium">{u.username}</div>
                        {u.is_admin ? <span className="text-[10px] px-1.5 py-0.5 rounded bg-yellow-500/20 text-yellow-300 border border-yellow-400/30">ADMIN</span> : null}
                        {isProtected ? <span className="text-[10px] px-1.5 py-0.5 rounded bg-sky-500/20 text-sky-300 border border-sky-400/30">DEFAULT</span> : null}
                        <div className="ml-auto text-xs text-slate-400">{new Date(u.created_at).toLocaleString()}</div>
                      </div>
                      <div className="mt-2 flex items-center gap-2">
                        <div className="text-xs text-slate-300">
                          Scope: <span className="text-slate-100">{u.root_path || <em>full library</em>}</span>
                        </div>
                        <div className="ml-auto flex items-center gap-2">
                          <button
                            className={`inline-flex items-center gap-1 px-2 py-1 rounded border ${isSelf || isProtected ? 'opacity-40 cursor-not-allowed' : 'hover:bg-rose-500/15'} bg-rose-500/10 border-rose-500/30 text-rose-300`}
                            title={isProtected ? 'Default admin cannot be deleted' : (isSelf ? 'You cannot delete your own account' : 'Delete user')}
                            disabled={isSelf || isProtected || deletingId === u.id}
                            onClick={() => deleteUser(u.id, u.username)}
                          >
                            <Trash2 className="w-4 h-4" />
                            {deletingId === u.id ? 'Deleting…' : 'Delete'}
                          </button>
                        </div>
                      </div>
                    </div>
                  )
                })}
                {list.length === 0 && <div className="text-slate-400 text-sm">No users yet.</div>}
              </div>
            )}
          </div>

          <div className="bg-white/5 border border-white/10 rounded-xl p-3 sm:col-span-2">
            <div className="flex items-center gap-2 mb-2">
              <div className="text-sm font-semibold">All Shares</div>
              <button className="ml-auto text-xs px-2 py-1 rounded bg-white/10 border border-white/10 hover:bg-white/15" onClick={loadAllShares}>Refresh</button>
            </div>
            {loadingShares ? (
              <div className="text-slate-400 text-sm">Loading shares…</div>
            ) : (
              <div className="space-y-2 text-sm">
                {allShares.map(s => (
                  <div key={s.id} className="rounded border border-white/10 p-2">
                    <div className="flex items-center gap-2">
                      <div className="font-medium truncate">{s.name}{s.selected && !s.name.includes("'") ? ' (selected)' : ''}</div>
                      <div className="text-xs text-slate-400 truncate">{s.folder}</div>
                      <span className="ml-auto text-[10px] px-1.5 py-0.5 rounded bg-sky-500/20 text-sky-300 border border-sky-400/30">{s.username || 'user ' + s.user_id}</span>
                    </div>
                    <div className="mt-2 flex items-center gap-2">
                      <a className="text-xs px-2 py-1 rounded bg-white/10 border border-white/10 hover:bg-white/15" href={s.urlPath || `/s/${s.token}`} target="_blank" rel="noreferrer">Open</a>
                      <button className="text-xs px-2 py-1 rounded bg-white/10 border border-white/10 hover:bg-white/15" onClick={async()=>{ try { await navigator.clipboard.writeText(`${window.location.origin}/s/${s.token}`) } catch {} }}>Copy link</button>
                      <button className="ml-auto text-xs px-2 py-1 rounded bg-rose-500/10 border border-rose-500/30 text-rose-300 hover:bg-rose-500/15" onClick={async()=>{ if(!confirm('Delete this share?')) return; try { const r = await API.shareDelete(s.id); if(r?.ok) setAllShares(prev=>prev.filter(x=>x.id!==s.id)) } catch{} }}>Delete</button>
                    </div>
                  </div>
                ))}
                {allShares.length === 0 && (
                  <div className="text-slate-400 text-sm">No shares.</div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}