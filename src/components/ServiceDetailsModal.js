import React from 'react';
import '../styles/ServiceDetailsModal.css';

function ServiceDetailsModal({ isOpen, onClose, service, onEnquire }) {
  if (!isOpen || !service) return null;

  return (
    <div className="service-modal-overlay" onClick={onClose}>
      <div className="service-modal-content" onClick={(e) => e.stopPropagation()}>
        <button className="service-modal-close" onClick={onClose}>&times;</button>
        
        <div className="service-modal-header">
          <div className="service-modal-icon">{service.icon}</div>
          <h2>{service.title}</h2>
        </div>

        <div className="service-modal-body">
          <h3>{service.backTitle}</h3>
          <ul className="package-details-modal">
            {service.details.map((detail, index) => (
              <li key={index}>{detail}</li>
            ))}
          </ul>
        </div>

        <div className="service-modal-actions">
          <button 
            onClick={() => {
              onEnquire(service.id);
              onClose();
            }} 
            className="enquire-btn-modal"
          >
            Enquire Now
          </button>
          <button onClick={onClose} className="close-btn-modal">Close</button>
        </div>
      </div>
    </div>
  );
}

export default ServiceDetailsModal;
