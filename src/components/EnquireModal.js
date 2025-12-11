import { useState, useEffect } from 'react';
import '../styles/EnquireModal.css';

function EnquireModal({ isOpen, onClose, preSelectedEventType = '' }) {
  const [formData, setFormData] = useState({
    name: '',
    email: '',
    phone: '',
    eventDate: '',
    eventType: preSelectedEventType,
    weddingPackage: 'full-night',
    venue: '',
    guestCount: '',
    message: ''
  });

  const [isSubmitted, setIsSubmitted] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');

  // Update event type when preSelectedEventType changes and reset on modal open
  useEffect(() => {
    if (isOpen) {
      // Reset submitted state when modal opens
      setIsSubmitted(false);
      setError('');
      setIsLoading(false);
      
      // Update event type if pre-selected
      if (preSelectedEventType) {
        setFormData(prev => ({
          ...prev,
          eventType: preSelectedEventType
        }));
      }
    }
  }, [preSelectedEventType, isOpen]);

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
      // Send form data to Netlify function
      const response = await fetch('/.netlify/functions/send-enquiry', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(formData)
      });

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || 'Failed to send enquiry');
      }

      setIsSubmitted(true);

      // Reset form after 2 seconds
      setTimeout(() => {
        setIsSubmitted(false);
        setFormData({
          name: '',
          email: '',
          phone: '',
          eventDate: '',
          eventType: '',
          weddingPackage: 'full-night',
          venue: '',
          guestCount: '',
          message: ''
        });
        onClose();
      }, 2000);
    } catch (err) {
      console.error('Enquiry submission failed:', err);
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
                    <option value="">Select Event Type</option>
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

              {formData.eventType === 'wedding' && (
                <div className="form-row">
                  <div className="form-group">
                    <label htmlFor="weddingPackage">Wedding Package *</label>
                    <select
                      id="weddingPackage"
                      name="weddingPackage"
                      value={formData.weddingPackage}
                      onChange={handleChange}
                      required
                      disabled={isLoading}
                    >
                      <option value="full-night">Full Night</option>
                      <option value="after-band">After Band</option>
                      <option value="not-sure">Not Sure Yet</option>
                    </select>
                  </div>
                </div>
              )}

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
