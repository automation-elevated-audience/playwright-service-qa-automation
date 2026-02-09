const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const axios = require('axios');
const { checkMultiplePages } = require('./linkChecker');
const { fetchPage } = require('./pageFetcher');
const { captureScreenshot } = require('./screenshotHandler');
const { checkPageContent } = require('./contentChecker');

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || '';

// Track active background jobs to prevent duplicate processing and report progress
// Key: job identifier (e.g. "start-qa:ProjectName" or "rerun:uuid")
// Value: { type, stage, startedAt, totalPages, checkedPages, projectName|projectId }
const activeJobs = new Map();

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
// Accepts either direct expectedContent text OR a contentDocLink (Google Docs URL)
app.post('/check-content', async (req, res) => {
  try {
    const { url, expectedContent, contentDocLink } = req.body;

    if (!url || typeof url !== 'string') {
      return res.status(400).json({
        error: 'Invalid request',
        message: 'Please provide a "url" in the request body'
      });
    }

    console.log(`[SERVER] Checking content for: ${url}`);
    if (contentDocLink) {
      console.log(`[SERVER] Using Google Doc link: ${contentDocLink}`);
    }
    
    const result = await checkPageContent(url, expectedContent || '', contentDocLink || null);
    
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

// ============================================================
// Server-side start-qa orchestrator
// Responds immediately, then runs link checks + forwards to n8n in the background
// This ensures the process survives browser refresh/navigation/close
// ============================================================
app.post('/start-qa', async (req, res) => {
  const { project_data, pages, settings, n8n_webhook_url } = req.body;

  if (!project_data || !project_data.project_name) {
    return res.status(400).json({
      error: 'Invalid request',
      message: 'project_data with project_name is required'
    });
  }

  const webhookUrl = n8n_webhook_url || N8N_WEBHOOK_URL;
  if (!webhookUrl) {
    return res.status(400).json({
      error: 'Configuration error',
      message: 'n8n webhook URL is not configured. Set N8N_WEBHOOK_URL in .env or pass n8n_webhook_url in the request body.'
    });
  }

  // Guard: prevent duplicate start-qa for the same project name
  const jobKey = `start-qa:${project_data.project_name}`;
  if (activeJobs.has(jobKey)) {
    const existing = activeJobs.get(jobKey);
    const elapsed = Math.round((Date.now() - existing.startedAt) / 1000);
    console.log(`[START-QA] Rejected duplicate request for "${project_data.project_name}" (running for ${elapsed}s)`);
    return res.status(409).json({
      error: 'already_running',
      message: `QA is already starting for "${project_data.project_name}". Please wait for it to finish.`,
      started_at: existing.startedAt,
      elapsed_seconds: elapsed
    });
  }

  // Register this job as active with granular progress tracking
  activeJobs.set(jobKey, {
    type: 'start-qa',
    startedAt: Date.now(),
    stage: 'checking_links',
    totalPages: (pages || []).length,
    checkedPages: 0,
    projectName: project_data.project_name,
  });

  // Respond immediately so the browser can navigate away safely
  res.json({ status: 'processing', project_name: project_data.project_name });

  // Background processing - runs after response is sent
  (async () => {
    try {
      console.log(`[START-QA] Starting server-side QA for "${project_data.project_name}" with ${(pages || []).length} pages`);

      // Step 1: Run Playwright link checks on the provided pages
      let pagesWithLinkChecks = pages || [];
      if (pages && pages.length > 0) {
        try {
          const playwrightPages = pages.map(p => ({
            url: p.page_url || p.pageUrl,
            pageName: p.page_name || p.pageName || 'Page'
          })).filter(p => p.url);

          if (playwrightPages.length > 0) {
            const concurrency = parseInt(process.env.MAX_CONCURRENCY) || 1;
            const startTime = Date.now();

            // Progress callback: update activeJobs as each page batch completes
            const onPageComplete = (checked, total) => {
              const job = activeJobs.get(jobKey);
              if (job) {
                job.checkedPages = checked;
                job.totalPages = total;
              }
            };

            const linkResults = await checkMultiplePages(playwrightPages, concurrency, onPageComplete);
            const duration = Date.now() - startTime;
            console.log(`[START-QA] Link checks completed for ${linkResults.length} pages in ${duration}ms`);

            // Enrich pages with link check results
            pagesWithLinkChecks = pages.map(p => {
              const pageUrl = (p.page_url || p.pageUrl || '').replace(/\/+$/, '');
              const lr = linkResults.find(l => (l.url || '').replace(/\/+$/, '') === pageUrl);
              return {
                ...p,
                link_checks: lr?.linkChecks || null
              };
            });
          }
        } catch (linkError) {
          console.warn(`[START-QA] Link check failed, continuing without:`, linkError.message);
        }
      }

      // Step 2: Forward the start request to n8n with enriched pages
      const job = activeJobs.get(jobKey);
      if (job) job.stage = 'forwarding_to_n8n';

      const payload = {
        ...project_data,
        ...(settings || {}),
        pages: pagesWithLinkChecks
      };

      console.log(`[START-QA] Forwarding to n8n: ${webhookUrl}/qa/start with ${pagesWithLinkChecks.length} pages`);

      const n8nResponse = await axios.post(`${webhookUrl}/qa/start`, payload, {
        timeout: 60000,
        headers: { 'Content-Type': 'application/json' }
      });

      console.log(`[START-QA] n8n responded for "${project_data.project_name}":`, n8nResponse.status);

      // Mark as completed briefly before cleanup
      const jobFinal = activeJobs.get(jobKey);
      if (jobFinal) jobFinal.stage = 'completed';
    } catch (error) {
      console.error(`[START-QA] Background processing failed for "${project_data.project_name}":`, error.message);
    } finally {
      activeJobs.delete(jobKey);
      console.log(`[START-QA] Job removed from activeJobs: "${project_data.project_name}"`);
    }
  })();
});

// ============================================================
// Server-side rerun orchestrator
// Responds immediately, then runs link checks + forwards to n8n in the background
// This ensures the process survives browser refresh/navigation/close
// ============================================================
app.post('/rerun', async (req, res) => {
  const { project_id, pages, settings, n8n_webhook_url } = req.body;

  if (!project_id) {
    return res.status(400).json({
      error: 'Invalid request',
      message: 'project_id is required'
    });
  }

  const webhookUrl = n8n_webhook_url || N8N_WEBHOOK_URL;
  if (!webhookUrl) {
    return res.status(400).json({
      error: 'Configuration error',
      message: 'n8n webhook URL is not configured. Set N8N_WEBHOOK_URL in .env or pass n8n_webhook_url in the request body.'
    });
  }

  // Guard: prevent duplicate rerun for the same project
  const jobKey = `rerun:${project_id}`;
  if (activeJobs.has(jobKey)) {
    const existing = activeJobs.get(jobKey);
    const elapsed = Math.round((Date.now() - existing.startedAt) / 1000);
    console.log(`[RERUN] Rejected duplicate request for project ${project_id} (running for ${elapsed}s)`);
    return res.status(409).json({
      error: 'already_running',
      message: 'A rerun is already in progress for this project. Please wait for it to finish.',
      started_at: existing.startedAt,
      elapsed_seconds: elapsed
    });
  }

  // Register this job as active with granular progress tracking
  activeJobs.set(jobKey, {
    type: 'rerun',
    startedAt: Date.now(),
    stage: 'checking_links',
    totalPages: (pages || []).length,
    checkedPages: 0,
    projectId: project_id,
  });

  // Respond immediately so the browser can navigate away safely
  res.json({ status: 'processing', project_id });

  // Background processing - runs after response is sent
  (async () => {
    try {
      console.log(`[RERUN] Starting server-side rerun for project ${project_id} with ${(pages || []).length} pages`);

      // Step 1: Run Playwright link checks on the provided pages
      let pagesWithLinkChecks = [];
      if (pages && pages.length > 0) {
        try {
          const playwrightPages = pages.map(p => ({
            url: p.page_url || p.pageUrl,
            pageName: p.page_name || p.pageName || 'Page'
          })).filter(p => p.url);

          if (playwrightPages.length > 0) {
            const concurrency = parseInt(process.env.MAX_CONCURRENCY) || 1;
            const startTime = Date.now();

            // Progress callback: update activeJobs as each page batch completes
            const onPageComplete = (checked, total) => {
              const job = activeJobs.get(jobKey);
              if (job) {
                job.checkedPages = checked;
                job.totalPages = total;
              }
            };

            const linkResults = await checkMultiplePages(playwrightPages, concurrency, onPageComplete);
            const duration = Date.now() - startTime;
            console.log(`[RERUN] Link checks completed for ${linkResults.length} pages in ${duration}ms`);

            // Map link check results back to pages
            pagesWithLinkChecks = pages.map(p => {
              const pageUrl = (p.page_url || p.pageUrl || '').replace(/\/+$/, '');
              const lr = linkResults.find(l => (l.url || '').replace(/\/+$/, '') === pageUrl);
              return {
                page_url: p.page_url || p.pageUrl,
                page_name: p.page_name || p.pageName || 'Page',
                link_checks: lr?.linkChecks || null
              };
            }).filter(p => p.link_checks != null);
          }
        } catch (linkError) {
          console.warn(`[RERUN] Link check failed, continuing without:`, linkError.message);
        }
      }

      // Step 2: Forward the rerun request to n8n with link check results
      const job = activeJobs.get(jobKey);
      if (job) job.stage = 'forwarding_to_n8n';

      const payload = {
        project_id,
        ...(settings || {}),
        pages: pagesWithLinkChecks
      };

      console.log(`[RERUN] Forwarding to n8n: ${webhookUrl}/qa/rerun with ${pagesWithLinkChecks.length} pages with link_checks`);

      const n8nResponse = await axios.post(`${webhookUrl}/qa/rerun`, payload, {
        timeout: 60000,
        headers: { 'Content-Type': 'application/json' }
      });

      console.log(`[RERUN] n8n responded for project ${project_id}:`, n8nResponse.status);

      // Mark as completed briefly before cleanup
      const jobFinal = activeJobs.get(jobKey);
      if (jobFinal) jobFinal.stage = 'completed';
    } catch (error) {
      console.error(`[RERUN] Background processing failed for project ${project_id}:`, error.message);
    } finally {
      activeJobs.delete(jobKey);
      console.log(`[RERUN] Job removed from activeJobs: project ${project_id}`);
    }
  })();
});

// ============================================================
// Job status endpoint for frontend polling
// Returns real-time progress of active background jobs
// ============================================================
app.get('/job-status', (req, res) => {
  const { project_name, project_id } = req.query;

  if (!project_name && !project_id) {
    return res.status(400).json({
      error: 'Invalid request',
      message: 'Provide project_name or project_id as a query parameter'
    });
  }

  // Look up by start-qa key first, then rerun key
  let jobKey = null;
  let job = null;

  if (project_name) {
    jobKey = `start-qa:${project_name}`;
    job = activeJobs.get(jobKey);
  }

  if (!job && project_id) {
    jobKey = `rerun:${project_id}`;
    job = activeJobs.get(jobKey);
  }

  // Also check the reverse: if project_name was given, maybe there's a rerun for it
  // (unlikely but handle gracefully)
  if (!job && project_name) {
    // Scan activeJobs for a matching projectName in rerun entries
    for (const [key, value] of activeJobs) {
      if (value.projectName === project_name) {
        job = value;
        break;
      }
    }
  }

  if (!job) {
    return res.json({ found: false });
  }

  const elapsed = Math.round((Date.now() - job.startedAt) / 1000);

  res.json({
    found: true,
    type: job.type,
    stage: job.stage,
    totalPages: job.totalPages,
    checkedPages: job.checkedPages,
    startedAt: job.startedAt,
    elapsed_seconds: elapsed,
    projectName: job.projectName || null,
    projectId: job.projectId || null,
  });
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
║   • GET  /job-status (real-time progress)                ║
║   • POST /check-links                                    ║
║   • POST /fetch-page                                     ║
║   • POST /screenshot                                     ║
║   • POST /check-content                                  ║
║   • POST /start-qa (server-side orchestrator)             ║
║   • POST /rerun (server-side orchestrator)               ║
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
