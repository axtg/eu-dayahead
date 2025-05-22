const logtailToken = process.env.LOGTAIL_TOKEN;
const logtailEndpoint = process.env.LOGTAIL_ENDPOINT || 'https://s1319479.eu-nbg-2.betterstackdata.com';

if (!logtailToken) {
  console.warn('⚠️  LOGTAIL_TOKEN not found in environment variables');
} else {
  console.log('✅ Logtail token loaded:', logtailToken.substring(0, 8) + '...');
}

// Send log via HTTP endpoint
const sendToLogtail = async logData => {
  if (!logtailToken) return;

  const payload = JSON.stringify(logData);

  try {
    const response = await fetch(logtailEndpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${logtailToken}`,
        'Content-Type': 'application/json'
      },
      body: payload
    });

    if (!response.ok) {
      console.error('Failed to send log to Logtail:', response.status, response.statusText);
    }
  } catch (error) {
    console.error('Error sending to Logtail:', error.message);
  }
};

const loggingMiddleware = (req, res, next) => {
  const startTime = Date.now();

  // Capture original end function
  const originalEnd = res.end;

  // Override res.end to capture response data
  res.end = function (chunk, encoding) {
    const responseTime = Date.now() - startTime;

    // Log structured data to Better Stack
    const logData = {
      dt: new Date().toISOString(), // Better Stack expects 'dt' for timestamp
      level: res.statusCode >= 400 ? 'error' : 'info',
      message: `${req.method} ${req.originalUrl} - ${res.statusCode}`,
      method: req.method,
      url: req.originalUrl,
      path: req.path,
      statusCode: res.statusCode,
      responseTime: responseTime,
      userAgent: req.get('User-Agent') || 'Unknown',
      ip: req.ip || req.connection.remoteAddress || req.socket.remoteAddress,
      referrer: req.get('Referrer'),
      country: req.params.country || null,
      endpoint: req.route?.path || req.path,
      query: Object.keys(req.query).length > 0 ? req.query : null,
      contentLength: res.get('Content-Length') || 0,
      service: 'eu-dayahead-api',
      environment: process.env.NODE_ENV || 'development'
    };

    // Send to Better Stack asynchronously
    if (logtailToken) {
      sendToLogtail(logData).catch(err => {
        console.error('Logtail logging failed:', err.message);
      });
    }

    // Also log to console for local development
    if (process.env.NODE_ENV !== 'production') {
      console.log(`${req.method} ${req.originalUrl} - ${res.statusCode} - ${responseTime}ms`);
    }

    // Call original end function
    originalEnd.call(this, chunk, encoding);
  };

  next();
};

// Error logging function
const logError = (error, req = null) => {
  const errorData = {
    dt: new Date().toISOString(),
    level: 'error',
    message: `Application Error: ${error.message}`,
    error: error.message,
    stack: error.stack,
    url: req?.originalUrl || 'Unknown',
    method: req?.method || 'Unknown',
    ip: req?.ip || req?.connection?.remoteAddress || 'Unknown',
    service: 'eu-dayahead-api',
    environment: process.env.NODE_ENV || 'development'
  };

  if (logtailToken) {
    sendToLogtail(errorData).catch(err => {
      console.error('Logtail error logging failed:', err.message);
    });
  }

  if (process.env.NODE_ENV !== 'production') {
    console.error('Error:', error);
  }
};

module.exports = {
  loggingMiddleware,
  logError,
  sendToLogtail
};
