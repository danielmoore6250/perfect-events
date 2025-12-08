import { useState } from 'react';
import emailjs from '@emailjs/browser';
import '../styles/EnquireModal.css';

// Initialize EmailJS
emailjs.init(process.env.REACT_APP_EMAILJS_PUBLIC_KEY);

function EnquireModal({ isOpen, onClose }) {
  const [formData, setFormData] = useState({
    name: '',
    email: '',
    phone: '',
    eventDate: '',
    eventType: 'wedding',
    venue: '',
    guestCount: '',
    message: ''
  });

  const [isSubmitted, setIsSubmitted] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');

  const handleChange = (e) => {
    const { name, value } = e.target;
    setFormData(prev => ({
      ...prev,
      [name]: value
    }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setIsLoading(true);
    setError('');

    try {
      // Send email via EmailJS
      const templateParams = {
        from_name: formData.name,
        from_email: formData.email,
        phone: formData.phone,
        event_date: formData.eventDate,
        event_type: formData.eventType,
        venue: formData.venue,
        guest_count: formData.guestCount,
        message: formData.message
      };

      await emailjs.send(
        process.env.REACT_APP_EMAILJS_SERVICE_ID,
        'template_ki9zsxj',
        templateParams
      );

      setIsSubmitted(true);

      // Reset form after 2 seconds
      setTimeout(() => {
        setIsSubmitted(false);
        setFormData({
          name: '',
          email: '',
          phone: '',
          eventDate: '',
          eventType: 'wedding',
          venue: '',
          guestCount: '',
          message: ''
        });
        onClose();
      }, 2000);
    } catch (err) {
      console.error('Email send failed:', err);
      setError(err.message || 'Failed to send enquiry. Please try again or contact us directly.');
      setIsLoading(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose}>&times;</button>
        
        {!isSubmitted ? (
          <>
            <h2>Enquire About Your Event</h2>
            {error && <div className="error-message">{error}</div>}
            <form onSubmit={handleSubmit} className="enquire-form">
              <div className="form-group">
                <label htmlFor="name">Full Name *</label>
                <input
                  type="text"
                  id="name"
                  name="name"
                  value={formData.name}
                  onChange={handleChange}
                  required
                  placeholder="Your Name"
                  disabled={isLoading}
                />
              </div>

              <div className="form-row">
                <div className="form-group">
                  <label htmlFor="email">Email *</label>
                  <input
                    type="email"
                    id="email"
                    name="email"
                    value={formData.email}
                    onChange={handleChange}
                    required
                    placeholder="Your Email"
                    disabled={isLoading}
                  />
                </div>
                <div className="form-group">
                  <label htmlFor="phone">Phone Number *</label>
                  <input
                    type="tel"
                    id="phone"
                    name="phone"
                    value={formData.phone}
                    onChange={handleChange}
                    required
                    placeholder="Your Phone"
                    disabled={isLoading}
                  />
                </div>
              </div>

              <div className="form-row">
                <div className="form-group">
                  <label htmlFor="eventType">Event Type *</label>
                  <select
                    id="eventType"
                    name="eventType"
                    value={formData.eventType}
                    onChange={handleChange}
                    required
                    disabled={isLoading}
                  >
                    <option value="wedding">Wedding</option>
                    <option value="private">Private Event/Party</option>
                    <option value="corporate">Corporate Event</option>
                    <option value="pa-hire">PA Hire & Engineering</option>
                  </select>
                </div>
                <div className="form-group">
                  <label htmlFor="eventDate">Event Date *</label>
                  <input
                    type="date"
                    id="eventDate"
                    name="eventDate"
                    value={formData.eventDate}
                    onChange={handleChange}
                    required
                    disabled={isLoading}
                  />
                </div>
              </div>

              <div className="form-row">
                <div className="form-group">
                  <label htmlFor="venue">Venue/Location *</label>
                  <input
                    type="text"
                    id="venue"
                    name="venue"
                    value={formData.venue}
                    onChange={handleChange}
                    required
                    placeholder="Where is your event?"
                    disabled={isLoading}
                  />
                </div>
                <div className="form-group">
                  <label htmlFor="guestCount">Expected Guests</label>
                  <input
                    type="number"
                    id="guestCount"
                    name="guestCount"
                    value={formData.guestCount}
                    onChange={handleChange}
                    placeholder="Approximate guest count"
                    disabled={isLoading}
                  />
                </div>
              </div>

              <div className="form-group">
                <label htmlFor="message">Additional Details</label>
                <textarea
                  id="message"
                  name="message"
                  value={formData.message}
                  onChange={handleChange}
                  placeholder="Tell us about your event, music preferences, special requests..."
                  rows="4"
                  disabled={isLoading}
                />
              </div>

              <button type="submit" className="submit-btn" disabled={isLoading}>
                {isLoading ? 'Sending...' : 'Send Enquiry'}
              </button>
            </form>
          </>
        ) : (
          <div className="success-message">
            <h3>✓ Enquiry Received!</h3>
            <p>Thank you for your interest. We'll get back to you shortly!</p>
          </div>
        )}
      </div>
    </div>
  );
}

export default EnquireModal;
