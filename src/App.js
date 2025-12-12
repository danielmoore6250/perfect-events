import './App.css';
import { useState } from 'react';
import EnquireModal from './components/EnquireModal';
import ServiceDetailsModal from './components/ServiceDetailsModal';
import ReviewCarousel from './components/ReviewCarousel';

function App() {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [selectedEventType, setSelectedEventType] = useState('');
  const [selectedService, setSelectedService] = useState(null);

  const services = [
    {
      id: 'wedding',
      title: 'Wedding DJ',
      icon: '💍',
      description: 'Create the perfect soundtrack for your big day. From ceremony to reception, we\'ll keep your guests dancing all night long.',
      backTitle: 'Wedding Packages',
      details: [
        'Full night and after-band packages',
        'Max 4.5 hour DJ set',
        'Playing the music YOU want',
        'Give us your favourite songs',
        'Our knowledge + your music = amazing night',
        'Don\'t like certain songs? We won\'t play it',
        'Professional sound & lighting system'
      ]
    },
    {
      id: 'private',
      title: 'Private Events',
      icon: '🎉',
      description: 'Birthday parties, anniversaries, and celebrations. We bring the energy and entertainment your guests will love.',
      backTitle: 'Private Event Packages',
      details: [
        'Covering all private events from birthday parties and other celebrations',
        'Max 4.5 hour DJ set',
        'Professional sound & lighting system',
        'Customisable playlist to tailor your event to the music you like'
      ]
    },
    {
      id: 'corporate',
      title: 'Corporate Events',
      icon: '🏢',
      description: 'Professional entertainment for conferences, product launches, and company celebrations. We keep it professional and fun.',
      backTitle: 'Corporate Packages',
      details: [
        'Let us take care of your corporate event',
        'Radio Personality Declan Wilson to host',
        'DJ included for post meal/awards entertainment',
        'Professional sound system'
      ]
    },
    {
      id: 'pa-hire',
      title: 'PA Hire & Engineering',
      icon: '🔊',
      description: 'Full sound system solutions with experienced engineers. Perfect for any venue size and event type.',
      backTitle: 'PA Hire Packages',
      details: [
        'Need a sound system? We have you covered',
        'Professional sound system with on-site engineer',
        'Our team present as your sound engineer',
        'System hire includes trained engineer',
        'No system hire without our team present'
      ]
    }
  ];

  const openServiceDetails = (service) => {
    setSelectedService(service);
  };

  const closeServiceDetails = () => {
    setSelectedService(null);
  };

  const scrollToSection = (id) => {
    const element = document.getElementById(id);
    if (element) {
      element.scrollIntoView({ behavior: 'smooth' });
    }
    setIsMobileMenuOpen(false); // Close menu after clicking
  };

  const openEnquire = (eventType = '') => {
    setSelectedEventType(eventType);
    setIsModalOpen(true);
    setIsMobileMenuOpen(false);
  };

  const closeEnquire = () => {
    setIsModalOpen(false);
    setSelectedEventType('');
  };

  return (
    <div className="App">
      {/* Navigation */}
      <nav className="navbar">
        <div className="nav-container">
          <div className="logo">
            <img 
              src={process.env.PUBLIC_URL + '/perfect_events_logo.png'} 
              alt="Perfect Events NI" 
              className="logo-img"
              style={{ borderRadius: '50%' }}
              onError={(e) => {e.target.style.display = 'none'}}
            />
            <span className="logo-text">Perfect Events NI</span>
          </div>
          
          {/* Desktop Menu */}
          <ul className={`nav-menu ${isMobileMenuOpen ? 'active' : ''}`}>
            <li><button onClick={() => scrollToSection('home')} className="nav-link">Home</button></li>
            <li><button onClick={() => scrollToSection('services')} className="nav-link">Services</button></li>
            <li><button onClick={() => scrollToSection('about')} className="nav-link">About</button></li>
            <li><button onClick={() => scrollToSection('testimonials')} className="nav-link">Testimonials</button></li>
            <li><button onClick={() => scrollToSection('contact')} className="nav-link">Contact</button></li>
            <li><button onClick={openEnquire} className="nav-link enquire-btn">Enquire Now</button></li>
          </ul>

          {/* Mobile Controls */}
          <div className="mobile-controls">
            <button onClick={openEnquire} className="enquire-btn-mobile">Enquire Now</button>
            <button 
              className={`hamburger ${isMobileMenuOpen ? 'active' : ''}`}
              onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
              aria-label="Toggle menu"
            >
              <span></span>
              <span></span>
              <span></span>
            </button>
          </div>
        </div>
      </nav>

      {/* Hero Section */}
      <section id="home" className="hero">
        <div className="hero-content">
          <img 
            src={process.env.PUBLIC_URL + '/perfect_events_logo.png'} 
            alt="Perfect Events NI Logo" 
            className="hero-logo"
          />
          <h1 className="hero-title">Perfect Events NI</h1>
          <p className="hero-subtitle">Professional DJ Services for Every Occasion</p>
          <div className="hero-taglines">
            <span className="tagline">Your Event</span>
            <span className="tagline-separator">•</span>
            <span className="tagline">Your Music</span>
            <span className="tagline-separator">•</span>
            <span className="tagline">Your Way</span>
          </div>
        </div>
      </section>

      {/* Services Section */}
      <section id="services" className="services">
        <div className="container">
          <h2 className="section-title">Our Services</h2>
          <div className="services-grid">
            {services.map((service) => (
              <div key={service.id} className="service-card">
                <div className="service-card-icon">{service.icon}</div>
                <h3>{service.title}</h3>
                <p>{service.description}</p>
                <button onClick={() => openServiceDetails(service)} className="more-info-btn">More Info</button>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Features Section */}
      <section id="about" className="features">
        <div className="container">
          <h2 className="section-title">Why Choose Perfect Events NI?</h2>
          <div className="features-grid">
            <div className="feature">
              <h3>✓ No Cheesy Content</h3>
              <p>We keep it professional and sophisticated. No tacky requests—just quality entertainment.</p>
            </div>
            <div className="feature">
              <h3>✓ Tailored to You</h3>
              <p>Every event is unique. We customize our music selection to match your exact preferences.</p>
            </div>
            <div className="feature">
              <h3>✓ Professional Quality</h3>
              <p>Premium sound systems and equipment to ensure crystal-clear audio at any venue.</p>
            </div>
            <div className="feature">
              <h3>✓ Experienced Team</h3>
              <p>Years of experience making events memorable across Ireland and Northern Ireland.</p>
            </div>
            <div className="feature">
              <h3>✓ Full Technical Support</h3>
              <p>On-site engineers to manage all technical aspects of your event.</p>
            </div>
            <div className="feature">
              <h3>✓ Flexible Packages</h3>
              <p>Options to suit any budget and event requirements.</p>
            </div>
          </div>

          {/* About Section */}
          <div className="about-section">
            <h2 className="section-title" style={{marginTop: '4rem'}}>About Perfect Events NI</h2>
            <div className="about-content">
              <div className="about-text">
                <h3>Professional DJ Services for Ireland</h3>
                <p>Based in <strong>Belfast, Northern Ireland</strong>, we provide professional DJ services throughout <strong>Ireland</strong>. Whether you're planning a wedding, private celebration, corporate event, or need PA equipment, we've got you covered.</p>
                <p><strong>Our Philosophy:</strong> We don't do cheesy. We believe in creating the perfect atmosphere through professional expertise and personalized music curation. Every event is different, and we tailor our services to your specific music needs and preferences.</p>
                <p>Our mission is to ensure you get <strong>value for money and help you enjoy your special day</strong>. We're invested in developing a personal connection with each and every one of our customers, providing quality service.</p>
                <p>We only use the <strong>best sound and lighting equipment</strong> to ensure your event is looking and sounding sharp!</p>
              </div>
            </div>

            {/* Team Section */}
            <div className="team-section">
              <h3 className="team-title">Meet Our Team</h3>
              <div className="team-grid">
                <div className="team-member">
                  <div className="member-name">Declan Wilson</div>
                  <div className="member-title">Award-Winning DJ</div>
                  <p className="member-bio">With over 15 years of experience in the entertainment industry, Declan is an award-winning radio DJ from Northern Ireland. His passion for entertainment spans singing in function bands, solo performances, and keeping the party going as a popular DJ.</p>
                  <div className="member-experience">15+ Years Experience</div>
                </div>

                <div className="team-member">
                  <div className="member-name">Daniel Moore</div>
                  <div className="member-title">Professional DJ</div>
                  <p className="member-bio">With 10 years of industry experience, Daniel brings creativity and technical expertise to every event. His deep knowledge of music curation and audience engagement ensures every celebration is unforgettable.</p>
                  <div className="member-experience">10 Years Experience</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Testimonials Section */}
      <section id="testimonials" className="testimonials">
        <div className="container">
          <h2 className="section-title">Client Testimonials</h2>
          <ReviewCarousel />
        </div>
      </section>

      {/* Contact Section */}
      <section id="contact" className="contact">
        <div className="container">
          <h2 className="section-title">Get In Touch</h2>
          <div className="contact-content">
            <div className="contact-info">
              <div className="info-item">
                <h4>📧 Email</h4>
                <p>enquiries@perfecteventsni.com</p>
              </div>
              <div className="info-item">
                <h4>📍 Location</h4>
                <p>Belfast, Northern Ireland</p>
                <p style={{fontSize: '0.9rem', marginTop: '0.5rem', color: 'rgba(255, 255, 255, 0.6)'}}>Serving all of Ireland</p>
              </div>
            </div>
            <div className="contact-cta">
              <h3>Ready to Book Your Event?</h3>
              <p>We can't wait to meet you and look forward to entertaining at your special occasion!</p>
              <button onClick={openEnquire} className="cta-button large">Send an Enquiry</button>
            </div>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="footer">
        <div className="container">
          <p>&copy; 2025 Perfect Events NI. All rights reserved.</p>
        </div>
      </footer>

      {/* Enquire Modal */}
      <EnquireModal isOpen={isModalOpen} onClose={closeEnquire} preSelectedEventType={selectedEventType} />
      
      {/* Service Details Modal */}
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
