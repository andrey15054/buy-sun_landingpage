import { whatsappUrl } from './contacts'
import './PriceSplit.css'

// «Кто за что платит»: what the candidate pays and what the employer covers,
// and the way from the anketa to the flight. Prices are in the «Тарифы» block.
const YOU_PAY = [
  ['Услуги BUY SUN', 'по тарифу вашей страны, см. «Тарифы»'],
  ['Консульский сбор', 'платится консульству, сумма зависит от страны'],
  ['Услуги визового центра', 'для Казахстана 80 000 ₸'],
]

const EMPLOYER_PAYS = [
  'Авиаперелёт туда и обратно',
  'Проживание в общежитии',
  'Трансфер от общежития до отеля',
  'Медицинская страховка в Турции',
  'Униформа и материалы для работы',
]

const STEPS = [
  ['Анкета', 'Заполните анкету на сайте или напишите нам в WhatsApp'],
  ['Собеседование', 'В Алматы или в Астане'],
  ['Документы', 'Договор и рабочая виза по законам Казахстана и Турции'],
  ['Вылет', 'Тренинг перед поездкой, перелёт за счёт работодателя'],
  ['Работа', 'Русскоязычный куратор в Турции до вашего возвращения'],
]

function PriceSplit() {
  return (
    <section className="price-split" aria-labelledby="price-split-title">
      <div className="price-split-container">
        <h2 id="price-split-title" className="price-split-title">Кто за что платит</h2>
        <p className="price-split-lead">Коротко: что оплачиваете вы и что берёт на себя работодатель.</p>

        <div className="price-split-grid">
          <div className="price-split-card you">
            <h3>Оплачиваете вы</h3>
            <ul>
              {YOU_PAY.map(([title, note]) => (
                <li key={title}><b>{title}</b><span>{note}</span></li>
              ))}
            </ul>
          </div>
          <div className="price-split-card employer">
            <h3>Оплачивает работодатель</h3>
            <ul>
              {EMPLOYER_PAYS.map((title) => <li key={title}><b>{title}</b></li>)}
            </ul>
            <p className="price-split-salary">Зарплата 750–1200 $ в месяц</p>
          </div>
        </div>

        <h3 className="price-split-steps-title">От анкеты до вылета</h3>
        <ol className="price-split-steps">
          {STEPS.map(([title, text], i) => (
            <li key={title}>
              <span className="price-split-step-number">{i + 1}</span>
              <b>{title}</b>
              <span>{text}</span>
            </li>
          ))}
        </ol>

        <div className="price-split-cta">
          <p>Точную сумму для вашей страны менеджер назовёт до подписания договора.</p>
          <a href={whatsappUrl} target="_blank" rel="noopener noreferrer" className="price-split-btn">Узнать стоимость в WhatsApp</a>
        </div>
      </div>
    </section>
  )
}

export default PriceSplit
