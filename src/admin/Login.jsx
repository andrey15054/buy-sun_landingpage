import { useState } from 'react'
import { api } from './api'

// Getting in: email and password, and on the first login a new password
// instead of the temporary one.
function Login({ state, onDone }) {
  const step = state?.next || 'login'
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const run = async (action) => {
    setError('')
    setBusy(true)
    try {
      onDone(await action())
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="cab-login">
      <div className="cab-card">
        <div className="cab-login-brand">BUY SUN</div>
        <h1>Кабинет менеджера</h1>
        {step === 'login' && <PasswordStep busy={busy} run={run} />}
        {step === 'password' && <NewPasswordStep busy={busy} run={run} name={state.user.name} />}
        {error && <p className="cab-error" role="alert">{error}</p>}
      </div>
    </div>
  )
}

function PasswordStep({ busy, run }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  return (
    <form onSubmit={(e) => { e.preventDefault(); run(() => api('POST', '/login', { email, password })) }}>
      <label className="cab-field">
        <span>Email</span>
        <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
      </label>
      <label className="cab-field">
        <span>Пароль</span>
        <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
      </label>
      <button className="cab-btn" disabled={busy}>{busy ? 'Проверяем…' : 'Войти'}</button>
    </form>
  )
}

function NewPasswordStep({ busy, run, name }) {
  const [password, setPassword] = useState('')
  const [repeat, setRepeat] = useState('')
  const [mismatch, setMismatch] = useState(false)
  const submit = (e) => {
    e.preventDefault()
    if (password !== repeat) return setMismatch(true)
    setMismatch(false)
    run(() => api('POST', '/password', { password }))
  }
  return (
    <form onSubmit={submit}>
      <p className="cab-lead">{name}, это первый вход. Придумайте свой пароль: не короче 10 символов, временный больше не подойдёт.</p>
      <label className="cab-field">
        <span>Новый пароль</span>
        <input type="password" autoComplete="new-password" minLength={10} value={password} onChange={(e) => setPassword(e.target.value)} required autoFocus />
      </label>
      <label className="cab-field">
        <span>Ещё раз</span>
        <input type="password" autoComplete="new-password" minLength={10} value={repeat} onChange={(e) => setRepeat(e.target.value)} required />
      </label>
      {mismatch && <p className="cab-error" role="alert">Пароли не совпадают</p>}
      <button className="cab-btn" disabled={busy}>Сохранить пароль</button>
    </form>
  )
}

export default Login
