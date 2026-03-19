import { Link } from 'react-router-dom'
import { fetchOverview, fetchQueues } from '../api'
import { useFetch } from '../hooks'

export function OverviewPage() {
  const overview = useFetch(() => fetchOverview(), [])
  const queues = useFetch(() => fetchQueues(), [])

  if (overview.loading) return <div className="loading">Loading...</div>
  if (overview.error) return <div className="error">Error: {overview.error}</div>
  if (!overview.data) return null

  const d = overview.data

  return (
    <div>
      <h1 className="page-title">Overview</h1>

      <div className="stats-grid">
        <div className="stat-card">
          <div className="label">Pending</div>
          <div className="value pending">{d.totalPending}</div>
        </div>
        <div className="stat-card">
          <div className="label">Active</div>
          <div className="value active">{d.totalActive}</div>
        </div>
        <div className="stat-card">
          <div className="label">Completed</div>
          <div className="value completed">{d.totalCompleted}</div>
        </div>
        <div className="stat-card">
          <div className="label">Failed</div>
          <div className="value failed">{d.totalFailed}</div>
        </div>
      </div>

      {queues.data && queues.data.queues.length > 0 && (
        <>
          <h2 className="page-title" style={{ fontSize: 16, marginTop: 16 }}>
            Queues
          </h2>
          <table>
            <thead>
              <tr>
                <th>Queue</th>
                <th>Pending</th>
                <th>Active</th>
                <th>Completed</th>
                <th>Failed</th>
              </tr>
            </thead>
            <tbody>
              {queues.data.queues.map((q) => (
                <tr key={q.name}>
                  <td>
                    <Link to={`/jobs?queue=${q.name}`} style={{ color: 'var(--accent)', textDecoration: 'none' }}>
                      {q.name}
                    </Link>
                  </td>
                  <td>{q.pending}</td>
                  <td>{q.active}</td>
                  <td>{q.completed}</td>
                  <td>{q.failed}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  )
}
