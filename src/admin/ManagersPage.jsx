import { useEffect, useState } from 'react'
import { api } from './api'
import { formatDate } from './common'

const STATUS = {
  active: ['ok', 'Работает'],
  new: ['wait', 'Ещё не вошёл'],
  disabled: ['off', 'Доступ закрыт'],
}

// Who can open the cabinet: add a colleague, give a new temporary password
// (forgotten password), close access for someone who left
function ManagersPage({ onError }) {
  const [items, setItems] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  // A temporary password is shown once, to send to the manager privately
  const [issued, setIssued] = useState(null)
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')

  useEffect(() => {
    api('GET', '/managers').then((d) => setItems(d.items)).catch(onError)
  }, [onError])

  const run = async (action) => {
    setBusy(true)
    setError('')
    try {
      await action()
    } catch (err) {
      onError(err)
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }
  const replace = (manager) => setItems((list) => {
    const rest = list.filter((m) => m.id !== manager.id)
    return [...rest, manager].sort((a, b) => a.id - b.id)
  })

  const add = (e) => {
    e.preventDefault()
    run(async () => {
      const { manager, password } = await api('POST', '/managers', { name, email })
      replace(manager)
      setIssued({ manager, password, first: true })
      setName('')
      setEmail('')
    })
  }
  const reset = (m) => {
    if (!window.confirm(`Выдать ${m.name} новый временный пароль? Старый пароль перестанет работать, ${m.name} выйдет из кабинета на всех устройствах.`)) return
    run(async () => {
      const { manager, password } = await api('POST', `/managers/${m.id}/reset`)
      replace(manager)
      setIssued({ manager, password })
    })
  }
  const toggle = (m) => {
    const close = m.status !== 'disabled'
    if (close && !window.confirm(`Закрыть доступ ${m.name}? Вход в кабинет сразу перестанет работать.`)) return
    run(async () => replace((await api('POST', `/managers/${m.id}/${close ? 'disable' : 'enable'}`)).manager))
  }

  const copy = async (e) => {
    try {
      await navigator.clipboard.writeText(e.currentTarget.dataset.text)
    } catch {
      e.currentTarget.parentElement.querySelector('input').select()
      document.execCommand('copy')
    }
  }

  return (
    <article>
      <a href="#/" className="cab-back">← Все заявки</a>
      <h1>Менеджеры</h1>
      {error && <p className="cab-error" role="alert">{error}</p>}

      {issued && (
        <section className="cab-section cab-issued" role="status">
          <h2>{issued.first ? 'Менеджер добавлен' : 'Новый временный пароль'}</h2>
          <p>Менеджер: <b>{issued.manager.name}</b>, {issued.manager.email}. Отправьте ему сообщение со входом лично, не в общий чат:</p>
          {(() => {
            const message = `Кабинет BUY SUN: https://buysun.kz/admin/\nПочта: ${issued.manager.email}\nВременный пароль: ${issued.password}\nПри первом входе придумайте свой пароль.`
            return (
              <div className="cab-share-row">
                <input className="cab-search" readOnly value={issued.password} onFocus={(e) => e.target.select()} aria-label="Временный пароль" />
                <button type="button" className="cab-btn" data-text={message} onClick={copy}>Скопировать сообщение</button>
              </div>
            )
          })()}
          <p className="cab-hint cab-gap">Пароль показан один раз. Закроете страницу — понадобится выдать новый.</p>
        </section>
      )}

      <section className="cab-section">
        <h2>Кто может входить в кабинет</h2>
        {!items ? <p className="cab-hint">Загрузка…</p> : (
          <ul className="cab-managers">
            {items.map((m) => {
              const [tone, label] = STATUS[m.status]
              return (
                <li key={m.id}>
                  <div>
                    <b>{m.name}</b>{m.me && <span className="cab-hint"> (это вы)</span>}
                    <div className="cab-hint">{m.email}</div>
                    <div className="cab-badges">
                      <span className={`cab-badge ${tone}`}>{label}</span>
                      {m.last_login_at && <span className="cab-hint">последний вход {formatDate(m.last_login_at)}</span>}
                    </div>
                  </div>
                  {!m.me && (
                    <div className="cab-actions">
                      <button type="button" className="cab-btn secondary" disabled={busy} onClick={() => reset(m)}>Сбросить пароль</button>
                      <button type="button" className="cab-btn secondary" disabled={busy} onClick={() => toggle(m)}>
                        {m.status === 'disabled' ? 'Открыть доступ' : 'Закрыть доступ'}
                      </button>
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </section>

      <section className="cab-section">
        <h2>Добавить менеджера</h2>
        <form className="cab-add-manager" onSubmit={add}>
          <label className="cab-field">
            <span>Имя</span>
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} required />
          </label>
          <label className="cab-field">
            <span>Email</span>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} maxLength={200} required />
          </label>
          <button className="cab-btn" disabled={busy}>Добавить</button>
        </form>
        <p className="cab-hint cab-gap">Сайт выдаст временный пароль. При первом входе менеджер придумает свой.</p>
      </section>
    </article>
  )
}

export default ManagersPage
