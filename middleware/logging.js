// middleware/logging.js - Better Stack logging middleware
const { Logtail } = require('@logtail/node');

// Initialize Logtail with your token
const logtail = new Logtail(process.env.LOGTAIL_TOKEN);

const loggingMiddleware = (req, res, next) => {
  const startTime = Date.now();
  
  // Capture original end function
  const originalEnd = res.end;
  
  // Override res.end to capture response data
  res.end = function(chunk, encoding) {
    const responseTime = Date.now() - startTime;
    
    // Log structured data to Better Stack
    const logData = {
      timestamp: new Date().toISOString(),
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
      contentLength: res.get('Content-Length') || 0
    };

    // Send to Better Stack
    if (res.statusCode >= 400) {
      logtail.error('API Error', logData);
    } else {
      logtail.info('API Request', logData);
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
    timestamp: new Date().toISOString(),
    error: error.message,
    stack: error.stack,
    url: req?.originalUrl || 'Unknown',
    method: req?.method || 'Unknown',
    ip: req?.ip || req?.connection?.remoteAddress || 'Unknown'
  };

  logtail.error('Application Error', errorData);
  
  if (process.env.NODE_ENV !== 'production') {
    console.error('Error:', error);
  }
};

module.exports = {
  loggingMiddleware,
  logError,
  logtail
};
