import { motion } from 'framer-motion'
import { CONTACTS, whatsappUrl } from './contacts'
import './Footer.css'

function Footer() {
  const containerVariants = {
    hidden: { opacity: 0 },
    visible: {
      opacity: 1,
      transition: {
        staggerChildren: 0.1,
        delayChildren: 0.2
      }
    }
  }

  const itemVariants = {
    hidden: { opacity: 0, y: 20 },
    visible: {
      opacity: 1,
      y: 0,
      transition: {
        duration: 0.5,
        ease: [0.22, 1, 0.36, 1]
      }
    }
  }

  return (
    <footer className="footer">
      <div className="footer-container">
        <motion.div 
          className="footer-brand"
          variants={itemVariants}
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true, margin: "-50px" }}
        >
          BUY <br/> SUN
        </motion.div>
        <motion.div 
          className="footer-social"
          variants={containerVariants}
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true, margin: "-50px" }}
        >
          <motion.a 
            href={CONTACTS.telegram} 
            target="_blank"
            rel="noopener noreferrer"
            className="footer-social-icon" 
            aria-label="Telegram"
            whileHover={{ scale: 1.15, y: -3 }}
            whileTap={{ scale: 0.95 }}
            variants={itemVariants}
          >
            <img src="/tg.png" alt="Telegram" />
          </motion.a>
          <motion.a 
            href={CONTACTS.tiktok} 
            target="_blank"
            rel="noopener noreferrer"
            className="footer-social-icon" 
            aria-label="TikTok"
            whileHover={{ scale: 1.15, y: -3 }}
            whileTap={{ scale: 0.95 }}
            variants={itemVariants}
          >
            <img src="/tt.png" alt="TikTok" />
          </motion.a>
          <motion.a 
            href={whatsappUrl} 
            target="_blank"
            rel="noopener noreferrer"
            className="footer-social-icon" 
            aria-label="WhatsApp"
            whileHover={{ scale: 1.15, y: -3 }}
            whileTap={{ scale: 0.95 }}
            variants={itemVariants}
          >
            <img src="/wa.png" alt="WhatsApp" />
          </motion.a>
          <motion.a 
            href={CONTACTS.instagram} 
            target="_blank"
            rel="noopener noreferrer"
            className="footer-social-icon" 
            aria-label="Instagram"
            whileHover={{ scale: 1.15, y: -3 }}
            whileTap={{ scale: 0.95 }}
            variants={itemVariants}
          >
            <img src="/inst.png" alt="Instagram" />
          </motion.a>
        </motion.div>
        <a className="footer-privacy" href="/privacy.html">Политика конфиденциальности</a>
      </div>
    </footer>
  )
}

export default Footer