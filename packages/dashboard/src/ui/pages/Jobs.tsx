import { useState, useEffect } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import { fetchJobs, fetchQueues } from '../api'
import { useFetch } from '../hooks'
import type { Job } from '../api'

const PAGE_SIZE = 50

export function JobsPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const navigate = useNavigate()

  const queueFilter = searchParams.get('queue') || ''
  const statusFilter = searchParams.get('status') || ''
  const [offset, setOffset] = useState(0)

  const queues = useFetch(() => fetchQueues(), [])
  const jobs = useFetch(
    () =>
      fetchJobs({
        queue: queueFilter || undefined,
        status: statusFilter || undefined,
        limit: PAGE_SIZE,
        offset,
      }),
    [queueFilter, statusFilter, offset],
  )

  // Reset offset when filters change
  useEffect(() => {
    setOffset(0)
  }, [queueFilter, statusFilter])

  function updateFilter(key: string, value: string) {
    const params = new URLSearchParams(searchParams)
    if (value) {
      params.set(key, value)
    } else {
      params.delete(key)
    }
    setSearchParams(params)
  }

  return (
    <div>
      <h1 className="page-title">Jobs</h1>

      <div className="filters">
        <select value={queueFilter} onChange={(e) => updateFilter('queue', e.target.value)}>
          <option value="">All queues</option>
          {queues.data?.queues.map((q) => (
            <option key={q.name} value={q.name}>
              {q.name}
            </option>
          ))}
        </select>

        <select value={statusFilter} onChange={(e) => updateFilter('status', e.target.value)}>
          <option value="">All statuses</option>
          <option value="pending">Pending</option>
          <option value="active">Active</option>
          <option value="completed">Completed</option>
          <option value="failed">Failed</option>
          <option value="dead">Dead</option>
          <option value="scheduled">Scheduled</option>
        </select>

        <button onClick={jobs.reload}>Refresh</button>
      </div>

      {jobs.loading ? (
        <div className="loading">Loading...</div>
      ) : jobs.error ? (
        <div className="error">Error: {jobs.error}</div>
      ) : !jobs.data ? null : (
        <>
          <div style={{ marginBottom: 12, fontSize: 13, color: 'var(--text-muted)' }}>
            Showing {jobs.data.data.length} of {jobs.data.total} jobs
          </div>

          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>Queue</th>
                <th>Name</th>
                <th>Status</th>
                <th>Attempt</th>
                <th>Priority</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {jobs.data.data.length === 0 ? (
                <tr>
                  <td colSpan={7} style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 32 }}>
                    No jobs found
                  </td>
                </tr>
              ) : (
                jobs.data.data.map((job: Job) => (
                  <tr key={job.id} className="clickable" onClick={() => navigate(`/jobs/${job.id}`)}>
                    <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{job.id.slice(0, 12)}...</td>
                    <td>{job.queue}</td>
                    <td>{job.name}</td>
                    <td>
                      <span className={`badge ${job.status}`}>{job.status}</span>
                    </td>
                    <td>
                      {job.attempt}/{job.maxRetries}
                    </td>
                    <td>{job.priority}</td>
                    <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                      {new Date(job.createdAt).toLocaleString()}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>

          <div className="pagination">
            <button className="btn-sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>
              Previous
            </button>
            <span>
              Page {Math.floor(offset / PAGE_SIZE) + 1} of {Math.max(1, Math.ceil(jobs.data.total / PAGE_SIZE))}
            </span>
            <button className="btn-sm" disabled={!jobs.data.hasMore} onClick={() => setOffset(offset + PAGE_SIZE)}>
              Next
            </button>
          </div>
        </>
      )}
    </div>
  )
}
