require('dotenv').config({ path: '.env.test' });

// Mock console methods to reduce noise during tests
global.console = {
  ...console,
  log: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  info: jest.fn()
};
