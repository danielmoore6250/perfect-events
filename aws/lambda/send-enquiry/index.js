const crypto = require('crypto');
const nodemailer = require('nodemailer');
const { SESv2Client, SendEmailCommand } = require('@aws-sdk/client-sesv2');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand } = require('@aws-sdk/lib-dynamodb');

// Amazon SES v2 client — authenticates via the Lambda's IAM role (no passwords).
const sesClient = new SESv2Client({ region: 'eu-west-1' });

// DynamoDB holds one record per enquiry so bookings live somewhere other than the inbox.
const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'eu-west-1' }), {
  marshallOptions: { removeUndefinedValues: true }
});
const BOOKINGS_TABLE = process.env.BOOKINGS_TABLE;

// Every email is sent from the business address on the SES-verified domain.
const FROM = 'Perfect Events NI <enquiries@perfecteventsni.com>';

const EVENT_TYPE_LABELS = {
  wedding: 'Wedding',
  private: 'Private Event/Party',
  corporate: 'Corporate Event',
  'pa-hire': 'PA Hire & Engineering'
};

const WEDDING_PACKAGE_LABELS = {
  'full-night': 'Full Night',
  'after-band': 'After Band',
  'not-sure': 'Not Sure Yet'
};

// Client input is never trusted inside email HTML — escape it everywhere.
const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]);

const trim = (value) => (typeof value === 'string' ? value.trim() : value == null ? '' : String(value));

// Keeps the ISO date the form sends (YYYY-MM-DD); anything unparseable becomes 'unknown'
// so the record still sorts predictably in the by-date index.
const normaliseDate = (value) => {
  const text = trim(value);
  const parsed = new Date(text);
  return text && !Number.isNaN(parsed.getTime()) ? text.slice(0, 10) : 'unknown';
};

const formatDate = (value) => {
  const parsed = new Date(trim(value));
  return Number.isNaN(parsed.getTime())
    ? 'Not specified'
    : parsed.toLocaleDateString('en-GB', { year: 'numeric', month: 'long', day: 'numeric' });
};

const labelFor = (labels, value, fallback = 'Not specified') => {
  const text = trim(value);
  if (!text) return fallback;
  return labels[text] || text.charAt(0).toUpperCase() + text.slice(1).replace(/-/g, ' ');
};

// Saves the enquiry as a booking record in the 'enquiry' stage.
// Returns the record, or null if the write failed — the emails go out either way,
// because losing the enquiry entirely is worse than losing the record of it.
const saveEnquiry = async (enquiry) => {
  if (!BOOKINGS_TABLE) {
    console.warn('BOOKINGS_TABLE is not set — skipping the booking record');
    return null;
  }

  const now = new Date().toISOString();
  const record = {
    id: crypto.randomUUID(),
    recordType: 'booking',
    status: 'enquiry',
    source: 'website',
    createdAt: now,
    updatedAt: now,
    eventDate: normaliseDate(enquiry.eventDate),
    client: {
      name: enquiry.name,
      email: enquiry.email,
      phone: enquiry.phone
    },
    event: {
      type: enquiry.eventType || null,
      weddingPackage: enquiry.eventType === 'wedding' ? enquiry.weddingPackage || null : null,
      venue: enquiry.venue || null,
      guestCount: enquiry.guestCount || null
    },
    message: enquiry.message || null,
    statusHistory: [{ status: 'enquiry', at: now, by: 'website-form' }]
  };

  try {
    await docClient.send(new PutCommand({ TableName: BOOKINGS_TABLE, Item: record }));
    console.log('Booking record saved:', record.id);
    return record;
  } catch (err) {
    console.error('Failed to save booking record:', err.message, err);
    return null;
  }
};

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  // Handle CORS preflight
  if (event.requestContext?.http?.method === 'OPTIONS' || event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  const method = event.requestContext?.http?.method || event.httpMethod;
  if (method !== 'POST') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  try {
    const submitted = JSON.parse(event.body);

    const formData = {
      name: trim(submitted.name),
      email: trim(submitted.email),
      phone: trim(submitted.phone),
      eventType: trim(submitted.eventType),
      weddingPackage: trim(submitted.weddingPackage),
      eventDate: trim(submitted.eventDate),
      venue: trim(submitted.venue),
      guestCount: trim(submitted.guestCount),
      message: trim(submitted.message)
    };

    // Validate required fields
    if (!formData.name || !formData.email || !formData.phone) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Missing required fields' })
      };
    }

    // Save first so the enquiry is on record before any email is attempted.
    const record = await saveEnquiry(formData);
    const reference = record ? record.id.slice(0, 8).toUpperCase() : null;

    // Pre-escaped values for the email templates.
    const safe = {
      name: esc(formData.name),
      email: esc(formData.email),
      phone: esc(formData.phone),
      eventType: esc(labelFor(EVENT_TYPE_LABELS, formData.eventType, 'Event')),
      weddingPackage: esc(labelFor(WEDDING_PACKAGE_LABELS, formData.weddingPackage)),
      eventDate: esc(formatDate(formData.eventDate)),
      venue: esc(formData.venue || 'Not specified'),
      guestCount: esc(formData.guestCount || 'Not specified'),
      message: esc(formData.message).replace(/\n/g, '<br>'),
      reference: esc(reference || 'not recorded')
    };

    // Send via Amazon SES (no SMTP, no passwords — uses the Lambda IAM role)
    console.log('Sending via Amazon SES from:', FROM);

    const transporter = nodemailer.createTransport({
      SES: { sesClient, SendEmailCommand }
    });

    console.log('Transporter created, attempting to send business email...');

    // Email to business
    const businessMailOptions = {
      from: FROM,
      to: 'enquiries@perfecteventsni.com',
      subject: `New Enquiry from ${formData.name} - ${labelFor(EVENT_TYPE_LABELS, formData.eventType, 'Event')}`,
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
                <h1>🎵 New Event Enquiry</h1>
                <p style="margin: 10px 0 0 0; opacity: 0.9;">Perfect Events NI</p>
              </div>

              <div class="content">
                <div class="section">
                  <div class="section-title">Client Information</div>
                  <div class="info-grid">
                    <div class="info-item">
                      <div class="info-label">Name</div>
                      <div class="info-value">${safe.name}</div>
                    </div>
                    <div class="info-item">
                      <div class="info-label">Email</div>
                      <div class="info-value"><a href="mailto:${encodeURI(formData.email)}" style="color: #0d0d0d;">${safe.email}</a></div>
                    </div>
                    <div class="info-item">
                      <div class="info-label">Phone</div>
                      <div class="info-value"><a href="tel:${encodeURI(formData.phone)}" style="color: #0d0d0d;">${safe.phone}</a></div>
                    </div>
                  </div>
                </div>

                <div class="section">
                  <div class="section-title">Event Details</div>
                  <div class="info-grid">
                    <div class="info-item">
                      <div class="info-label">Event Type</div>
                      <div class="info-value">${safe.eventType}</div>
                    </div>
                    <div class="info-item">
                      <div class="info-label">Event Date</div>
                      <div class="info-value">${safe.eventDate}</div>
                    </div>
                    <div class="info-item">
                      <div class="info-label">Venue/Location</div>
                      <div class="info-value">${safe.venue}</div>
                    </div>
                    <div class="info-item">
                      <div class="info-label">Expected Guests</div>
                      <div class="info-value">${safe.guestCount}</div>
                    </div>
                    ${formData.eventType === 'wedding' ? `
                    <div class="info-item">
                      <div class="info-label">Wedding Package</div>
                      <div class="info-value">${safe.weddingPackage}</div>
                    </div>
                    ` : ''}
                  </div>
                </div>

                ${formData.message ? `
                <div class="section">
                  <div class="section-title">Additional Details</div>
                  <div class="message-box">${safe.message}</div>
                </div>
                ` : ''}

                <div class="footer">
                  <p>This enquiry was submitted through Perfect Events NI website</p>
                  <p>Reply to: ${safe.email}</p>
                  <p>Booking reference: ${safe.reference}</p>
                </div>
              </div>
            </div>
          </body>
        </html>
      `
    };

    // Confirmation email to user
    const userMailOptions = {
      from: FROM,
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
                <h1>✓ Enquiry Received!</h1>
                <p style="margin: 10px 0 0 0; opacity: 0.9;">Thank you for choosing Perfect Events NI</p>
              </div>

              <div class="content">
                <div class="section">
                  <p>Hi ${safe.name},</p>
                  <p>Thank you for submitting your event enquiry! We're thrilled that you're considering Perfect Events NI for your ${safe.eventType.toLowerCase()}.</p>
                </div>

                <div class="highlight">
                  <p><strong>What happens next?</strong></p>
                  <p>Our team will review your enquiry shortly and get back to you within <strong>24 hours</strong> with a personalised quote and to discuss your requirements.</p>
                </div>

                <div class="section">
                  <p><strong>Your Event Details:</strong></p>
                  <div class="summary-box">
                    <div class="summary-label">Event Type</div>
                    <div class="summary-value">${safe.eventType}</div>
                  </div>
                  <div class="summary-box">
                    <div class="summary-label">Event Date</div>
                    <div class="summary-value">${safe.eventDate}</div>
                  </div>
                  <div class="summary-box">
                    <div class="summary-label">Venue</div>
                    <div class="summary-value">${safe.venue}</div>
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

    // Track email sending results
    const results = {
      businessEmailSent: false,
      userEmailSent: false,
      errors: []
    };

    // Send business email
    try {
      await transporter.sendMail(businessMailOptions);
      results.businessEmailSent = true;
      console.log('Business email sent successfully');
    } catch (err) {
      console.error('Failed to send business email:', err.message, err);
      results.errors.push(`Business email failed: ${err.message}`);
    }

    // Send user email with same transporter
    try {
      await transporter.sendMail(userMailOptions);
      results.userEmailSent = true;
      console.log('User confirmation email sent successfully');
    } catch (err) {
      console.error('Failed to send user email:', err.message, err);
      results.errors.push(`User email failed: ${err.message}`);
    }

    console.log('Email results:', JSON.stringify(results, null, 2));

    // The enquiry is safe once it is either recorded or emailed to the business.
    if (record || results.businessEmailSent) {
      if (!results.businessEmailSent || !results.userEmailSent) {
        console.warn('Partial delivery:', { saved: Boolean(record), ...results });
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({
            success: true,
            message: 'Enquiry received. There was a minor issue, but we have it on record.'
          })
        };
      }

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          success: true,
          message: 'Enquiry sent successfully'
        })
      };
    }

    console.error('Enquiry was neither saved nor emailed to the business');
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: 'Failed to send enquiry',
        details: 'Email service temporarily unavailable. Please try again or contact us directly.'
      })
    };
  } catch (error) {
    console.error('Enquiry handling error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: 'Failed to send enquiry',
        details: error.message
      })
    };
  }
};
