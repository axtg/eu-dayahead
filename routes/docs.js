// routes/docs.js - API documentation routes
const express = require('express');
const path = require('path');
const router = express.Router();

// Serve the OpenAPI spec
router.get('/openapi.yaml', (req, res) => {
  res.sendFile(path.join(__dirname, '../docs/openapi.yaml'));
});

// Serve the Swagger UI HTML
router.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../docs/index.html'));
});

module.exports = router;
