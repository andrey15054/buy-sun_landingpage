import { CONTACTS, whatsappUrl } from './contacts'
import './Faq.css'

// «Вопросы и ответы». Answers repeat only what the site already says
// (tariffs, what is included, what the employer gives); change them here.
const offices = CONTACTS.offices.map((o) => `${o.city}: ${o.address}`).join('; ')

const FAQ = [
  ['Сколько стоит трудоустройство?',
    'Зависит от страны, все цены — в блоке «Тарифы». Для Казахстана: 160 000 ₸, если вы уже ездили с нами, и 190 000 ₸ для новых клиентов. Отдельно оплачиваются консульский сбор и услуги визового центра.'],
  ['Что входит в стоимость?',
    'Консультация, профессиональное резюме, юридическая поддержка в оформлении рабочей визы, собеседование, тренинг перед вылетом и постоянный русскоязычный куратор в Турции.'],
  ['Что оплачивает работодатель?',
    'Авиаперелёт туда и обратно, проживание в общежитии, трансфер от общежития до отеля, медицинскую страховку в Турции и униформу.'],
  ['Сколько можно заработать?',
    'Зарплата в отелях — 750–1200 $ в месяц, есть возможность дополнительного заработка.'],
  ['Где проходит собеседование?',
    `В наших офисах. ${offices}.`],
  ['Кто поможет, если в Турции возникнут сложности?',
    'Постоянный русскоязычный куратор. Мы сопровождаем вас на каждом этапе, вплоть до обратного вылета на родину.'],
  ['Как оформляются документы?',
    'Строго по законодательству Казахстана и Турции: подписывается трудовой договор и другие нужные соглашения, мы помогаем собрать документы для рабочей визы.'],
  ['Я не из Казахстана. Можно к вам?',
    'Да. Работаем с кандидатами из Узбекистана, Таджикистана, Кыргызстана, Азербайджана, России, Беларуси и Европы — цены для каждой страны в блоке «Тарифы».'],
  ['Как подать заявку?',
    'Нажмите «Заполнить анкету» вверху страницы. Подготовьте 5 фото и укажите 2–3 места работы. После отправки откроется WhatsApp, а менеджер свяжется с вами.'],
]

// The same questions for search engines (Google shows them under the site)
const structuredData = JSON.stringify({
  '@context': 'https://schema.org',
  '@type': 'FAQPage',
  mainEntity: FAQ.map(([q, a]) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })),
})

function Faq() {
  return (
    <section className="faq" aria-labelledby="faq-title">
      <div className="faq-container">
        <h2 id="faq-title" className="faq-title">Вопросы и ответы</h2>
        <div className="faq-list">
          {FAQ.map(([question, answer]) => (
            <details key={question} className="faq-item">
              <summary>{question}</summary>
              <p>{answer}</p>
            </details>
          ))}
        </div>
        <div className="faq-cta">
          <p>Не нашли ответ? Спросите менеджера.</p>
          <a href={whatsappUrl} target="_blank" rel="noopener noreferrer" className="faq-btn">Задать вопрос в WhatsApp</a>
        </div>
      </div>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: structuredData }} />
    </section>
  )
}

export default Faq
