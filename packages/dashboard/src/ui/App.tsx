import { BrowserRouter, Routes, Route, NavLink } from 'react-router-dom'
import { OverviewPage } from './pages/Overview'
import { QueuesPage } from './pages/Queues'
import { JobsPage } from './pages/Jobs'
import { JobDetailPage } from './pages/JobDetail'
import { EventsPage } from './pages/Events'

export function App() {
  return (
    <BrowserRouter>
      <div className="app">
        <nav className="sidebar">
          <div className="logo">PsyQueue</div>
          <ul>
            <li>
              <NavLink to="/" end>
                Overview
              </NavLink>
            </li>
            <li>
              <NavLink to="/queues">Queues</NavLink>
            </li>
            <li>
              <NavLink to="/jobs">Jobs</NavLink>
            </li>
            <li>
              <NavLink to="/events">Live Events</NavLink>
            </li>
          </ul>
        </nav>
        <main className="content">
          <Routes>
            <Route path="/" element={<OverviewPage />} />
            <Route path="/queues" element={<QueuesPage />} />
            <Route path="/jobs" element={<JobsPage />} />
            <Route path="/jobs/:id" element={<JobDetailPage />} />
            <Route path="/events" element={<EventsPage />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  )
}
