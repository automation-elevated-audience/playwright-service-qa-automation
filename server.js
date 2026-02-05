const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const { checkMultiplePages } = require('./linkChecker');
const { fetchPage } = require('./pageFetcher');
const { captureScreenshot } = require('./screenshotHandler');
const { checkPageContent } = require('./contentChecker');

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Request logging middleware
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    service: 'playwright-link-checker',
    timestamp: new Date().toISOString()
  });
});

// Main endpoint: Check links for multiple pages
app.post('/check-links', async (req, res) => {
  try {
    const { pages } = req.body;
    
    // Validate input
    if (!pages || !Array.isArray(pages) || pages.length === 0) {
      return res.status(400).json({
        error: 'Invalid request',
        message: 'Please provide an array of pages with url and pageName'
      });
    }
    
    console.log(`[SERVER] Received request to check ${pages.length} pages`);
    
    // Validate each page has required fields
    const validPages = pages.filter(page => page.url);
    
    if (validPages.length === 0) {
      return res.status(400).json({
        error: 'Invalid request',
        message: 'No valid pages found. Each page must have a "url" field'
      });
    }
    
    if (validPages.length !== pages.length) {
      console.log(`[SERVER] Warning: ${pages.length - validPages.length} invalid pages filtered out`);
    }
    
    // Get concurrency from query params or use default
    const concurrency = parseInt(req.query.concurrency) || parseInt(process.env.MAX_CONCURRENCY) || 1;
    
    // Check links for all pages
    const startTime = Date.now();
    const results = await checkMultiplePages(validPages, concurrency);
    const duration = Date.now() - startTime;
    
    console.log(`[SERVER] Completed checking ${results.length} pages in ${duration}ms`);
    
    // Send response
    res.json({
      success: true,
      results,
      metadata: {
        totalPages: results.length,
        duration: `${duration}ms`,
        timestamp: new Date().toISOString()
      }
    });
    
  } catch (error) {
    console.error('[SERVER] Error processing request:', error);
    
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error.message
    });
  }
});

// Fetch page HTML (JS-rendered) for metadata parsing
app.post('/fetch-page', async (req, res) => {
  try {
    const { url } = req.body;

    if (!url || typeof url !== 'string') {
      return res.status(400).json({
        error: 'Invalid request',
        message: 'Please provide a "url" in the request body'
      });
    }

    const result = await fetchPage(url);
    res.json(result);
  } catch (error) {
    console.error('[SERVER] Error fetching page:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error.message
    });
  }
});

// Capture screenshot (returns raw image bytes)
app.post('/screenshot', async (req, res) => {
  try {
    const { url, viewport = 'desktop', fullPage = true, quality = 70 } = req.body;

    if (!url || typeof url !== 'string') {
      return res.status(400).json({
        error: 'Invalid request',
        message: 'Please provide a "url" in the request body'
      });
    }

    const validViewports = ['desktop', 'tablet', 'mobile'];
    const viewportType = validViewports.includes(viewport) ? viewport : 'desktop';

    const buffer = await captureScreenshot(url, viewportType, fullPage, quality);
    res.set('Content-Type', 'image/jpeg');
    res.send(buffer);
  } catch (error) {
    console.error('[SERVER] Error capturing screenshot:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error.message
    });
  }
});

// Check page content against expected content
app.post('/check-content', async (req, res) => {
  try {
    const { url, expectedContent } = req.body;

    if (!url || typeof url !== 'string') {
      return res.status(400).json({
        error: 'Invalid request',
        message: 'Please provide a "url" in the request body'
      });
    }

    console.log(`[SERVER] Checking content for: ${url}`);
    const result = await checkPageContent(url, expectedContent || '');
    
    res.json({
      success: true,
      url,
      contentCheck: result
    });
  } catch (error) {
    console.error('[SERVER] Error checking content:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error.message
    });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('[SERVER] Unhandled error:', err);
  res.status(500).json({
    success: false,
    error: 'Internal server error',
    message: err.message
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: 'Not found',
    message: `Route ${req.method} ${req.path} not found`
  });
});

// Start server
const server = app.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════════════╗
║   Playwright Link Checker Service                         ║
║                                                           ║
║   Status: Running                                         ║
║   Port: ${PORT}                                             ║
║   Environment: ${process.env.NODE_ENV || 'development'}                              ║
║                                                           ║
║   Endpoints:                                             ║
║   • GET  /health                                         ║
║   • POST /check-links                                    ║
║   • POST /fetch-page                                     ║
║   • POST /screenshot                                     ║
║   • POST /check-content                                  ║
╚═══════════════════════════════════════════════════════════╝
  `);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[SERVER] SIGTERM received, shutting down gracefully');
  server && server.close(() => {
    console.log('[SERVER] Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('[SERVER] SIGINT received, shutting down gracefully');
  process.exit(0);
});
