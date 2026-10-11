import { useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { getItem } from '../../preview/sampleData'

const TEST_FILE = /(^|\/)(tests?|e2e|__tests__)\/.*\.(spec|test)\.(js|jsx|ts|tsx|mjs|cjs|sql)$|\.(spec|test)\.(js|jsx|ts|tsx)$/
const TC_TAG = /@TC-\d+/g
const MAX_FILES = 40

function parseRepo(url) {
  const m = url?.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)$/)
  return m ? { owner: m[1], repo: m[2] } : null
}

export default function ProjectRepository() {
  const { project, setProject, can } = useOutletContext()
  const [editing, setEditing] = useState(false)

  return (
    <div className="stack">
      <div className="card">
        <div className="card-head">
          <h2>Repository</h2>
          {can('project.edit') && !editing && (
            <button type="button" className="secondary" onClick={() => setEditing(true)}>
              {project.repository_url ? 'Change link' : 'Link a repository'}
            </button>
          )}
        </div>
        <p className="muted small">
          The GitHub repository that holds this project's automated tests. Tests are matched to test cases by tags like{' '}
          <code>@TC-012</code> in their names, and CI results will be posted back as test runs.
        </p>
        {editing ? (
          <RepositoryForm
            project={project}
            onCancel={() => setEditing(false)}
            onSaved={(p) => {
              setProject(p)
              setEditing(false)
            }}
          />
        ) : project.repository_url ? (
          <p>
            <a href={project.repository_url} target="_blank" rel="noreferrer">
              {project.repository_url}
            </a>
          </p>
        ) : (
          <p className="muted">No repository linked yet.</p>
        )}
      </div>

      {project.repository_url && !editing && <RepositoryScan url={project.repository_url} />}
    </div>
  )
}

function RepositoryForm({ project, onCancel, onSaved }) {
  const [url, setUrl] = useState(project.repository_url ?? '')
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function handleSubmit(e) {
    e.preventDefault()
    setSaving(true)
    setError('')
    const { data, error } = await supabase.rpc('update_project_repository', {
      p_project: project.id,
      p_repository_url: url.trim(),
      p_reason: reason.trim() || null,
    })
    setSaving(false)
    if (error)
      setError(error.code === '23514' ? 'Enter a GitHub repository link like https://github.com/owner/repo' : error.message)
    else onSaved(data)
  }

  return (
    <form className="form-inline" onSubmit={handleSubmit}>
      <label>
        GitHub repository URL
        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://github.com/owner/repo" />
      </label>
      <label>
        Reason (recorded in the audit trail)
        <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
      </label>
      <p className="muted small">Leave the URL empty to remove the link.</p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="actions">
        <button type="submit" disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button type="button" className="secondary" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  )
}

// Reads the public repository straight from GitHub in the browser. Nothing is stored.
function RepositoryScan({ url }) {
  const [status, setStatus] = useState('idle') // idle | scanning | done | error
  const [error, setError] = useState('')
  const [result, setResult] = useState(null)

  async function scan() {
    const parsed = parseRepo(url)
    if (!parsed) return
    setStatus('scanning')
    setError('')
    try {
      const api = `https://api.github.com/repos/${parsed.owner}/${parsed.repo}`
      const repoRes = await fetch(api)
      if (repoRes.status === 404) throw new Error('Repository not found. It may be private: reading private repositories needs a GitHub token, which comes later.')
      if (repoRes.status === 403) throw new Error('GitHub rate limit reached (60 requests an hour without signing in). Try again later.')
      if (!repoRes.ok) throw new Error(`GitHub returned ${repoRes.status}`)
      const repo = await repoRes.json()

      const treeRes = await fetch(`${api}/git/trees/${repo.default_branch}?recursive=1`)
      if (!treeRes.ok) throw new Error(`Couldn't read the file list (GitHub returned ${treeRes.status})`)
      const tree = await treeRes.json()
      const testPaths = tree.tree.filter((n) => n.type === 'blob' && TEST_FILE.test(n.path)).map((n) => n.path)

      const files = await Promise.all(
        testPaths.slice(0, MAX_FILES).map(async (path) => {
          const raw = await fetch(`https://raw.githubusercontent.com/${parsed.owner}/${parsed.repo}/${repo.default_branch}/${path}`)
          const text = raw.ok ? await raw.text() : ''
          const tags = [...new Set(text.match(TC_TAG) ?? [])]
          const testCount = path.endsWith('.sql')
            ? (text.match(/select\s+(ok|is|isnt|results_eq|throws_ok|lives_ok|cmp_ok|col_type_is|has_column)\s*\(/gi) ?? []).length
            : (text.match(/\btest\s*\(/g) ?? []).length
          return { path, tags, testCount }
        }),
      )
      setResult({ repo, files, truncated: testPaths.length > MAX_FILES, scannedAt: new Date() })
      setStatus('done')
    } catch (e) {
      setError(e.message)
      setStatus('error')
    }
  }

  const allTags = result ? [...new Set(result.files.flatMap((f) => f.tags))].sort() : []

  return (
    <div className="card">
      <div className="card-head">
        <h3>Automated tests in this repository</h3>
        <button type="button" onClick={scan} disabled={status === 'scanning'}>
          {status === 'scanning' ? 'Scanning…' : status === 'done' ? 'Scan again' : 'Scan repository'}
        </button>
      </div>
      <p className="muted small">
        Reads the test files on the default branch and lists the <code>@TC-…</code> tags found. Read-only, and only public
        repositories for now.
      </p>

      {status === 'error' && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {status === 'done' && result && (
        <>
          <p className="small">
            <strong>{result.repo.full_name}</strong> · branch <code>{result.repo.default_branch}</code> · {result.files.length} test files ·{' '}
            {allTags.length} test case tags
            {result.truncated && ` (first ${MAX_FILES} files only)`}
          </p>
          <div className="table-wrap">
            <table aria-label="Test files">
              <thead>
                <tr>
                  <th>File</th>
                  <th>Tests</th>
                  <th>Test case tags</th>
                </tr>
              </thead>
              <tbody>
                {result.files.map((f) => (
                  <tr key={f.path}>
                    <td>
                      <a href={`${result.repo.html_url}/blob/${result.repo.default_branch}/${f.path}`} target="_blank" rel="noreferrer">
                        <code>{f.path}</code>
                      </a>
                    </td>
                    <td>{f.testCount}</td>
                    <td>
                      {f.tags.length === 0 ? (
                        <span className="muted small">No @TC tags yet</span>
                      ) : (
                        f.tags.map((t) => {
                          const tc = getItem(t.slice(1))
                          return (
                            <div key={t} className="small">
                              <code>{t}</code> {tc ? <span className="muted">{tc.title} (sample)</span> : <span className="error">no matching test case</span>}
                            </div>
                          )
                        })
                      )}
                    </td>
                  </tr>
                ))}
                {result.files.length === 0 && (
                  <tr>
                    <td colSpan={3} className="muted">
                      No test files found.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {allTags.length === 0 && result.files.length > 0 && (
            <p className="notice small">
              None of these tests are tagged with a test case ID yet. Once TC items exist (Phase 3), tag each test like{' '}
              <code>{"test('…', { tag: '@TC-001' }, …)"}</code> to link it.
            </p>
          )}
        </>
      )}
    </div>
  )
}
