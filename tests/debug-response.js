// tests/debug-response.js - Debug script to see actual API response structure
const request = require('supertest');
const app = require('../index');

async function debugResponse() {
  try {
    console.log('🔍 Testing /api/nl/today response structure...\n');

    const response = await request(app).get('/api/nl/today').expect(200);

    console.log('✅ Status:', response.status);
    console.log('✅ Response structure:');
    console.log(JSON.stringify(response.body, null, 2));

    if (response.body.data && response.body.data.length > 0) {
      console.log('\n🔍 First price object structure:');
      console.log(JSON.stringify(response.body.data[0], null, 2));

      console.log('\n📋 Available properties:');
      Object.keys(response.body.data[0]).forEach(key => {
        console.log(`  - ${key}: ${typeof response.body.data[0][key]}`);
      });
    }
  } catch (error) {
    console.error('❌ Error:', error.message);
    if (error.response) {
      console.error('❌ Response:', JSON.stringify(error.response.body, null, 2));
    }
  }

  process.exit(0);
}

debugResponse();
