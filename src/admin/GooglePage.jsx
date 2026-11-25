import { useEffect, useState } from 'react'
import { api } from './api'

// Google Drive for anketa copies: connected once with the agency's Google
// account. Google sends the manager back to #/google?ok=1 or ?error=…
function GooglePage({ onError }) {
  const [drive, setDrive] = useState(null)
  const [busy, setBusy] = useState(false)
  const query = new URLSearchParams(window.location.hash.split('?')[1] || '')
  const [message] = useState(query.get('ok') ? { ok: true, text: 'Google Диск подключён. Анкеты, которые уже есть, копируются туда сейчас, новые — сразу после отправки.' }
    : query.get('error') ? { ok: false, text: query.get('error') } : null)

  useEffect(() => {
    api('GET', '/google').then(setDrive).catch(onError)
  }, [onError])

  const disconnect = async () => {
    if (!window.confirm('Отключить Google Диск? Новые анкеты перестанут туда копироваться. То, что уже скопировано, останется на Диске.')) return
    setBusy(true)
    try {
      setDrive(await api('DELETE', '/google'))
    } catch (err) { onError(err) } finally { setBusy(false) }
  }

  return (
    <article>
      <a href="#/" className="cab-back">← Все заявки</a>
      <h1>Google Диск</h1>
      {message && <p className={message.ok ? 'cab-ok' : 'cab-error'}>{message.text}</p>}
      <section className="cab-section">
        {!drive ? <p className="cab-hint">Загрузка…</p>
          : !drive.configured ? (
            <p>Google Диск ещё не настроен на сервере. Напишите разработчику.</p>
          ) : drive.connected ? (
            <>
              <p>Подключён: <b>{drive.email}</b></p>
              <p className="cab-hint">Каждая анкета — отдельная папка «Имя — дата — анкета №» с PDF и фото внутри папки «BUY SUN — анкеты с сайта». Исправили анкету в кабинете — файлы на Диске обновятся.</p>
              <div className="cab-actions">
                <a className="cab-btn" href={drive.folder_url} target="_blank" rel="noopener noreferrer">Открыть папку</a>
                <button type="button" className="cab-btn secondary" disabled={busy} onClick={disconnect}>Отключить</button>
              </div>
            </>
          ) : (
            <>
              <p>Анкеты с сайта будут сами сохраняться на ваш Google Диск: каждая в своей папке, с PDF и фото.</p>
              <ol className="cab-steps">
                <li>Нажмите «Подключить Google Диск».</li>
                <li>Выберите Google-аккаунт, где хотите хранить анкеты.</li>
                <li>Нажмите «Разрешить». Пароль от Google никому давать не нужно.</li>
              </ol>
              <p className="cab-hint">Сайт видит на Диске только папки и файлы, которые создал сам, — остальные ваши файлы ему недоступны.</p>
              <a className="cab-btn" href="/api/admin/google/connect">Подключить Google Диск</a>
            </>
          )}
      </section>
    </article>
  )
}

export default GooglePage
