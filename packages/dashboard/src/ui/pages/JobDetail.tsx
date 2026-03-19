import { useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { fetchJob, retryJob } from '../api'
import { useFetch } from '../hooks'

export function JobDetailPage() {
  const { id } = useParams<{ id: string }>()
  const { data: job, loading, error, reload } = useFetch(() => fetchJob(id!), [id])
  const [retrying, setRetrying] = useState(false)
  const [retryMsg, setRetryMsg] = useState<string | null>(null)

  if (loading) return <div className="loading">Loading...</div>
  if (error) return <div className="error">Error: {error}</div>
  if (!job) return null

  async function handleRetry() {
    setRetrying(true)
    setRetryMsg(null)
    try {
      await retryJob(job!.id)
      setRetryMsg('Job requeued successfully')
      reload()
    } catch (err) {
      setRetryMsg(err instanceof Error ? err.message : String(err))
    } finally {
      setRetrying(false)
    }
  }

  const canRetry = job.status === 'failed' || job.status === 'dead'

  return (
    <div>
      <Link to="/jobs" className="back-link">
        &larr; Back to Jobs
      </Link>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h1 className="page-title" style={{ marginBottom: 0 }}>
          Job Detail
        </h1>
        {canRetry && (
          <button onClick={handleRetry} disabled={retrying}>
            {retrying ? 'Retrying...' : 'Retry Job'}
          </button>
        )}
      </div>

      {retryMsg && (
        <div style={{ padding: '8px 12px', marginBottom: 16, borderRadius: 6, background: 'var(--bg-card)', border: '1px solid var(--border)', fontSize: 13 }}>
          {retryMsg}
        </div>
      )}

      <div className="detail-grid">
        <div className="label">ID</div>
        <div className="value" style={{ fontFamily: 'monospace' }}>{job.id}</div>

        <div className="label">Queue</div>
        <div className="value">{job.queue}</div>

        <div className="label">Name</div>
        <div className="value">{job.name}</div>

        <div className="label">Status</div>
        <div className="value">
          <span className={`badge ${job.status}`}>{job.status}</span>
        </div>

        <div className="label">Attempt</div>
        <div className="value">{job.attempt} / {job.maxRetries}</div>

        <div className="label">Priority</div>
        <div className="value">{job.priority}</div>

        <div className="label">Backoff</div>
        <div className="value">{job.backoff}</div>

        <div className="label">Timeout</div>
        <div className="value">{job.timeout}ms</div>

        <div className="label">Created At</div>
        <div className="value">{new Date(job.createdAt).toLocaleString()}</div>

        {job.scheduledAt && (
          <>
            <div className="label">Scheduled At</div>
            <div className="value">{new Date(job.scheduledAt).toLocaleString()}</div>
          </>
        )}
      </div>

      <h2 style={{ fontSize: 14, marginBottom: 8, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
        Payload
      </h2>
      <pre className="payload">{JSON.stringify(job.payload, null, 2)}</pre>

      {job.meta && Object.keys(job.meta).length > 0 && (
        <>
          <h2 style={{ fontSize: 14, margin: '20px 0 8px', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
            Metadata
          </h2>
          <pre className="payload">{JSON.stringify(job.meta, null, 2)}</pre>
        </>
      )}
    </div>
  )
}
