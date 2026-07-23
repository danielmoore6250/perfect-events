import './App.css';
import { useState, useEffect, useRef } from 'react';
import EnquireModal from './components/EnquireModal';
import ServiceDetailsModal from './components/ServiceDetailsModal';
import ReviewCarousel from './components/ReviewCarousel';
import {
  CheckIcon,
  MailIcon,
  LocationIcon,
  StarIcon,
  ArrowIcon,
} from './components/Icons';

const services = [
  {
    id: 'wedding',
    title: 'Wedding DJ',
    description:
      "The soundtrack to your big day — from the first dance to the last song, played the way you want it.",
    backTitle: 'Wedding Packages',
    details: [
      'Full night and after-band packages',
      'Max 4.5 hour DJ set',
      'Playing the music YOU want',
      'Give us your favourite songs',
      'Our knowledge + your music = amazing night',
      "Don't like certain songs? We won't play it",
      'Professional sound & lighting system',
    ],
  },
  {
    id: 'private',
    title: 'Private Events',
    description:
      'Birthdays, anniversaries and celebrations — real energy and entertainment your guests will remember.',
    backTitle: 'Private Event Packages',
    details: [
      'Covering all private events from birthday parties and other celebrations',
      'Max 4.5 hour DJ set',
      'Professional sound & lighting system',
      'Customisable playlist to tailor your event to the music you like',
    ],
  },
  {
    id: 'corporate',
    title: 'Corporate Events',
    description:
      'Polished entertainment for conferences, launches and company celebrations. Professional, never cheesy.',
    backTitle: 'Corporate Packages',
    details: [
      'Let us take care of your corporate event',
      'Radio Personality Declan Wilson to host',
      'DJ included for post meal/awards entertainment',
      'Professional sound system',
    ],
  },
  {
    id: 'pa-hire',
    title: 'PA Hire & Engineering',
    description:
      'Full sound-system solutions with an experienced engineer on site — right for any venue and event.',
    backTitle: 'PA Hire Packages',
    details: [
      'Need a sound system? We have you covered',
      'Professional sound system with on-site engineer',
      'Our team present as your sound engineer',
      'System hire includes trained engineer',
      'No system hire without our team present',
    ],
  },
];

const features = [
  { title: 'No cheesy content', text: 'We keep it professional and sophisticated. No tacky requests — just quality entertainment.' },
  { title: 'Tailored to you', text: 'Every event is unique. We curate the music to match your exact taste and crowd.' },
  { title: 'Professional quality', text: 'Premium sound systems and equipment for crystal-clear audio at any venue.' },
  { title: 'Experienced team', text: 'Years of experience making events memorable across Ireland and Northern Ireland.' },
  { title: 'Full technical support', text: 'On-site engineers manage every technical aspect of your event, start to finish.' },
  { title: 'Flexible packages', text: 'Options to suit any budget and event requirement, with no surprises.' },
];

function App() {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [selectedEventType, setSelectedEventType] = useState('');
  const [selectedService, setSelectedService] = useState(null);
  const [navScrolled, setNavScrolled] = useState(false);
  const appRef = useRef(null);

  // Sticky-nav background on scroll
  useEffect(() => {
    const onScroll = () => setNavScrolled(window.scrollY > 24);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  // Scroll-reveal for elements marked .reveal
  useEffect(() => {
    const els = Array.from(document.querySelectorAll('.reveal'));
    if (!('IntersectionObserver' in window) || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      els.forEach((el) => el.classList.add('in'));
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add('in');
            io.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.15, rootMargin: '0px 0px -60px 0px' }
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);

  const openServiceDetails = (service) => setSelectedService(service);
  const closeServiceDetails = () => setSelectedService(null);

  const scrollToSection = (id) => {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' });
    setIsMobileMenuOpen(false);
  };

  const openEnquire = (eventType = '') => {
    setSelectedEventType(typeof eventType === 'string' ? eventType : '');
    setIsModalOpen(true);
    setIsMobileMenuOpen(false);
  };

  const closeEnquire = () => {
    setIsModalOpen(false);
    setSelectedEventType('');
  };

  const logo = process.env.PUBLIC_URL + '/perfect_events_logo.png';

  return (
    <div className="App" ref={appRef}>
      {/* ===== Navigation ===== */}
      <nav className="nav" data-scrolled={navScrolled}>
        <div className="nav__inner container">
          <button className="nav__brand" onClick={() => scrollToSection('home')} aria-label="Perfect Events NI — home">
            <img src={logo} alt="Perfect Events NI" className="nav__logo" onError={(e) => { e.target.style.display = 'none'; }} />
            <span className="nav__name">Perfect Events NI</span>
          </button>

          <ul className={`nav__menu ${isMobileMenuOpen ? 'active' : ''}`}>
            <li><button className="nav__link" onClick={() => scrollToSection('home')}>Home</button></li>
            <li><button className="nav__link" onClick={() => scrollToSection('services')}>Services</button></li>
            <li><button className="nav__link" onClick={() => scrollToSection('about')}>About</button></li>
            <li><button className="nav__link" onClick={() => scrollToSection('testimonials')}>Reviews</button></li>
            <li><button className="nav__link" onClick={() => scrollToSection('contact')}>Contact</button></li>
          </ul>

          <div className="nav__actions">
            <button className="btn btn--solid nav__cta" onClick={() => openEnquire()}>Enquire</button>
            <button
              className={`nav__burger ${isMobileMenuOpen ? 'active' : ''}`}
              onClick={() => setIsMobileMenuOpen((v) => !v)}
              aria-label="Toggle menu"
              aria-expanded={isMobileMenuOpen}
            >
              <span></span><span></span><span></span>
            </button>
          </div>
        </div>
      </nav>

      {/* ===== Hero ===== */}
      <section id="home" className="hero">
        <div className="hero__media">
          <img src={process.env.PUBLIC_URL + '/images/hero-dj.jpg'} alt="Perfect Events NI DJ mixing at an event in Belfast" className="hero__img" />
        </div>
        <div className="hero__scrim"></div>
        <div className="hero__grain"></div>

        <div className="hero__inner container">
          <div className="hero__content">
            <p className="eyebrow">Your event · Your music · Your way</p>
            <h1 className="hero__title">Wedding &amp; event DJs<em> in Belfast &amp; across Ireland</em></h1>
            <p className="hero__lead">
              Professional DJ hire and event entertainment for weddings, private parties and
              corporate events across Belfast and all of Ireland. No cheesy content — just the
              soundtrack your night deserves.
            </p>
            <div className="hero__actions">
              <button className="btn btn--solid btn--lg" onClick={() => openEnquire()}>
                Enquire now <ArrowIcon />
              </button>
              <button className="btn btn--ghost btn--lg" onClick={() => scrollToSection('services')}>
                Explore services
              </button>
            </div>

            <ul className="hero__stats">
              <li>
                <span className="stat__num">15+</span>
                <span className="stat__label">Years experience</span>
              </li>
              <li>
                <span className="stat__num">
                  5.0 <span className="stat__stars"><StarIcon /></span>
                </span>
                <span className="stat__label">Client rating</span>
              </li>
              <li>
                <span className="stat__num">All Ireland</span>
                <span className="stat__label">Weddings · Private · Corporate</span>
              </li>
            </ul>
          </div>
        </div>
      </section>

      {/* ===== Services ===== */}
      <section id="services" className="section">
        <div className="container">
          <div className="section__head">
            <p className="eyebrow">What we do</p>
            <h2 className="section__title">Services built around your event</h2>
            <p className="section__sub">
              Four ways we keep the floor full — every one tailored to your crowd, your venue and your taste.
            </p>
          </div>

          <div className="services__grid">
            {services.map((service, i) => (
              <article key={service.id} className="scard reveal" data-delay={i % 4}>
                <h3 className="scard__title">{service.title}</h3>
                <p className="scard__text">{service.description}</p>
                <button className="scard__link" onClick={() => openServiceDetails(service)}>
                  More info <ArrowIcon />
                </button>
              </article>
            ))}
          </div>
        </div>
      </section>

      {/* ===== Why choose / Features ===== */}
      <section id="about" className="section section--alt">
        <div className="container">
          <div className="section__head">
            <p className="eyebrow">Why Perfect Events NI</p>
            <h2 className="section__title">The details that make the night</h2>
          </div>

          <div className="features__grid">
            {features.map((f, i) => (
              <div key={f.title} className="feature reveal" data-delay={i % 3}>
                <span className="feature__check"><CheckIcon /></span>
                <div>
                  <h3>{f.title}</h3>
                  <p>{f.text}</p>
                </div>
              </div>
            ))}
          </div>

          {/* About */}
          <div className="about">
            <div className="about__text reveal">
              <h3>Professional DJ services for Ireland</h3>
              <p>
                Based in <strong>Belfast, Northern Ireland</strong>, we provide professional DJ
                services throughout <strong>Ireland</strong> — weddings, private celebrations,
                corporate events, and PA equipment with a trained engineer.
              </p>
              <p>
                <strong>Our philosophy:</strong> we don't do cheesy. We create the perfect atmosphere
                through professional expertise and personalised music curation. Every event is
                different, and we tailor everything to your music and your crowd.
              </p>
              <p>
                Our mission is simple — <strong>value for money and a night you'll never forget</strong>.
                We only use the best sound and lighting equipment so your event looks and sounds sharp.
              </p>
            </div>
            <div className="about__media reveal" data-delay="1">
              <img src={process.env.PUBLIC_URL + '/images/decks.jpg'} alt="Professional DJ decks and mixer" />
            </div>
          </div>

          {/* Team */}
          <div className="team">
            <div className="section__head section__head--center">
              <p className="eyebrow">The team</p>
              <h2 className="section__title">Behind the decks</h2>
            </div>
            <div className="team__grid">
              <div className="member reveal">
                <div className="member__row">
                  <span className="member__name">Declan Wilson</span>
                  <span className="member__title">Award-winning DJ</span>
                </div>
                <p className="member__bio">
                  With over 15 years in entertainment, Declan is an award-winning radio DJ from
                  Northern Ireland. His passion spans singing in function bands, solo performances,
                  and keeping the party going as a popular DJ.
                </p>
                <span className="member__exp">15+ years experience</span>
              </div>
              <div className="member reveal" data-delay="1">
                <div className="member__row">
                  <span className="member__name">Daniel Moore</span>
                  <span className="member__title">Professional DJ</span>
                </div>
                <p className="member__bio">
                  With 10 years of industry experience, Daniel brings creativity and technical
                  expertise to every event. His knowledge of music curation and reading a crowd keeps
                  every celebration unforgettable.
                </p>
                <span className="member__exp">10 years experience</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ===== Testimonials ===== */}
      <section id="testimonials" className="section">
        <div className="container">
          <div className="section__head section__head--center">
            <p className="eyebrow">Kind words</p>
            <h2 className="section__title">What our clients say</h2>
            <div className="testimonials__rating" style={{ justifyContent: 'center' }}>
              <span className="stat__stars">
                <StarIcon /><StarIcon /><StarIcon /><StarIcon /><StarIcon />
              </span>
              <span>Rated 5.0 by couples and event organisers across Ireland</span>
            </div>
          </div>
          <ReviewCarousel />
        </div>
      </section>

      {/* ===== Contact ===== */}
      <section id="contact" className="section section--alt">
        <div className="container">
          <div className="section__head">
            <p className="eyebrow">Get in touch</p>
            <h2 className="section__title">Let's talk about your event</h2>
          </div>

          <div className="contact__grid">
            <div className="contact__info">
              <div className="info-card">
                <span className="info-card__icon"><MailIcon /></span>
                <div>
                  <div className="info-card__label">Email</div>
                  <div className="info-card__value">enquiries@perfecteventsni.com</div>
                </div>
              </div>
              <div className="info-card">
                <span className="info-card__icon"><LocationIcon /></span>
                <div>
                  <div className="info-card__label">Based in</div>
                  <div className="info-card__value">Belfast, Northern Ireland</div>
                  <div className="info-card__value small">Serving all of Ireland</div>
                </div>
              </div>
            </div>

            <div className="contact__cta">
              <h3>Ready to book your event?</h3>
              <p>
                Tell us the date, the venue and the vibe — we'll get back to you quickly with
                availability and a package that fits.
              </p>
              <button className="btn btn--solid btn--lg" onClick={() => openEnquire()} style={{ alignSelf: 'flex-start' }}>
                Send an enquiry <ArrowIcon />
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* ===== Footer ===== */}
      <footer className="footer">
        <div className="container footer__inner">
          <div className="footer__brand">
            <img src={logo} alt="" onError={(e) => { e.target.style.display = 'none'; }} />
            Perfect Events NI
          </div>
          <div className="footer__meta">© {new Date().getFullYear()} Perfect Events NI — All rights reserved</div>
        </div>
      </footer>

      {/* Modals */}
      <EnquireModal isOpen={isModalOpen} onClose={closeEnquire} preSelectedEventType={selectedEventType} />
      <ServiceDetailsModal
        isOpen={selectedService !== null}
        onClose={closeServiceDetails}
        service={selectedService}
        onEnquire={openEnquire}
      />
    </div>
  );
}

export default App;
