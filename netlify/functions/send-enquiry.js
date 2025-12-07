const nodemailer = require('nodemailer');

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

    // Create transporter using environment variables
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
      }
    });

    // Email to business
    const businessMailOptions = {
      from: process.env.EMAIL_USER,
      to: 'hello@perfecteventsni.com',
      subject: `New Enquiry from ${formData.name} - ${formData.eventType}`,
      html: `
        <h2>New Event Enquiry</h2>
        <p><strong>Name:</strong> ${formData.name}</p>
        <p><strong>Email:</strong> ${formData.email}</p>
        <p><strong>Phone:</strong> ${formData.phone}</p>
        <p><strong>Event Type:</strong> ${formData.eventType}</p>
        <p><strong>Event Date:</strong> ${formData.eventDate}</p>
        <p><strong>Venue:</strong> ${formData.venue}</p>
        <p><strong>Guest Count:</strong> ${formData.guestCount || 'Not specified'}</p>
        <p><strong>Message:</strong></p>
        <p>${formData.message || 'No additional details'}</p>
        <hr />
        <p>Reply to: ${formData.email}</p>
      `
    };

    // Confirmation email to user
    const userMailOptions = {
      from: process.env.EMAIL_USER,
      to: formData.email,
      subject: 'We Received Your Enquiry - Perfect Events NI',
      html: `
        <h2>Thank You for Your Enquiry!</h2>
        <p>Hi ${formData.name},</p>
        <p>We've received your enquiry for your ${formData.eventType} event on ${formData.eventDate}.</p>
        <p>We'll review your details and get back to you within 24 hours.</p>
        <p>If you need anything else in the meantime, feel free to get in touch.</p>
        <p>Best regards,<br />Perfect Events NI</p>
      `
    };

    // Send both emails
    await transporter.sendMail(businessMailOptions);
    await transporter.sendMail(userMailOptions);

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
