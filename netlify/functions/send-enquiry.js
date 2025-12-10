const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');

// Handler function for sending enquiries
exports.handler = async (event) => {
  // Only allow POST requests
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  try {
    const formData = JSON.parse(event.body);

    // Validate required fields
    if (!formData.name || !formData.email || !formData.phone) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Missing required fields' })
      };
    }

    // Create transporter using environment variables (Office 365 via GoDaddy)
    console.log('Creating transporter with:', {
      host: 'smtp.office365.com',
      port: 587,
      user: process.env.EMAIL_USER
    });
    
    const transporter = nodemailer.createTransport({
      host: 'smtp.office365.com',
      port: 587,
      secure: false,
      requireTLS: true,
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
      }
    });

    console.log('Transporter created, attempting to send business email...');

    // Get logo as base64 (for local testing)
    let logoBase64 = '';
    try {
      const logoPath = path.join(__dirname, '../../public/perfect-events-logo.png');
      if (fs.existsSync(logoPath)) {
        const logoBuffer = fs.readFileSync(logoPath);
        logoBase64 = logoBuffer.toString('base64');
      }
    } catch (err) {
      console.log('Logo not found, continuing without it');
    }

    // Email to business
    const businessMailOptions = {
      from: process.env.EMAIL_USER,
      to: 'enquiries@perfecteventsni.com',
      subject: `New Enquiry from ${formData.name} - ${formData.eventType}`,
      html: `
        <!DOCTYPE html>
        <html>
          <head>
            <style>
              body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; line-height: 1.6; color: #333; }
              .container { max-width: 600px; margin: 0 auto; background: #f9f9f9; padding: 20px; border-radius: 8px; }
              .header { background: #0d0d0d; color: white; padding: 30px 20px; border-radius: 8px 8px 0 0; text-align: center; }
              .logo { max-width: 100px; height: auto; margin-bottom: 15px; }
              .header h1 { margin: 0; font-size: 24px; }
              .content { background: white; padding: 30px; border-radius: 0 0 8px 8px; }
              .section { margin-bottom: 25px; }
              .section-title { font-weight: 600; font-size: 14px; color: #0d0d0d; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 10px; border-bottom: 2px solid #f0f0f0; padding-bottom: 8px; }
              .info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 15px; margin-top: 10px; }
              .info-item { background: #f9f9f9; padding: 12px; border-radius: 6px; }
              .info-label { font-size: 12px; color: #999; text-transform: uppercase; font-weight: 600; margin-bottom: 4px; }
              .info-value { font-size: 15px; color: #333; }
              .message-box { background: #f0f0f0; padding: 15px; border-left: 4px solid #0d0d0d; border-radius: 4px; margin-top: 10px; }
              .footer { text-align: center; padding: 20px; color: #999; font-size: 12px; border-top: 1px solid #e0e0e0; margin-top: 20px; }
              .cta-button { display: inline-block; background: #0d0d0d; color: white; padding: 12px 30px; border-radius: 6px; text-decoration: none; margin-top: 20px; font-weight: 600; }
            </style>
          </head>
          <body>
            <div class="container">
              <div class="header">
                ${logoBase64 ? `<img src="data:image/png;base64,${logoBase64}" alt="Perfect Events NI" class="logo">` : ''}
                <h1>🎵 New Event Enquiry</h1>
                <p style="margin: 10px 0 0 0; opacity: 0.9;">Perfect Events NI</p>
              </div>
              
              <div class="content">
                <div class="section">
                  <div class="section-title">Client Information</div>
                  <div class="info-grid">
                    <div class="info-item">
                      <div class="info-label">Name</div>
                      <div class="info-value">${formData.name}</div>
                    </div>
                    <div class="info-item">
                      <div class="info-label">Email</div>
                      <div class="info-value"><a href="mailto:${formData.email}" style="color: #0d0d0d;">${formData.email}</a></div>
                    </div>
                    <div class="info-item">
                      <div class="info-label">Phone</div>
                      <div class="info-value"><a href="tel:${formData.phone}" style="color: #0d0d0d;">${formData.phone}</a></div>
                    </div>
                  </div>
                </div>

                <div class="section">
                  <div class="section-title">Event Details</div>
                  <div class="info-grid">
                    <div class="info-item">
                      <div class="info-label">Event Type</div>
                      <div class="info-value">${formData.eventType.charAt(0).toUpperCase() + formData.eventType.slice(1).replace('-', ' ')}</div>
                    </div>
                    <div class="info-item">
                      <div class="info-label">Event Date</div>
                      <div class="info-value">${new Date(formData.eventDate).toLocaleDateString('en-GB', { year: 'numeric', month: 'long', day: 'numeric' })}</div>
                    </div>
                    <div class="info-item">
                      <div class="info-label">Venue/Location</div>
                      <div class="info-value">${formData.venue}</div>
                    </div>
                    <div class="info-item">
                      <div class="info-label">Expected Guests</div>
                      <div class="info-value">${formData.guestCount || 'Not specified'}</div>
                    </div>
                  </div>
                </div>

                ${formData.message ? `
                <div class="section">
                  <div class="section-title">Additional Details</div>
                  <div class="message-box">${formData.message.replace(/\n/g, '<br>')}</div>
                </div>
                ` : ''}

                <div class="footer">
                  <p>This enquiry was submitted through Perfect Events NI website</p>
                  <p>Reply to: ${formData.email}</p>
                </div>
              </div>
            </div>
          </body>
        </html>
      `
    };

    // Confirmation email to user
    const userMailOptions = {
      from: process.env.EMAIL_USER,
      to: formData.email,
      subject: 'We Received Your Enquiry - Perfect Events NI',
      html: `
        <!DOCTYPE html>
        <html>
          <head>
            <style>
              body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; line-height: 1.6; color: #333; }
              .container { max-width: 600px; margin: 0 auto; background: #f9f9f9; padding: 20px; border-radius: 8px; }
              .header { background: #0d0d0d; color: white; padding: 30px 20px; border-radius: 8px 8px 0 0; text-align: center; }
              .logo { max-width: 100px; height: auto; margin-bottom: 15px; }
              .header h1 { margin: 0; font-size: 24px; }
              .content { background: white; padding: 30px; border-radius: 0 0 8px 8px; }
              .section { margin-bottom: 25px; }
              .highlight { background: #f0f0f0; padding: 20px; border-radius: 8px; border-left: 4px solid #0d0d0d; }
              .highlight p { margin: 10px 0; }
              .summary-box { background: #f9f9f9; padding: 15px; border-radius: 6px; margin: 15px 0; }
              .summary-label { font-size: 12px; color: #999; text-transform: uppercase; font-weight: 600; }
              .summary-value { font-size: 15px; color: #333; margin-top: 5px; }
              .cta-section { text-align: center; margin: 30px 0; }
              .cta-button { display: inline-block; background: #0d0d0d; color: white; padding: 14px 40px; border-radius: 6px; text-decoration: none; font-weight: 600; font-size: 16px; }
              .footer { text-align: center; padding: 20px; color: #999; font-size: 12px; border-top: 1px solid #e0e0e0; margin-top: 20px; }
              .contact-info { margin-top: 20px; }
              .contact-item { margin: 10px 0; }
            </style>
          </head>
          <body>
            <div class="container">
              <div class="header">
                ${logoBase64 ? `<img src="data:image/png;base64,${logoBase64}" alt="Perfect Events NI" class="logo">` : ''}
                <h1>✓ Enquiry Received!</h1>
                <p style="margin: 10px 0 0 0; opacity: 0.9;">Thank you for choosing Perfect Events NI</p>
              </div>
              
              <div class="content">
                <div class="section">
                  <p>Hi ${formData.name},</p>
                  <p>Thank you for submitting your event enquiry! We're thrilled that you're considering Perfect Events NI for your ${formData.eventType}.</p>
                </div>

                <div class="highlight">
                  <p><strong>What happens next?</strong></p>
                  <p>Our team will review your enquiry shortly and get back to you within <strong>24 hours</strong> with a personalised quote and to discuss your requirements.</p>
                </div>

                <div class="section">
                  <p><strong>Your Event Details:</strong></p>
                  <div class="summary-box">
                    <div class="summary-label">Event Type</div>
                    <div class="summary-value">${formData.eventType.charAt(0).toUpperCase() + formData.eventType.slice(1).replace('-', ' ')}</div>
                  </div>
                  <div class="summary-box">
                    <div class="summary-label">Event Date</div>
                    <div class="summary-value">${new Date(formData.eventDate).toLocaleDateString('en-GB', { year: 'numeric', month: 'long', day: 'numeric' })}</div>
                  </div>
                  <div class="summary-box">
                    <div class="summary-label">Venue</div>
                    <div class="summary-value">${formData.venue}</div>
                  </div>
                </div>

                <div class="section">
                  <p><strong>Why Choose Perfect Events NI?</strong></p>
                  <ul>
                    <li>✓ 15+ years of professional DJ and entertainment experience</li>
                    <li>✓ Professional PA hire & engineering support</li>
                    <li>✓ Your Event • Your Music • Your Way</li>
                    <li>✓ Don't like it? We won't play it!</li>
                    <li>✓ Competitive pricing & flexible packages</li>
                    <li>✓ Available 24/7 for your peace of mind</li>
                  </ul>
                </div>

                <div class="section">
                  <p>If you have any questions before we get back to you, feel free to reply to this email or contact us directly:</p>
                  <div class="contact-info">
                    <div class="contact-item">📧 <a href="mailto:enquiries@perfecteventsni.com" style="color: #0d0d0d; text-decoration: none;">enquiries@perfecteventsni.com</a></div>
                  </div>
                </div>

                <div class="footer">
                  <p style="margin-top: 0;">Perfect Events NI • Professional DJ & Entertainment Services</p>
                  <p style="margin-bottom: 0;">Belfast, Northern Ireland</p>
                </div>
              </div>
            </div>
          </body>
        </html>
      `
    };

    // Send business email
    try {
      await transporter.sendMail(businessMailOptions);
      console.log('Business email sent successfully');
    } catch (err) {
      console.error('Failed to send business email:', err.message);
    }

    // Send user email with same transporter
    try {
      await transporter.sendMail(userMailOptions);
      console.log('User confirmation email sent successfully');
    } catch (err) {
      console.error('Failed to send user email:', err.message);
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ 
        success: true, 
        message: 'Enquiry sent successfully' 
      })
    };
  } catch (error) {
    console.error('Email send error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ 
        error: 'Failed to send enquiry',
        details: error.message 
      })
    };
  }
};
