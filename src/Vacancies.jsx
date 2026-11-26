import { POSITIONS } from './positions'
import { whatsappUrl } from './contacts'
import './Vacancies.css'

// «Вакансии»: the same list as «Желаемая вакансия» in the anketa
// (src/positions.js), so the site and the form never disagree
const VACANCIES = POSITIONS.filter(([code]) => code !== 'other')

function Vacancies() {
  return (
    <section className="vacancies" aria-labelledby="vacancies-title">
      <div className="vacancies-container">
        <h2 id="vacancies-title" className="vacancies-title">Вакансии</h2>
        <p className="vacancies-lead">Работа в отелях Турции. Нужную вакансию выберите в анкете.</p>
        <ul className="vacancies-grid">
          {VACANCIES.map(([code, ru, en]) => (
            <li key={code} className="vacancy-card">
              <b>{ru}</b>
              {ru !== en && <span lang="en">{en}</span>}
            </li>
          ))}
        </ul>
        <div className="vacancies-cta">
          <a href={whatsappUrl} target="_blank" rel="noopener noreferrer" className="vacancies-btn">Спросить о вакансии в WhatsApp</a>
        </div>
      </div>
    </section>
  )
}

export default Vacancies
