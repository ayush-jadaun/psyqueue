import { useState, useEffect, useRef } from 'react'
import { Link } from 'react-router-dom'

interface EventEntry {
  event: string
  jobId?: string
  queue?: string
  result?: string | Record<string, unknown>
  error?: string
  source?: string
  ts?: number
  _receivedAt?: number
}

export function EventsPage() {
  const [events, setEvents] = useState<EventEntry[]>([])
  const [connected, setConnected] = useState(false)
  const [autoScroll, setAutoScroll] = useState(true)
  const bottomRef = useRef<HTMLDivElement>(null)
  const eventSourceRef = useRef<EventSource | null>(null)

  useEffect(() => {
    // Connect to SSE stream
    const es = new EventSource('/api/events/stream')
    eventSourceRef.current = es

    es.onopen = () => setConnected(true)
    es.onerror = () => setConnected(false)
    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data) as EventEntry
        if (data.event === 'connected') {
          setConnected(true)
          return
        }
        setEvents(prev => {
          const next = [...prev, { ...data, _receivedAt: Date.now() }]
          // Keep last 500 events
          return next.length > 500 ? next.slice(-500) : next
        })
      } catch {}
    }

    // Also fetch recent events on mount
    fetch('/api/events/recent')
      .then(r => r.json())
      .then((data: { events: EventEntry[] }) => {
        if (data.events?.length) {
          setEvents(data.events)
        }
      })
      .catch(() => {})

    return () => { es.close() }
  }, [])

  useEffect(() => {
    if (autoScroll && bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: 'smooth' })
    }
  }, [events, autoScroll])

  // Extract worker info from result (string or object)
  function getWorkerTag(evt: EventEntry): string | null {
    if (evt.source) return evt.source
    if (!evt.result) return null
    try {
      const r = typeof evt.result === 'string' ? JSON.parse(evt.result) : evt.result
      if (r?.worker) return String(r.worker)
      if (r?.pid) return 'PID:' + r.pid
    } catch {}
    return null
  }

  function getFileName(evt: EventEntry): string | null {
    if (!evt.result) return null
    try {
      const r = typeof evt.result === 'string' ? JSON.parse(evt.result) : evt.result
      if (r?.file) return String(r.file)
    } catch {}
    return null
  }

  const eventColor = (evt: string) => {
    if (evt === 'completed') return '#4ade80'
    if (evt === 'failed') return '#f87171'
    if (evt === 'enqueued') return '#60a5fa'
    if (evt === 'active') return '#fbbf24'
    if (evt === 'stalled') return '#f97316'
    if (evt === 'connected') return '#94a3b8'
    return '#e2e8f0'
  }

  return (
    <div>
      <h1 className="page-title">
        Live Events
        <span style={{
          display: 'inline-block',
          width: 10,
          height: 10,
          borderRadius: '50%',
          backgroundColor: connected ? '#4ade80' : '#f87171',
          marginLeft: 12,
          verticalAlign: 'middle',
        }} />
        <span style={{ fontSize: 12, color: '#94a3b8', marginLeft: 8 }}>
          {connected ? 'Connected (SSE)' : 'Disconnected'}
        </span>
      </h1>

      <div style={{ marginBottom: 12, display: 'flex', gap: 12, alignItems: 'center' }}>
        <button
          onClick={() => setEvents([])}
          style={{ padding: '4px 12px', background: '#334155', border: '1px solid #475569', borderRadius: 4, color: '#e2e8f0', cursor: 'pointer' }}
        >
          Clear
        </button>
        <label style={{ color: '#94a3b8', fontSize: 13 }}>
          <input
            type="checkbox"
            checked={autoScroll}
            onChange={(e) => setAutoScroll(e.target.checked)}
            style={{ marginRight: 6 }}
          />
          Auto-scroll
        </label>
        <span style={{ color: '#64748b', fontSize: 13 }}>
          {events.length} events
        </span>
      </div>

      <div style={{
        background: '#0f172a',
        border: '1px solid #1e293b',
        borderRadius: 8,
        padding: 16,
        maxHeight: '70vh',
        overflowY: 'auto',
        fontFamily: 'monospace',
        fontSize: 13,
        lineHeight: 1.6,
      }}>
        {events.length === 0 && (
          <div style={{ color: '#475569', textAlign: 'center', padding: 40 }}>
            Waiting for events... Enqueue some jobs to see them here.
          </div>
        )}
        {events.map((evt, i) => (
          <div key={i} style={{ borderBottom: '1px solid #1e293b', padding: '4px 0', display: 'flex', gap: 12 }}>
            <span style={{ color: '#475569', minWidth: 60 }}>
              {evt._receivedAt ? new Date(evt._receivedAt).toLocaleTimeString() : ''}
            </span>
            <span style={{
              color: eventColor(evt.event),
              fontWeight: 'bold',
              minWidth: 80,
              textTransform: 'uppercase',
            }}>
              {evt.event}
            </span>
            {evt.queue && (
              <Link
                to={'/jobs?queue=' + evt.queue}
                style={{ color: '#a78bfa', textDecoration: 'none', fontSize: 12, padding: '1px 6px', background: '#1e1b4b', borderRadius: 3 }}
              >
                {evt.queue}
              </Link>
            )}
            {evt.jobId ? (
              <Link
                to={'/jobs/' + evt.jobId}
                style={{ color: '#38bdf8', textDecoration: 'none' }}
                onMouseEnter={(e) => (e.target as HTMLElement).style.textDecoration = 'underline'}
                onMouseLeave={(e) => (e.target as HTMLElement).style.textDecoration = 'none'}
                title={'Click to view full job details: ' + evt.jobId}
              >
                {evt.jobId.substring(0, 16)}...
              </Link>
            ) : null}
            {(() => {
              const worker = getWorkerTag(evt)
              const file = getFileName(evt)
              return <>
                {worker && (
                  <span style={{
                    color: worker.includes('W1') || worker.includes('1') ? '#22d3ee' : '#f472b6',
                    fontSize: 12,
                    fontWeight: 'bold',
                    padding: '1px 8px',
                    background: worker.includes('W1') || worker.includes('1') ? '#083344' : '#4a0336',
                    borderRadius: 3,
                    border: '1px solid ' + (worker.includes('W1') || worker.includes('1') ? '#0e7490' : '#9d174d'),
                  }}>
                    {worker}
                  </span>
                )}
                {file && (
                  <span style={{ color: '#94a3b8', fontSize: 11 }}>
                    {file}
                  </span>
                )}
              </>
            })()}
            {evt.error && (
              <span style={{ color: '#f87171', fontSize: 12, fontWeight: 'bold' }}>
                {evt.error}
              </span>
            )}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  )
}
