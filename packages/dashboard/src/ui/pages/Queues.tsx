import { Link } from 'react-router-dom'
import { fetchQueues } from '../api'
import { useFetch } from '../hooks'

export function QueuesPage() {
  const { data, loading, error, reload } = useFetch(() => fetchQueues(), [])

  if (loading) return <div className="loading">Loading...</div>
  if (error) return <div className="error">Error: {error}</div>
  if (!data) return null

  const queues = data.queues

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <h1 className="page-title" style={{ marginBottom: 0 }}>
          Queues
        </h1>
        <button onClick={reload}>Refresh</button>
      </div>

      {queues.length === 0 ? (
        <div className="loading">No queues found. Enqueue some jobs to see them here.</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Pending</th>
              <th>Active</th>
              <th>Completed</th>
              <th>Failed</th>
              <th>Total</th>
            </tr>
          </thead>
          <tbody>
            {queues.map((q) => {
              const total = q.pending + q.active + q.completed + q.failed
              return (
                <tr key={q.name}>
                  <td>
                    <Link to={`/jobs?queue=${q.name}`} style={{ color: 'var(--accent)', textDecoration: 'none' }}>
                      {q.name}
                    </Link>
                  </td>
                  <td>
                    <span className="badge pending">{q.pending}</span>
                  </td>
                  <td>
                    <span className="badge active">{q.active}</span>
                  </td>
                  <td>
                    <span className="badge completed">{q.completed}</span>
                  </td>
                  <td>
                    <span className="badge failed">{q.failed}</span>
                  </td>
                  <td>{total}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </div>
  )
}
